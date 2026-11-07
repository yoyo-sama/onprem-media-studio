"""MOSS-Image bench, inside the container: is it worth a qualification as an image engine?

    docker exec -i studio python - < tools/qualify/moss_bench.py               # every case
    docker exec -i studio python - --cases sft-turbo4 < tools/qualify/moss_bench.py
    docker exec -i studio python - --download-only < tools/qualify/moss_bench.py
    docker exec -i studio python - --cases sft-turbo4,sft-turbo4-destripe --seeds 42,7,1234 \
        --prompts poster-en,menu-fr,layout --out moss-seeds < tools/qualify/moss_bench.py

MOSS-Image is not in the catalog (not qualified). This script downloads its weights to
data/bench/moss-weights/ (about 41 GB, public repositories, Apache-2.0), never to
data/models/, and renders the same prompts and seed with each case below. Images and one
comparison sheet per prompt land in data/output/bench/moss/ (they show in the gallery);
timings in data/output/bench/moss/results.json and on stdout. A case is only judged by
looking at its images: a render that ends proves nothing (LESSONS #1).

The official pipeline code (pipeline_moss_image.py, Apache-2.0) is imported from the
downloaded snapshot. LoRAs are applied UNMERGED, in fp32, as forward hooks: the turbo
deltas are below bf16's rounding step and vanish once merged (the authors' warning; same
lesson as the H3 LoRAs, LESSONS #30). A LoRA key that matches no layer stops that case,
never silently dropped.
"""
import argparse
import gc
import importlib.util
import json
import os
import shutil
import sys
import time
from pathlib import Path

import torch

SFT = "OpenMOSS-Team/MOSS-Image-SFT"
KROMOSS = "lodestones/Kromoss"
FILES = {  # repository → files or patterns to download
    SFT: ["model_index.json", "pipeline_moss_image.py", "scheduler/*", "text_encoder/*",
          "tokenizer/*", "transformer/*", "vae/*"],
    KROMOSS: ["transformer/*", "8-steps-dmd2-lora.safetensors"],
    "akhaliq/MOSS-Image-SFT-4-steps": ["moss_image_sft_4step_v2.0.safetensors"],
    "lodestones/MOSS-Image-SFT-8-steps-dmd": ["lora_latest.safetensors"],
    "nynxz/MOSS-Image": ["loras/moss_sft_destripe_top64_bf16.safetensors"],
}
TURBO4 = ("akhaliq/MOSS-Image-SFT-4-steps", "moss_image_sft_4step_v2.0.safetensors", 1.0)
DMD8 = ("lodestones/MOSS-Image-SFT-8-steps-dmd", "lora_latest.safetensors", 0.7)
DMD2 = (KROMOSS, "8-steps-dmd2-lora.safetensors", 1.0)
DESTRIPE = ("nynxz/MOSS-Image", "loras/moss_sft_destripe_top64_bf16.safetensors", 1.5)  # 1.5 at 1024 px

# Each case: transformer, LoRAs, steps, guidance (3 = official CFG with the negative
# branch skipping block 22, 1 = no negative branch), size, prompts (None = all).
CASES = {
    "sft-50": dict(model=SFT, loras=[], steps=50, cfg=3.0),             # the official settings
    "sft-25": dict(model=SFT, loras=[], steps=25, cfg=3.0),
    "sft-25-destripe": dict(model=SFT, loras=[DESTRIPE], steps=25, cfg=3.0),
    "sft-turbo4": dict(model=SFT, loras=[TURBO4], steps=4, cfg=1.0),
    "sft-turbo4-destripe": dict(model=SFT, loras=[TURBO4, DESTRIPE], steps=4, cfg=1.0),
    "sft-dmd8": dict(model=SFT, loras=[DMD8], steps=8, cfg=1.0),
    "sft-turbo8-1920": dict(model=SFT, loras=[TURBO4], steps=8, cfg=1.0, size=(1920, 1088),
                            prompts=["poster-en", "portrait"]),  # sheet size; 6-8 steps above 1024²
    "kromoss-dmd2-8": dict(model=KROMOSS, loras=[DMD2], steps=8, cfg=1.0),
}

LAYOUT = {  # the official layout example (USERGUIDE.md), for a 1024×1024 canvas
    "summary": {"meta": ["poster"], "canvas": "single",
                "caption": "A minimalist travel poster with a cream background, a blue mountain "
                           "illustration, and the title EXPLORE at the top."},
    "items": [
        {"label": "text", "caption": "Large dark-blue uppercase title centered at the top.",
         "text": "EXPLORE", "bbox": [-416, -384, -288, 384]},
        {"label": "object", "caption": "A flat blue mountain illustration in the lower center.",
         "bbox": [-192, -288, 384, 288]}],
    "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
PROMPTS = {
    "poster-en": 'A cinematic movie poster of a lone lighthouse on a cliff during a storm at dusk, '
                 'waves crashing below. At the top, large bold white serif title "THE LAST LIGHT". '
                 'At the bottom, smaller text "IN CINEMAS 12 DECEMBER".',
    "menu-fr": 'A café chalkboard on an easel in a Paris street, written in white chalk: '
               '"Menu du jour\nCrêpe complète — 9,50 €\nCafé crème — 3,20 €\nTarte aux pommes — 4,80 €". '
               'Morning light, shallow depth of field.',
    "portrait": "Studio portrait of a woman in her forties with short silver hair and a navy turtleneck, "
                "soft key light, plain smooth light-grey seamless backdrop, 85 mm photograph.",
    "sky": "A wide calm sea at sunset, a smooth gradient sky from orange to deep blue, "
           "a tiny sailboat on the horizon, minimal composition.",
    "layout": json.dumps(LAYOUT, ensure_ascii=False),
}
SEED = 42
SIZE = (1024, 1024)


def device():
    return "cuda" if torch.cuda.is_available() else "cpu"


def sync():
    if torch.cuda.is_available():
        torch.cuda.synchronize()


def download(weights: Path, local: Path | None) -> dict:
    """repository → local snapshot folder (and the commit, for the record)."""
    if local:  # tests: one folder per repository name
        return {repo: (local / repo.split("/")[1], "local") for repo in FILES}
    from huggingface_hub import snapshot_download
    snaps = {}
    for repo, patterns in FILES.items():
        began = time.time()
        path = Path(snapshot_download(repo, allow_patterns=patterns, cache_dir=weights))
        snaps[repo] = (path, path.name)
        print(f"weights: {repo} @ {path.name[:10]} ready in {time.time() - began:.0f} s", flush=True)
    return snaps


def load_official(snapshot: Path):
    spec = importlib.util.spec_from_file_location("pipeline_moss_image", snapshot / "pipeline_moss_image.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["pipeline_moss_image"] = module
    spec.loader.exec_module(module)
    return module


def load_transformer(moss, snapshot: Path):
    # Read whole, not memory-mapped (LESSONS #42).
    return moss.MOSSImageTransformer.from_pretrained(
        snapshot / "transformer", torch_dtype=torch.bfloat16, disable_mmap=True).eval().to(device())


def build_pipe(moss, snapshot: Path):
    from diffusers import AutoencoderKLFlux2
    from transformers import AutoModel, AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(snapshot / "tokenizer")
    text_encoder = AutoModel.from_pretrained(snapshot / "text_encoder", dtype=torch.bfloat16,
                                             disable_mmap=True).eval()
    vae = AutoencoderKLFlux2.from_pretrained(snapshot / "vae", torch_dtype=torch.float32).eval()
    scheduler = moss.MOSSImageScheduler.from_pretrained(snapshot, subfolder="scheduler")
    pipe = moss.MOSSImagePipeline(load_transformer(moss, snapshot), scheduler,
                                  text_encoder=text_encoder, tokenizer=tokenizer, vae=vae)
    return pipe.to(device())


SUFFIXES = {".lora_down.weight": "down", ".lora_up.weight": "up", ".lora_A.weight": "down",
            ".lora_B.weight": "up", ".alpha": "alpha"}
PREFIXES = ("diffusion_model.", "model.diffusion_model.", "transformer.", "lora_unet_")


def read_lora(path: Path, transformer) -> dict:
    """module name → {down, up, alpha}; raises on any key that matches no Linear layer."""
    from safetensors.torch import load_file
    linears = {}
    for name, module in transformer.named_modules():
        if isinstance(module, torch.nn.Linear):
            linears[name] = name
            linears[name.replace(".", "_")] = name  # kohya underscore form
    parts, unknown = {}, []
    for key, tensor in load_file(str(path)).items():
        suffix = next((s for s in SUFFIXES if key.endswith(s)), None)
        stem = key[:-len(suffix)] if suffix else key
        for prefix in PREFIXES:
            if stem.startswith(prefix):
                stem = stem[len(prefix):]
                break
        if suffix is None or stem not in linears:
            unknown.append(key)
            continue
        parts.setdefault(linears[stem], {})[SUFFIXES[suffix]] = tensor
    incomplete = [n for n, p in parts.items() if "down" not in p or "up" not in p]
    if unknown or incomplete or not parts:
        raise ValueError(f"{path.name}: {len(unknown)} keys match no layer (e.g. {unknown[:3]}), "
                         f"{len(incomplete)} layers lack down/up (e.g. {incomplete[:3]})")
    ranks = sorted({p["down"].shape[0] for p in parts.values()})
    print(f"lora: {path.name}: {len(parts)} layers, rank {ranks[0]}–{ranks[-1]}, "
          f"{next(iter(parts.values()))['down'].dtype}", flush=True)
    return parts


def hook_lora(transformer, parts: dict, strength: float) -> list:
    """Unmerged fp32 side branch on each layer: y = W x + strength · alpha/rank · up(down(x))."""
    modules = dict(transformer.named_modules())
    handles = []
    for name, p in parts.items():
        down = p["down"].to(device(), torch.float32)
        up = p["up"].to(device(), torch.float32)
        alpha = float(p["alpha"]) if "alpha" in p else down.shape[0]
        scale = strength * alpha / down.shape[0]

        def hook(module, args, out, down=down, up=up, scale=scale):
            return out + (scale * ((args[0].float() @ down.T) @ up.T)).to(out.dtype)
        handles.append(modules[name].register_forward_hook(hook))
    return handles


def kernels() -> str:
    found = []
    for module in ("fla", "causal_conv1d"):
        try:
            __import__(module)
            found.append(f"{module} yes")
        except ImportError:
            found.append(f"{module} no")
    return ", ".join(found)


def sheet(images: list, path: Path):
    """One row per prompt: each case's image, 512 px high, its case name above it."""
    from PIL import Image, ImageDraw
    thumbs = [(case, img.resize((round(img.width * 512 / img.height), 512))) for case, img in images]
    width = sum(t.width for _, t in thumbs) + 8 * (len(thumbs) - 1)
    out = Image.new("RGB", (width, 540), "white")
    x = 0
    for case, thumb in thumbs:
        out.paste(thumb, (x, 28))
        ImageDraw.Draw(out).text((x + 4, 6), case, fill="black")
        x += thumb.width + 8
    out.save(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", default=",".join(CASES), help="comma-separated, from: " + ", ".join(CASES))
    parser.add_argument("--seeds", default=str(SEED), help="comma-separated seeds, each case renders every one")
    parser.add_argument("--prompts", default=",".join(PROMPTS), help="comma-separated, from: " + ", ".join(PROMPTS))
    parser.add_argument("--out", default="moss", help="folder under data/output/bench/ (a new one keeps earlier runs)")
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--local", type=Path, help="tests only: local repositories instead of downloads")
    parser.add_argument("--size", type=int, help="tests only: square size instead of the real ones")
    args = parser.parse_args()
    cases = args.cases.split(",")
    if unknown := [c for c in cases if c not in CASES]:
        sys.exit(f"unknown cases {unknown}; known: {', '.join(CASES)}")
    seeds, prompts = [int(s) for s in args.seeds.split(",")], args.prompts.split(",")
    if unknown := [p for p in prompts if p not in PROMPTS]:
        sys.exit(f"unknown prompts {unknown}; known: {', '.join(PROMPTS)}")

    from studio.config import Settings
    settings = Settings()
    weights, out = settings.data_dir / "bench" / "moss-weights", settings.output_dir / "bench" / args.out
    weights.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(weights).free / 1e9
    print(f"disk: {free:.0f} GB free on the data volume (about 41 GB needed the first time)", flush=True)
    snaps = download(weights, args.local)
    if args.download_only:
        return 0

    print(f"kernels for Qwen3.5 linear attention: {kernels()}", flush=True)
    moss = load_official(snaps[SFT][0])
    began = time.time()
    pipe = build_pipe(moss, snaps[SFT][0])
    sync()
    results = {"load_s": round(time.time() - began, 1), "kernels": kernels(), "seeds": seeds,
               "commits": {r: c for r, (_, c) in snaps.items()}, "prompts": {}, "cases": {}}
    print(f"load: SFT pipeline in {results['load_s']} s", flush=True)

    # Prompts encoded once (their time is per prompt, not per case), with the empty negative.
    embeds = {}
    for name in prompts:
        prompt = PROMPTS[name]
        sync()
        t = time.time()
        embeds[name] = pipe.encode_prompt(prompt)
        sync()
        results["prompts"][name] = round(time.time() - t, 2)
    negative = pipe.encode_prompt("")
    print("text encoder: " + ", ".join(f"{n} {s} s" for n, s in results["prompts"].items()), flush=True)

    current, images = SFT, {(name, seed): [] for name in prompts for seed in seeds}
    for case in sorted(cases, key=lambda c: CASES[c]["model"] != SFT):  # SFT first, one swap
        spec = CASES[case]
        if spec["model"] != current:
            pipe.transformer = None
            gc.collect()
            torch.cuda.empty_cache() if torch.cuda.is_available() else None
            t = time.time()
            pipe.transformer = load_transformer(moss, snaps[spec["model"]][0])
            sync()
            current = spec["model"]
            print(f"load: {current} transformer in {time.time() - t:.0f} s", flush=True)
        try:
            handles = [h for repo, file, strength in spec["loras"]
                       for h in hook_lora(pipe.transformer, read_lora(snaps[repo][0] / file, pipe.transformer),
                                          strength)]
        except (OSError, ValueError, KeyError) as error:
            print(f"{case}: SKIPPED, {error}", flush=True)
            results["cases"][case] = {"error": str(error)}
            continue
        width, height = (args.size, args.size) if args.size else spec.get("size", SIZE)
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        timings = {}
        for name in [p for p in (spec.get("prompts") or PROMPTS) if p in prompts]:
            if name == "layout" and (width, height) != SIZE and not args.size:
                continue  # the layout's boxes are for 1024×1024
            for seed in seeds:
                (pos, pos_mask), (neg, neg_mask) = embeds[name], negative
                sync()
                t = time.time()
                image = pipe(prompt_embeds=pos, prompt_attention_mask=pos_mask,
                             negative_prompt_embeds=neg, negative_prompt_attention_mask=neg_mask,
                             width=width, height=height, num_inference_steps=spec["steps"],
                             guidance_scale=spec["cfg"], uncond_skip_layers=[22] if spec["cfg"] != 1 else [],
                             generator=torch.Generator("cpu").manual_seed(seed)).images[0]
                sync()
                key = name if len(seeds) == 1 else f"{name} s{seed}"
                timings[key] = round(time.time() - t, 1)
                image.save(out / (f"{name}--{case}.png" if len(seeds) == 1 else f"{name}--{case}--s{seed}.png"))
                images[(name, seed)].append((case, image))
        for handle in handles:
            handle.remove()
        peak = torch.cuda.max_memory_allocated() / 1e9 if torch.cuda.is_available() else 0
        results["cases"][case] = {"size": f"{width}x{height}", "steps": spec["steps"], "cfg": spec["cfg"],
                                  "loras": [f"{r}/{f} @{s}" for r, f, s in spec["loras"]],
                                  "seconds": timings, "peak_gb": round(peak, 1)}
        print(f"{case}: {width}×{height}, {spec['steps']} steps, cfg {spec['cfg']}: "
              + ", ".join(f"{n} {s} s" for n, s in timings.items()) + f", peak {peak:.0f} GB", flush=True)

    for (name, seed), row in images.items():
        if row:
            sheet(row, out / (f"sheet--{name}.png" if len(seeds) == 1 else f"sheet--{name}--s{seed}.png"))
    (out / "results.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))
    print(f"done: images and sheets in {out}, timings in {out / 'results.json'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
