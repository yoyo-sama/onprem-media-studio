"""Time one load of an image engine with one loading mode, inside the container:

    docker exec -i studio python - krea2-turbo mmap < tools/qualify/load_speed.py

Modes: mmap (from_pretrained then .to), nommap (disable_mmap=True, files read whole),
direct (device_map set to the GPU, no .to), warm and warm-nommap (the model folder read
ahead into the page cache by common.prefetch, then mmap or nommap; the server's way is
warm-nommap). load_speed.sh runs them all with the page cache dropped before each.
"""
import sys
import time

import torch
from diffusers import Krea2Pipeline, QwenImage21Pipeline

from studio.config import Settings
from studio.pipelines.common import prefetch

model, mode = sys.argv[1], sys.argv[2]
cls = {"krea2-turbo": Krea2Pipeline, "qwen-image-2.1": QwenImage21Pipeline}[model]
kwargs = {"torch_dtype": torch.bfloat16}
path = Settings().models_dir / model
began = time.time()
read = None
if mode.startswith("warm"):
    read = prefetch(path)
    mode = mode.removeprefix("warm").lstrip("-") or "mmap"
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
print(f"{model} {sys.argv[2]}: {time.time() - began:.1f} s"
      + (f" (files read in {read:.1f} s)" if read is not None else ""), flush=True)
