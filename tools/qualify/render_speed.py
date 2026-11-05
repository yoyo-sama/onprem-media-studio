"""Time renders of an image engine at the sheet size with one speed-up, inside the container:

    docker exec -i studio python - krea2-turbo base < tools/qualify/render_speed.py

Variants: base (no compilation), compile (torch.compile of the transformer, default mode:
no CUDA graphs, see LESSONS #37; what the server runs). Each variant renders the same prompt
and seed three times and saves the last image under output/bench/ (it shows in the
gallery), to compare them by eye. render_speed.sh runs both. Measured on the GB10
(2026-11-05, 1920×1088): Krea 2 5.70 → 4.99 s per step, Qwen Image 2.1 2.95 → 2.30 s; the
first render pays about 20 s of compilation. FP8 by torchao (dynamic activations, per-row
scales) took 1 800 s per Krea 2 step: never use it on the GB10 (LESSONS #43).
"""
import sys
import time

import torch
from diffusers import Krea2Pipeline, QwenImage21Pipeline

from studio.config import Settings
from studio.pipelines.common import from_pretrained

model, variant = sys.argv[1], sys.argv[2]
cls, steps = {"krea2-turbo": (Krea2Pipeline, 8), "qwen-image-2.1": (QwenImage21Pipeline, 25)}[model]
PROMPT = ("Character turnaround reference sheet of a red-haired explorer in a weathered leather jacket, "
          "front, three-quarter, side and back views, full body, plain light grey studio background, "
          "even soft lighting")
settings = Settings()
path = settings.models_dir / model

began = time.time()
pipe = from_pretrained(cls, path)
if variant == "compile":
    pipe.transformer.compile()
elif variant != "base":
    sys.exit(f"unknown variant {variant!r}")
torch.cuda.synchronize()
load = time.time() - began

# The server's settings (krea2.py, qwen.py).
kwargs = ({"guidance_scale": 0.0} if model == "krea2-turbo"
          else {"true_cfg_scale": 1.0, "image": None, "output_resolution": 1024})
runs, step_times = [], []
for _ in range(3):
    marks = []

    def mark(pipe_, step, timestep, tensors):
        torch.cuda.synchronize()
        marks.append(time.time())
        return tensors

    began = time.time()
    image = pipe(prompt=PROMPT, width=1920, height=1088, num_inference_steps=steps,
                 generator=torch.Generator("cuda").manual_seed(1234), callback_on_step_end=mark,
                 **kwargs).images[0]
    runs.append(time.time() - began)
    step_times.append((marks[-1] - marks[0]) / (len(marks) - 1))

out = settings.output_dir / "bench"
out.mkdir(parents=True, exist_ok=True)
image.save(out / f"{model}-{variant}.png")
print(f"{model} {variant}: load {load:.0f} s, renders {', '.join(f'{r:.1f}' for r in runs)} s, "
      f"{steps} steps × {step_times[-1]:.2f} s, peak {torch.cuda.max_memory_allocated() / 1024**3:.0f} GB, "
      f"image output/bench/{model}-{variant}.png", flush=True)
