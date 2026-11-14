# Handover

French version: [fr/HANDOVER.md](fr/HANDOVER.md).

This page lets someone (a person or an AI model) pick up the development of OnPrem Media Studio
with no earlier context. It is a snapshot of **2026-11-12, `main` at `21148ea`** (PR #33). It
summarises and points to the reference documents; when they disagree with this page, the code
and the reference documents win. Read next, in this order: [AGENTS.md](../AGENTS.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [LESSONS.md](LESSONS.md),
[adr/0001-inference-stack.md](adr/0001-inference-stack.md), then the engine page you need
([IMAGE-ENGINES.md](IMAGE-ENGINES.md), [H3.md](H3.md)).

## 1. Goal and scope

OnPrem Media Studio 2.0 is a private AI image and video studio that runs entirely on the user's
machine. It succeeds AI Content Studio 1.4 (repository `yoyo-sama/dellaicontent`, a static front
end driving ComfyUI and Ollama). The goals set by the project owner (GitHub `yoyo-sama`) on
2026-10-29:

- **Self-contained**: no ComfyUI, no Ollama, no cloud generation. The app runs the models itself
  and downloads the weights it needs on first use.
- **Same feature coverage as 1.4**: Text2Image, Image2Image, campaign, subject and setting
  sheets, the storyboard director (sheets, shot images, cuts, animatic), reference to video,
  Relay, the Canvas, the gallery, the in-app update. Plus, new in 2.0: the creative assistant
  (a chat with roles), MOSS-Image, Upscale ×2, LoRA stacks on every engine.
- **The 1.4 lessons carry over** ([LESSONS.md](LESSONS.md)).
- **Targets**: DGX OS on a GB10 (ARM64, unified memory) first, in Docker. Ubuntu next. Omarchy
  and Windows 11 (x86 and ARM64) later. Bare metal later (see § 9).
- **The product name must stay easy to change**: it lives in `studio/config.py` (`APP_NAME`,
  `STUDIO_APP_NAME`) only; the package is `studio`, the environment prefix `STUDIO_`.
- **Maestro and WanGP are references only** (non-commercial licence): never copy their code,
  never depend on them.

The repository is **public** since 2026-11-10.

## 2. Architecture in one screen

One Docker container, one port (8090), one Python process (FastAPI) with one GPU worker thread
and one CPU worker thread, plus a `llama-server` child process for Gemma started on demand. A
second compose service, `updater`, does the in-app update. Details:
[ARCHITECTURE.md](ARCHITECTURE.md).

| Concern | Choice |
|---|---|
| Server | FastAPI (`studio/main.py`), job queue `studio/jobs.py` (history in `data/jobs.json`) |
| Image engines | Hugging Face diffusers 0.42.1, official weights (`studio/pipelines/krea2.py`, `qwen.py`, `moss.py`) |
| Video engines | FastVideo (pinned commit in `docker/Dockerfile`) for MiniMax H3 (`h3.py`, `h3_runtime.py`, `h3_upscaler.py`, `h3_lora.py`) |
| LLM | llama.cpp `llama-server` b11982 built for sm_121, Gemma 4 26B-A4B GGUF + mmproj (`studio/llm.py`) |
| Model download | `huggingface_hub`, per file, `.complete` marker, pinned `revision` per catalog entry (`studio/models.py`, `studio/catalog.json`) |
| Prompt compilers | The 1.4 JavaScript engine ported to English, in the front end (`web/js/prompts.js`); the backend only runs inference and receives final prompts (ADR 0001) |
| Front end | `web/index.html` (Assistant and Studio modes) and `web/canvas.html`, no build step, FR/EN/ES/DE ([FRONTEND.md](FRONTEND.md)) |
| Assistant | `studio/assistant/` (roles in `roles/*.md`, tools, `/api/chat` over SSE) ([ASSISTANT.md](ASSISTANT.md)) |
| Gallery, update, LoRA upload | `studio/gallery.py` (SQLite/FTS5), `studio/update.py`, `docker/updater/server.py`, `studio/loras.py` ([GALLERY.md](GALLERY.md)) |
| Packaging | NGC PyTorch **25.11** base image (torch 2.10, CUDA 13), exact Python versions in `docker/constraints.txt` |

Key contract: a pipeline is a `Pipeline` subclass (`studio/pipelines/`) with the catalog ids it
needs (`models`), a `validate()` that refuses unknown parameters with 422 and returns the
normalised ones, and a `run()`. Nothing creates a job except a client post.

## 3. Engines and models

All entries of `studio/catalog.json` are `"qualified": true`, each pinned to the Hugging Face
commit of its qualified render.

| Pipeline id | Use | Model (catalog id) | Licence | Qualified |
|---|---|---|---|---|
| `krea2-t2i` | Text to image, campaign, sheets | Krea 2 Turbo (`krea2-turbo`), 8 steps | Krea 2 licence, **gated** (`HF_TOKEN` + licence accepted on Hugging Face) | gb10-demo, 2026-10-30 (7/7 cases) |
| `qwen-image-2.1` | Image to image, shot images (sheets + setting + references), text to image | Qwen Image 2.1 (`qwen-image-2.1`) with the Lightning v2 RL transformer (`qwen-image-2.1-lightning`), 4 steps | Qwen Research License, **non-commercial** | base 2026-10-30; Lightning on promaxgb10-95c7, 2026-11-07 (LESSONS #46) |
| `moss-image` | Text to image with text in the image | MOSS-Image SFT (`moss-image-sft`) + turbo LoRA (`moss-image-turbo-lora`); modes Preview 4 / Standard 8 (default) / Quality 25 | Apache-2.0 | promaxgb10-95c7, 2026-11-08 |
| `h3-t2v`, `h3-i2v` | Text, image, first/last image (FL2VA) to video with audio | FastH3 V2 NVFP4 (`fasth3-v2-nvfp4`) | MiniMax H3 Community License (**excludes EU, UK, South Korea, USA**; a commercial product must show "MiniMax H3") | gb10-demo, 2026-10-30 |
| `h3-r2v` | References (≤9 images, 3 clips, 3 sounds) to video, two passes | FastH3 OmniRef NVFP4 (`fasth3-omniref-nvfp4`) + latent upscaler (`h3-latent-upscaler`, Apache-2.0) | as above | gb10-demo, 2026-10-30 |
| `upscale-2x` | Image or video ×2 from the gallery | SPAN 2xNomosUni (`span-2x-nomosuni`) through spandrel | CC BY 4.0 (credited in `NOTICE`) | gb10-demo, 2026-11-06 |
| (LLM) | Prompt enrichment and the assistant chat | Gemma 4 26B-A4B Q4_0 (`gemma4-26b-a4b`) | Apache-2.0 | 2026-11-07 (ADR 0001 amendment) |
| `video-concat`, `image-grid`, `video-frames` | Montage on the CPU worker (ffmpeg, Pillow) | none | — | — |

**Dropped, and why** (do not bring them back without the owner asking):

| Model | Dropped on | Reason |
|---|---|---|
| LTX 2.5 (and every LTX) | 2026-10-29 | Owner's decision: MiniMax H3 replaces it on every video path |
| Qwen-Image-Edit 2509 | 2026-10-29 | Not required: Qwen Image 2.1 covers every 1.4 edit (symmetric references, up to 10 images) |
| H3 FP8 checkpoints (`FastH3-8-Step-V2-FP8`, `FastH3-OmniRef-FP8`) and `STUDIO_H3_PRECISION` | 2026-11-07 (PR #16) | Never rendered, so never qualified; the owner wants no unvalidated model listed |
| Gemma 4 E4B | 2026-11-07 (PR #17) | One LLM is enough; 26B-A4B follows the long role instructions and calls tools |
| Qwen Image 2.1 base transformer (25 steps) and the official 8-step Turbo | 2026-11-07 (PR #18) | Lightning is 2.9 to 3.6 times faster with identity kept; Turbo was only 2× faster, darker and duller |
| torchao FP8 on image engines | 2026-11-05 | 300 times slower per step on the GB10 (LESSONS #43) |
| `torch.compile` on Krea 2 | 2026-11-05 | About 33 s of compile per size for 6 s saved per image |
| DLSS 5, RTX Video SDK, nvidia-vfx | 2026-11-06 | Nothing from NVIDIA runs on the GB10 (Windows or x86 only, game engines); SPAN replaces them (LESSONS #44) |
| MOSS community LoRAs (Fizgig, KOOK, lodestones DMD, Kromoss…) | 2026-11-07 | Redundant, no licence, or worse renders than the turbo LoRA at 8 steps |

**Known engine limits**: FL2VA shows a ghost second head (frames ~30–100) when the first and last
images differ strongly in framing, lead unverified ([H3.md](H3.md#qualification)); H3 clips are
5 to 15 s (FastVideo); MOSS Preview may double a title word, Standard pulls towards sunset light;
Qwen Lightning adds contrast and stray structures in text to image; at most two subjects per
shot image (LESSONS #24).

## 4. Install and update under Docker

The README holds the verified steps ([README.md](../README.md#run-with-docker)). In short, on the
machine:

```bash
git clone https://github.com/yoyo-sama/onprem-media-studio.git && cd onprem-media-studio
scripts/docker-install.sh --check   # changes nothing; says what to fix (Docker, NVIDIA toolkit, port, disk)
scripts/docker-install.sh           # .env (600) from .env.example, ./data, build, start, wait for /api/health
nano .env                           # HF_TOKEN=hf_... (Krea 2 only), then: docker compose up -d
```

- Port 8090 is also 1.4's: on a machine running 1.4, set `STUDIO_HOST_PORT=8096` in `.env`.
- Models and renders live in `./data` (`STUDIO_DATA` for another disk); plan for 300 GB.
- `python -m studio.import14` reuses the H3 upscaler, the Qwen 2.1 text encoder and the H3 LoRAs
  of a 1.4 install (README § Reuse files).
- **Update**: the Monitor panel's "Update" row asks the `updater` service to `git pull`, rebuild
  the image, hold the queue and recreate the studio once no job runs. By hand:
  `git pull && scripts/docker-install.sh` (it refuses while a job runs or a model downloads).
- **The updater never rebuilds itself**: after a change to `docker/updater/`, run
  `docker compose up -d --build updater` once on each machine (the Monitor says so,
  `updater_stale`).
- `web/` and `studio/` are copied into the image: a `git pull` alone changes nothing on a running
  machine, the image must be rebuilt; then Ctrl+Shift+R in the browser.
- Diagnosis: `curl -s localhost:8090/api/health`, and
  `docker logs studio 2>&1 | grep -E "llm:|engine:|render:"` (a slow chat turn is easily
  mistaken for a slow render).

## 5. Test machines

Three GB10s (DGX OS, ARM64, ~121 GiB unified memory). **Do not assume paths, users or state from
one to another.**

| Machine | User | Role |
|---|---|---|
| `gb10-demo` | `spark` | First 2.0 test machine (qualifications of 2026-10-30, Upscale ×2). Was short on disk on 2026-10-30. |
| `promaxgb10-95c7` | `spark` | The owner's machine running the Docker install (repo `/home/spark/onprem-media-studio`, container `studio`). Most measurements since 2026-11-07. Reached through Remote Control, which the owner turns on from Claude Desktop; its Claude session may not run `docker compose build` itself, the owner then runs it by hand. `data/` is root-owned there: write into it through `docker exec`. Holds ~200 GB of another tool's ComfyUI models in `~/.zcode`: not ours, leave them. |
| `promaxgb10-6c5f` | `sparks` | Hosts **1.4** (ComfyUI, `comfyui-nvidia`, open-webui, spark-control-center). Not a 2.0 test machine. |

Before testing a branch on a machine, write down its current branch and the `studio.commit`
label of its running image (`docker inspect studio --format '{{index .Config.Labels "studio.commit"}}'`),
and put it back afterwards. On 2026-11-09 a test silently dropped a fix that the machine was
running from another branch.

Renders and qualifications happen on a GB10 only. The cloud container used by Claude sessions
cannot reach huggingface.co or download.pytorch.org (PyPI and GitHub work), so torch tests
(`tests/test_image_lora_models.py`) run on the GB10 only.

## 6. Rules learned (beyond LESSONS.md)

The owner's standing rules are in [AGENTS.md](../AGENTS.md); the 49 technical lessons in
[LESSONS.md](LESSONS.md). The ones most often at stake:

1. **No unqualified model in the catalog.** An entry is added `"qualified": false`; only a real
   render on the GB10, looked at (frames, edges, gradients, audio) and **accepted by the owner**,
   sets it to true, with `revision` pinned to the commit of that render. A `success` status
   proves nothing.
2. **Never rebuild or restart the studio while a job runs or a model downloads.** Jobs live in
   server memory; a rebuild on 2026-11-08 killed an H3 OmniRef render. Use
   `scripts/docker-install.sh` (it checks) and tell the owner to wait for running jobs before
   any `docker compose up -d --build`.
3. **Nothing renders without a click**, and **the user's prompt is sent verbatim** (graph
   invariants are re-appended by code). Tested by `tools/assistant-ui.js` and
   `tools/prompt-systems.js`.
4. **GB10 speed**: never memory-map weights (`disable_mmap`, `common.from_pretrained`,
   `h3_runtime.WholeFile`/`RangeFile`); no torchao FP8; `torch.compile` only where it pays
   (Qwen only before Lightning, now off); measure available system memory, not "free VRAM".
5. **Memory**: only one H3 engine fits; Gemma (17 GB) is stopped before every r2v render and
   when an H3 engine needs the memory; image engines stay resident while memory allows (LRU).
6. **FlashInfer**: `MAX_JOBS=4` and its cache on `/data/cache`, or the first NVFP4 job runs the
   GB10 out of memory (LESSONS #36).
7. **H3 image references are only ever downscaled** to a 2048 px short edge, as ComfyUI does
   (FastVideo upscales them: 2.6× slower r2v, LESSONS #38).
8. **Gemma thinking**: off for compile calls (`enable_thinking: false`; it cost 44–81 s per call);
   the chat keeps it, capped at 2048 thinking tokens then asked again without thinking.
   llama.cpp b11982 has no `--reasoning-budget` and no `--no-mmap`.
9. **Pin what was qualified**: model revisions in the catalog, Python versions in
   `docker/constraints.txt`, the NGC base tag, the llama.cpp tag and the FastVideo commit in the
   Dockerfile. peft stays below 0.19 (0.19+ refuses NGC 25.11's torchao).
10. **Upgrading FastVideo**: re-check the two stage classes wrapped by
    `h3_runtime.report_stages` (`MiniMaxH3DenoisingStage`, `MiniMaxH3VideoDecodingStage`) and the
    per-step `scheduler.step` call; keep the never-upscale reference rule.
11. **Measure, don't guess**: every speed change in this project came from a bench script in
    `tools/qualify/` (`load_speed.sh`, `render_speed.sh`, `qwen_fast_bench.sh`, `moss_bench.py`,
    `run_upscale.py`). A bench run with `docker exec -i studio python - < script` shows only as
    `python -` in the container; never run two benches at once (both may restart the studio).

## 7. How work is done

- Code, comments, logs, commit messages, PR descriptions and documents are in **English**; every
  document has a French translation under `docs/fr/` (and `README.fr.md`), updated in the same
  change. The interface is FR/EN/ES/DE, informal "you".
- One branch and one PR per piece of work, from `main`. The owner reads the PR and says when to
  merge; a branch whose PR merged restarts from `main` for new work.
- Before asking for a merge: `python -m pytest`, and for any front-end, prompt or instruction
  change `node tools/parity-prompts.js` (needs `../dellaicontent`), `tools/prompt-systems.js`,
  `tools/assistant-ui.js`, `tools/lora-ui.js`, `tools/relay-ui.js` (commands in AGENTS.md). GitHub Actions runs them
  on every PR; the parity test only when the `DELLAICONTENT_TOKEN` secret is set.
- Changing a prompt compiler or a Gemma instruction makes the parity and fingerprint tests fail
  on purpose: update the reference in the same commit and say why.
- "Simplest thing that works": no option, abstraction or feature beyond what was asked.

## 8. PR history

| PRs | Date | Content |
|---|---|---|
| #1, #4 | 2026-10-30 | Step 1: FastAPI server, model catalog and download, job queue, Gemma via llama.cpp, Docker image; fixes from the first GB10 build |
| #2 | 2026-10-30 | Step 2: Krea 2 and Qwen Image 2.1 engines, qualified |
| #3 | 2026-10-30 | Step 3: MiniMax H3 through FastVideo (t2v/i2v/FL2VA on FastH3 V2, two-pass Ref2VA on OmniRef with our latent upscaler, LoRA stack), NVFP4 qualified |
| #5 | 2026-10-30 | Step 4: Studio and Canvas front end ported from 1.4, gallery, in-app update, i18n, bare-metal `install.sh` (paused) |
| #6, #7 | 2026-10-30 | Engines kept resident (LRU memory budget); `studio.import14` reuses 1.4 files |
| #8, #9 | 2026-10-31 → 11-01 | Creative assistant (7 roles, cards, animated character, first mode); render progress on cards, sheets handed to the director, sheet from a photo, Gemma thinking off for compile calls |
| #10 | 2026-11-05 | Loads without memory mapping, compiled Qwen, render timing logs, video player and "Regenerate the video" |
| #11, #12 | 2026-11-05 → 06 | Reference to video from the assistant card and the Studio with image, clip and sound references; one-scene videos go to the r2v card |
| #13 | 2026-11-08 | H3 render log lines; chat thinking budget |
| #14 | 2026-11-06 | Upscale ×2 (SPAN), after ruling out DLSS 5 |
| #15, #16 | 2026-11-07 | In-app update under Docker (`updater` service); H3 FP8 removed |
| #17, #18, #19 | 2026-11-08 | Gemma 26B-A4B only; Qwen 2.1 on Lightning (4 steps); MOSS-Image engine |
| #20 → #23 | 2026-11-08 | Jobs cut by a restart shown as failed; code review follow-up (job history and retry, CPU lane, queue hold, pinned revisions, constraints, CI, Gemma off during r2v); gallery "Inputs"; review items 9, 10, 20 |
| #24 → #27 | 2026-11-08 → 09 | Update row in the Monitor; LoRA stacks (max 4); style LoRAs on Krea 2, Qwen 2.1 and MOSS (name-prefix classification, three community layouts, MOSS fused qkv) |
| #28, #29 | 2026-11-09 | `scripts/docker-install.sh` and `.env.example`; `updater_stale` |
| #30 | 2026-11-09 | H3 progress per denoising step |
| #31 → #33 | 2026-11-10 | README install as numbered steps; licences of MOSS-Image, its turbo LoRA and Gemma 4 |
| **#34 (open)** | 2026-11-10 | Docs for the public repository: no token to clone or update; `STUDIO_GIT_TOKEN` kept for a private fork. Waiting for the owner's go to merge. Until it merges, README and `.env.example` on `main` still describe a private repository. |

## 9. Open items

Nothing below was asked to be done now; each waits for the owner.

**Checks on a GB10**
- H3 progress bar (PR #30, merged before any GPU render): confirm on promaxgb10-95c7 that it moves
  step by step on an H3 render.
- FastH3 OmniRef r2v timing on promaxgb10-95c7 after the latest update (the load time gain of
  review item 10 shows on the next `engine:` log line of an H3 load; 153 s measured before).
- r2v with clip and sound references (PR #11): never rendered on a GB10.
- Character sheet from a photo (Qwen Image 2.1, PR #9): never qualified.
- The SPAN upscaler weights are not yet downloaded on promaxgb10-95c7 (automatic on first use).

**Known defects and leads**
- FL2VA ghost head (§ 3): lead is to stop writing the shot's camera motion in a cut prompt that
  has an end image; to verify with a render.
- Qwen_2.1-Unchained LoRA at strength 1: darker image with a fine dot grid (clean at 0.5); the
  `[gate; up]` split order of its fused keys is unsettled. Advice given: use it at 0.5–0.7.
- Unused: the optional MTP draft file of the Gemma GGUF repository (faster decoding).

**Deliberately not done (owner's decisions)**
- **Security items "P4" of the 2026-11-08 code review**: an access token or authentication on
  :8090, a global same-origin middleware, an Origin check on the WebSocket, a shared secret
  between the studio and the updater, a non-root container. Excluded by the owner; propose again
  only if asked.
- Install review of 2026-11-09: D4–D8 (`data/` owned by root, Triton/CUDA caches outside `/data`
  to measure…), U2 (security), and B1–B6 for bare metal.
- **Bare-metal install paused** since 2026-10-30 ("a working Docker solution first"):
  `scripts/install.sh` and [INSTALL.md](INSTALL.md) exist but are not maintained; they ignore
  `docker/constraints.txt` and use an unqualified PyPI torch 2.12 (Docker runs NGC torch 2.10).
- **The assistant in the Canvas** is on the roadmap, not started.
- Omarchy and Windows 11 targets: not started.
- Image LoRAs are not sent by the storyboard, campaign and sheet flows (not asked).

**Documentation drift**: [ROADMAP.md](ROADMAP.md) still marks step 1 "first build on GB10
pending" and step 4 "full pass on the GB10 pending"; both happened on 2026-10-30 (step 4's
bare-metal part excepted). Update it when the roadmap is next touched.

## 10. Working with the owner

- Write to the owner **in French** (chat, threads, decision cards). Code, commits, PRs and
  documents stay in English, documents with their French translation.
- Give **verified, self-contained steps**: the exact commands in order, which machine and folder,
  what to wait for, and what result to expect (for example the `git log --oneline -1` title to
  see). The owner dislikes trial-and-error commands. A front-end change still needs an image
  rebuild (§ 4); saying "git pull is enough" was wrong once.
- Before any rebuild instruction, say to wait for running jobs to end.
- The owner decides scope and qualification: propose, recommend one option, and do not add
  features, options or models that were not asked for.
- Licences matter (Dell demonstration context): recall the MiniMax H3 territory exclusions and
  the Qwen Image 2.1 non-commercial licence whenever commercial use comes up.
