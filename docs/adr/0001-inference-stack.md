# ADR 0001 — Inference stack without ComfyUI or Ollama

- Status: accepted (2026-10-29)
- French version: [../fr/adr/0001-inference-stack.md](../fr/adr/0001-inference-stack.md)

## Context

AI Content Studio 1.4 is a static front end driving ComfyUI (`:8188`) and Ollama (`:11434`)
through nginx, plus two small Python services (updater, gallery). Version 2.0 must run every
model itself, download the weights it needs automatically, keep the 1.4 feature coverage, and
install as one Docker container on a GB10 (DGX OS, ARM64) first, then bare metal, Ubuntu,
Omarchy and Windows 11.

Models in scope: Krea 2, Qwen Image Edit (2509 and 2.1), MiniMax H3 through FastH3 (OmniRef for
reference-to-video). LTX 2.5 is dropped; H3 takes over every video path. Gemma 4 E4B stays the
only prompt LLM.

Maestro and WanGP do the same job but are released under the WanGP Non-Commercial Evaluation
License 1.1. Decision of 2026-10-29: they are **references only**; no code is copied and neither
is a dependency.

## Decision

| Concern | Choice | Why |
|---|---|---|
| Server | Python, FastAPI, one process, one GPU worker thread | Same language as every model runtime; jobs run in order on one GPU |
| Krea 2, Qwen Edit | Hugging Face `diffusers` pipelines, official weights | Official repositories are in diffusers layout (`model_index.json`); Apache-2.0 library |
| MiniMax H3 / FastH3 | `FastVideo` (Apache-2.0) | Publishes the FastH3 OmniRef NVFP4 QAD weights with a DGX Spark recipe; NVFP4 and VSA kernels are its job, not ours |
| Prompt LLM | `llama-server` from llama.cpp, Gemma 4 E4B GGUF + mmproj | Same as Maestro's approach; OpenAI-compatible API; vision through mmproj |
| Model download | `huggingface_hub`, per-file, `.complete` marker | Resumable, disk-space check, gated repositories through `HF_TOKEN` |
| Prompt compilers | The 1.4 JavaScript engine (`js/engine.js`), ported to English | Single source shared by Studio and Canvas, already covered by parity tests; the backend stays inference-only |
| Packaging | NGC PyTorch base image (multi-arch, CUDA 13) | Ships a PyTorch build for Blackwell/GB10; bare metal reuses the same Python package |

## Consequences

- One port (8090), no nginx, no second service: the gallery and the updater become modules of
  the same server in step 4.
- The backend never builds node graphs. A pipeline is a Python class: models it needs + `run()`.
- The ComfyUI-only pieces of the validated OmniRef workflow need an equivalent: the 3D latent
  upscaler (community node) and the "power LoRA stack" (exact-branch LoRA on a quantised model).
  Step 3 checks what FastVideo offers before writing anything, and the licence of the upscaler
  weights before using them.
- The front end talks to `/api/*` instead of `/comfy/*` and `/ollama/*`; its graph-building
  layer is replaced by job submissions.

## Risks

- **MiniMax H3 licence:** the Community License excludes the European Union, the United Kingdom,
  South Korea and the United States, and requires "MiniMax H3" to be shown in the UI of a
  commercial product. This already applied to 1.4. Use in excluded territories needs a licence
  from MiniMax.
- **Krea 2 is gated:** the user must accept its licence on Hugging Face and provide `HF_TOKEN`.
- **FastH3 for first/last frame (I2V/FL2VA):** OmniRef is validated; the FL2VA FastH3 weights
  still have to be identified and qualified in step 3.
- **NGC image tag and llama.cpp revision** are pinned but not yet built on GB10: first build on
  the device may require a bump.
