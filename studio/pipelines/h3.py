"""MiniMax H3 video with synchronized audio, through FastVideo (FastH3).

Three engines:
- `h3-t2v`: text to video (FastH3 V2, 8 transformer forwards);
- `h3-i2v`: first image to video, or first and last images (FL2VA) when
  `last_image` is given (same checkpoint and FastVideo pipeline: the keyframes
  become conditioning rows);
- `h3-r2v`: reference images to video (FastH3 OmniRef), the two passes of the
  workflow validated on the GB10 in ComfyUI: 8 steps at about 0.3 MP, latent
  upscale to about 0.9 MP, then 3 refine steps at denoise 0.4. `preview` stops
  after the first pass.

Rules carried over from 1.4 (LESSONS.md § 6):
- the prompt arrives already compiled in the H3 grammar (`web/js/h3.js`) and
  is sent verbatim; the 7,000-character cap is enforced, never by trimming;
- frame counts follow the 17n+5 grid: a 5 s request renders 124 frames;
- `<Picture N>` numbers the references in the order they are sent;
- no guidance (cfg 1), so a negative prompt is refused.

FastVideo constrains H3 to clips of 5 to 15 seconds (1.4 allowed shorter
cuts): a shorter duration is refused with a clear message.

Every clip is written as an MP4 with its audio, plus the last frame as a
lossless PNG, which a Relay segment uses as the first image of the next one.
"""

import json
import math
import re
import time
import traceback
from pathlib import Path

from ..config import Settings
from . import Pipeline, common, h3_lora, register

FPS = 24
MIN_SECONDS, MAX_SECONDS = 5, 15
PROMPT_CHARS = 7000           # H3_PROMPT_CHARS of 1.4
MAX_REFERENCES = 9            # 1.4: two sheets + seven references
MAX_PIXELS = 768 * 1344       # FastVideo's MiniMax H3 canvas limit
MULTIPLE = 32
FINAL_MEGAPIXELS = 0.9        # size of every final clip (validated Ref2VA workflow)
PASS1_MEGAPIXELS = 0.3        # first Ref2VA pass
VAE_DOWNSAMPLE = 16
NO_NEGATIVE = "MiniMax H3 runs without guidance (cfg 1), so a negative prompt is never used."

V2 = {"nvfp4": "fasth3-v2-nvfp4", "fp8": "fasth3-v2-fp8"}
OMNIREF = {"nvfp4": "fasth3-omniref-nvfp4", "fp8": "fasth3-omniref-fp8"}
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
    out["loras"] = h3_lora.check(params.get("loras", []), Settings().loras_dir / "h3")
    out["seed"] = common.seed(params)
    return out


def _cited_pictures(prompt: str) -> set[int]:
    return {int(n) for n in re.findall(r"<Picture (\d+)>", prompt)}


# ── Precision and fallback ───────────────────────────────────────────────────

# Process-wide: after an NVFP4 failure in "auto" mode, H3 stays on FP8 until
# restart; after an NVFP4 success, a later failure is reported, not retried.
_precision = {"fallback": False, "proven": False}


def precision(settings: Settings) -> str:
    if settings.h3_precision == "auto":
        return "fp8" if _precision["fallback"] else "nvfp4"
    return settings.h3_precision


def _with_fallback(ctx, render, ids: dict[str, str], extra: list[str]):
    """render(precision, model paths). In auto mode, a first NVFP4 failure
    (kernels or packed weights not working on this GPU) retries once on FP8."""
    settings = ctx.models.settings
    chosen = precision(settings)
    paths = ctx.models.ensure([ids[chosen], *extra], ctx.progress, ctx.cancelled)
    try:
        result = render(chosen, paths)
    except ValueError:
        raise  # a bad input (a LoRA, an image) fails the same way in FP8
    except Exception as exc:
        ctx.check()
        if settings.h3_precision != "auto" or chosen != "nvfp4" or _precision["proven"]:
            raise
        traceback.print_exc()
        _precision["fallback"] = True
        ctx.progress(0, f"NVFP4 failed ({exc}); falling back to FP8 for this session")
        paths = ctx.models.ensure([ids["fp8"], *extra], ctx.progress, ctx.cancelled)
        return render("fp8", paths)
    if chosen == "nvfp4":
        _precision["proven"] = True
    return result


def _engine(ctx, model_dir: Path, ref2va: bool, prec: str, loras: list[dict]):
    from .h3_runtime import Engine, EngineSpec
    settings = ctx.models.settings
    lora = h3_lora.build(loras, settings.loras_dir / "h3", settings.data_dir / "cache" / "h3-loras")
    spec = EngineSpec(model_dir=model_dir, ref2va=ref2va, precision=prec, lora=lora)
    label = "FastH3 OmniRef" if ref2va else "FastH3"
    ctx.progress(0, f"Loading MiniMax H3 ({label}, {prec.upper()})")
    return common.load(("h3", spec), lambda: Engine(spec))


# ── Outputs ──────────────────────────────────────────────────────────────────

def _video_path(ctx) -> Path:
    folder = ctx.output_dir / ctx.job.pipeline
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{time.strftime('%Y%m%d-%H%M%S')}-{ctx.job.id}.mp4"


def _outputs(result, path: Path, ctx, params: dict) -> list[Path]:
    """The MP4 FastVideo wrote, tagged with the job's metadata, and the clip's
    last frame as a PNG named after it (hidden from the gallery's default view)."""
    from PIL import Image
    video = Path(result.video_path) if result.video_path else path
    if not video.is_file():
        raise RuntimeError("FastVideo reported success but wrote no video (LESSONS.md #1)")
    if not result.frames:
        raise RuntimeError("FastVideo returned no frames")
    common.tag_video(video, ctx, params)
    last = common.save_images([Image.fromarray(result.frames[-1])], ctx, params, role="last-frame", stem=video.stem)
    return [video, *last]


def _reference(path: Path):
    from fastvideo.pipelines.basic.minimax_h3 import MiniMaxH3Reference
    return MiniMaxH3Reference(source=str(path), media_type="image")


def _open(ctx, ref: str):
    return common.open_image(ctx.files.resolve(ref))


# ── Engines ──────────────────────────────────────────────────────────────────

class H3Pipeline(Pipeline):
    ids: dict[str, str] = V2
    extra: list[str] = []

    def needs(self, settings):
        return [self.ids[precision(settings)], *self.extra]


class H3TextToVideo(H3Pipeline):
    id = "h3-t2v"
    models = [V2["nvfp4"]]

    def validate(self, params, files):
        out = _common(params, files, {"aspect", "width", "height"})
        out["width"], out["height"] = _size(params, (16, 9))
        return out

    def run(self, params, models, ctx):
        return _with_fallback(ctx, lambda prec, paths: self._render(prec, paths, params, ctx), self.ids, [])

    def _render(self, prec, paths, params, ctx, pil_image=None, last_image=None):
        model_dir = paths[self.ids[prec]]
        engine = _engine(ctx, model_dir, False, prec, params["loras"])
        ctx.progress(0.1, f"Rendering {params['width']}×{params['height']}, {params['frames']} frames")
        path = _video_path(ctx)
        result = engine.generate(ctx, prompt=params["prompt"], width=params["width"], height=params["height"],
                                 frames=params["frames"], steps=contract(model_dir)["num_inference_steps"],
                                 seed=params["seed"], output=path, pil_image=pil_image, last_image=last_image)
        return _outputs(result, path, ctx, params)


class H3ImageToVideo(H3TextToVideo):
    """First image, and optionally last image (FL2VA). FastVideo stretches the
    keyframes to the canvas, so the canvas follows the first image's aspect."""
    id = "h3-i2v"

    def validate(self, params, files):
        out = _common(params, files, {"image", "last_image", "aspect", "width", "height"})
        from PIL import Image
        if "image" not in params:
            raise ValueError("image is required (the first frame)")
        with Image.open(files.resolve(params["image"])) as img:
            first = img.size
        out["image"] = params["image"]
        if params.get("last_image") is not None:
            files.resolve(params["last_image"])
            out["last_image"] = params["last_image"]
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
        return _with_fallback(ctx, lambda prec, paths: self._render(prec, paths, params, ctx, first, last),
                              self.ids, [])


class H3ReferenceToVideo(H3Pipeline):
    id = "h3-r2v"
    ids = OMNIREF
    extra = [UPSCALER]
    models = [OMNIREF["nvfp4"], UPSCALER]

    def validate(self, params, files):
        out = _common(params, files, {"references", "aspect", "preview"})
        out["references"] = common.image_refs(params, "references", files, 1, MAX_REFERENCES)
        wrong = sorted(n for n in _cited_pictures(out["prompt"]) if not 1 <= n <= len(out["references"]))
        if wrong:
            raise ValueError(f"The prompt cites <Picture {wrong[0]}> but only {len(out['references'])} "
                             "reference image(s) were sent")
        aspect = parse_aspect(params.get("aspect", "16:9"))
        out["aspect"] = "%d:%d" % aspect
        out["pass1_width"], out["pass1_height"] = size_for(aspect, PASS1_MEGAPIXELS)
        out["width"], out["height"], _ = upscale_target(out["pass1_width"], out["pass1_height"])
        out["preview"] = params.get("preview", False)
        if not isinstance(out["preview"], bool):
            raise ValueError("preview must be true or false")
        if out["preview"]:
            out["width"], out["height"] = out["pass1_width"], out["pass1_height"]
        return out

    def run(self, params, models, ctx):
        return _with_fallback(ctx, lambda prec, paths: self._render(prec, paths, params, ctx),
                              self.ids, self.extra)

    def _render(self, prec, paths, params, ctx):
        model_dir = paths[self.ids[prec]]
        terms = contract(model_dir)
        engine = _engine(ctx, model_dir, True, prec, params["loras"])
        # FastVideo resizes reference images to a 2048-pixel short edge, which is
        # what ref_image_size=max did in the validated workflow.
        refs = [_reference(ctx.files.resolve(r)) for r in params["references"]]
        w1, h1, preview = params["pass1_width"], params["pass1_height"], params["preview"]
        path = _video_path(ctx)
        ctx.progress(0.1, f"Pass 1: {w1}×{h1}, {params['frames']} frames")
        with engine.overrides(latent_output=not preview):
            first = engine.generate(ctx, prompt=params["prompt"], width=w1, height=h1, frames=params["frames"],
                                    steps=terms["num_inference_steps"], seed=params["seed"], output=path,
                                    save=preview, references=refs)
        if preview:
            return _outputs(first, path, ctx, params)

        ctx.progress(0.5, f"Latent upscale to {params['width']}×{params['height']}")
        latents, audio = refine_inputs(first.samples, first.audio, model_dir, paths[UPSCALER] / UPSCALER_FILE,
                                       terms, (w1, h1), params["seed"])
        indices = pdd_indices(REFINE_SIGMAS, terms["video_scheduler_shift"], terms["pdd_steps"], terms["grid_max_t"])
        ctx.progress(0.6, f"Pass 2: {len(indices) - 1} refine steps at {params['width']}×{params['height']}")
        with engine.overrides(pdd_step_indices=indices):
            second = engine.generate(ctx, prompt=params["prompt"], width=params["width"], height=params["height"],
                                     frames=params["frames"], steps=len(indices) - 1, seed=params["seed"],
                                     output=path, references=refs, latents=latents, audio_latents=audio)
        return _outputs(second, path, ctx, params)


def _stats(model_dir: Path, component: str):
    import torch
    cfg = json.loads((model_dir / component / "config.json").read_text())
    return torch.tensor(cfg["latents_mean"]), torch.tensor(cfg["latents_std"])


def refine_inputs(video, audio, model_dir: Path, upscaler_file: Path, terms: dict, pass1_size, seed: int):
    """Latents for the refine pass, from the first pass's (denormalised) output.

    The video latents are normalised (DiT space), enlarged by the latent
    upscaler, then noised to the first refine node. The upscaler works one
    normalisation further: its ComfyUI node normalises its input again, though
    that input is already in DiT space, and denormalises its output once, so the
    same is done here (fed DiT-space latents, it renders pink mush). Noise:
    x = (1 − σ)·latent + σ·ε, as a ComfyUI sampler does at denoise < 1; the
    audio latents are noised the same way at the audio sigma of that node.
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


register(H3TextToVideo())
register(H3ImageToVideo())
register(H3ReferenceToVideo())
