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

Style LoRAs (loras/moss/, ComfyUI or diffusers files) are applied the same way, each with
its strength, on top of the turbo LoRA in the turbo modes. They are trained on the SFT or
Base model at 50 steps with guidance: how they hold at 4 or 8 turbo steps is for the eye.

The initial noise is drawn on the CPU, as in the bench: a seed gives the image of the
bench sheets. A negative prompt is refused: the quality mode's negative branch is part
of the model's settings, and the turbo modes run without guidance.
"""

import contextlib
import importlib.util
import sys
import time
from pathlib import Path

from .. import loras as lora_files
from . import Pipeline, common, image_lora, register

SFT, TURBO = "moss-image-sft", "moss-image-turbo-lora"
TURBO_FILE = "moss_image_sft_4step_v2.0.safetensors"
# mode → (steps, guidance, turbo LoRA). Guidance 1 skips the negative branch entirely.
MODES = {"preview": (4, 1.0, True), "standard": (8, 1.0, True), "quality": (25, 3.0, False)}
DEFAULT_MODE = "standard"
UNCOND_SKIP_LAYERS = [22]  # the official negative branch skips block 22
SIZE_MULTIPLE = 16         # the pipeline works on 16-pixel latent cells
LORA_FOLDER = "moss"
NO_NEGATIVE = "MOSS-Image uses its own negative branch in quality mode and none in the other modes."


class MossImage(Pipeline):
    id = "moss-image"
    models = [SFT, TURBO]

    def validate(self, params, files):
        common.check_keys(params, {"prompt", "mode", "width", "height", "count", "seed", "loras"}, NO_NEGATIVE)
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
            "loras": lora_files.check_stack(params.get("loras", []), files.loras_dir, LORA_FOLDER),
        }

    def run(self, params, models, ctx):
        steps, guidance, turbo = MODES[params["mode"]]
        ctx.progress(0, "Loading MOSS-Image")
        engine = common.load(self.id, lambda: MossRuntime(models[SFT], models[TURBO] / TURBO_FILE),
                             common.disk_size(models[SFT]) + common.disk_size(models[TURBO]))
        engine.use_loras(params["loras"], ctx.files.loras_dir / LORA_FOLDER)
        callback = common.step_progress(ctx, steps, f"MOSS-Image {params['mode']}")
        began = time.time()
        images = engine.render(params["prompt"], params["width"], params["height"], steps, guidance, turbo,
                               params["count"], params["seed"], callback)
        common.log_render(self.id, f"{params['mode']} {params['width']}×{params['height']} ×{params['count']}"
                          + image_lora.label(params["loras"]), began, callback.marks)
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
        # The style LoRAs of the last render, on the GPU, and their strengths.
        self.styles, self.style_key, self.strengths = [], [], []

    def use_loras(self, stack: list[dict], folder: Path) -> None:
        """Read the job's style LoRAs (again only when the files changed) with their strengths."""
        import torch
        files = [folder / item["name"] for item in stack]
        key = [(f.name, f.stat().st_size, f.stat().st_mtime_ns) for f in files]
        if key != self.style_key:
            self.styles, self.style_key = [], []  # a refused file leaves none
            dev = common.device()
            self.styles = [{name: (down.to(dev, torch.float32), up.to(dev, torch.float32), scale)
                            for name, (down, up, scale) in read_lora(f, self.pipe.transformer).items()}
                           for f in files]
            self.style_key = key
        self.strengths = [item["strength"] for item in stack]

    def render(self, prompt, width, height, steps, guidance, turbo, count, seed, callback):
        import torch
        with contextlib.ExitStack() as stack:
            if turbo:
                stack.enter_context(lora_hooks(self.pipe.transformer, self.lora))
            for layers, strength in zip(self.styles, self.strengths):
                stack.enter_context(lora_hooks(self.pipe.transformer, layers, strength))
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


SUFFIXES = {".lora_down.weight": "down", ".lora_up.weight": "up", ".lora_A.weight": "down",
            ".lora_B.weight": "up", ".alpha": "alpha"}
# ComfyUI and kohya files name the layers under diffusion_model., diffusers files under transformer.
PREFIXES = ("diffusion_model.", "transformer.")


def read_lora(path: Path, transformer) -> dict:
    """Linear layer name → (down, up, alpha / rank) of a LoRA file (kohya, ComfyUI or diffusers
    keys). Without an .alpha key, the alpha of the file's diffusers metadata, else the rank.
    A fused proj.qkv (block attention trained as one projection) is split onto proj.q/k/v.
    A key that matches no Linear layer, or a layer without both halves, refuses the whole file."""
    import torch
    from safetensors.torch import load_file
    linears = {n for n, m in transformer.named_modules() if isinstance(m, torch.nn.Linear)}
    default_alpha = _metadata_alpha(path)
    parts, unknown, fused = {}, [], {}
    for key, tensor in load_file(str(path)).items():
        suffix = next((s for s in SUFFIXES if key.endswith(s)), None)
        prefix = next((p for p in PREFIXES if key.startswith(p)), None)
        name = key[len(prefix):-len(suffix)] if suffix and prefix else None
        if name not in linears and name and name.endswith(".qkv") and \
                all(name[:-3] + x in linears for x in "qkv"):
            fused.setdefault(name, {})[SUFFIXES[suffix]] = tensor
            continue
        if name not in linears:
            unknown.append(key)
            continue
        parts.setdefault(name, {})[SUFFIXES[suffix]] = tensor
    for name, p in fused.items():
        # A fused attention projection (ai-toolkit): one down for q, k and v, the up rows in
        # q, k, v order, as the model's own fused qkv (text blocks) chunks them.
        ups = p["up"].chunk(3, 0) if "up" in p else [None] * 3
        for part, up in zip("qkv", ups):
            parts[name[:-3] + part] = {k: v for k, v in {**p, "up": up}.items() if v is not None}
    incomplete = [n for n, p in parts.items() if "down" not in p or "up" not in p]
    if unknown or incomplete or not parts:
        raise ValueError(f"{path.name}: {len(unknown)} key(s) match no layer (e.g. {unknown[:3]}), "
                         f"{len(incomplete)} layer(s) lack down or up (e.g. {incomplete[:3]})")
    return {n: (p["down"], p["up"], float(p.get("alpha", default_alpha or p["down"].shape[0])) / p["down"].shape[0])
            for n, p in parts.items()}


def _metadata_alpha(path: Path) -> float | None:
    """lora_alpha of the LoraConfig diffusers writes into a LoRA file's metadata, if any. A
    per-layer rank or alpha pattern refuses the file: one alpha would not be the right one."""
    import json

    from safetensors import safe_open
    with safe_open(str(path), framework="pt") as f:
        raw = (f.metadata() or {}).get("lora_adapter_metadata")
    if not raw:
        return None
    # A pipeline's save_lora_weights prefixes the keys with the component ("transformer.r").
    config = {k.removeprefix("transformer."): v for k, v in json.loads(raw).items()}
    if config.get("rank_pattern") or config.get("alpha_pattern"):
        raise ValueError(f"{path.name}: per-layer rank or alpha patterns are not supported")
    return config.get("lora_alpha")


@contextlib.contextmanager
def lora_hooks(transformer, lora: dict, strength: float = 1.0):
    """y = W x + strength · alpha/rank · up(down(x)), in fp32, on each layer of `lora` while inside.
    Hooks on one layer add up: a stack is the sum of its LoRAs."""
    modules = dict(transformer.named_modules())
    handles = []

    def hook_for(down, up, scale):
        return lambda module, args, out: out + (scale * ((args[0].float() @ down.T) @ up.T)).to(out.dtype)
    try:
        for name, (down, up, scale) in lora.items():
            handles.append(modules[name].register_forward_hook(hook_for(down, up, scale * strength)))
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
