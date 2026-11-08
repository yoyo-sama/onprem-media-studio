"""Qwen Image 2.1 against two step-distilled transformers, on the Qwen qualification cases.
Run by qwen_fast_bench.sh inside the container, one process per variant:

    python qwen_fast_bench.py base|lightning|turbo   # render the cases with one variant
    python qwen_fast_bench.py compare                # table + side-by-side images

Variants (the text encoder, VAE and processor always come from qwen-image-2.1):
- base: Qwen/Qwen-Image-2.1, 25 steps, torch.compile, what the server ran until 2026-11-07
  (it needs Qwen's own transformer, which installs made since then no longer download);
- lightning: lightx2v/Qwen-Image-2.1-Lightning-v2-RL, its 4 sigmas, no compile, what the
  server runs since 2026-11-07. The transformer is stored in FP32 (28.5 GB) and loaded in BF16;
- turbo: Qwen/Qwen-Image-2.1-Turbo, its 8 sigmas, no compile.
Both distilled schedules are already shifted: they need a scheduler without dynamic
shifting (the base one would shift them again). Their weights go to <data>/bench/
qwen-fast/, outside the model store: nothing is listed in the app (not qualified).

Inputs: the sheets and the thumbnail the cases use, rendered beforehand by
run_image_cases.py (report inputs.json next to this file). Each case is rendered twice
with its seed and the second render is timed (the first one pays compilation and
warm-up), then once with each next seed (BENCH_SEEDS=3: seed+1 and seed+2). Images:
<data>/output/bench/qwen-fast/<case>-<variant>-<seed>.png, and <case>-compare.png
(one row per seed, columns base | lightning | turbo) after `compare`. A variant is judged on
those images, never on its time alone (AGENTS.md: never trust a success status).
"""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = ["shot-21-solo", "shot-21-dual", "i2i-21", "i2i-21-refs", "t2i-21"]
VARIANTS = {
    "base": None,
    "lightning": ("lightx2v/Qwen-Image-2.1-Lightning-v2-RL",
                  ["config.json", "diffusion_pytorch_model.safetensors", "inference_config.json"]),
    "turbo": ("Qwen/Qwen-Image-2.1-Turbo", ["model_index.json", "scheduler/*", "transformer/*"]),
}
REPEATS = 2
# Seeds per case: the case seed, then seed+1, seed+2… (BENCH_SEEDS, default 1).
SEEDS = int(os.environ.get("BENCH_SEEDS", "1"))


def substitute(value, outputs):
    """'@<case>' or '@<case>:<n>' of image_cases.json -> a file of the inputs report."""
    if isinstance(value, list):
        return [substitute(v, outputs) for v in value]
    if isinstance(value, str) and value.startswith("@"):
        case, _, n = value[1:].partition(":")
        return outputs[case][int(n or 0)]
    return value


def load_cases(output_dir: Path) -> list[dict]:
    """The Qwen cases with their image references turned into paths."""
    report = json.loads((HERE / "inputs.json").read_text())
    outputs = {}
    for entry in report:
        if entry["status"] != "done":
            sys.exit(f"Input case {entry['id']} did not finish: rerun qwen_fast_bench.sh")
        # "http://localhost:8090/outputs/krea2-t2i/x.png" -> <data>/output/krea2-t2i/x.png
        outputs[entry["id"]] = [output_dir / o.split("/outputs/", 1)[1] for o in entry["outputs"]]
    cases = {c["id"]: c for c in json.loads((HERE / "image_cases.json").read_text())["cases"]}
    return [{"id": cid, **{k: substitute(v, outputs) for k, v in cases[cid]["params"].items()}}
            for cid in CASES]


def download(variant: str, bench: Path, token) -> Path:
    from huggingface_hub import snapshot_download
    repo, allow = VARIANTS[variant]
    target = bench / variant
    if not (target / ".complete").is_file():
        print(f"Downloading {repo} to {target}", flush=True)
        snapshot_download(repo, allow_patterns=allow, local_dir=target, token=token)
        (target / ".complete").touch()
    return target


def build(variant: str, settings):
    """The pipeline, its sampling arguments, and its load time."""
    import torch
    import transformers
    from diffusers import FlowMatchEulerDiscreteScheduler, QwenImage21Pipeline, QwenImage21Transformer2DModel
    from studio.pipelines import common, qwen

    base = settings.models_dir / "qwen-image-2.1"
    if not base.is_dir():
        sys.exit(f"{base} is missing: render one Qwen Image 2.1 image in the app first")
    fast = download(variant, settings.data_dir / "bench" / "qwen-fast", settings.hf_token) if VARIANTS[variant] else None
    device = "cuda" if torch.cuda.is_available() else "cpu"
    began = time.time()
    parts = {}
    # As common.from_pretrained: every safetensors file read whole, in bfloat16.
    index = json.loads((base / "model_index.json").read_text())
    for name, spec in index.items():
        model = getattr(transformers, spec[1], None) if isinstance(spec, list) and spec[0] == "transformers" else None
        if isinstance(model, type) and issubclass(model, transformers.PreTrainedModel):
            parts[name] = model.from_pretrained(base / name, dtype=torch.bfloat16, disable_mmap=True)
    if fast:
        folder = fast / "transformer" if (fast / "transformer").is_dir() else fast
        parts["transformer"] = QwenImage21Transformer2DModel.from_pretrained(
            folder, torch_dtype=torch.bfloat16, disable_mmap=True)
    pipe = QwenImage21Pipeline.from_pretrained(base, torch_dtype=torch.bfloat16, disable_mmap=True,
                                               **parts).to(device)
    if variant == "base":
        # What the server ran until 2026-11-07: torch.compile, default mode, 25 steps.
        os.environ.setdefault("TORCHINDUCTOR_CACHE_DIR", str(settings.data_dir / "cache" / "inductor"))
        pipe.transformer.compile()
        sampling = {"num_inference_steps": 25}
    elif variant == "lightning":
        config = json.loads((fast / "inference_config.json").read_text())
        pipe.scheduler = FlowMatchEulerDiscreteScheduler(**config["scheduler"])
        sampling = {"sigmas": config["sample_sigmas"], "use_kv_cache": config["use_kv_cache"]}
        if config["true_cfg_scale"] != 1.0 or config["base_model"] != "Qwen/Qwen-Image-2.1":
            sys.exit(f"Unexpected inference_config.json: {config}")
    else:
        pipe.scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(fast / "scheduler")
        sampling = {"sigmas": json.loads((fast / "model_index.json").read_text())["sample_sigmas"]}
    if fast and pipe.scheduler.config.use_dynamic_shifting:
        sys.exit(f"{variant}: the scheduler would shift the sigmas again")
    if device == "cuda":
        torch.cuda.synchronize()
    return pipe, sampling, time.time() - began, device


def render(variant: str) -> None:
    import torch
    from studio.config import Settings
    from studio.pipelines import common, qwen

    settings = Settings()
    out = settings.output_dir / "bench" / "qwen-fast"
    out.mkdir(parents=True, exist_ok=True)
    cases = load_cases(settings.output_dir)
    pipe, sampling, load, device = build(variant, settings)
    print(f"{variant}: loaded in {load:.0f} s", flush=True)
    results = {"variant": variant, "load": round(load, 1), "cases": {}}
    for case in cases:
        images = [common.open_image(Path(p)) for p in qwen.ordered_images(case)]
        width, height = (case["width"], case["height"]) if "width" in case else common.fit_area(*images[0].size)
        # The case seed first, rendered twice (the first render pays compilation and warm-up),
        # then the next seeds once each.
        seeds = [case["seed"]] * REPEATS + [case["seed"] + n for n in range(1, SEEDS)]
        timed = []
        for n, seed in enumerate(seeds):
            marks = []

            def mark(pipe_, step, timestep, tensors):
                if device == "cuda":
                    torch.cuda.synchronize()
                marks.append(time.time())
                return tensors

            began = time.time()
            image = pipe(prompt=case["prompt"], image=images or None, width=width, height=height,
                         true_cfg_scale=1.0, num_images_per_prompt=1,
                         output_resolution=qwen.QWEN21_RESOLUTION,
                         generator=torch.Generator(device).manual_seed(seed),
                         callback_on_step_end=mark, **sampling).images[0]
            seconds = time.time() - began
            image.save(out / f"{case['id']}-{variant}-{seed}.png")
            if n >= REPEATS - 1:
                steps = [b - a for a, b in zip([began] + marks, marks)]
                timed.append((seconds, steps))
        seconds, steps = timed[0]
        results["cases"][case["id"]] = {
            "size": f"{width}x{height}", "images": len(images), "steps": len(steps),
            "seconds": round(seconds, 1), "decode": round(seconds - sum(steps), 1),
            "first_step": round(steps[0], 2),  # text + reference encoding and the KV prefill
            "next_steps": round(sum(steps[1:]) / max(1, len(steps) - 1), 2),
            "seeds": sorted(set(seeds)),
            "seconds_per_seed": [round(t, 1) for t, _ in timed],
        }
        print(f"{variant} {case['id']}: {results['cases'][case['id']]}", flush=True)
    # The schedule the last render really used (terminal 0 appended by the scheduler).
    results["sigmas"] = [round(float(x), 6) for x in pipe.scheduler.sigmas]
    if device == "cuda":
        results["peak_gb"] = round(torch.cuda.max_memory_allocated() / 1024**3, 1)
    (settings.data_dir / "bench" / "qwen-fast" / f"{variant}.json").write_text(json.dumps(results, indent=2) + "\n")


def compare() -> None:
    from PIL import Image, ImageDraw
    from studio.config import Settings

    settings = Settings()
    bench, out = settings.data_dir / "bench" / "qwen-fast", settings.output_dir / "bench" / "qwen-fast"
    runs = {v: json.loads((bench / f"{v}.json").read_text()) for v in VARIANTS if (bench / f"{v}.json").is_file()}
    print("| case | " + " | ".join(runs) + " |")
    print("|---|" + "---|" * len(runs))
    for cid in CASES:
        cells = [f"{r['cases'][cid]['seconds']} s ({r['cases'][cid]['steps']} × {r['cases'][cid]['next_steps']} s)"
                 if cid in r["cases"] else "-" for r in runs.values()]
        print(f"| {cid} | " + " | ".join(cells) + " |")
        seeds = next((r["cases"][cid]["seeds"] for r in runs.values() if cid in r["cases"]), [])
        tiles = {(v, seed): out / f"{cid}-{v}-{seed}.png" for v in runs for seed in seeds}
        tiles = {k: Image.open(f) for k, f in tiles.items() if f.is_file()}
        if tiles:
            # One row per seed, one column per variant.
            w, h = next(iter(tiles.values())).size
            sheet = Image.new("RGB", (w * len(runs), (h + 40) * len(seeds)), "white")
            draw = ImageDraw.Draw(sheet)
            for row, seed in enumerate(seeds):
                for col, v in enumerate(runs):
                    if (v, seed) in tiles:
                        sheet.paste(tiles[v, seed].convert("RGB").resize((w, h)), (col * w, row * (h + 40) + 40))
                    draw.text((col * w + 10, row * (h + 40) + 10), f"{v} · seed {seed}", fill="black", font_size=24)
            sheet.save(out / f"{cid}-compare.png")
    print("| load | " + " | ".join(f"{r['load']} s" for r in runs.values()) + " |")
    print("| peak | " + " | ".join(f"{r.get('peak_gb', '-')} GB" for r in runs.values()) + " |")
    print(f"Images: {out}")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else ""
    if what == "compare":
        compare()
    elif what in VARIANTS:
        render(what)
    else:
        sys.exit(f"usage: qwen_fast_bench.py {'|'.join(VARIANTS)}|compare")
