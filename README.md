# OnPrem Media Studio

**Private AI image and video studio that runs entirely on your own machine.** No ComfyUI, no
Ollama, no cloud: the app runs the models itself and downloads the weights it needs on first use.

Successor of AI Content Studio 1.4. Engines: Krea 2, Qwen Image 2.1, MOSS-Image,
MiniMax H3 through FastH3, Gemma 4 26B-A4B for prompt enrichment and the creative assistant (a chat with
roles that proposes ready-to-run cards: [docs/ASSISTANT.md](docs/ASSISTANT.md)).

> Status: the assistant, the Studio and the Canvas run in Docker on the GB10. Krea 2, Qwen Image
> 2.1, MOSS-Image, Gemma 4 26B-A4B and the MiniMax H3 video engines in NVFP4 (text, image,
> first/last image and references to video) are qualified there by real renders. See the
> [roadmap](docs/ROADMAP.md).

Version française : [README.fr.md](README.fr.md).

## Requirements

- NVIDIA GPU. First target: DGX OS on a GB10 (ARM64). Ubuntu next; Omarchy and Windows 11 later.
- Docker with the NVIDIA Container Toolkit.
- Disk: models take hundreds of GB; plan for 300 GB free.
- A Hugging Face token for gated models (Krea 2), after accepting their licence on the model page.

## Run with Docker

1. Get the repository. While it is private, `git clone` asks for a user name and a password:
   give your GitHub login and a token that can read the repository (fine-grained, *Contents:
   read-only*).

   ```bash
   git clone https://github.com/yoyo-sama/onprem-media-studio.git
   cd onprem-media-studio
   ```

2. Check the machine. This changes nothing; it tells what to fix, with the command, if Docker is
   not usable by your user, no GPU is seen in a container (NVIDIA Container Toolkit), the port is
   taken or the disk is short.

   ```bash
   scripts/docker-install.sh --check
   ```

3. Install and start. The script creates `.env` and `./data`, builds the image (the first
   build takes several minutes), starts the studio and waits until it answers.

   ```bash
   scripts/docker-install.sh
   ```

4. Add your tokens to `.env`, then apply them:

   ```bash
   nano .env                # HF_TOKEN=hf_...   STUDIO_GIT_TOKEN=github_pat_...
   docker compose up -d
   ```

   `HF_TOKEN` is for Krea 2 (accept its licence on its Hugging Face page first);
   `STUDIO_GIT_TOKEN` is the GitHub token of step 1, for in-app updates while the repository is
   private.

5. Open `http://localhost:8090` (or `http://<machine address>:8090` from another computer).
   Each model downloads on its first use.

Good to know:

- AI Content Studio 1.4 uses port 8090. On a machine where it runs, steps 2 and 3 stop on the
  port: create the settings file yourself with `cp .env.example .env && chmod 600 .env`, set
  `STUDIO_HOST_PORT=8096` in it, then run steps 2 and 3 (the address of step 5 ends in `:8096`).
- All settings are in `.env`, created once from [`.env.example`](.env.example) and readable by
  you only; the script never changes an existing one. Models and renders go to `./data`
  (`STUDIO_DATA=/path` in `.env` for another disk).
- Running the script again rebuilds and restarts the studio, but never while a job runs or a
  model downloads: it says so and stops.
- State and logs: `curl -s localhost:8090/api/health` and `docker compose logs -f studio`.

### Updates

The "Update" panel of the interface pulls the repository, rebuilds the image (the studio keeps
working meanwhile), then restarts the studio once no job runs; models and renders stay. The
`updater` service of `compose.yaml` does it ([docs/GALLERY.md](docs/GALLERY.md#docker-docker-compose)).
A private repository needs `STUDIO_GIT_TOKEN` in `.env` (step 4). By hand, in this folder:
`git pull && scripts/docker-install.sh`, which waits for no job to run before the restart.

### Reuse files from AI Content Studio 1.4

On a machine where 1.4 is installed, this copies into `./data` what 2.0 can use from its ComfyUI
models folder, so it is not downloaded again: the H3 latent upscaler (0.7 GB), the Qwen Image 2.1
text encoder (17.5 GB, rebuilt into the Hugging Face shards) and your MiniMax H3 LoRAs. The other
1.4 models are ComfyUI formats (fp8, int8, NVFP4 conversions) that 2.0 cannot load; they are
downloaded on first use. A reused file is kept only if its SHA-256 equals the one Hugging Face
publishes. Speed-up LoRAs (turbo, lightning, n-step) are left out: the H3 checkpoints of 2.0 are
already distilled. The 1.4 folder is mounted read-only and never changed.

```bash
docker compose run --rm -v ~/comfyui-spark/basedir/models:/import:ro studio python -m studio.import14 /import
```

It prints what was reused, which LoRAs were imported or skipped and why, and what is still to
download per model. The copies take new disk space: the 1.4 files stay where they are.

## Install on bare metal (DGX OS, Ubuntu)

```bash
scripts/install.sh --check     # checks driver, CUDA 13 toolkit, GPU, Python, disk
scripts/install.sh             # builds and starts the "studio" systemd service
```

See [docs/INSTALL.md](docs/INSTALL.md).

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
- [Image engines](docs/IMAGE-ENGINES.md): Krea 2, Qwen Image 2.1 and MOSS-Image jobs, image references, qualification
- [Video engines](docs/H3.md): MiniMax H3 jobs, the two-pass reference-to-video, precision,
  LoRA stack, qualification
- [Creative assistant](docs/ASSISTANT.md): the assistant mode, its roles, cards and model
- [Front end](docs/FRONTEND.md): Studio and Canvas pages, Canvas cards, differences from 1.4,
  front-end tests
- [Bare-metal install](docs/INSTALL.md): `scripts/install.sh`, service, updates
- [Gallery, update, LoRA upload](docs/GALLERY.md): output index, trash, in-app update
- [Lessons from 1.4](docs/LESSONS.md): rules learned the hard way, read before changing a prompt
  or an engine
- [ADR 0001](docs/adr/0001-inference-stack.md): why diffusers, FastVideo and llama.cpp
- [Roadmap](docs/ROADMAP.md)
- [Handover](docs/HANDOVER.md): state of the project, test machines and open items, to resume
  development without earlier context

## Licences

This repository does not contain model weights. Each model keeps its own licence, listed in
`studio/catalog.json` and on the status page. Note in particular:

- **MiniMax H3** (and FastH3): MiniMax H3 Community License. It **excludes the European Union,
  the United Kingdom, South Korea and the United States**, and requires "MiniMax H3" to be shown
  in the interface of a commercial product (the status page shows it). See [NOTICE](NOTICE).
- **MiniMax H3 latent upscaler** (LBH-123-AI): Apache-2.0 weights; the code that runs them is
  this project's.
- **SPAN 2xNomosUni** (Upscale ×2, Philip Hofmann): CC BY 4.0 weights, credited in
  [NOTICE](NOTICE); run through spandrel (MIT).
- **Krea 2**: gated on Hugging Face, licence accepted per user.
- **Qwen Image 2.1**: Qwen Research License, **non-commercial use only**; commercial use needs a
  licence from Qwen. Every image edit and shot image uses it.
- **MOSS-Image** (OpenMOSS-Team/MOSS-Image-SFT) and its turbo LoRA
  (akhaliq/MOSS-Image-SFT-4-steps, downloaded with it for the Preview and Standard modes):
  Apache-2.0.
- **Gemma 4 26B-A4B** (GGUF by ggml-org): Apache-2.0.

The wording of the subject sheet drawn from a photo is adapted from H3 Character Sheet Designer
(MIT), credited in [NOTICE](NOTICE).

Maestro and WanGP inspired the approach; no code was taken from them (their licence is
non-commercial).
