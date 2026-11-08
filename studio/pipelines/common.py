"""What the image engines share: parameter checks, the pipelines kept in GPU
memory, seeded generators, step progress and PNG output.

torch and diffusers are imported inside functions so that the server and its
unit tests run on a machine without them.
"""

import gc
import json
import math
import os
import random
import shutil
import subprocess
import time
from pathlib import Path

from ..files import media_kind

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
        if media_kind(ref) != "image":
            raise ValueError(f"{key}: {ref} is not an image")
    return refs


def image_ref(ref, key: str, files) -> str:
    """One image reference: an existing file with an image extension, else ValueError."""
    files.resolve(ref)
    if media_kind(ref) != "image":
        raise ValueError(f"{key}: {ref} is not an image")
    return ref


def image_size(path: Path) -> tuple[int, int]:
    """Width and height of an image file; ValueError when it is not a readable image."""
    from PIL import Image, UnidentifiedImageError
    try:
        with Image.open(path) as img:
            return img.size
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"{path.name} is not a readable image") from exc


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
# not fit. An H3 video engine is loaded alone: its peak (text encoder, references,
# upscaler, VAE decode) goes far past its weights, and with Qwen kept next to it a
# two-pass r2v left 11 GB free on the GB10.
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


# Safetensors read whole instead of memory-mapped, for every model of a pipeline: on the
# GB10, Krea 2 loaded in 82 s instead of 253 s with diffusers' own models read whole, and
# its page cache warm did not help the mapped files (236 s): the cost is the mapping, not
# the disk (4.3 GB/s). diffusers does not pass disable_mmap to transformers models (the
# text encoders: 9 GB for Krea 2, 17 GB for Qwen), so from_pretrained loads those itself.
# device_map on the GPU gained nothing (258 s). tools/qualify/load_speed.sh, 2026-11-05.
def from_pretrained(cls, path: Path, **given):
    """A diffusers pipeline of `cls` from `path`, every safetensors file read whole, in
    bfloat16 on the GPU. `given` components are used as they are (loaded elsewhere)."""
    import torch
    import transformers
    index = json.loads((Path(path) / "model_index.json").read_text())
    parts = dict(given)
    for name, spec in index.items():
        if name in parts:
            continue
        model = getattr(transformers, spec[1], None) if isinstance(spec, list) and spec[0] == "transformers" else None
        if isinstance(model, type) and issubclass(model, transformers.PreTrainedModel):
            parts[name] = model.from_pretrained(Path(path) / name, dtype=torch.bfloat16, disable_mmap=True)
    return cls.from_pretrained(path, torch_dtype=torch.bfloat16, disable_mmap=True, **parts).to(device())


class EnginePool:
    """The engines kept in memory, least recently used first, and the memory policy:
    before building one, the least recently used are freed until its weights plus
    RESERVE fit in free memory, or all of them when it must run alone; when nothing is
    left to free, it is built anyway. `low_memory` holds the hooks that stop the LLM
    (each returns whether it stopped something)."""

    def __init__(self):
        self.resident: dict = {}
        self.low_memory: list = []

    def load(self, key, build, size: int = 0, alone: bool = False):
        """The resident engine for `key`, built on first use."""
        if key in self.resident:
            self.resident[key] = self.resident.pop(key)  # now the most recently used
            return self.resident[key]
        began, freed = time.time(), []
        # Blocks the last render left in torch's cache count as used: given back first, so an
        # engine is not freed for room that was only cached (Qwen was freed for Krea 2 on the
        # GB10 with 55 GB available once the cache was empty).
        _empty_cache()
        while self.resident and (alone or free_memory() < size + RESERVE):
            freed.append(next(iter(self.resident)))
            self.free(freed[-1])
        if alone and self.low_memory and free_memory() < size + RESERVE:
            for hook in self.low_memory:
                hook()
        self.resident[key] = build()
        # One line per load in the container log (`docker logs studio | grep engine:`):
        # a slow job is often a model loaded again.
        print(f"engine: {_name(key)} loaded in {time.time() - began:.1f} s"
              + (f", after freeing {', '.join(map(_name, freed))}" if freed else ""), flush=True)
        return self.resident[key]

    def free_llm(self, reason: str) -> None:
        """Stop the LLM before a render that needs its memory; the next LLM request starts it again."""
        if any([hook() for hook in self.low_memory]):
            print(f"engine: LLM stopped to leave its memory to {reason}", flush=True)

    def free(self, key) -> None:
        # close() when there is one: a FastVideo generator owns resources that dropping
        # a reference does not free.
        old = self.resident.pop(key)
        if hasattr(old, "close"):
            old.close()
        del old
        gc.collect()
        _empty_cache()


POOL = EnginePool()


def load(key, build, size: int = 0, alone: bool = False):
    return POOL.load(key, build, size, alone)


def free_llm(reason: str) -> None:
    POOL.free_llm(reason)


def _name(key) -> str:
    return " ".join(map(str, key)) if isinstance(key, tuple) else str(key)


def _empty_cache() -> None:
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
    """diffusers step callback that reports progress; raises if the job was cancelled.
    It keeps the time each step ended in `callback.marks`, for log_render."""
    marks = []

    def callback(pipe, step, timestep, tensors):
        marks.append(time.time())
        ctx.progress((step + 1) / steps, f"{label}: step {step + 1}/{steps}")
        return tensors
    callback.marks = marks
    return callback


def log_render(key: str, detail: str, began: float, marks: list[float]) -> None:
    """One line per image render in the container log (`grep render:`). The first step
    is counted with the text encoding (no engine compiles its transformer any more)."""
    total = time.time() - began
    if len(marks) < 2:
        print(f"render: {key} {detail} in {total:.1f} s", flush=True)
        return
    step = (marks[-1] - marks[0]) / (len(marks) - 1)
    print(f"render: {key} {detail} in {total:.1f} s: text encoding and first step {marks[0] - began:.1f} s, "
          f"{len(marks) - 1} more steps × {step:.2f} s, decoding {time.time() - marks[-1]:.1f} s", flush=True)


def open_image(path: Path):
    from PIL import Image
    with Image.open(path) as img:
        return img.convert("RGB")


def metadata(ctx, params: dict, role: str | None = None) -> str:
    """What the gallery reads back from an output (search, "reuse prompt", filters)."""
    meta = {"pipeline": ctx.job.pipeline, "origin": ctx.job.origin, "params": params}
    if role:
        meta["role"] = role
    return json.dumps(meta)


def save_images(images, ctx, params: dict, role: str | None = None, stem: str | None = None) -> list[Path]:
    """PNG files under outputs/<pipeline>/, with the job's metadata in a `studio`
    text chunk. `role` marks a technical image (a clip's last frame); `stem`
    names the files after another output (the clip they come from)."""
    from PIL.PngImagePlugin import PngInfo
    folder = ctx.output_dir / ctx.job.pipeline
    folder.mkdir(parents=True, exist_ok=True)
    meta = PngInfo()
    meta.add_text("studio", metadata(ctx, params, role))
    stem = stem or f"{time.strftime('%Y%m%d-%H%M%S')}-{ctx.job.id}"
    paths = []
    for n, img in enumerate(images, 1):
        path = folder / f"{stem}-{n}.png"
        img.save(path, pnginfo=meta)
        paths.append(path)
    return paths


def tag_video(path: Path, ctx, params: dict) -> None:
    """Write the job's metadata into an MP4 as a `studio` tag, remuxed without
    re-encoding, before the job ends; skipped (with a log line) without ffmpeg.
    The temporary file starts with a dot: the gallery never indexes it."""
    if shutil.which("ffmpeg") is None:
        print(f"ffmpeg not found: {path.name} keeps no metadata for the gallery")
        return
    tmp = path.with_name(f".{path.stem}.tagging{path.suffix}")
    done = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-map", "0", "-c", "copy",
                           "-movflags", "use_metadata_tags", "-metadata", f"studio={metadata(ctx, params)}",
                           str(tmp)], capture_output=True, timeout=120)
    if done.returncode:
        tmp.unlink(missing_ok=True)
        print(f"Could not tag {path.name}: {done.stderr.decode(errors='replace')[-300:]}")
        return
    os.replace(tmp, path)
