"""Time one load of an image engine with one loading mode, inside the container:

    docker exec -i studio python - krea2-turbo mmap < tools/qualify/load_speed.py

Modes: mmap (the server's way: from_pretrained then .to), nommap (disable_mmap=True,
files read whole), direct (device_map set to the GPU, no .to). load_speed.sh runs
all three with the page cache dropped before each.
"""
import sys
import time

import torch
from diffusers import Krea2Pipeline, QwenImage21Pipeline

from studio.config import Settings

model, mode = sys.argv[1], sys.argv[2]
cls = {"krea2-turbo": Krea2Pipeline, "qwen-image-2.1": QwenImage21Pipeline}[model]
kwargs = {"torch_dtype": torch.bfloat16}
if mode == "nommap":
    kwargs["disable_mmap"] = True
elif mode == "direct":
    kwargs["device_map"] = "cuda"
elif mode != "mmap":
    sys.exit(f"unknown mode {mode!r}")
began = time.time()
pipe = cls.from_pretrained(Settings().models_dir / model, **kwargs)
if mode != "direct":
    pipe.to("cuda")
torch.cuda.synchronize()
print(f"{model} {mode}: {time.time() - began:.1f} s", flush=True)
