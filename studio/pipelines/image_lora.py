"""Style LoRAs on the diffusers image engines, Krea 2 and Qwen Image 2.1 (MOSS-Image, which
runs its own pipeline code, applies them as hooks: see moss.py).

A job's stack (studio/loras.py check_stack) is loaded as PEFT adapters on the resident
pipeline and weighted per render with set_adapters, unmerged: each adapter is a side branch
next to the bf16 weights, never folded into them (a LoRA's deltas are mostly below bf16's
rounding step, LESSONS #30). The adapters stay loaded while the next render asks for the
same files; an empty stack unloads them, so a render without LoRA runs the engine exactly
as it was qualified.

Files come from STUDIO_DATA_DIR/loras/<folder>/. Community formats (ComfyUI, kohya,
AI-Toolkit, diffusers) are converted by the engine's own diffusers loader. A file is
refused whole when any of its keys would not land on a layer of the transformer: diffusers
only warns about such keys and renders without them, which would not be the render the
user asked for.
"""

from pathlib import Path

from ..loras import describe

A, B = ".lora_A.weight", ".lora_B.weight"
PREFIX = "transformer."


def unmatched(keys, linears: set[str]) -> list[str]:
    """Keys of a converted (diffusers-format) LoRA that would not be applied: anything but a
    lora_A/lora_B pair on a Linear layer of the transformer."""
    pairs: dict[str, set] = {}
    bad = []
    for key in keys:
        suffix = A if key.endswith(A) else B if key.endswith(B) else None
        module = key[len(PREFIX):-len(suffix)] if suffix and key.startswith(PREFIX) else None
        if module not in linears:
            bad.append(key)
        else:
            pairs.setdefault(module, set()).add(suffix)
    return bad + [m + " (one half missing)" for m, halves in pairs.items() if len(halves) != 2]


def label(stack: list[dict]) -> str:
    """The stack for a render log line: ", LoRA a.safetensors ×0.8" or nothing."""
    return f", LoRA {describe(stack)}" if stack else ""


def apply(pipe, stack: list[dict], folder: Path) -> None:
    """Make `stack` the active LoRAs of `pipe` (a resident Krea2Pipeline or QwenImage21Pipeline)."""
    files = [folder / item["name"] for item in stack]
    key = [(f.name, f.stat().st_size, f.stat().st_mtime_ns) for f in files]
    if getattr(pipe, "studio_loras", []) != key:
        pipe.studio_loras = None  # until every file is loaded: a refused file leaves no half stack
        if getattr(pipe.transformer, "peft_config", None):
            pipe.unload_lora_weights()  # the original layers back, not adapters left disabled
        for n, f in enumerate(files):
            _check(pipe, f)
            pipe.load_lora_weights(str(f.parent), weight_name=f.name, adapter_name=f"lora{n}",
                                   local_files_only=True)
        pipe.studio_loras = key
    if stack:
        pipe.set_adapters([f"lora{n}" for n in range(len(stack))], [item["strength"] for item in stack])


def _check(pipe, path: Path) -> None:
    import torch
    try:
        converted = type(pipe).lora_state_dict(str(path.parent), weight_name=path.name, local_files_only=True)
    except (ValueError, KeyError) as exc:
        raise ValueError(f"LoRA {path.name} is in a format this engine does not read: {exc}") from exc
    linears = {n for n, m in pipe.transformer.named_modules() if isinstance(m, torch.nn.Linear)}
    bad = unmatched(converted, linears)
    if bad or not converted:
        raise ValueError(f"LoRA {path.name}: {len(bad)} key(s) match no layer of this engine "
                         f"(e.g. {', '.join(bad[:3])}): is it a LoRA for this model?")
