# ADR 0001 — Inference stack without ComfyUI or Ollama

- Status: accepted (2026-10-29)
- French version: [../fr/adr/0001-inference-stack.md](../fr/adr/0001-inference-stack.md)

## Context

AI Content Studio 1.4 is a static front end driving ComfyUI (`:8188`) and Ollama (`:11434`)
through nginx, plus two small Python services (updater, gallery). Version 2.0 must run every
model itself, download the weights it needs automatically, keep the 1.4 feature coverage, and
install as one Docker container on a GB10 (DGX OS, ARM64) first, then bare metal, Ubuntu,
Omarchy and Windows 11.

Models in scope: Krea 2, Qwen Image 2.1 (Qwen-Image-Edit 2509 dropped on 2026-10-29), MiniMax H3 through FastH3 (OmniRef for
reference-to-video). LTX 2.5 is dropped; H3 takes over every video path. Gemma 4 E4B stays the
only prompt LLM.

Maestro and WanGP do the same job but are released under the WanGP Non-Commercial Evaluation
License 1.1. Decision of 2026-10-29: they are **references only**; no code is copied and neither
is a dependency.

## Decision

| Concern | Choice | Why |
|---|---|---|
| Server | Python, FastAPI, one process, one GPU worker thread | Same language as every model runtime; jobs run in order on one GPU |
| Krea 2, Qwen Image 2.1 | Hugging Face `diffusers` pipelines, official weights | Official repositories are in diffusers layout (`model_index.json`); Apache-2.0 library |
| MiniMax H3 / FastH3 | `FastVideo` (Apache-2.0) | Publishes the FastH3 OmniRef NVFP4 QAD weights with a DGX Spark recipe; NVFP4 and VSA kernels are its job, not ours |
| Prompt LLM | `llama-server` from llama.cpp, Gemma 4 GGUF + mmproj (E4B at first; 26B-A4B since 2026-10-31, see below) | Same as Maestro's approach; OpenAI-compatible API; vision through mmproj |
| Model download | `huggingface_hub`, per-file, `.complete` marker | Resumable, disk-space check, gated repositories through `HF_TOKEN` |
| Prompt compilers | The 1.4 JavaScript engine (`js/engine.js`), ported to English | Single source shared by Studio and Canvas, already covered by parity tests; the backend stays inference-only |
| Packaging | NGC PyTorch base image (multi-arch, CUDA 13) | Ships a PyTorch build for Blackwell/GB10; bare metal reuses the same Python package |

## Consequences

- One port (8090), no nginx, no second service: the gallery and the updater become modules of
  the same server in step 4.
- The backend never builds node graphs. A pipeline is a Python class: models it needs + `run()`.
- The ComfyUI-only pieces of the validated OmniRef workflow need an equivalent: the 3D latent
  upscaler (community node) and the "power LoRA stack" (exact-branch LoRA on a quantised model).
  Step 3 (H3.md): FastVideo has neither, so both are written here: the upscaler as our own module
  loading LBH-123-AI's checkpoint (Apache-2.0 weights), the stack as one merged adapter that
  FastVideo runs as a side branch. The two passes run through FastVideo's public options
  (latent output, injected latents, PDD plan) without forking it.
- The front end talks to `/api/*` instead of `/comfy/*` and `/ollama/*`; its graph-building
  layer is replaced by job submissions.

## Risks

- **MiniMax H3 licence:** the Community License excludes the European Union, the United Kingdom,
  South Korea and the United States, and requires "MiniMax H3" to be shown in the UI of a
  commercial product. This already applied to 1.4. Use in excluded territories needs a licence
  from MiniMax.
- **Krea 2 is gated:** the user must accept its licence on Hugging Face and provide `HF_TOKEN`.
- **FastH3 for first/last frame (I2V/FL2VA):** OmniRef is validated. Step 3 uses FastH3 V2
  (`FastVideo/FastH3-QAD-v2`), whose
  pipeline takes first and last images, but upstream records only text to video for it: to
  qualify on GB10.
- **FastVideo pins torch 2.12** while the image keeps the NGC 25.11 torch (2.10); FastVideo is
  installed without its dependencies and pip is constrained to the base torch. API and imports
  check out on 2.10 without a GPU, and the kernels ran on the GB10 (2026-10-30), with FastVideo's
  own CUDA 13.0 + torch 2.12 stack as the fallback (`docs/H3.md` § Torch version).
- **H3 clips are 5 to 15 s** in FastVideo, where 1.4 allowed shorter cuts.
- **NGC image tag and llama.cpp revision** are pinned but not yet built on GB10: first build on
  the device may require a bump.

## Amendment of 2026-10-31: one larger Gemma for prompts and the assistant

The creative assistant (docs/ASSISTANT.md) needs a model that follows long role instructions and
calls tools reliably. At the owner's request, one model serves both the assistant and the
enrichments: Gemma 4 26B-A4B (`ggml-org/gemma-4-26B-A4B-it-GGUF`, Q4_0 14.6 GB + mmproj,
Apache-2.0). It is a mixture of experts with about 4B active parameters per token, so its speed
stays close to E4B's while its quality is that of a much larger model. Gemma 4 E4B stays
available through `STUDIO_LLM_MODEL=gemma4-e4b`. Still the only LLM: one `llama-server`, stopped
when an H3 engine needs the memory. To check on the GB10: tool calls through `--jinja`, speed,
and the enrichments compared with E4B's.
