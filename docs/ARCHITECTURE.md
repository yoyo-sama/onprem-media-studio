# Architecture

French version: [fr/ARCHITECTURE.md](fr/ARCHITECTURE.md). Design decisions: [adr/](adr/).

## Overview

```
browser ──HTTP/WS──> studio (FastAPI, :8090)
                       ├─ /api/models   catalog + download (huggingface_hub)
                       ├─ /api/inputs   image, clip or sound upload → reference for jobs
                       ├─ /api/jobs     queue → one GPU worker → pipelines (diffusers, FastVideo); CPU jobs on a second worker
                       ├─ /api/llm      llama-server (Gemma 4 26B-A4B, 127.0.0.1:8095)
                       ├─ /api/chat     creative assistant: roles, conversations, cards
                       ├─ /api/gallery  index of the outputs: search, thumbnails, tags, trash
                       ├─ /api/update   in-app update: git checkout, or the updater service (Docker)
                       ├─ /api/loras    LoRA list and upload
                       ├─ /api/instructions  Gemma instructions replaced in the settings
                       ├─ /api/ws       job and download events
                       ├─ /inputs       uploaded images
                       ├─ /outputs      rendered files
                       └─ /             front end (web/)
```

Everything runs in one process plus one `llama-server` child process, started on the first LLM
request.

## Code layout

| Path | Role |
|---|---|
| `studio/config.py` | Settings from environment variables; **the display name lives here only** |
| `studio/catalog.json` | Every downloadable model: repository, files, licence, gated, qualified |
| `studio/models.py` | `ModelStore`: installed state, resumable per-file download, disk check |
| `studio/import14.py` | `python -m studio.import14`: reuses the models and H3 LoRAs of a 1.4 install (identical files, shards rebuilt and checked by SHA-256) |
| `studio/files.py` | `FileStore`: uploads, `inputs/…` and `outputs/…` references |
| `studio/jobs.py` | `JobQueue`: submission, one GPU worker and one CPU worker (montage jobs, `Pipeline.gpu = False`), progress, cancellation, events, history in `jobs.json` |
| `studio/pipelines/` | `Pipeline` contract and registry; one subclass per engine |
| `studio/pipelines/krea2.py`, `qwen.py`, `moss.py` | Image engines (Krea 2, Qwen Image 2.1, MOSS-Image): [IMAGE-ENGINES.md](IMAGE-ENGINES.md) |
| `studio/pipelines/h3.py` | Video engines (MiniMax H3: text, image, first/last image and references to video), geometry and refine schedule: [H3.md](H3.md) |
| `studio/pipelines/h3_runtime.py` | FastVideo adapter: Spark recipes, NVFP4 profile, latent output and refine-pass overrides, cancellation |
| `studio/pipelines/h3_upscaler.py`, `h3_lora.py` | H3 latent upscaler (3D conv, LBH v1 checkpoint) and LoRA stack (exact merge into one side branch) |
| `studio/pipelines/montage.py` | CPU jobs on rendered files with ffmpeg and Pillow: `video-concat` (clips end to end), `image-grid` (contact sheet), `video-frames` (frames near a clip's end, for Relay transitions); they run on the CPU worker, never behind a render |
| `studio/pipelines/upscale.py` | `upscale-2x`: an image or a video twice as large through the SPAN network, on a gallery click: [IMAGE-ENGINES.md](IMAGE-ENGINES.md#upscale-2) |
| `studio/pipelines/common.py` | Parameter checks, the pipelines kept in memory (least recently used freed when the next does not fit), step progress, PNG output |
| `tools/qualify/` | Qualification cases built from the 1.4 prompt compilers, and their runner |
| `studio/llm.py` | `LlamaServer`: start on demand (32k context, one slot), OpenAI chat call, streamed call with tools, vision via base64 images; stopped when an H3 engine needs the memory, and before every r2v render |
| `studio/gallery.py` | `Gallery`: SQLite/FTS5 index of the outputs, thumbnails, tags, favourites, rename, trash: [GALLERY.md](GALLERY.md) |
| `studio/update.py`, `loras.py` | In-app update (git fast-forward and restart in place, or forwarded to the updater service under Docker) and LoRA upload: [GALLERY.md](GALLERY.md) |
| `docker/updater/server.py` | The `updater` service of `compose.yaml`: pull, image rebuild, studio container recreated once the queue is empty: [GALLERY.md](GALLERY.md#docker-docker-compose) |
| `studio/assistant/` | Creative assistant: role registry (`roles.py`, shipped roles in `roles/*.md`), tools and their checks (`tools.py`), routing, turns and conversations (`chat.py`, `/api/chat`, `/api/roles`, `/api/chats`): [ASSISTANT.md](ASSISTANT.md) |
| `studio/instructions.py` | Gemma instructions replaced in the interface, kept in `STUDIO_DATA_DIR/instructions.json` (`/api/instructions`); the defaults live in `web/js/prompts.js` |
| `studio/guard.py` | Same-origin check of the routes that move or write files |
| `studio/main.py` | HTTP/WebSocket API and static files; `/api/health` gives the app, GPU, memory, LLM state, the number of jobs in the queue, of model downloads outside a job, and whether the queue is held for an update |
| `web/index.html`, `web/canvas.html` | Front end: the Studio and the Canvas, ported from 1.4, no build step: [FRONTEND.md](FRONTEND.md) |
| `web/js/prompts.js` | Prompt compilers and Gemma instructions of 1.4, one copy for both pages (prompts are compiled in the front end, ADR 0001) |
| `tools/parity-prompts.js`, `tools/prompt-systems.js` | Front-end regression tests against 1.4: prompt parity and the Gemma instruction per engine: [FRONTEND.md](FRONTEND.md#tests) |
| `docker/Dockerfile` | NGC PyTorch base + llama.cpp built for sm_121 + FastVideo and its kernels built for sm_121a |

## Job lifecycle

1. The client posts `{"pipeline": id, "params": {...}, "origin": feature}` (`origin`, optional,
   names the front-end feature for the gallery and is never read by a pipeline). `Pipeline.validate` rejects bad input
   (unknown parameter, missing image reference) with 422 before anything is queued, and returns
   the parameters the job keeps, defaults filled in and seed drawn.
2. The worker picks jobs in order. Missing models (`Pipeline.models`) are downloaded first,
   inside the job, and the download shows in the job's own progress.
3. `Pipeline.run(params, model_paths, ctx)` renders and returns the files written under
   `ctx.output_dir`; the job lists them as references (`outputs/…`). `ctx.files` resolves image
   references. `ctx.progress()` reports progress and raises if the job was cancelled; the image
   engines call it at every denoising step, so a cancel stops a render within one step. The video
   engines interrupt FastVideo directly (H3.md).
4. Status: `queued → running → done | error | cancelled`. Every change is pushed on `/api/ws`;
   a finished job's outputs are in the gallery before its `done` event is sent. A restart
   (`docker compose up -d --build`, an update) cuts the running job and the queued ones. The last
   200 jobs are kept in `STUDIO_DATA_DIR/jobs.json` (and in memory, with any job still queued or
   running), written at each change of status: after a
   restart, a job that was queued or running is read back as failed with `interrupted: true`
   ("the server restarted during this job"), and the Studio's job queue lists it with a "Launch
   again" button (`POST /api/jobs/{id}/retry`: same parameters as first sent, same seed). It
   never runs again by itself. Job ids carry a per-start prefix (`job-<6 hex>-<n>`), so a page
   never mistakes a new job for the one it waited on. When the socket reconnects, a page still
   waiting for a job reads its state, failed if a restart cut it, instead of keeping its last
   progress forever. An assistant card stored as running before the server started is read
   back as failed for the same reason, so its button works again.

No code path creates a job by itself.

## Data directory

`STUDIO_DATA_DIR` (default `~/.local/share/studio`, `/data` in Docker):

```
models/<catalog id>/...   weights, plus .complete once fully downloaded
input/<hash>.<ext>        uploaded images (reference inputs/<hash>.<ext>)
output/<pipeline>/...     renders (reference outputs/<pipeline>/...)
loras/h3/<file>.safetensors   H3 LoRAs, referenced by file name
cache/h3-loras/...        merged LoRA stacks
cache/thumbs/...          gallery thumbnails
gallery.db                gallery index, tags and favourites
chats/<id>.json           assistant conversations
roles/<id>.md             assistant roles replaced or added by the user
output/.trash/...         gallery trash (purged by hand)
```

## Configuration

| Variable | Default | Use |
|---|---|---|
| `STUDIO_APP_NAME` | `OnPrem Media Studio` | Display name |
| `STUDIO_DATA_DIR` | `~/.local/share/studio` | Models and outputs |
| `STUDIO_HOST` / `STUDIO_PORT` | `0.0.0.0` / `8090` | Listening address |
| `HF_TOKEN` | — | Gated repositories (Krea 2); never logged |
| `STUDIO_LLAMA_SERVER` | `llama-server` | Path to the llama.cpp server binary |
| `STUDIO_LLM_PORT` | `8095` | Loopback port of llama-server |
| `STUDIO_LLM_MODEL` | `gemma4-26b-a4b` | Catalog id of the LLM of the assistant and the enrichments; `gemma4-26b-a4b` is the only one |
| `STUDIO_DISK_RESERVE_GB` | `20` | Free space kept after any download |
| `STUDIO_GALLERY_SCAN` | `60` | Seconds between two gallery scans of the output folder |
| `STUDIO_UPDATE_BRANCH` | `main` | Branch the in-app update follows (bare metal, and the updater service through `.env`) |
| `STUDIO_UPDATER_URL` | — | Docker: the updater service (`compose.yaml` sets `http://updater:8091`) |
| `STUDIO_GIT_TOKEN` | — | Docker, in `.env`: GitHub token the updater service reads a private repository with; never logged |

## Renaming the product

The name appears in `studio/config.py` (`APP_NAME`), `pyproject.toml` (`name`), `compose.yaml`,
`README*.md` and the repository name. The import package (`studio`), environment prefix
(`STUDIO_`), image name and data directory are neutral and do not change. GitHub redirects the
old repository URL after a rename.
