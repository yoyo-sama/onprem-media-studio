"""MOSS-Image (OpenMOSS, Apache-2.0): text to image, strongest at legible text in the
image (long titles, accents, Chinese).

Three modes, chosen per render (Lionel's choice on 2026-11-07, after the GB10 bench of
tools/qualify/moss_bench.py; times at 1024² on promaxgb10-95c7):
- "preview": the SFT model with the 4-step turbo LoRA, 4 steps, no guidance. About 11 s;
  on the poster prompt the title came out with a doubled word on 2 seeds of 3.
- "standard" (default): the same LoRA at 8 steps, no guidance. About 19 s; text exact on
  3 seeds of 3, with a pull towards warm sunset light.
- "quality": the SFT model alone, 25 steps, guidance 3 with the model's own negative
  branch (empty prompt, block 22 skipped). About 72 s; text exact, the most faithful light.

diffusers 0.42 has no MOSS pipeline: the official pipeline_moss_image.py is imported from
the downloaded model folder, whose revision the catalog pins (the code that runs is the
code the bench ran). It has no step callback, so progress and cancellation are taken
after each scheduler step.

The turbo LoRA (fp32, rank 128) stays UNMERGED, as fp32 forward hooks added for the
render and removed after it: its deltas are below bf16's rounding step and would vanish
once merged into the bf16 weights (the authors' warning; LESSONS #30 for H3).

The initial noise is drawn on the CPU, as in the bench: a seed gives the image of the
bench sheets. A negative prompt is refused: the quality mode's negative branch is part
of the model's settings, and the turbo modes run without guidance.
"""

import contextlib
import importlib.util
import sys
import time
from pathlib import Path

from . import Pipeline, common, register

SFT, TURBO = "moss-image-sft", "moss-image-turbo-lora"
TURBO_FILE = "moss_image_sft_4step_v2.0.safetensors"
# mode → (steps, guidance, turbo LoRA). Guidance 1 skips the negative branch entirely.
MODES = {"preview": (4, 1.0, True), "standard": (8, 1.0, True), "quality": (25, 3.0, False)}
DEFAULT_MODE = "standard"
UNCOND_SKIP_LAYERS = [22]  # the official negative branch skips block 22
SIZE_MULTIPLE = 16         # the pipeline works on 16-pixel latent cells
NO_NEGATIVE = "MOSS-Image uses its own negative branch in quality mode and none in the other modes."


class MossImage(Pipeline):
    id = "moss-image"
    models = [SFT, TURBO]

    def validate(self, params, files):
        common.check_keys(params, {"prompt", "mode", "width", "height", "count", "seed"}, NO_NEGATIVE)
        mode = params.get("mode", DEFAULT_MODE)
        if mode not in MODES:
            raise ValueError(f"mode must be one of {', '.join(MODES)}")
        return {
            "prompt": common.prompt(params),
            "mode": mode,
            "width": common.integer(params, "width", 1024, 256, 2048, SIZE_MULTIPLE),
            "height": common.integer(params, "height", 1024, 256, 2048, SIZE_MULTIPLE),
            "count": common.integer(params, "count", 1, 1, 4),
            "seed": common.seed(params),
        }

    def run(self, params, models, ctx):
        steps, guidance, turbo = MODES[params["mode"]]
        ctx.progress(0, "Loading MOSS-Image")
        engine = common.load(self.id, lambda: MossRuntime(models[SFT], models[TURBO] / TURBO_FILE),
                             common.disk_size(models[SFT]) + common.disk_size(models[TURBO]))
        callback = common.step_progress(ctx, steps, f"MOSS-Image {params['mode']}")
        began = time.time()
        images = engine.render(params["prompt"], params["width"], params["height"], steps, guidance, turbo,
                               params["count"], params["seed"], callback)
        common.log_render(self.id, f"{params['mode']} {params['width']}×{params['height']} ×{params['count']}",
                          began, callback.marks)
        return common.save_images(images, ctx, params)


class MossRuntime:
    """The resident MOSS pipeline and the turbo LoRA's layers, kept on the GPU in fp32."""

    def __init__(self, sft: Path, turbo_file: Path):
        import torch
        from diffusers import AutoencoderKLFlux2
        from transformers import AutoModel, AutoTokenizer
        moss = _official_module(sft)
        dev = common.device()
        # Read whole, not memory-mapped (LESSONS #42); the VAE in fp32 as in the bench.
        transformer = moss.MOSSImageTransformer.from_pretrained(
            sft / "transformer", torch_dtype=torch.bfloat16, disable_mmap=True).eval()
        text_encoder = AutoModel.from_pretrained(sft / "text_encoder", dtype=torch.bfloat16, disable_mmap=True).eval()
        vae = AutoencoderKLFlux2.from_pretrained(sft / "vae", torch_dtype=torch.float32).eval()
        self.pipe = moss.MOSSImagePipeline(
            transformer, moss.MOSSImageScheduler.from_pretrained(sft, subfolder="scheduler"),
            text_encoder=text_encoder, tokenizer=AutoTokenizer.from_pretrained(sft / "tokenizer"), vae=vae).to(dev)
        self.lora = {name: (down.to(dev, torch.float32), up.to(dev, torch.float32), scale)
                     for name, (down, up, scale) in read_lora(turbo_file, transformer).items()}

    def render(self, prompt, width, height, steps, guidance, turbo, count, seed, callback):
        import torch
        with contextlib.ExitStack() as stack:
            if turbo:
                stack.enter_context(lora_hooks(self.pipe.transformer, self.lora))
            stack.enter_context(step_callback(self.pipe, callback))
            return self.pipe(prompt=prompt, width=width, height=height, num_inference_steps=steps,
                             guidance_scale=guidance, uncond_skip_layers=UNCOND_SKIP_LAYERS if guidance != 1 else [],
                             num_images_per_prompt=count,
                             generator=torch.Generator("cpu").manual_seed(seed)).images


def _official_module(sft: Path):
    name = "pipeline_moss_image"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, sft / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


SUFFIXES = {".lora_down.weight": "down", ".lora_up.weight": "up", ".alpha": "alpha"}
PREFIX = "diffusion_model."


def read_lora(path: Path, transformer) -> dict:
    """Linear layer name → (down, up, alpha / rank) of a kohya LoRA file. A key that matches
    no Linear layer, or a layer without both halves, refuses the whole file."""
    import torch
    from safetensors.torch import load_file
    linears = {n for n, m in transformer.named_modules() if isinstance(m, torch.nn.Linear)}
    parts, unknown = {}, []
    for key, tensor in load_file(str(path)).items():
        suffix = next((s for s in SUFFIXES if key.endswith(s)), None)
        name = key[len(PREFIX):-len(suffix)] if suffix and key.startswith(PREFIX) else None
        if name not in linears:
            unknown.append(key)
            continue
        parts.setdefault(name, {})[SUFFIXES[suffix]] = tensor
    incomplete = [n for n, p in parts.items() if "down" not in p or "up" not in p]
    if unknown or incomplete or not parts:
        raise ValueError(f"{path.name}: {len(unknown)} key(s) match no layer (e.g. {unknown[:3]}), "
                         f"{len(incomplete)} layer(s) lack down or up (e.g. {incomplete[:3]})")
    return {n: (p["down"], p["up"], float(p.get("alpha", p["down"].shape[0])) / p["down"].shape[0])
            for n, p in parts.items()}


@contextlib.contextmanager
def lora_hooks(transformer, lora: dict):
    """y = W x + alpha/rank · up(down(x)), in fp32, on each layer of `lora` while inside."""
    modules = dict(transformer.named_modules())
    handles = []

    def hook_for(down, up, scale):
        return lambda module, args, out: out + (scale * ((args[0].float() @ down.T) @ up.T)).to(out.dtype)
    try:
        for name, (down, up, scale) in lora.items():
            handles.append(modules[name].register_forward_hook(hook_for(down, up, scale)))
        yield
    finally:
        for handle in handles:
            handle.remove()


@contextlib.contextmanager
def step_callback(pipe, callback):
    """Calls callback(pipe, step, timestep, {}) after each scheduler step while inside: the
    official pipeline has no callback_on_step_end. A cancelled job raises from it."""
    scheduler, count = pipe.scheduler, [0]
    step = scheduler.step

    def counted(model_output, timestep, *args, **kwargs):
        out = step(model_output, timestep, *args, **kwargs)
        callback(pipe, count[0], timestep, {})
        count[0] += 1
        return out
    scheduler.step = counted
    try:
        yield
    finally:
        del scheduler.step  # the class's method again


register(MossImage())
