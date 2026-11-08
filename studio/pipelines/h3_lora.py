"""H3 LoRA stack: several community LoRAs, each with its strength, folded into
one adapter file that FastVideo loads as a single side branch.

FastVideo holds one adapter per layer of a packed (NVFP4) transformer, so
a stack is merged here. The merge is exact: concatenating the low-rank factors
of n adapters along their rank gives a rank-(r1+…+rn) adapter whose product is
the sum of the n products. Each adapter's strength and alpha/rank are folded
into its B factor, and the merged file is loaded at strength 1.

The adapter always runs as a side branch next to the quantized weights
(FASTVIDEO_LORA_SIDE_BRANCH=1), never merged into them and re-quantized:
merging a LoRA into a quantized checkpoint destroys most of it (LESSONS.md #30).

Files come from STUDIO_DATA_DIR/loras/h3/ and are referenced by file name; the
stack is validated by studio.loras.check_stack.
"""

import hashlib
import json
from pathlib import Path

SUFFIX_A, SUFFIX_B, SUFFIX_ALPHA = ".lora_A.weight", ".lora_B.weight", ".alpha"


def fold(adapters: list[tuple[dict, float]]) -> dict:
    """Merge native-layout adapters (FastVideo keys) with their strengths into one."""
    import torch
    parts: dict[str, list] = {}
    for tensors, strength in adapters:
        for key in tensors:
            if not key.endswith(SUFFIX_A):
                continue
            module = key[:-len(SUFFIX_A)]
            a, b = tensors[key], tensors[module + SUFFIX_B]
            alpha = tensors.get(module + SUFFIX_ALPHA)
            scale = strength * (float(alpha) / a.shape[0] if alpha is not None else 1.0)
            parts.setdefault(module, []).append((a, b, scale))
    out = {}
    for module, items in parts.items():
        dtype = items[0][0].dtype
        out[module + SUFFIX_A] = torch.cat([a.float() for a, _, _ in items], dim=0).to(dtype).contiguous()
        out[module + SUFFIX_B] = torch.cat([b.float() * s for _, b, s in items], dim=1).to(dtype).contiguous()
    return out


def _convert(path: Path) -> dict:
    from fastvideo.models.loader.h3_community_lora import convert_h3_community_lora
    from safetensors.torch import load_file
    conversion = convert_h3_community_lora(load_file(str(path)))
    # Never drop part of an adapter silently: the render would no longer be the
    # one the user asked for.
    if conversion.dense_keys:
        raise ValueError(f"LoRA {path.name} holds full-weight patches ({len(conversion.dense_keys)} keys), "
                         "which the H3 LoRA stack does not apply")
    if conversion.unrecognized or not conversion.tensors:
        examples = ", ".join(conversion.unrecognized[:3])
        raise ValueError(f"LoRA {path.name} has keys that match no MiniMax H3 layer ({examples}): "
                         "is it an H3 LoRA?")
    return conversion.tensors


def build(loras: list[dict], folder: Path, cache: Path) -> Path | None:
    """The merged adapter file for a stack (built once, then reused), or None."""
    if not loras:
        return None
    files = [folder / item["name"] for item in loras]
    key = json.dumps([[f.name, f.stat().st_size, f.stat().st_mtime_ns, item["strength"]]
                      for f, item in zip(files, loras)])
    target = cache / (hashlib.sha256(key.encode()).hexdigest()[:16] + ".safetensors")
    if not target.is_file():
        from safetensors.torch import save_file
        cache.mkdir(parents=True, exist_ok=True)
        merged = fold([(_convert(f), item["strength"]) for f, item in zip(files, loras)])
        tmp = target.with_suffix(".tmp")
        save_file(merged, str(tmp))
        tmp.replace(target)
    return target
