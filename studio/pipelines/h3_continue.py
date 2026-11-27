"""Latent continuation of an H3 clip: the long take of the Relay (docs/LONG-VIDEO.md).

Every H3 clip keeps its final video latents next to its MP4 (`<stem>.latents.safetensors`,
DiT-normalised, float16, with the canvas size and the clip it continues in its metadata).
A continuous Relay segment is then rendered by h3-r2v with `continue_from`: the subjects'
sheets as references, and the previous clip's last TAIL_LATENTS video latents (22 frames)
as condition rows, which take the time of the target's first TAIL_LATENTS latent frames.
They are noised like any condition row (MINIMAX_H3_KEYFRAME_NOISE_AUG) and never stepped,
so the new clip starts on the movement, the light and the faces of the previous one. No
sound is carried over: an audio tail faded the sound out clip after clip on the GB10.

The clips of a take are then put end to end in latent space, each continuing clip without
its first TAIL_LATENTS latents (they redo the previous clip's last 22 frames), and decoded
once (video-stitch): the causal VAE carries its history across the joins. Decoded apart,
each clip restarted its VAE without history and a join jumped (mean gap 15.2 against 7.3,
promaxgb10-95c7, 2026-11-19).

FastVideo has no such input; its Ref2VA latent preparation is wrapped, in this process only:
the request is prepared as usual (sheets, target noise), then the tail is added as one more
silent video reference, and the positions are rewritten so that every row but the tail's
keeps the time it had without it. Any request without a tail runs FastVideo's code unchanged.

Pure arithmetic first (unit-tested without torch), then the FastVideo parts.
"""

import contextlib
import json
from pathlib import Path

# 7 latents = the first group (1 + 4 frames) and one full chunk (17): 22 frames, 0.92 s.
# A count of 2 + 5n keeps every following latent in its phase of the 17-frame chunks.
TAIL_LATENTS = 7
FPS = 24
SUFFIX = ".latents.safetensors"


def frames_of(latents: int) -> int:
    """Frames a run of H3 video latents decodes to (the 17n+5 grid)."""
    if latents < 2 or (latents - 2) % 5:
        raise ValueError(f"{latents} latent frames are not on the H3 grid (2 + 5n)")
    return (latents - 2) // 5 * 17 + 5


TAIL_FRAMES = frames_of(TAIL_LATENTS)  # 22


def latents_path(video: Path) -> Path:
    return video.with_name(video.stem + SUFFIX)


def read_meta(video: Path) -> dict | None:
    """The metadata of a clip's saved latents (width, height, latents, continues), read from
    the safetensors header without torch; None when the clip kept none."""
    path = latents_path(video)
    if not path.is_file():
        return None
    with open(path, "rb") as fh:
        size = int.from_bytes(fh.read(8), "little")
        meta = json.loads(fh.read(size)).get("__metadata__") or {}
    return {"width": int(meta["width"]), "height": int(meta["height"]), "latents": int(meta["latents"]),
            "continues": meta.get("continues") or None}


def links(clips: list[str], metas: list[dict | None]) -> list[bool]:
    """For each clip after the first: True when it was rendered as the continuation of the
    clip before it in the list (its latents say so and both kept theirs)."""
    return [bool(metas[k] and metas[k - 1] and metas[k]["continues"] == clips[k - 1]) for k in range(1, len(clips))]


def runs(linked: list[bool]) -> list[list[int]]:
    """Clip indexes grouped into runs joined in latent space: [T, F, T] → [[0, 1], [2, 3]]."""
    out = [[0]]
    for k, link in enumerate(linked, start=1):
        if link:
            out[-1].append(k)
        else:
            out.append([k])
    return out


def stitched_latents(counts: list[int]) -> int:
    """Latent frames of a run once stitched: the first clip whole, the others without their tail."""
    total = counts[0] + sum(c - TAIL_LATENTS for c in counts[1:])
    frames_of(total)  # stays on the grid by construction; checked all the same
    return total


# ── FastVideo ────────────────────────────────────────────────────────────────

_tail = None   # (video latents (1, C, K, h, w), seed) for the running request
_installed = False


@contextlib.contextmanager
def tail(video, seed: int):
    """Make the requests run inside this block continue from `video` (the last latents of the
    previous clip). One H3 request runs at a time (h3_runtime), hence a module-level slot."""
    global _tail
    _tail = (video, seed)
    try:
        yield
    finally:
        _tail = None


def load_tail(video: Path):
    """The last TAIL_LATENTS video latents a clip kept, as float32 (1, C, K, h, w)."""
    from safetensors.torch import load_file
    return load_file(str(latents_path(video)))["video"][:, :, -TAIL_LATENTS:].float()


def save(video: Path, latents, width: int, height: int, continues: str | None) -> Path:
    """Keep a clip's final video latents (DiT-normalised) next to its MP4."""
    from safetensors.torch import save_file
    path = latents_path(video)
    meta = {"width": str(width), "height": str(height), "latents": str(latents.shape[2])}
    if continues:
        meta["continues"] = continues
    save_file({"video": latents.detach().to("cpu").half().contiguous()}, str(path), metadata=meta)
    return path


def final_latents(batch, fastvideo_args):
    """The target's video latents at the decoding stage, (1, C, T, h, w), condition rows dropped
    (what FastVideo's video decoder unpatchifies before it denormalises)."""
    from fastvideo.pipelines.basic.minimax_h3.packing import h3_dit_patch_size, unpatchify_video_tokens
    from fastvideo.pipelines.basic.minimax_h3.stages.minimax_h3_latent_preparation import MINIMAX_H3_LAYOUT_KEY
    layout = batch.extra[MINIMAX_H3_LAYOUT_KEY]
    _, channels, frames, height, width = batch.raw_latent_shape
    return unpatchify_video_tokens(batch.latents[layout.num_condition_video_rows:], frames, height, width,
                                   channels, h3_dit_patch_size(fastvideo_args))


def install() -> None:
    """Wrap FastVideo's H3 latent preparation once per process (idempotent)."""
    global _installed
    if _installed:
        return
    import torch
    import torch.nn.functional as F
    try:
        from fastvideo.pipelines.basic.minimax_h3.packing import (
            MINIMAX_H3_KEYFRAME_NOISE_AUG, build_ref2va_packed_sequence, h3_dit_patch_size, patchify_video_latents)
        from fastvideo.pipelines.basic.minimax_h3.reference import MiniMaxH3PreparedReference
        from fastvideo.pipelines.basic.minimax_h3.stages import minimax_h3_latent_preparation as LP
    except ImportError as err:
        raise RuntimeError("Latent continuation needs the FastVideo build of docker/Dockerfile "
                           f"(FASTVIDEO_REF): {err}") from err
    stage = LP.MiniMaxH3LatentPreparationStage
    prepare = stage.forward

    @torch.no_grad()
    def forward(self, batch, fastvideo_args):
        if _tail is None or not self.ref2va:
            return prepare(self, batch, fastvideo_args)
        video, seed = _tail
        refs = list(batch.references or [])
        out = prepare(self, batch, fastvideo_args)       # sheets, target noise: unchanged
        old = batch.extra[LP.MINIMAX_H3_LAYOUT_KEY]
        patch = h3_dit_patch_size(fastvideo_args)
        frames, height, width = old.num_video_latent_frames, old.latent_height, old.latent_width
        k = int(video.shape[2])
        if tuple(video.shape[3:]) != (height, width):     # the first pass runs at about 0.6 MP
            video = F.interpolate(video[0].permute(1, 0, 2, 3), size=(height, width), mode="bilinear",
                                  align_corners=False, antialias=True).permute(1, 0, 2, 3)[None]
        device = batch.latents.device
        rows = patchify_video_latents(video.to(device, torch.float32), patch)
        noise = torch.randn(rows.shape, generator=torch.Generator("cpu").manual_seed(seed)).to(device)
        rows = self.scheduler.scale_noise(rows, MINIMAX_H3_KEYFRAME_NOISE_AUG, noise)
        silent = MiniMaxH3PreparedReference(media_type="video", has_audio=False, num_latent_frames=k,
                                            latent_height=height, latent_width=width)
        new = build_ref2va_packed_sequence(old.token_tags[old.text_indices], refs + [silent], frames, height,
                                           width, old.num_audio_latents, patch)
        n_old, n_new = int(old.num_condition_video_rows), int(new.num_condition_video_rows)
        batch.latents = torch.cat((batch.latents[:n_old], rows, batch.latents[n_old:]))
        pos = new.position_ids
        target = new.video_indices[n_new:]
        sound = new.audio_indices[int(new.num_condition_audio_rows):]
        # Every target row keeps the time it had without the tail ...
        pos[target] = old.position_ids[old.video_indices[n_old:]]
        pos[sound] = old.position_ids[old.audio_indices[int(old.num_condition_audio_rows):]]
        # ... and the tail takes the time of the target's first k latent frames.
        per_frame = (height // patch[1]) * (width // patch[2])
        pos[new.video_indices[n_old:n_new]] = pos[target[:k * per_frame]]
        batch.extra[LP.MINIMAX_H3_LAYOUT_KEY] = new
        return out

    stage.forward = forward
    _installed = True
    print("engine: FastVideo H3 latent preparation patched for latent continuation", flush=True)
