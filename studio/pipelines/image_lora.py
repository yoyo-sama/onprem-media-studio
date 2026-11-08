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

Before that, `normalized` rewrites three layouts the diffusers loaders miss (seen on community
files, 2026-11-08): kohya names for Krea 2 (lora_unet_blocks_0_attn_wq), alpha keys next to
diffusers-format pairs (diffusers would prefix those files with a second "transformer."), and
Qwen Image 2.1's fused img_mlp.gate_up, which diffusers splits into gate_layer and proj.
"""

import re
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


KOHYA_KREA = re.compile(r"lora_unet_(blocks|txtfusion_layerwise_blocks|txtfusion_refiner_blocks)_(\d+)_(attn|mlp)_(\w+)$")
KOHYA_SUFFIXES = {"lora_down.weight": A, "lora_up.weight": B, "alpha": ".alpha"}


def normalized(sd: dict) -> dict:
    """`sd` (a LoRA file's tensors) with the layouts above rewritten, or `sd` itself when none
    applies, so that a file the engine reads as it is still loads from its path (with its
    metadata)."""
    out = {}
    for key, value in sd.items():
        module, _, suffix = key.partition(".")
        m = KOHYA_KREA.match(module) if suffix in KOHYA_SUFFIXES else None
        if m:  # the Krea 2 reference names, which the engine's own converter maps
            block, idx, kind, sub = m.groups()
            block = block.replace("txtfusion_", "txtfusion.")
            key = f"diffusion_model.{block}.{idx}.{kind}.{sub}{KOHYA_SUFFIXES[suffix]}"
        out[key] = value
    for key in [k for k in out if k.endswith(".alpha") and k[:-6] + A in out]:
        # alpha / rank folded into lora_A, as the loaders do for the formats they convert
        down = out[key[:-6] + A]
        out[key[:-6] + A] = down * (float(out.pop(key)) / down.shape[0])
    for key in [k for k in out if k.endswith(".img_mlp.gate_up" + A) and k[:-len(A)] + B in out]:
        base = key[:-len("gate_up" + A)]
        down, up = out.pop(key), out.pop(base + "gate_up" + B)
        half = up.shape[0] // 2  # gate rows first, as diffusers splits the fused weight
        out.update({base + "gate_layer" + A: down, base + "gate_layer" + B: up[:half],
                    base + "proj" + A: down, base + "proj" + B: up[half:]})
    return sd if out.keys() == sd.keys() and all(out[k] is sd[k] for k in sd) else out


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
        # Every file is checked against the plain layers before any is loaded: once one adapter
        # is in, its layers are PEFT wrappers, no longer Linear, and a stack could not be checked.
        sources = [_check(pipe, f) for f in files]
        for n, (f, sd) in enumerate(zip(files, sources)):
            if sd is None:
                pipe.load_lora_weights(str(f.parent), weight_name=f.name, adapter_name=f"lora{n}",
                                       local_files_only=True)
            else:
                pipe.load_lora_weights(dict(sd), adapter_name=f"lora{n}")
        pipe.studio_loras = key
    if stack:
        pipe.set_adapters([f"lora{n}" for n in range(len(stack))], [item["strength"] for item in stack])


def _check(pipe, path: Path) -> dict | None:
    """Refuse `path` unless every key lands on the transformer; return the rewritten tensors to
    load, or None when the file loads as it is."""
    import torch
    from safetensors.torch import load_file
    raw = load_file(path)
    sd = normalized(raw)
    source = None if sd is raw else sd
    try:
        if source is None:
            converted = type(pipe).lora_state_dict(str(path.parent), weight_name=path.name, local_files_only=True)
        else:
            converted = type(pipe).lora_state_dict(dict(source))
    except (ValueError, KeyError) as exc:
        raise ValueError(f"LoRA {path.name} is in a format this engine does not read: {exc}") from exc
    linears = {n for n, m in pipe.transformer.named_modules() if isinstance(m, torch.nn.Linear)}
    bad = unmatched(converted, linears)
    if bad or not converted:
        raise ValueError(f"LoRA {path.name}: {len(bad)} key(s) match no layer of this engine "
                         f"(e.g. {', '.join(bad[:3])}): is it a LoRA for this model?")
    return source
