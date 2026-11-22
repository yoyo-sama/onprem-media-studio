"""A start frame for H3 Ref2VA: the references AND a first image in one render.

FastVideo (FASTVIDEO_REF of docker/Dockerfile) refuses the mix on both of its H3
pipelines: references belong to Ref2VA, a first frame to FL2VA. Both condition the
same way, as VAE-encoded rows set before the target's noisy rows (same token label,
same noise augmentation); only their time differs. Ref2VA gives every reference its
own time slot, and the target starts after all of them, so no reference can ever be
frame 0 (a "Picture 1 at 0.00 seconds" prompt rendered a new shot on the GB10,
2026-11-15).

This module patches three stages of FastVideo, in this process only: a request with
references and a `pil_image` is prepared as Ref2VA, and the image (stretched to the
canvas, as a FL2VA first frame) is added as one more silent video reference: the
picture held still for START_FRAMES frames. Its rows are then moved to the time of the
target's first latent frames and the slot Ref2VA gave it is handed back, so every
other position is the one of a pure Ref2VA layout. The text encoder never sees the
start frame: <Picture N> are the references only. Any other request runs FastVideo's
code unchanged.

Why a held picture and not one image: the start frame used to be one image row at the
target's frame-0 time. On the OmniRef checkpoint 7 clips in 11 kept it for 1 or 2
frames and then cut to another shot (GB10, 2026-11-18, docs/LONG-VIDEO.md, method B).
Latent continuation (`h3_continue`) puts 7 latent frames (22 frames) of the previous
clip at the time of the target's first 7 and never lost them: the same layout, fed a
still clip of the picture, makes the clip start on the picture, hold it for about
0.9 s, then move, with the references in view (the first segment of a long take with
a first frame and sheets). On the V2 (FL2VA) checkpoint a start frame with references
drew a second, identical woman: h3-i2v never takes references.
"""

from .h3_continue import TAIL_FRAMES

# The still clip of the start picture: as long as a continuation tail (7 latent frames).
START_FRAMES = TAIL_FRAMES

KEY = "studio_start_frame"
_installed = False


def _keyframe_rows(layout, patch) -> int:
    return (layout.latent_height // patch[1]) * (layout.latent_width // patch[2])


def move_start_frame(layout, rows: int) -> None:
    """Put the last `rows` condition rows (the held start picture) at the positions of the
    target's first `rows` rows, and move the target video and audio back by the slot Ref2VA
    advanced for it."""
    n_cond = int(layout.num_condition_video_rows)
    pos = layout.position_ids
    start = layout.video_indices[n_cond - rows:n_cond]
    video = layout.video_indices[n_cond:]
    audio = layout.audio_indices[int(layout.num_condition_audio_rows):]
    shift = float(pos[video[0], 0]) - float(pos[start[0], 0])
    pos[video, 0] -= shift
    pos[audio, 0] -= shift
    pos[start] = pos[video[:rows]]


def install() -> None:
    """Patch FastVideo's H3 stages once per process (idempotent)."""
    global _installed
    if _installed:
        return
    import numpy as np
    import torch
    from PIL import ImageOps
    try:
        from fastvideo.pipelines.basic.minimax_h3 import minimax_h3_pipeline as MP
        from fastvideo.pipelines.basic.minimax_h3.packing import h3_dit_patch_size, prepare_keyframe_image
        from fastvideo.pipelines.basic.minimax_h3.reference import MiniMaxH3PreparedReference
        from fastvideo.pipelines.basic.minimax_h3.stages import minimax_h3_conditioning as CO
        from fastvideo.pipelines.basic.minimax_h3.stages import minimax_h3_input_preparation as IP
        from fastvideo.pipelines.basic.minimax_h3.stages import minimax_h3_latent_preparation as LP
        stages = (IP.MiniMaxH3InputPreparationStage, CO.MiniMaxH3ConditioningStage, LP.MiniMaxH3LatentPreparationStage)
        for owner, name in ((IP, "prepare_common_request"), (MP, "_default_audio_geometry"),
                            (stages[0], "_prepare_ref2va"), (LP, "MINIMAX_H3_LAYOUT_KEY")):
            getattr(owner, name)
    except (ImportError, AttributeError) as err:
        raise RuntimeError("A start frame with references needs the FastVideo build of docker/Dockerfile "
                           f"(FASTVIDEO_REF): {err}") from err

    ip_forward, co_forward, lp_forward = (stage.forward for stage in stages)

    @torch.no_grad()
    def input_forward(self, batch, fastvideo_args):
        first = batch.pil_image
        if not (batch.references and first is not None):
            return ip_forward(self, batch, fastvideo_args)
        if batch.last_image is not None or batch.image_path is not None:
            raise ValueError("Ref2VA takes a start frame only, never a last image")
        batch.pil_image = None
        IP.prepare_common_request(batch)
        saved = self.audio_vae
        if self.audio_vae is None:
            self.audio_vae = MP._default_audio_geometry()
        try:
            self._prepare_ref2va(batch)
        finally:
            self.audio_vae = saved
        image = ImageOps.exif_transpose(first).convert("RGB")
        batch.extra[KEY] = prepare_keyframe_image(image, batch.height, batch.width, stretch=True)
        return batch

    def conditioning_forward(self, batch, fastvideo_args):
        if KEY not in batch.extra or self.ref2va:
            return co_forward(self, batch, fastvideo_args)
        self.ref2va = True
        try:
            return co_forward(self, batch, fastvideo_args)
        finally:
            self.ref2va = False

    def latent_forward(self, batch, fastvideo_args):
        image = batch.extra.get(KEY)
        if image is None:
            return lp_forward(self, batch, fastvideo_args)
        refs, saved = list(batch.references), self.ref2va
        held = MiniMaxH3PreparedReference(media_type="video", frames=np.stack([np.asarray(image)] * START_FRAMES))
        self.ref2va = True
        batch.references = refs + [held]
        try:
            out = lp_forward(self, batch, fastvideo_args)
        finally:
            self.ref2va = saved
            batch.references = refs
        layout = batch.extra[LP.MINIMAX_H3_LAYOUT_KEY]
        move_start_frame(layout, held.num_latent_frames * _keyframe_rows(layout, h3_dit_patch_size(fastvideo_args)))
        return out

    stages[0].forward, stages[1].forward, stages[2].forward = input_forward, conditioning_forward, latent_forward
    _installed = True
    print("engine: FastVideo H3 stages patched for a start frame with references", flush=True)
