"""MiniMax H3 latent upscaler: a 3D convolutional network that enlarges video
latents between the two passes of the reference-to-video engine.

Written for this project from the architecture of LBH-123-AI's published
checkpoint (Apache-2.0 weights, `LBH-123-AI/Minimax_h3_latent_Upscaler`); the
module names follow the checkpoint so its state dict loads strictly. It is
conditioned on the upscale factor and works on 24-channel latents normalised
*twice* with the H3 video VAE statistics: its ComfyUI node normalises its input
again although the DiT's latents already are. The caller does the same and
denormalises the output once (h3.refine_inputs); fed the DiT latents directly,
its output does not correlate with a trilinear upscale (r = -0.01 against 0.86
on the GB10) and the refined clip comes out as pink mush.

Long clips are processed in temporal chunks with an overlap equal to the
temporal kernel size and a linear cross-fade, as the reference node does: the
validated workflow ran with chunking on (5 s = 37 latent frames > 32).

torch is imported here, so import this module only where a GPU run happens.
"""

from pathlib import Path

import torch
import torch.nn.functional as F
from torch import nn

CHANNELS = 512
EMBED = 64
BLOCKS = 12
TEMPORAL_EVERY = 2
TEMPORAL_KERNEL = 5
CHUNK = 32


def _norm(channels: int) -> nn.GroupNorm:
    return nn.GroupNorm(32, channels)


class ResBlockEmb3D(nn.Module):
    def __init__(self, channels: int, emb_channels: int, dropout: float = 0.0):
        super().__init__()
        self.in_layers = nn.Sequential(_norm(channels), nn.SiLU(), nn.Conv3d(channels, channels, 3, padding=1))
        self.emb_layers = nn.Sequential(nn.SiLU(), nn.Linear(emb_channels, 2 * channels))
        self.out_norm = _norm(channels)
        self.out_layers = nn.Sequential(nn.SiLU(), nn.Dropout(dropout), nn.Conv3d(channels, channels, 3, padding=1))
        self.skip = nn.Identity()

    def forward(self, x, emb):
        scale, shift = self.emb_layers(emb)[:, :, None, None, None].chunk(2, dim=1)
        h = self.out_norm(self.in_layers(x)) * (1 + scale) + shift
        return self.skip(x) + self.out_layers(h)


class TemporalConv(nn.Module):
    """Depthwise convolution along time only, then a pointwise mix, as a residual."""

    def __init__(self, channels: int, kernel: int = TEMPORAL_KERNEL):
        super().__init__()
        self.norm = _norm(channels)
        self.dwconv = nn.Conv3d(channels, channels, (kernel, 1, 1), padding=(kernel // 2, 0, 0), groups=channels)
        self.pwconv = nn.Conv3d(channels, channels, 1)

    def forward(self, x):
        return x + self.pwconv(self.dwconv(F.silu(self.norm(x))))


def _blocks() -> nn.ModuleList:
    blocks = nn.ModuleList()
    for b in range(BLOCKS):
        blocks.append(ResBlockEmb3D(CHANNELS, EMBED))
        if b % TEMPORAL_EVERY == 0:
            blocks.append(TemporalConv(CHANNELS))
    return blocks


class LatentUpscaler3D(nn.Module):
    def __init__(self, latent_channels: int = 24):
        super().__init__()
        self.conv_in = nn.Conv3d(latent_channels, CHANNELS, 3, padding=1)
        self.embed = nn.Sequential(nn.Linear(1, EMBED), nn.SiLU(), nn.Linear(EMBED, EMBED))
        self.in_blocks = _blocks()
        self.out_blocks = _blocks()
        self.norm_out = _norm(CHANNELS)
        self.conv_out = nn.Conv3d(CHANNELS, latent_channels, 3, padding=1)

    def _run(self, blocks, x, emb):
        for block in blocks:
            x = block(x, emb) if isinstance(block, ResBlockEmb3D) else block(x)
        return x

    def segment(self, x, scale: float, size: tuple[int, int, int]):
        """One forward over a whole segment: x (B, C, T, h, w) -> (B, C, *size)."""
        emb = self.embed(torch.tensor([[scale - 1.0]], dtype=x.dtype, device=x.device)).expand(x.shape[0], -1)
        x = self._run(self.in_blocks, self.conv_in(x), emb)
        x = F.interpolate(x, size=size, mode="trilinear", align_corners=False)
        x = self._run(self.out_blocks, x, emb)
        return self.conv_out(F.silu(self.norm_out(x)))

    def forward(self, x, scale: float, height: int, width: int):
        """Upscale normalised latents spatially; time is kept, chunked past CHUNK frames."""
        t = x.shape[2]
        if t <= CHUNK:
            return self.segment(x, scale, (t, height, width))
        overlap = TEMPORAL_KERNEL
        padded = F.pad(x, (0, 0, 0, 0, overlap, overlap), mode="replicate")
        out = x.new_zeros(x.shape[0], x.shape[1], t, height, width)
        total = x.new_zeros(1, 1, t, 1, 1)
        for start in range(0, t, CHUNK):
            end = min(t, start + CHUNK)
            # Frames this chunk writes (its own plus an overlap each side), and
            # the window of the padded input it reads. The window is the one of
            # the reference node, context included, so that results match the
            # validated workflow; do not "fix" its asymmetry.
            lo_out, hi_out = max(0, start - overlap), min(t, end + overlap)
            lo_in, hi_in = max(0, lo_out - overlap), min(t + 2 * overlap, hi_out + overlap)
            seg = self.segment(padded[:, :, lo_in:hi_in], scale, (hi_in - lo_in, height, width))
            first = lo_out + overlap - lo_in
            seg = seg[:, :, first:first + hi_out - lo_out]
            weight = torch.ones(hi_out - lo_out, device=x.device, dtype=x.dtype)
            if start > lo_out:
                n = start - lo_out
                weight[:n] = torch.arange(1, n + 1, device=x.device, dtype=x.dtype) / (n + 1)
            if hi_out > end:
                n = hi_out - end
                weight[-n:] = torch.arange(n, 0, -1, device=x.device, dtype=x.dtype) / (n + 1)
            weight = weight.view(1, 1, -1, 1, 1)
            out[:, :, lo_out:hi_out] += seg * weight
            total[:, :, lo_out:hi_out] += weight
        return out / total.clamp(min=1e-8)


def load(path: Path, device: str, dtype=torch.bfloat16) -> LatentUpscaler3D:
    from safetensors.torch import load_file
    state = load_file(str(path))
    if any(k.startswith("upscaler.") for k in state):
        state = {k[len("upscaler."):]: v for k, v in state.items() if k.startswith("upscaler.")}
    model = LatentUpscaler3D(latent_channels=state["conv_in.weight"].shape[1])
    model.load_state_dict(state, strict=True)
    return model.to(device=device, dtype=dtype).eval().requires_grad_(False)
