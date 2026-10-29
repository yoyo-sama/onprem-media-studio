# OnPrem Media Studio

**Private AI image and video studio that runs entirely on your own machine.** No ComfyUI, no
Ollama, no cloud: the app runs the models itself and downloads the weights it needs on first use.

Successor of AI Content Studio 1.4. Engines: Krea 2, Qwen Image Edit (2509, 2.1), MiniMax H3
through FastH3, Gemma 4 E4B for prompt enrichment.

> Status: step 3 of the [roadmap](docs/ROADMAP.md). The server, model downloads, job queue and
> LLM bridge are in place; the image engines (Krea 2, Qwen Edit 2509 and 2.1) and the MiniMax H3
> video engines (text, image, first/last image and references to video) are written but not yet
> qualified on a GPU.

Version française : [README.fr.md](README.fr.md).

## Requirements

- NVIDIA GPU. First target: DGX OS on a GB10 (ARM64). Ubuntu next; Omarchy and Windows 11 later.
- Docker with the NVIDIA Container Toolkit.
- Disk: models take hundreds of GB; plan for 300 GB free.
- A Hugging Face token for gated models (Krea 2), after accepting their licence on the model page.

## Run with Docker

```bash
echo "HF_TOKEN=hf_..." > .env          # optional, needed for Krea 2
docker compose up -d --build
open http://localhost:8090
```

Models and renders go to `./data` (change with `STUDIO_DATA=/path` in `.env`). If port 8090 is
already taken (AI Content Studio 1.4 uses it), set `STUDIO_HOST_PORT=8096` in `.env`.

## Run without Docker (development)

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"                     # add ,inference to run the engines (torch installed separately)
python -m pytest
STUDIO_DATA_DIR=./data python -m studio      # http://localhost:8090
```

The LLM needs a `llama-server` binary from [llama.cpp](https://github.com/ggml-org/llama.cpp) on
the `PATH` or in `STUDIO_LLAMA_SERVER`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, API, job lifecycle, configuration, renaming
- [Image engines](docs/IMAGE-ENGINES.md): Krea 2 and Qwen Edit jobs, image references, qualification
- [Video engines](docs/H3.md): MiniMax H3 jobs, the two-pass reference-to-video, precision
  fallback, LoRA stack, qualification
- [Lessons from 1.4](docs/LESSONS.md): rules learned the hard way, read before changing a prompt
  or an engine
- [ADR 0001](docs/adr/0001-inference-stack.md): why diffusers, FastVideo and llama.cpp
- [Roadmap](docs/ROADMAP.md)

## Licences

This repository does not contain model weights. Each model keeps its own licence, listed in
`studio/catalog.json` and on the status page. Note in particular:

- **MiniMax H3** (and FastH3): MiniMax H3 Community License. It **excludes the European Union,
  the United Kingdom, South Korea and the United States**, and requires "MiniMax H3" to be shown
  in the interface of a commercial product (the status page shows it). See [NOTICE](NOTICE).
- **MiniMax H3 latent upscaler** (LBH-123-AI): Apache-2.0 weights; the code that runs them is
  this project's.
- **Krea 2**: gated on Hugging Face, licence accepted per user.
- **Qwen Image 2.1**: Qwen Research License, **non-commercial use only**; commercial use needs a
  licence from Qwen. Qwen-Image-Edit 2509 and its Lightning LoRA are Apache-2.0.

Maestro and WanGP inspired the approach; no code was taken from them (their licence is
non-commercial).
