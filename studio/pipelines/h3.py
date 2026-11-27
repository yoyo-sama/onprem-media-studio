"""MiniMax H3 video with synchronized audio, through FastVideo (FastH3).

Three engines:
- `h3-t2v`: text to video (FastH3 V2, 8 transformer forwards);
- `h3-i2v`: first image to video, or first and last images (FL2VA) when
  `last_image` is given (same checkpoint and FastVideo pipeline: the keyframes
  become conditioning rows);
- `h3-r2v`: references to video (FastH3 OmniRef): images, silent clips and
  sounds, in one ordered list, and optionally a start frame (`image`, the
  first segment of a long take: `h3_start_frame`) or the clip it continues
  (`continue_from`, the continuous segments of the Relay: `h3_continue`); the
  two passes of the workflow validated on the GB10 in ComfyUI: 8 steps at
  about 0.3 MP, latent upscale to about 0.9 MP, then 3 refine steps at denoise
  0.4. `preview` stops after the first pass.

One more GPU job, `video-stitch`, assembles a Relay take: the clips joined by
latent continuation are put end to end as latents and decoded once.

Rules carried over from 1.4 (LESSONS.md § 6):
- the prompt arrives already compiled in the H3 grammar (`web/js/h3.js`) and
  is sent verbatim; the 7,000-character cap is enforced, never by trimming;
- frame counts follow the 17n+5 grid: a 5 s request renders 124 frames;
- `<Picture N>` numbers the reference images in the order they are sent,
  `<Video N>` the clips and `<Audio N>` the sounds, each kind on its own
  (FastVideo's presentation, MiniMax's full-reference guide);
- no guidance (cfg 1), so a negative prompt is refused.

FastVideo constrains H3 to clips of 5 to 15 seconds (1.4 allowed shorter
cuts): a shorter duration is refused with a clear message.

Every clip is written as an MP4 with its audio, plus the last frame as a
lossless PNG, which a Relay segment uses as the first image of the next one,
and its final video latents (`h3_continue`), which a continuous segment and
video-stitch read.
"""

import json
import math
import re
import time
from pathlib import Path

from .. import loras as lora_files
from ..files import media_kind
from . import Pipeline, common, h3_continue, h3_lora, montage, register

FPS = 24
MIN_SECONDS, MAX_SECONDS = 5, 15
PROMPT_CHARS = 7000           # H3_PROMPT_CHARS of 1.4
# FastVideo's Ref2VA limits (MINIMAX_H3_MAX_REFERENCE_*): 9 images, 3 clips,
# 3 sounds, 12 in all, and a sound never alone.
MAX_REFERENCES = {"image": 9, "video": 3, "audio": 3}
MAX_ALL_REFERENCES = 12
REFERENCE_LABELS = {"image": "Picture", "video": "Video", "audio": "Audio"}
MAX_PIXELS = 768 * 1344       # FastVideo's MiniMax H3 canvas limit
MULTIPLE = 32
FINAL_MEGAPIXELS = 0.9        # size of every final clip (validated Ref2VA workflow)
PASS1_MEGAPIXELS = 0.3        # first Ref2VA pass
# A bench may ask another first-pass size (`pass1_megapixels`, API only): faces of whole bodies
# were a few pixels at 0.3 MP and invented by H3 (runway take, GB10 2026-11-27).
PASS1_RANGE = (0.3, 0.9)
VAE_DOWNSAMPLE = 16
NO_NEGATIVE = "MiniMax H3 runs without guidance (cfg 1), so a negative prompt is never used."

V2 = "fasth3-v2-nvfp4"
OMNIREF = "fasth3-omniref-nvfp4"
UPSCALER = "h3-latent-upscaler"
UPSCALER_FILE = "minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"

# Refine pass of the validated workflow: ComfyUI BasicScheduler "beta", 3 steps,
# denoise 0.4 at video shift 12, i.e. the last 4 sigmas of a 7-step beta schedule.
REFINE_SIGMAS = (0.8897085946145332, 0.7698646262507357, 0.48214285714285715, 0.0)


# ── Geometry and schedule (pure functions, unit-tested) ──────────────────────

def frames_for(seconds: float) -> int:
    """Frames FastVideo renders for a duration: rounded up to the 17n+5 grid (h3VideoFrames of 1.4)."""
    base = max(5, round(seconds * FPS))
    return base + (5 - base % 17) % 17


def latent_frames(frames: int) -> int:
    return (frames - 5) // 17 * 5 + 2


def parse_aspect(value) -> tuple[int, int]:
    if not isinstance(value, str) or not re.fullmatch(r"[1-9]\d{0,3}:[1-9]\d{0,3}", value):
        raise ValueError('aspect must look like "16:9"')
    w, h = map(int, value.split(":"))
    if not 1 / 4 <= w / h <= 4:
        raise ValueError("MiniMax H3 supports aspect ratios from 1:4 to 4:1")
    return w, h


def size_for(aspect: tuple[int, int], megapixels: float) -> tuple[int, int]:
    return common.fit_area(*aspect, area=round(megapixels * 1024 * 1024), multiple=MULTIPLE)


def upscale_target(width: int, height: int, megapixels: float = FINAL_MEGAPIXELS) -> tuple[int, int, float]:
    """Pixel size after the latent upscaler and the factor it is conditioned on
    (the reference node's "megapixels" mode, alignment 32: the factor comes from
    the unrounded target, the size from the target rounded to 32 pixels)."""
    lw, lh = width // VAE_DOWNSAMPLE, height // VAE_DOWNSAMPLE
    aspect = lw / lh
    target_h = math.sqrt(megapixels * 1024 * 1024 / aspect)
    target_w = target_h * aspect
    scale = (target_w / (lw * VAE_DOWNSAMPLE) + target_h / (lh * VAE_DOWNSAMPLE)) / 2
    w = round(round(target_w / MULTIPLE) * MULTIPLE / VAE_DOWNSAMPLE) * VAE_DOWNSAMPLE
    h = round(round(target_h / MULTIPLE) * MULTIPLE / VAE_DOWNSAMPLE) * VAE_DOWNSAMPLE
    return w, h, scale


def upscale_scale(width: int, height: int, final: tuple[int, int]) -> float:
    """The upscaler's factor for a given final size (a clip that continues another one
    renders at that clip's size, which upscale_target may not give)."""
    return (final[0] / (width // VAE_DOWNSAMPLE * VAE_DOWNSAMPLE)
            + final[1] / (height // VAE_DOWNSAMPLE * VAE_DOWNSAMPLE)) / 2


def node_sigma(index: int, shift: float, steps: int = 32, grid_max: float = 0.999) -> float:
    """Sigma of a PDD node: the fine grid u = grid_max·(1 − k/steps), shifted."""
    u = grid_max * (1 - index / steps)
    return shift * u * grid_max / (u * (shift - 1) + grid_max)


def pdd_indices(sigmas, shift: float, steps: int = 32, grid_max: float = 0.999) -> tuple[int, ...]:
    """Nearest PDD nodes of a sigma schedule (what the refine pass runs through)."""
    out = []
    for sigma in sigmas:
        u = sigma * grid_max / (shift * grid_max - sigma * (shift - 1))
        out.append(round((1 - u / grid_max) * steps))
    return tuple(out)


def contract(model_dir: Path) -> dict:
    """The checkpoint's fastvideo_inference.json: steps, shifts, PDD grid."""
    return json.loads((model_dir / "fastvideo_inference.json").read_text())


# ── Parameters ───────────────────────────────────────────────────────────────

def _prompt(params: dict) -> str:
    text = common.prompt(params)
    if len(text) > PROMPT_CHARS:
        raise ValueError(f"prompt is {len(text)} characters, over the {PROMPT_CHARS}-character limit of "
                         "MiniMax H3 (the front end trims detailed_description, never the closing fields)")
    return text


def _duration(params: dict) -> float:
    value = params.get("duration", MIN_SECONDS)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not MIN_SECONDS <= value <= MAX_SECONDS:
        raise ValueError(f"duration must be between {MIN_SECONDS} and {MAX_SECONDS} seconds: FastVideo's "
                         "MiniMax H3 renders clips of 5 to 15 s (cuts shorter than 5 s are not possible)")
    return float(value)


def _size(params: dict, default_aspect: tuple[int, int]) -> tuple[int, int]:
    if ("width" in params) != ("height" in params):
        raise ValueError("Send width and height together")
    if "width" in params:
        if "aspect" in params:
            raise ValueError("Send either aspect, or width and height")
        width = common.integer(params, "width", 0, MULTIPLE, 4096, MULTIPLE)
        height = common.integer(params, "height", 0, MULTIPLE, 4096, MULTIPLE)
        if width * height > MAX_PIXELS or not 1 / 4 <= width / height <= 4:
            raise ValueError(f"{width}×{height} is outside MiniMax H3's canvas (at most {MAX_PIXELS} pixels, "
                             "aspect 1:4 to 4:1)")
        return width, height
    aspect = parse_aspect(params["aspect"]) if "aspect" in params else default_aspect
    if not 1 / 4 <= aspect[0] / aspect[1] <= 4:
        raise ValueError("MiniMax H3 supports aspect ratios from 1:4 to 4:1")
    return size_for(aspect, FINAL_MEGAPIXELS)


def _common(params: dict, files, extra: set[str]) -> dict:
    common.check_keys(params, {"prompt", "duration", "seed", "loras", *extra}, NO_NEGATIVE)
    out = {"prompt": _prompt(params), "duration": _duration(params)}
    out["frames"] = frames_for(out["duration"])
    out["loras"] = lora_files.check_stack(params.get("loras", []), files.loras_dir, "h3")
    out["seed"] = common.seed(params)
    return out


def _cited_pictures(prompt: str, label: str = "Picture") -> set[int]:
    return {int(n) for n in re.findall(rf"<{label} (\d+)>", prompt)}


def _references(params: dict, files) -> list[str]:
    """The ordered Ref2VA list: each entry's kind comes from its extension."""
    refs = params.get("references", [])
    if not isinstance(refs, list) or not refs:
        raise ValueError("references must be a non-empty list of images, videos and sounds")
    counts = dict.fromkeys(MAX_REFERENCES, 0)
    for ref in refs:
        files.resolve(ref)
        kind = media_kind(ref)
        if kind is None:
            raise ValueError(f"references: {ref} is neither an image, a video nor a sound")
        counts[kind] += 1
    for kind, limit in MAX_REFERENCES.items():
        if counts[kind] > limit:
            raise ValueError(f"MiniMax H3 takes at most {limit} {kind} references, {counts[kind]} were sent")
    if len(refs) > MAX_ALL_REFERENCES:
        raise ValueError(f"MiniMax H3 takes at most {MAX_ALL_REFERENCES} references, {len(refs)} were sent")
    if counts["audio"] == len(refs):
        raise ValueError("A sound reference needs at least one image or video reference beside it")
    return refs


def _engine(ctx, model_dir: Path, ref2va: bool, loras: list[dict]):
    from .h3_runtime import Engine, EngineSpec
    settings = ctx.models.settings
    lora = h3_lora.build(loras, settings.loras_dir / "h3", settings.data_dir / "cache" / "h3-loras")
    spec = EngineSpec(model_dir=model_dir, ref2va=ref2va, lora=lora, lora_names=lora_files.describe(loras))
    label = "FastH3 OmniRef" if ref2va else "FastH3"
    ctx.progress(0, f"Loading MiniMax H3 ({label}, NVFP4)" + (f" + LoRA {spec.lora_names}" if loras else ""))
    return common.load(("h3", spec), lambda: Engine(spec), alone=True)


# ── Outputs ──────────────────────────────────────────────────────────────────

def _video_path(ctx) -> Path:
    folder = ctx.output_dir / ctx.job.pipeline
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{time.strftime('%Y%m%d-%H%M%S')}-{ctx.job.id}.mp4"


def _keeper(path: Path, params: dict, continues: str | None = None):
    """Keeps the clip's final video latents next to its MP4 (Engine.generate's `keep`)."""
    def keep(batch, fastvideo_args):
        h3_continue.save(path, h3_continue.final_latents(batch, fastvideo_args), params["width"],
                         params["height"], continues)
    return keep


def _outputs(result, path: Path, ctx, params: dict) -> list[Path]:
    """The MP4 FastVideo wrote, tagged with the job's metadata, and the clip's
    last frame as a PNG named after it (hidden from the gallery's default view).
    The latents kept under the requested name follow the MP4 if FastVideo named it otherwise."""
    from PIL import Image
    video = Path(result.video_path) if result.video_path else path
    if not video.is_file():
        raise RuntimeError("FastVideo reported success but wrote no video (LESSONS.md #1)")
    kept = h3_continue.latents_path(path)
    if video != path and kept.is_file():
        kept.replace(h3_continue.latents_path(video))
    if not result.frames:
        raise RuntimeError("FastVideo returned no frames")
    common.tag_video(video, ctx, params)
    last = common.save_images([Image.fromarray(result.frames[-1])], ctx, params, role="last-frame", stem=video.stem)
    return [video, *last]


def _reference(path: Path):
    """One FastVideo reference. A clip goes silent, as decoded frames: FastVideo would
    otherwise adopt its soundtrack as one more <Audio N> the prompt does not define
    (the full-reference guide: a video's sound is not a reference by itself being
    there). A sound is its own reference."""
    from fastvideo.pipelines.basic.minimax_h3 import MiniMaxH3Reference
    kind = media_kind(path.name)
    if kind == "video":
        from fastvideo.pipelines.basic.minimax_h3.reference import decode_reference_video
        frames, fps, _ = decode_reference_video(path)
        return MiniMaxH3Reference(source=frames, media_type="video", fps=fps)
    return MiniMaxH3Reference(source=str(path), media_type=kind)


def _steps(ctx, low: float, high: float, label: str):
    """Progress of one FastVideo request, for Engine.generate: its denoising steps move the
    job from `low` to `high`, and the video decoding, which follows, shows at `high`.
    Cancelling is left to the engine's watcher, which interrupts FastVideo cleanly."""
    def report(stage: str, done: int, total: int) -> None:
        if ctx.cancelled():
            return
        if stage == "denoise":
            ctx.progress(low + (high - low) * done / total, f"{label}: step {done}/{total}")
        else:
            ctx.progress(high, f"{label}: decoding the video")
    return report


def _open(ctx, ref: str):
    return common.open_image(ctx.files.resolve(ref))


# ── Engines ──────────────────────────────────────────────────────────────────

class H3TextToVideo(Pipeline):
    id = "h3-t2v"
    models = [V2]

    def validate(self, params, files):
        out = _common(params, files, {"aspect", "width", "height"})
        out["width"], out["height"] = _size(params, (16, 9))
        return out

    def run(self, params, models, ctx):
        return self._render(models, params, ctx)

    def _render(self, models, params, ctx, pil_image=None, last_image=None):
        model_dir = models[V2]
        engine = _engine(ctx, model_dir, False, params["loras"])
        what = f"Rendering {params['width']}×{params['height']}, {params['frames']} frames"
        ctx.progress(0.1, what)
        path = _video_path(ctx)
        began = time.time()
        result = engine.generate(ctx, prompt=params["prompt"], width=params["width"], height=params["height"],
                                 frames=params["frames"], steps=contract(model_dir)["num_inference_steps"],
                                 seed=params["seed"], output=path, pil_image=pil_image, last_image=last_image,
                                 progress=_steps(ctx, 0.1, 0.9, what), keep=_keeper(path, params))
        print(f"render: {self.id} {params['width']}×{params['height']}, {params['frames']} frames "
              f"in {time.time() - began:.1f} s", flush=True)
        return _outputs(result, path, ctx, params)


class H3ImageToVideo(H3TextToVideo):
    """First image, and optionally last image (FL2VA). FastVideo stretches the
    keyframes to the canvas, so the canvas follows the first image's aspect."""
    id = "h3-i2v"

    def validate(self, params, files):
        out = _common(params, files, {"image", "last_image", "aspect", "width", "height"})
        if "image" not in params:
            raise ValueError("image is required (the first frame)")
        out["image"] = common.image_ref(params["image"], "image", files)
        first = common.image_size(files.resolve(out["image"]))
        if params.get("last_image") is not None:
            out["last_image"] = common.image_ref(params["last_image"], "last_image", files)
            common.image_size(files.resolve(out["last_image"]))
        # <Picture 1> is the first image, <Picture 2> the last one (h3Alignment of 1.4).
        pictures = 2 if "last_image" in out else 1
        if any(n > pictures for n in _cited_pictures(out["prompt"])):
            raise ValueError("The prompt cites <Picture 2> (the last image) but no last_image was sent"
                             if pictures == 1 else "An image-to-video prompt cites <Picture 1> and <Picture 2> only")
        out["width"], out["height"] = _size(params, first)
        return out

    def run(self, params, models, ctx):
        first = _open(ctx, params["image"])
        last = _open(ctx, params["last_image"]) if "last_image" in params else None
        return self._render(models, params, ctx, first, last)


class H3ReferenceToVideo(Pipeline):
    id = "h3-r2v"
    models = [OMNIREF, UPSCALER]

    def validate(self, params, files):
        out = _common(params, files, {"references", "image", "continue_from", "aspect", "preview", "pass1_megapixels"})
        out["references"] = _references(params, files)
        mp = params.get("pass1_megapixels", PASS1_MEGAPIXELS)
        if isinstance(mp, bool) or not isinstance(mp, (int, float)) or not PASS1_RANGE[0] <= mp <= PASS1_RANGE[1]:
            raise ValueError(f"pass1_megapixels must be a number from {PASS1_RANGE[0]} to {PASS1_RANGE[1]}")
        # A start frame is frame 0 of the clip, not a reference: <Picture N> are the references.
        # FastVideo stretches it to the canvas, so the canvas follows it unless an aspect is sent.
        first = None
        if params.get("continue_from") is not None:
            if params.get("image") is not None or "aspect" in params or params.get("preview"):
                raise ValueError("continue_from takes neither a start image, an aspect nor a preview: "
                                 "the clip continues the other one, at its size")
            ref = params["continue_from"]
            if not isinstance(ref, str) or media_kind(ref) != "video":
                raise ValueError("continue_from must be the reference of an H3 clip")
            meta = h3_continue.read_meta(files.resolve(ref))
            if meta is None:
                raise ValueError(f"{ref} kept no latents (rendered before latent continuation, or not by "
                                 "MiniMax H3): render that segment again to continue from it")
            out["continue_from"] = ref
            width, height = meta["width"], meta["height"]
            g = math.gcd(width, height)
            out["aspect"] = "%d:%d" % (width // g, height // g)
            out["pass1_width"], out["pass1_height"] = size_for((width, height), mp)
            out["width"], out["height"], out["preview"] = width, height, False
            self._cited(out)
            return out
        if params.get("image") is not None:
            out["image"] = common.image_ref(params["image"], "image", files)
            first = common.image_size(files.resolve(out["image"]))
        self._cited(out)
        if "aspect" in params or first is None:
            aspect = parse_aspect(params.get("aspect", "16:9"))
        else:
            aspect = first
            if not 1 / 4 <= aspect[0] / aspect[1] <= 4:
                raise ValueError("MiniMax H3 supports aspect ratios from 1:4 to 4:1")
        out["aspect"] = "%d:%d" % aspect
        out["pass1_width"], out["pass1_height"] = size_for(aspect, mp)
        out["width"], out["height"], _ = upscale_target(out["pass1_width"], out["pass1_height"])
        out["preview"] = params.get("preview", False)
        if not isinstance(out["preview"], bool):
            raise ValueError("preview must be true or false")
        if out["preview"]:
            out["width"], out["height"] = out["pass1_width"], out["pass1_height"]
        return out

    @staticmethod
    def _cited(out: dict) -> None:
        for kind, label in REFERENCE_LABELS.items():
            sent = sum(media_kind(r) == kind for r in out["references"])
            wrong = sorted(n for n in _cited_pictures(out["prompt"], label) if not 1 <= n <= sent)
            if wrong:
                raise ValueError(f"The prompt cites <{label} {wrong[0]}> but only {sent} {kind} reference(s) were sent")

    def run(self, params, models, ctx):
        if "continue_from" not in params:
            return self._render(models, params, ctx)
        h3_continue.install()
        tail = h3_continue.load_tail(ctx.files.resolve(params["continue_from"]))
        with h3_continue.tail(tail, params["seed"]):
            return self._render(models, params, ctx)

    def _render(self, models, params, ctx):
        model_dir = models[OMNIREF]
        terms = contract(model_dir)
        # With Gemma loaded next to it (17 GB), a two-pass r2v left 10.9 GiB available on the
        # GB10 and pushed 5.6 GB to swap (promaxgb10-95c7, 2026-11-08, LESSONS #49): Gemma is
        # stopped before each r2v render and starts again on the next LLM request (~27 s cold).
        common.free_llm(self.id)
        start = _open(ctx, params["image"]) if "image" in params else None
        if start is not None:
            from . import h3_start_frame
            h3_start_frame.install()
        engine = _engine(ctx, model_dir, True, params["loras"])
        # FastVideo resizes reference images to a 2048-pixel short edge, which is
        # what ref_image_size=max did in the validated workflow. Clips are decoded
        # once for both passes.
        began = time.time()
        refs = [_reference(ctx.files.resolve(r)) for r in params["references"]]
        w1, h1, preview = params["pass1_width"], params["pass1_height"], params["preview"]
        what = (f"{params['width']}×{params['height']}, {params['frames']} frames, {len(refs)} reference(s)"
                + (", start frame" if start is not None else "")
                + (", continuing a clip" if "continue_from" in params else ""))
        marks = [time.time()]
        path = _video_path(ctx)
        pass1 = f"Pass 1: {w1}×{h1}, {params['frames']} frames"
        ctx.progress(0.1, pass1)
        with engine.overrides(latent_output=not preview):
            first = engine.generate(ctx, prompt=params["prompt"], width=w1, height=h1, frames=params["frames"],
                                    steps=terms["num_inference_steps"], seed=params["seed"], output=path,
                                    save=preview, references=refs, pil_image=start,
                                    progress=_steps(ctx, 0.1, 0.9 if preview else 0.5, pass1))
        marks.append(time.time())
        if preview:
            print(f"render: {self.id} {what}, preview in {marks[-1] - began:.1f} s: "
                  f"references {marks[0] - began:.1f} s, pass 1 {marks[1] - marks[0]:.1f} s", flush=True)
            return _outputs(first, path, ctx, params)

        ctx.progress(0.5, f"Latent upscale to {params['width']}×{params['height']}")
        latents, audio = refine_inputs(first.samples, first.audio, model_dir, models[UPSCALER] / UPSCALER_FILE,
                                       terms, (w1, h1), params["seed"], (params["width"], params["height"]))
        indices = pdd_indices(REFINE_SIGMAS, terms["video_scheduler_shift"], terms["pdd_steps"], terms["grid_max_t"])
        marks.append(time.time())
        ctx.progress(0.6, f"Pass 2: {len(indices) - 1} refine steps at {params['width']}×{params['height']}")
        with engine.overrides(pdd_step_indices=indices):
            second = engine.generate(ctx, prompt=params["prompt"], width=params["width"], height=params["height"],
                                     frames=params["frames"], steps=len(indices) - 1, seed=params["seed"],
                                     output=path, references=refs, pil_image=start, latents=latents, audio_latents=audio,
                                     progress=_steps(ctx, 0.6, 0.9, f"Pass 2 at {params['width']}×{params['height']}"),
                                     keep=_keeper(path, params, params.get("continue_from")))
        marks.append(time.time())
        # Each pass includes FastVideo's text and reference encoding; pass 2 also the VAE
        # decoding and the MP4 (the first pass ends on latents).
        print(f"render: {self.id} {what} in {marks[-1] - began:.1f} s: references {marks[0] - began:.1f} s, "
              f"pass 1 {marks[1] - marks[0]:.1f} s, upscale {marks[2] - marks[1]:.1f} s, "
              f"pass 2 and decoding {marks[3] - marks[2]:.1f} s", flush=True)
        return _outputs(second, path, ctx, params)


def _stats(model_dir: Path, component: str):
    import torch
    cfg = json.loads((model_dir / component / "config.json").read_text())
    return torch.tensor(cfg["latents_mean"]), torch.tensor(cfg["latents_std"])


def refine_inputs(video, audio, model_dir: Path, upscaler_file: Path, terms: dict, pass1_size, seed: int,
                  final: tuple[int, int] | None = None):
    """Latents for the refine pass, from the first pass's (denormalised) output.

    The video latents are normalised (DiT space), enlarged by the latent
    upscaler, then noised to the first refine node. The upscaler works one
    normalisation further: its ComfyUI node normalises its input again, though
    that input is already in DiT space, and denormalises its output once, so the
    same is done here (fed DiT-space latents, it renders pink mush). Noise:
    x = (1 − σ)·latent + σ·ε, as a ComfyUI sampler does at denoise < 1; the
    audio latents are noised the same way at the audio sigma of that node.
    `final` sets the size (a clip continuing another one), else upscale_target does.
    FastVideo multiplies the injected rows by the node's sigma (it expects unit
    noise there), so x/σ is what is injected.
    """
    import torch
    from . import h3_upscaler
    vmean, vstd = _stats(model_dir, "vae")
    amean, astd = _stats(model_dir, "audio_vae")
    view_v = (1, -1, 1, 1, 1)
    vmean, vstd = vmean.view(view_v), vstd.view(view_v)
    video = (video.float() - vmean) / vstd
    width, height, scale = upscale_target(*pass1_size)
    if final is not None:
        width, height, scale = *final, upscale_scale(*pass1_size, final)
    device = common.device()
    model = h3_upscaler.load(upscaler_file, device)
    try:
        with torch.inference_mode():
            video = model(((video - vmean) / vstd).to(device, torch.bfloat16), scale,
                          height // VAE_DOWNSAMPLE, width // VAE_DOWNSAMPLE).float().cpu()
    finally:
        del model
        torch.cuda.empty_cache()
    video = video * vstd + vmean
    view_a = (1, -1, 1)
    audio = (audio.float() - amean.view(view_a)) / astd.view(view_a)

    first = pdd_indices(REFINE_SIGMAS, terms["video_scheduler_shift"], terms["pdd_steps"], terms["grid_max_t"])[0]
    sv = node_sigma(first, terms["video_scheduler_shift"], terms["pdd_steps"], terms["grid_max_t"])
    sa = node_sigma(first, terms["audio_scheduler_shift"], terms["pdd_steps"], terms["grid_max_t"])
    gen = torch.Generator("cpu").manual_seed(seed)
    noise_v = torch.randn(video.shape, generator=gen)
    noise_a = torch.randn(audio.shape, generator=gen)
    return ((1 - sv) * video + sv * noise_v) / sv, ((1 - sa) * audio + sa * noise_a) / sa


class VideoStitch(Pipeline):
    """A Relay take: its clips end to end. A run of clips joined by latent continuation (each one
    rendered with continue_from the clip before it in the list) is put together as latents, each
    continuing clip without its first TAIL_LATENTS latents (they redo the end of the clip before),
    and decoded once by the OmniRef video VAE (h3_continue); any other clip is a cut and is taken
    as its MP4. The sound is each clip's own, cut where its image is, brought to one loudness with
    a 25 ms fade at each join (montage.assemble): one decode of a take's sound faded with the
    take on the GB10, and an audio tail as condition faded it too."""

    id = "video-stitch"
    models = [OMNIREF]

    def validate(self, params, files):
        common.check_keys(params, {"clips"}, "a montage has no prompt.")
        clips = montage.video_refs(params, "clips", files, 2, montage.MAX_CLIPS)
        metas = [h3_continue.read_meta(files.resolve(ref)) for ref in clips]
        linked = h3_continue.links(clips, metas)
        for run in h3_continue.runs(linked):
            if len(run) > 1 and len({(metas[k]["width"], metas[k]["height"]) for k in run}) > 1:
                raise ValueError(f"{clips[run[0]]} and the clips continuing it differ in size")
        return {"clips": clips, "links": linked}

    def run(self, params, models, ctx):
        import shutil
        clips, groups = params["clips"], h3_continue.runs(params["links"])
        paths = [ctx.files.resolve(ref) for ref in clips]
        folder = ctx.output_dir / self.id
        folder.mkdir(parents=True, exist_ok=True)
        stem = montage.output_stem(ctx)
        work = folder / f".{stem}"
        work.mkdir()
        stitched = sum(len(g) for g in groups if len(g) > 1)
        ctx.progress(0.02, f"{len(clips)} clips: {stitched} joined by latent continuation, "
                           f"{len(groups) - 1} cut(s)")
        videos, sounds = [], []
        try:
            for n, group in enumerate(groups):
                if len(group) == 1:
                    videos.append(paths[group[0]])
                    frames = [montage.probe(paths[group[0]])["frames"]]
                else:
                    metas = [h3_continue.read_meta(paths[k]) for k in group]
                    frames = [h3_continue.frames_of(m["latents"]) for m in metas]
                    videos.append(self._decode_run([paths[k] for k in group], metas, work / f"run{n}", ctx, models))
                for j, k in enumerate(group):
                    start = h3_continue.TAIL_FRAMES / FPS if j else 0.0
                    sounds.append((paths[k], start, frames[j] / FPS - start))
            out = folder / f"{stem}.mp4"
            ctx.progress(0.9, "Joining the sound of the clips")
            montage.assemble(videos, sounds, out, True, ctx)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        common.tag_video(out, ctx, params)
        return [out]

    @staticmethod
    def _engine(ctx, models):
        """The resident OmniRef generator, whatever its LoRAs (the VAE is the same), else a new one."""
        for key in list(common.POOL.resident):
            if key[0] == "h3" and key[1].ref2va:
                return common.load(key, None, alone=True)
        return _engine(ctx, models[OMNIREF], True, [])

    def _decode_run(self, paths: list[Path], metas: list[dict], base: Path, ctx, models) -> Path:
        import torch
        from safetensors.torch import load_file
        common.free_llm(self.id)
        engine = self._engine(ctx, models)
        parts = [load_file(str(h3_continue.latents_path(p)))["video"].float() for p in paths]
        count = h3_continue.stitched_latents([int(x.shape[2]) for x in parts])
        latents = torch.cat([parts[0]] + [x[:, :, h3_continue.TAIL_LATENTS:] for x in parts[1:]], dim=2)
        frames = h3_continue.frames_of(count)
        ctx.progress(0.1, f"Decoding {len(paths)} clips at once: {frames} frames at "
                          f"{metas[0]['width']}×{metas[0]['height']}")
        began = time.time()
        buffer = base.with_suffix(".f32")
        try:
            pixels = engine.decode(latents, buffer)
            ctx.check()
            ctx.progress(0.6, f"Encoding {frames} frames")
            video = base.with_suffix(".mp4")
            _encode(pixels, video, ctx)
        finally:
            pixels = None
            buffer.unlink(missing_ok=True)
        print(f"render: {self.id} {len(paths)} clips, {count} latents, {frames} frames decoded once "
              f"in {time.time() - began:.1f} s", flush=True)
        return video


def _encode(pixels, path: Path, ctx, chunk: int = 24) -> None:
    """Float [0, 1] frames (1, 3, F, H, W) to an MP4 at 24 fps, near lossless (the take is encoded
    again when its sound is added), quantised as FastVideo's video decoding stage does."""
    import subprocess
    import torch
    _, _, count, height, width = pixels.shape
    args = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
            "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "12", "-preset", "medium",
            "-pix_fmt", "yuv420p", str(path)]
    with subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        try:
            for t in range(0, count, chunk):
                ctx.check()
                block = pixels[0, :, t:t + chunk].mul(255).clamp_(0, 255).to(torch.uint8)
                proc.stdin.write(block.permute(1, 2, 3, 0).contiguous().numpy().tobytes())
            proc.stdin.close()
            err = proc.stderr.read()
        except BaseException:
            proc.kill()
            raise
    if proc.returncode:
        raise RuntimeError(f"ffmpeg failed: {err.decode(errors='replace')[-400:]}")


register(H3TextToVideo())
register(H3ImageToVideo())
register(H3ReferenceToVideo())
register(VideoStitch())
