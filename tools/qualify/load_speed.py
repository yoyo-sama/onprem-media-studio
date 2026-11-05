"""Time one load of an image engine with one loading mode, inside the container:

    docker exec -i studio python - krea2-turbo mmap < tools/qualify/load_speed.py

Modes: mmap (from_pretrained then .to), nommap (disable_mmap=True: diffusers' own models
read whole, the text encoder still mapped), direct (device_map set to the GPU, no .to),
server (common.from_pretrained: every model read whole, text encoder included).
load_speed.sh runs them all with the page cache dropped before each. Measured on the GB10
(2026-11-05, Krea 2): mmap 253 s, nommap 82 s, direct 258 s; the page cache read ahead
first changed nothing (236 s mapped, 85 s nommap), so the mapping is the cost, not the disk.
"""
import sys
import time

import torch
from diffusers import Krea2Pipeline, QwenImage21Pipeline

from studio.config import Settings
from studio.pipelines.common import from_pretrained

model, mode = sys.argv[1], sys.argv[2]
cls = {"krea2-turbo": Krea2Pipeline, "qwen-image-2.1": QwenImage21Pipeline}[model]
kwargs = {"torch_dtype": torch.bfloat16}
path = Settings().models_dir / model
began = time.time()
if mode == "server":
    from_pretrained(cls, path)
    torch.cuda.synchronize()
    print(f"{model} {mode}: {time.time() - began:.1f} s", flush=True)
    sys.exit(0)
if mode == "nommap":
    kwargs["disable_mmap"] = True
elif mode == "direct":
    kwargs["device_map"] = "cuda"
elif mode != "mmap":
    sys.exit(f"unknown mode {mode!r}")
pipe = cls.from_pretrained(path, **kwargs)
if mode != "direct":
    pipe.to("cuda")
torch.cuda.synchronize()
print(f"{model} {mode}: {time.time() - began:.1f} s", flush=True)
