# Handover

French version: [fr/HANDOVER.md](fr/HANDOVER.md).

This page lets someone (a person or an AI model) pick up the development of OnPrem Media Studio
with no earlier context. It is a snapshot of **2026-11-23, `main` at `756bc78`** (PR #56, the
last merged; no pull request open). It summarises and points to the reference documents; when
they disagree with this page, the code and the reference documents win. Read next, in this
order: [AGENTS.md](../AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), [LESSONS.md](LESSONS.md),
[adr/0001-inference-stack.md](adr/0001-inference-stack.md), then the page of the part you work
on ([IMAGE-ENGINES.md](IMAGE-ENGINES.md), [H3.md](H3.md), [LONG-VIDEO.md](LONG-VIDEO.md),
[FRONTEND.md](FRONTEND.md), [ASSISTANT.md](ASSISTANT.md), [GALLERY.md](GALLERY.md)).

## 1. Goal and scope

OnPrem Media Studio 2.0 is a private AI image and video studio that runs entirely on the user's
machine. It succeeds AI Content Studio 1.4 (repository `yoyo-sama/dellaicontent`, a static front
end driving ComfyUI and Ollama). The goals set by the project owner (GitHub `yoyo-sama`) on
2026-10-29:

- **Self-contained**: no ComfyUI, no Ollama, no cloud generation. The app runs the models itself
  and downloads the weights it needs on first use.
- **Same feature coverage as 1.4**, reshaped since: Text2Image, Image2Image, campaign, subject
  and setting sheets, video from references, the long take (with the 1.4 storyboard folded into
  it), the Canvas, the gallery, the in-app update. New in 2.0: the creative assistant (a chat
  with roles), MOSS-Image, Upscale ×2, LoRA stacks on every engine.
- **Long videos** are the owner's main goal since mid-November: videos of a minute or more where
  the subjects (face, hair, build, clothes) and the scene stay the same from start to end, with
  as little interaction as possible (brief → length → one click, no review step), § 4.
- **The 1.4 lessons carry over** ([LESSONS.md](LESSONS.md), 58 entries now).
- **Targets**: DGX OS on a GB10 (ARM64, unified memory) first, in Docker. Ubuntu next. Omarchy
  and Windows 11 (x86 and ARM64) later. Bare metal later (see § 10).
- **The product name must stay easy to change**: it lives in `studio/config.py` (`APP_NAME`,
  `STUDIO_APP_NAME`) only; the package is `studio`, the environment prefix `STUDIO_`.
- **Maestro and WanGP are references only** (non-commercial licence): never copy their code,
  never depend on them.

The repository is **public** since 2026-11-10: name the owner by GitHub login only, and write
no LAN address, account name or private link in it.

## 2. Architecture in one screen

One Docker container, one port (8090), one Python process (FastAPI) with one GPU worker thread
and one CPU worker thread, plus a `llama-server` child process for Gemma started on demand. A
second compose service, `updater`, does the in-app update. Details:
[ARCHITECTURE.md](ARCHITECTURE.md).

| Concern | Choice |
|---|---|
| Server | FastAPI (`studio/main.py`), job queue `studio/jobs.py` (history in `data/jobs.json`) |
| Image engines | Hugging Face diffusers 0.42.1, official weights (`studio/pipelines/krea2.py`, `qwen.py`, `moss.py`, LoRA loading in `image_lora.py`) |
| Video engines | FastVideo (pinned commit in `docker/Dockerfile`) for MiniMax H3 (`h3.py`, `h3_runtime.py`, `h3_upscaler.py`, `h3_lora.py`), plus two patches of FastVideo's latent preparation for the long take: `h3_continue.py` (a clip continues the previous one's last 7 video latents) and `h3_start_frame.py` (a start picture held 22 frames in a Ref2VA render) |
| Montage | `studio/pipelines/montage.py`: `video-concat`, `image-grid`, `video-frames` on the CPU worker, `video-stitch` on the GPU (a take decoded once from its latents, sound at -18 LUFS) |
| LLM | llama.cpp `llama-server` b11982 built for sm_121, Gemma 4 26B-A4B GGUF + mmproj (`studio/llm.py`) |
| Model download | `huggingface_hub`, per file, `.complete` marker, pinned `revision` per catalog entry (`studio/models.py`, `studio/catalog.json`) |
| Prompt compilers | The 1.4 JavaScript engine ported to English, in the front end (`web/js/prompts.js`); the backend only runs inference and receives final prompts (ADR 0001) |
| Front end | `web/index.html` (Assistant and Studio modes) and `web/canvas.html`, ES modules in `web/js/` (`studio.js` form and flows, `director.js` long take, `form.js` pipelines and controls, `chat.js` assistant, `gallery.js`, `canvas*.js`), no build step, FR/EN/ES/DE ([FRONTEND.md](FRONTEND.md)) |
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
| `krea2-t2i` | Text to image, campaign, sheets from a brief | Krea 2 Turbo (`krea2-turbo`), 8 steps | Krea 2 licence, **gated** (`HF_TOKEN` + licence accepted on Hugging Face) | gb10-demo, 2026-10-30 (7/7 cases) |
| `qwen-image-2.1` | Image to image (up to 10 images), sheet from a photo, text to image | Qwen Image 2.1 (`qwen-image-2.1`) with the Lightning v2 RL transformer (`qwen-image-2.1-lightning`), 4 steps | Qwen Research License, **non-commercial** | base 2026-10-30; Lightning on promaxgb10-95c7, 2026-11-07 (LESSONS #46) |
| `moss-image` | Text to image with text in the image | MOSS-Image SFT (`moss-image-sft`) + turbo LoRA (`moss-image-turbo-lora`); modes Preview 4 / Standard 8 (default) / Quality 25 | Apache-2.0 | promaxgb10-95c7, 2026-11-08 |
| `h3-t2v`, `h3-i2v` | Text, image, first/last image (FL2VA) to video with audio | FastH3 V2 NVFP4 (`fasth3-v2-nvfp4`) | MiniMax H3 Community License (**excludes EU, UK, South Korea, USA**; a commercial product must show "MiniMax H3") | gb10-demo, 2026-10-30 |
| `h3-r2v` | References (≤9 images, 3 clips, 3 sounds) to video, two passes; also takes `image` (a start picture, held) or `continue_from` (the clip it continues) for the long take | FastH3 OmniRef NVFP4 (`fasth3-omniref-nvfp4`) + latent upscaler (`h3-latent-upscaler`, Apache-2.0) | as above | gb10-demo, 2026-10-30; `continue_from` 2026-11-20 and the held start picture 2026-11-22 on promaxgb10-95c7 |
| `upscale-2x` | Image or video ×2 from the gallery | SPAN 2xNomosUni (`span-2x-nomosuni`) through spandrel | CC BY 4.0 (credited in `NOTICE`) | gb10-demo, 2026-11-06 |
| (LLM) | Prompt enrichment, the long take's split, image description, the assistant chat | Gemma 4 26B-A4B Q4_0 (`gemma4-26b-a4b`) | Apache-2.0 | 2026-11-07 (ADR 0001 amendment) |
| `video-stitch` | A long take: continuing clips decoded once from their latents, cuts as they are, sound at -18 LUFS | the OmniRef video VAE (`fasth3-omniref-nvfp4`) | as H3 | promaxgb10-95c7, by script then through the UI, 2026-11-20 |
| `video-concat`, `image-grid`, `video-frames` | Montage on the CPU worker (ffmpeg, Pillow) | none | — | — |

**Dropped, and why** (do not bring them back without the owner asking):

| Model or feature | Dropped on | Reason |
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
| Long take from key images (Qwen key per segment + FL2VA, PR #43, closed unmerged) | 2026-11-19 | Hours of tests, worse than the start (framing missed one key in 5, elastic motion, ghosts); replaced by latent continuation ([LONG-VIDEO.md](LONG-VIDEO.md)) |
| The Studio storyboard (shot list, shot images, animatic) and the assistant's storyboard card | 2026-11-21 (PR #52) | Folded into the long take after a good three-scene render; the **Canvas keeps its storyboard card** |
| The r2v director with sheets to approve ("Consistent character + setting"), "Skip the sheets", r2v style | 2026-11-21 (PR #53) | Replaced by one "Video from references" form, one click, one job |
| MiniMax-H3-Image for sheets, the hybrid FL2VA/Ref2VA checkpoint, RefMods | evaluated 2026-11-13/16, not adopted | Too large for the GB10 as is, unqualified, licence "other"; sheets went to Qwen 2.1 instead |

**Known engine limits**: FL2VA shows a ghost second head (frames ~30–100) when the first and last
images differ strongly in framing, lead unverified ([H3.md](H3.md#qualification)); H3 clips are
5 to 15 s (FastVideo); MOSS Preview may double a title word, Standard pulls towards sunset light;
Qwen Lightning adds contrast and stray structures in text to image; at most two subjects per
Qwen shot image (LESSONS #24); the OmniRef (Ref2VA) path renders quieter sound than V2, levelled
at assembly.

## 4. What the Studio does today

**Studio pipelines** (`PIPELINES` in `web/js/form.js`): Text2Image (Krea 2, Qwen 2.1 or
MOSS-Image), Image2Image (Qwen 2.1, input image + up to 9 references, markets), Text2Video and
Image2Video (H3 V2), **Video from references** (one `h3-r2v` job from a References list: up to 9
images, 3 clips, 3 sounds, each with a role; the six-field Ref2VA prompt built by
`buildH3RefPrompt`, the same as the assistant's `reference_video` card), and two pipelines owned
by their goal card (no Pipeline menu shown): the **long take** (card "Narrative video") and the
**full campaign**. The gallery offers "→ First frame" and "→ Reference" on images where the form
takes them.

**The long take** ([LONG-VIDEO.md](LONG-VIDEO.md), `web/js/director.js`), the result of the
2026-11-14 → 22 work:

1. Inputs: a brief or a screenplay (prose, one paragraph per scene; or a file in the owner's H3
   layout, read without Gemma, its `[Shot N]` starting a new scene), a total length (10 s
   segments), an optional **First frame** and up to 7 **References** with roles (character,
   setting, object). "✨ Subject sheet / ✨ Setting sheet from the brief" (one Krea 2 job each)
   and "✨ Sheet" on a character photo (one Qwen 2.1 five-view job) add sheets in one click, with
   no approval step.
2. Gemma's split (`H3_SCENARIO_SYSTEM`) turns it into segment cards `{"new_shot", "text"}`; a new
   shot becomes a 🎞 cut. When the scene count is known (paragraphs, file), the code sets the
   cuts. Shared Lighting and Soundscape are left empty when there are several scenes; the camera
   keeps the main subject's face in frame.
3. One click runs the chain. **Segment 1**: no image and no reference → `h3-t2v`; references
   only → `h3-r2v`; a first frame alone, with a setting only, or a described scene → `h3-i2v`
   on it; a first frame **and** subject references → `h3-r2v` with `image` (the picture held
   still about 0.9 s, then moving) and the characters and objects only. **Continuous segments**
   with references → `h3-r2v` with `continue_from` (latent continuation, no start frame). **Cuts
   and new scenes** → `h3-r2v` on the references only, no frame of the previous place. A take of
   several scenes sends **no setting reference** (a place image anchors the character there);
   segments that send fewer references renumber their `<Subject N>` and write a left-out one as
   its description.
4. The take ends with `video-stitch`: continuing clips decoded once, cuts as they are, -18 LUFS,
   25 ms fades, true-peak limiter.

Measured on promaxgb10-95c7: a 10 s `h3-r2v` segment takes about 4–5 min with one reference and
up to 9 min with four; a three-scene 30–40 s take runs 23 to 29 min end to end. The owner judged
the 47 s app take of 2026-11-20 "not perfect but satisfying"; joins read 6–14 on fast motion.

**The assistant** (first mode of the page): seven roles (general assistant, director, casting
and settings, ad art director, localisation, product and fashion campaign, transitions editor)
answer with cards that run nothing until clicked (`create_image`, `edit_image`, sheets,
`video_from_text`, `video_from_image`, `long_take`, `reference_video`, `join_videos`, `campaign`,
`ask_choices`). The Director takes a story of several scenes to a `long_take` card. Gemma's card
arguments are unreliable in a new way each run (missing kinds, missing references): the app fills
what it can (a reference with no kind takes its card's role; a long-take card with no references
takes the conversation's finished sheets).

**The Canvas** keeps its own cards, including the storyboard and the reference-to-video cards,
unchanged by the long-take work; the assistant is not in the Canvas yet.

## 5. Install and update under Docker

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
  The repository is public: no token is needed; `STUDIO_GIT_TOKEN` is only for a private fork.
- **The updater never rebuilds itself**: after a change to `docker/updater/`, run
  `docker compose up -d --build updater` once on each machine (the Monitor says so,
  `updater_stale`).
- `web/` and `studio/` are copied into the image: a `git pull` alone changes nothing on a running
  machine, the image must be rebuilt; then Ctrl+Shift+R in the browser.
- Diagnosis: `curl -s localhost:8090/api/health`, and
  `docker logs studio 2>&1 | grep -E "llm:|engine:|render:"` (a slow chat turn is easily
  mistaken for a slow render).

## 6. Test machines

Three GB10s (DGX OS, ARM64, ~121 GiB unified memory). **Do not assume paths, users or state from
one to another.**

| Machine | User | Role |
|---|---|---|
| `gb10-demo` | `spark` | First 2.0 test machine (qualifications of 2026-10-30, Upscale ×2). Was short on disk on 2026-10-30. Not used since mid-November. |
| `promaxgb10-95c7` | `spark` | The owner's machine running the Docker install (repo `/home/spark/onprem-media-studio`, container `studio`). Every render since 2026-11-07. **Runs `main` 756bc78**, rebuilt on 2026-11-22 21:39 UTC after PR #56 (queue empty, health OK). Reached through Remote Control, which the owner turns on from Claude Desktop. Holds `control-tests/` (the PR #55/#56 control renders, reports `inspection-*.md`): delete only on the owner's word. Also holds ~200 GB of another tool's ComfyUI models in `~/.zcode`: not ours, leave them. |
| `promaxgb10-6c5f` | `sparks` | Hosts **1.4** (ComfyUI, `comfyui-nvidia`, open-webui, spark-control-center). Not a 2.0 test machine. |

Working on promaxgb10-95c7:

- The Claude session there runs in auto mode: it refuses some commands (`docker compose build`,
  `rm` through a root container) that the owner then runs by hand. Submitting renders or
  restarting the studio needs the owner's **written** go in the thread.
- `data/` is root-owned: write into it through `docker exec`.
- Before testing a branch, write down the current branch and the `studio.commit` label of the
  running image (`docker inspect studio --format '{{index .Config.Labels "studio.commit"}}'`),
  and put it back afterwards (on 2026-11-09 a test silently dropped a fix the machine was running
  from another branch). After a PR merges, rebuild the machine on `main`.
- UI renders are driven with Playwright (`tools/qualify/narrative_take.js`, `director_take.js`,
  `first_frame_take.js`) in a container run with `--user $(id -u):$(id -g)`: outputs written as
  root could not be deleted on 2026-11-21.

Renders and qualifications happen on a GB10 only. The cloud container used by Claude sessions
cannot reach huggingface.co or download.pytorch.org (PyPI and GitHub work), so torch tests
(`tests/test_image_lora_models.py`) run on the GB10 only. Claude sessions can push only their own
branch: the owner deletes old remote branches in the GitHub interface.

## 7. Rules learned (beyond LESSONS.md)

The owner's standing rules are in [AGENTS.md](../AGENTS.md); the 58 technical lessons in
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
    `h3_runtime.report_stages` (`MiniMaxH3DenoisingStage`, `MiniMaxH3VideoDecodingStage`), the
    per-step `scheduler.step` call, and the latent-preparation code patched by `h3_continue.py`
    and `h3_start_frame.py`; keep the never-upscale reference rule.
11. **Measure, don't guess**: every speed change came from a bench script in `tools/qualify/`
    (`load_speed.sh`, `render_speed.sh`, `qwen_fast_bench.sh`, `moss_bench.py`,
    `run_upscale.py`). A bench run with `docker exec -i studio python - < script` shows only as
    `python -` in the container; never run two benches at once (both may restart the studio).
12. **Long-video work**: set a stop criterion before each test; after one more failure on a
    track, propose a fresh approach built on what was learned rather than another patch (the
    owner's words of 2026-11-18, the reason PR #43 was closed). Keep the path brief → length →
    one click; checks run inside the chain, never as a user review step.
13. **Fill what the app can** rather than trust Gemma's structured output: a flag per item beats
    a list of numbers, prose beats a layout inside a tool argument (LESSONS #55, #56), and code
    decides what is deterministic (cuts when the scene count is known, references per segment).

## 8. How work is done

- Code, comments, logs, commit messages, PR descriptions and documents are in **English**; every
  document has a French translation under `docs/fr/` (and `README.fr.md`), updated in the same
  change. The interface is FR/EN/ES/DE, informal "you".
- One branch and one PR per piece of work, from `main`. The owner reads the PR and says when to
  merge; never merge without the owner asking. A branch whose PR merged restarts from `main` for
  new work.
- Before asking for a merge: `python -m pytest`, and for any front-end, prompt or instruction
  change `node tools/parity-prompts.js` (needs `../dellaicontent`), `tools/prompt-systems.js`,
  `tools/assistant-ui.js`, `tools/lora-ui.js`, `tools/relay-ui.js` (commands in AGENTS.md).
  GitHub Actions runs them on every PR; the parity test only when the `DELLAICONTENT_TOKEN`
  secret is set.
- Changing a prompt compiler or a Gemma instruction makes the parity and fingerprint tests fail
  on purpose: update the reference in the same commit and say why.
- A change to the long take is checked by a control render on promaxgb10-95c7 (on the owner's
  go), its frames and sound inspected and written up in a report next to the take.
- "Simplest thing that works": no option, abstraction or feature beyond what was asked.
- When a PR changes engines, machines or open items, update this page (§ 3, § 4, § 6, § 9, § 10)
  and its French copy in the same PR.

## 9. PR history

| PRs | Date | Content |
|---|---|---|
| #1, #4 | 2026-10-30 | Step 1: FastAPI server, model catalog and download, job queue, Gemma via llama.cpp, Docker image; fixes from the first GB10 build |
| #2 | 2026-10-30 | Step 2: Krea 2 and Qwen Image 2.1 engines, qualified |
| #3 | 2026-10-30 | Step 3: MiniMax H3 through FastVideo (t2v/i2v/FL2VA on FastH3 V2, two-pass Ref2VA on OmniRef with our latent upscaler, LoRA stack), NVFP4 qualified |
| #5 | 2026-10-30 | Step 4: Studio and Canvas front end ported from 1.4, gallery, in-app update, i18n, bare-metal `install.sh` (paused) |
| #6, #7 | 2026-10-30 | Engines kept resident (LRU memory budget); `studio.import14` reuses 1.4 files |
| #8, #9 | 2026-10-31 → 11-01 | Creative assistant (7 roles, cards, animated character, first mode); render progress on cards, sheet from a photo, Gemma thinking off for compile calls |
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
| #35 | 2026-11-12 | This handover |
| #36, #38 | 2026-11-14 | Subject sheet from a photo with Qwen 2.1: five views (method after H3 Character Sheet Designer, MIT), portraits stacked left, true side view |
| #37 | 2026-11-14 | Relay redesign: shared look ("Cadrage"), total length in 10 s segments, production board, long take from any image, 25 ms fades at joins |
| #39 | 2026-11-15 | Relay cards follow the total length; a sheet is never a first frame |
| #40, #41 | 2026-11-16 → 17 | Relay cuts on H3 Ref2VA with the sheets and setting; continuous segments as Ref2VA with a start frame (`h3_start_frame.py`) |
| #42 | 2026-11-17 | Lighter Studio form and director (one main action per step, the rest folded), automatic assembly of the chain |
| #43 | closed 2026-11-19, not merged | Key-image long take (Qwen keys + FL2VA): stopped by the owner, see § 3 |
| #34, #45 | 2026-11-20 | Docs for the public repository (no token to clone or update); handover row |
| #44 | 2026-11-20 | **Latent continuation**: `h3-r2v` `continue_from`, clips keep their latents, `video-stitch` decodes a take once, -18 LUFS ([LONG-VIDEO.md](LONG-VIDEO.md)) |
| #46, #47 | 2026-11-20 | Screenplay files in the H3 layout, start with no image (t2v), described scene starts in i2v on its picture, assistant `long_take` card; First frame and References (roles) as separate inputs |
| #48, #49 | 2026-11-20 | Gallery "→ First frame" / "→ Reference"; a goal card with its own pipeline shows no Pipeline menu |
| #50, #51 | 2026-11-20 → 21 | One "Narrative video" card: cuts from Gemma's split, one-click sheets; a new scene carries nothing of the previous place, no shared light or sound across scenes |
| #52 | 2026-11-21 | Storyboard removed from the Studio and the assistant (kept on the Canvas) |
| #53 | 2026-11-21 | "Video from references" form replaces "Consistent character + setting" (one click, one job) |
| #54, #55 | 2026-11-21 | Assistant long-take card in prose with a total length; split segments flagged `new_shot`, face kept in frame, no setting reference across scenes, card references filled by the app |
| #56 | 2026-11-22 | Long take segment 1 on a first frame sees the subject references (`h3-r2v` + start picture held 22 frames); dropped references renumbered in prompts |

## 10. Open items

Nothing below was asked to be done now; each waits for the owner.

**Checks on a GB10, never done**
- r2v with clip and sound references (PR #11): never rendered on a GB10.
- H3 progress bar (PR #30, merged before any GPU render): confirm that it moves step by step on
  an H3 render.
- FastH3 OmniRef load time after review item 10 (export read by `RangeFile`): read the next
  `engine:` log line of an H3 load (153 s measured before).
- Long take: the A6 fix that renumbers `<Subject N>` and writes a dropped reference (the harbour,
  the cottage) as its description is not re-rendered; neither is a screenplay file with a start
  image, nor a file's `[Shot N]` scenes.
- Character sheet from a photo (Qwen 2.1, five views, PR #36/#38): rendered by API on three
  subjects, never qualified by the owner.

**Known defects and leads**
- Long take with a first frame and references: a **brightness pop** where the 0.9 s hold ends
  (luma −11, same shot).
- H3 **cut to another place** 1.2 s into segment 3 of the café take (C3 and C4, same seed); not
  caused by the hold. Seed-driven segment motion is fixed with "Regenerate".
- A Krea 2 sheet from the brief drew a **fedora instead of the story's beanie**; in A6 the
  fisherman also turned his back for about 4 s and the boat differed between harbour and sea.
- Latent continuation joins are visible on fast motion (6–14, inside-clip motion up to 18).
- FL2VA ghost head (§ 3): lead is to stop writing the camera motion in a cut prompt that has an
  end image; to verify with a render.
- Qwen_2.1-Unchained LoRA at strength 1: darker image with a fine dot grid (clean at 0.5).
  Advice given: use it at 0.5–0.7.
- Unused: the optional MTP draft file of the Gemma GGUF repository (faster decoding).

**Later, or deliberately not done (owner's decisions)**
- **Security items "P4" of the 2026-11-08 code review**: an access token or authentication on
  :8090, a global same-origin middleware, an Origin check on the WebSocket, a shared secret
  between the studio and the updater, a non-root container. Excluded by the owner; propose again
  only if asked.
- Install review of 2026-11-09: D4–D8 (`data/` owned by root, Triton/CUDA caches outside `/data`
  to measure…), U2 (security), and B1–B6 for bare metal.
- **Bare-metal install paused** since 2026-10-30 ("a working Docker solution first"):
  `scripts/install.sh` and [INSTALL.md](INSTALL.md) exist but are not maintained; they ignore
  `docker/constraints.txt` and use an unqualified PyPI torch 2.12 (Docker runs NGC torch 2.10).
- Omarchy and Windows 11 targets: not started.
- **The assistant in the Canvas**: on the roadmap, not started.
- Caching the NVFP4-converted H3 weights on disk (about 75 s saved per H3 load): only if asked.
- A character LoRA for identity over long takes (candidate 4 of [LONG-VIDEO.md](LONG-VIDEO.md)):
  not started.
- Image LoRAs are not sent by the Canvas storyboard, campaign and sheet flows (not asked).

**Documentation drift**: [ROADMAP.md](ROADMAP.md) still marks step 1 "first build on GB10
pending" and step 4 "full pass on the GB10 pending" (both done on 2026-10-30, bare metal
excepted), and says nothing of the long take. Update it when the roadmap is next touched.

## 11. Working with the owner

- Write to the owner **in French** (chat, threads, decision cards). Code, commits, PRs and
  documents stay in English, documents with their French translation.
- Give **verified, self-contained steps**: the exact commands in order, which machine and folder,
  what to wait for, and what result to expect (for example the `git log --oneline -1` title to
  see). The owner dislikes trial-and-error commands. A front-end change still needs an image
  rebuild (§ 5); saying "git pull is enough" was wrong once.
- Before any rebuild instruction, say to wait for running jobs to end.
- The owner decides scope and qualification: propose, recommend one option, and do not add
  features, options or models that were not asked for; no unvalidated model is ever listed.
- The owner judges by the result on screen and by ease of use ("it must stay simple to use"),
  not by the number of fixes: show the render, say plainly what is still wrong.
- Never delete test files or renders on a machine without the owner's word.
- Licences matter (Dell demonstration context): recall the MiniMax H3 territory exclusions and
  the Qwen Image 2.1 non-commercial licence whenever commercial use comes up.
