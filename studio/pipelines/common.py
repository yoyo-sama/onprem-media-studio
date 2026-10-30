"""What the image engines share: parameter checks, the pipelines kept in GPU
memory, seeded generators, step progress and PNG output.

torch and diffusers are imported inside functions so that the server and its
unit tests run on a machine without them.
"""

import gc
import json
import math
import random
import time
from pathlib import Path

MAX_SEED = 2**32 - 1
NEGATIVE_KEYS = ("negative", "negative_prompt")


# ── Parameters ───────────────────────────────────────────────────────────────

def check_keys(params: dict, allowed: set[str], negative_reason: str) -> None:
    for key in NEGATIVE_KEYS:
        if key in params:
            raise ValueError(f"{key} is not accepted: {negative_reason} Phrase every constraint "
                             "positively in the prompt.")
    unknown = sorted(set(params) - allowed)
    if unknown:
        raise ValueError(f"Unknown parameter(s): {', '.join(unknown)}")


def prompt(params: dict) -> str:
    text = params.get("prompt")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("prompt is required")
    return text  # verbatim: never stripped, rewritten or completed (LESSONS.md #6)


def integer(params: dict, key: str, default: int, low: int, high: int, multiple: int = 1) -> int:
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{key} must be an integer between {low} and {high}")
    if value % multiple:
        raise ValueError(f"{key} must be a multiple of {multiple}")
    return value


def seed(params: dict) -> int:
    """The seed the job will use; drawn here when absent so the job records it."""
    if params.get("seed") is None:
        return random.randint(0, MAX_SEED)
    return integer(params, "seed", 0, 0, MAX_SEED)


def image_refs(params: dict, key: str, files, low: int, high: int) -> list[str]:
    refs = params.get(key, [])
    if not isinstance(refs, list) or not low <= len(refs) <= high:
        raise ValueError(f"{key} must be a list of {low} to {high} image references")
    for ref in refs:
        files.resolve(ref)
    return refs


def fit_area(width: int, height: int, area: int = 1024 * 1024, multiple: int = 32) -> tuple[int, int]:
    """About `area` pixels at the ratio of width×height, rounded to `multiple` (1.4 formula)."""
    ratio = width / height
    return (max(multiple, round(math.sqrt(area * ratio) / multiple) * multiple),
            max(multiple, round(math.sqrt(area / ratio) / multiple) * multiple))


# ── Runtime ──────────────────────────────────────────────────────────────────

# Pipelines stay resident while memory allows, as ComfyUI keeps its models: Krea 2
# and Qwen Image 2.1 together take about 65 GB next to the LLM, which fits in the
# 128 GB of a GB10, and switching between them would otherwise reload ~30 GB each
# time (about 3 min). The least recently used ones are freed when the next one does
# not fit, typically when an H3 video engine comes in.
_resident: dict[object, object] = {}
RESERVE = 16 * 1024**3  # left free next to the weights for the render's activations


def available_memory(cuda_free: int, cuda_total: int, meminfo: str) -> int:
    """Free GPU memory. On unified memory (GB10: GPU total within 5 % of RAM total), CUDA's
    figure leaves out the reclaimable page cache, so MemAvailable is used instead (LESSONS #33)."""
    fields = {k: int(v.split()[0]) * 1024 for k, v in
              (line.split(":", 1) for line in meminfo.splitlines() if ":" in line)}
    total, available = fields.get("MemTotal"), fields.get("MemAvailable")
    if total and available is not None and abs(cuda_total - total) <= 0.05 * total:
        return available
    return cuda_free


def free_memory() -> int:
    import torch
    free, total = torch.cuda.mem_get_info()
    try:
        return available_memory(free, total, Path("/proc/meminfo").read_text())
    except OSError:  # not Linux
        return free


def disk_size(path: Path) -> int:
    """Bytes of a model directory: what its weights take once loaded, near enough."""
    return sum(f.stat().st_size for f in Path(path).rglob("*") if f.is_file())


def load(key, build, size: int = 0):
    """The resident pipeline for `key`, built on first use. Before building one,
    the least recently used pipelines are freed until `size` bytes (its weights)
    plus RESERVE fit in free memory; when nothing is left to free, it is built
    anyway."""
    if key in _resident:
        _resident[key] = _resident.pop(key)  # now the most recently used
        return _resident[key]
    while _resident and free_memory() < size + RESERVE:
        _free(next(iter(_resident)))
    _resident[key] = build()
    return _resident[key]


def _free(key) -> None:
    # close() when there is one: a FastVideo generator owns resources that dropping
    # a reference does not free.
    old = _resident.pop(key)
    if hasattr(old, "close"):
        old.close()
    del old
    gc.collect()
    try:
        import torch
    except ImportError:
        return
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def device() -> str:
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("No CUDA device: the image engines need a GPU")
    return "cuda"


def generator(seed_: int):
    import torch
    return torch.Generator(device()).manual_seed(seed_)


def step_progress(ctx, steps: int, label: str):
    """diffusers step callback that reports progress; raises if the job was cancelled."""
    def callback(pipe, step, timestep, tensors):
        ctx.progress((step + 1) / steps, f"{label}: step {step + 1}/{steps}")
        return tensors
    return callback


def open_image(path: Path):
    from PIL import Image
    with Image.open(path) as img:
        return img.convert("RGB")


def save_images(images, ctx, params: dict) -> list[Path]:
    """PNG files under outputs/<pipeline>/, with the job's pipeline and parameters
    in a `studio` text chunk (the gallery reads it back for "reuse prompt")."""
    from PIL.PngImagePlugin import PngInfo
    folder = ctx.output_dir / ctx.job.pipeline
    folder.mkdir(parents=True, exist_ok=True)
    meta = PngInfo()
    meta.add_text("studio", json.dumps({"pipeline": ctx.job.pipeline, "params": params}))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    paths = []
    for n, img in enumerate(images, 1):
        path = folder / f"{stamp}-{ctx.job.id}-{n}.png"
        img.save(path, pnginfo=meta)
        paths.append(path)
    return paths
