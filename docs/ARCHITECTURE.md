# Architecture

French version: [fr/ARCHITECTURE.md](fr/ARCHITECTURE.md). Design decisions: [adr/](adr/).

## Overview

```
browser ──HTTP/WS──> studio (FastAPI, :8090)
                       ├─ /api/models   catalog + download (huggingface_hub)
                       ├─ /api/inputs   image upload → reference for jobs
                       ├─ /api/jobs     queue → one GPU worker → pipelines (diffusers, FastVideo)
                       ├─ /api/llm      llama-server (Gemma 4 E4B, 127.0.0.1:8095)
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
| `studio/files.py` | `FileStore`: uploads, `inputs/…` and `outputs/…` references |
| `studio/jobs.py` | `JobQueue`: submission, single worker, progress, cancellation, events |
| `studio/pipelines/` | `Pipeline` contract and registry; one subclass per engine |
| `studio/pipelines/krea2.py`, `qwen.py` | Image engines (Krea 2, Qwen Image 2.1): [IMAGE-ENGINES.md](IMAGE-ENGINES.md) |
| `studio/pipelines/common.py` | Parameter checks, the single resident pipeline, step progress, PNG output |
| `tools/qualify/` | Qualification cases built from the 1.4 prompt compilers, and their runner |
| `studio/llm.py` | `LlamaServer`: start on demand, OpenAI chat call, vision via base64 images |
| `studio/main.py` | HTTP/WebSocket API and static files |
| `web/` | Front end (status page today; Studio and Canvas port in step 4) |
| `docker/Dockerfile` | NGC PyTorch base + llama.cpp built for sm_121 |

## Job lifecycle

1. The client posts `{"pipeline": id, "params": {...}}`. `Pipeline.validate` rejects bad input
   (unknown parameter, missing image reference) with 422 before anything is queued, and returns
   the parameters the job keeps, defaults filled in and seed drawn.
2. The worker picks jobs in order. Missing models are downloaded first, inside the job, and the
   download shows in the job's own progress.
3. `Pipeline.run(params, model_paths, ctx)` renders and returns the files written under
   `ctx.output_dir`; the job lists them as references (`outputs/…`). `ctx.files` resolves image
   references. `ctx.progress()` reports progress and raises if the job was cancelled; the image
   engines call it at every denoising step, so a cancel stops a render within one step.
4. Status: `queued → running → done | error | cancelled`. Every change is pushed on `/api/ws`.

No code path creates a job by itself.

## Data directory

`STUDIO_DATA_DIR` (default `~/.local/share/studio`, `/data` in Docker):

```
models/<catalog id>/...   weights, plus .complete once fully downloaded
input/<hash>.<ext>        uploaded images (reference inputs/<hash>.<ext>)
output/<pipeline>/...     renders (reference outputs/<pipeline>/...)
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
| `STUDIO_DISK_RESERVE_GB` | `20` | Free space kept after any download |

## Renaming the product

The name appears in `studio/config.py` (`APP_NAME`), `pyproject.toml` (`name`), `compose.yaml`,
`README*.md` and the repository name. The import package (`studio`), environment prefix
(`STUDIO_`), image name and data directory are neutral and do not change. GitHub redirects the
old repository URL after a rename.
