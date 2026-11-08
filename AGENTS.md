# AGENTS.md — guide for coding agents

OnPrem Media Studio 2.0: a self-contained local AI image and video studio (successor of AI Content
Studio 1.4, repository `yoyo-sama/dellaicontent`). No ComfyUI, no Ollama: a FastAPI server runs
the models (diffusers, FastVideo) and Gemma 4 through llama.cpp, and downloads weights from
Hugging Face on first use. Start with `docs/ARCHITECTURE.md`, `docs/LESSONS.md`,
`docs/adr/0001-inference-stack.md` and `docs/ROADMAP.md`.

## Commands

```bash
pip install -e ".[dev]" && python -m pytest        # unit tests, no GPU needed
node tools/parity-prompts.js                       # prompt compilers equal to 1.4 (needs ../dellaicontent)
NODE_PATH=$(npm root -g) node tools/prompt-systems.js   # Gemma instruction per engine, both pages headless
NODE_PATH=$(npm root -g) node tools/assistant-ui.js     # assistant mode: no job without a click, one job per card
STUDIO_DATA_DIR=./data python -m studio            # dev server on :8090
docker compose up -d --build                       # full image (GB10 / ARM64 + CUDA)
curl -s localhost:8090/api/health                  # app, GPU, LLM state
python tools/qualify/run_image_cases.py            # image qualification renders (GB10, server running)
node tools/qualify/export_1_4_prompts.js ../dellaicontent > tools/qualify/image_cases.json  # rebuild cases from 1.4
node tools/qualify/export_1_4_video_prompts.js ../dellaicontent > tools/qualify/video_cases.json
python tools/qualify/run_image_cases.py --cases image_cases.json video_cases.json   # image + video renders
```

Image engines, their parameters and what they guarantee: `docs/IMAGE-ENGINES.md`; MiniMax H3
video engines (FastVideo, two-pass Ref2VA, NVFP4, LoRA stack): `docs/H3.md`; Studio and
Canvas front end, its rules and tests: `docs/FRONTEND.md`; creative assistant (chat, roles in
`studio/assistant/roles/*.md`, cards): `docs/ASSISTANT.md`. Pipelines get
final prompts; prompt compilers belong to the front end (ADR 0001).

## Rules set by the project owner

- **English everywhere in code**: identifiers, comments, log lines, error messages, commit
  messages. Documents are written in English with a French translation under `docs/fr/` (and
  `README.fr.md`); update both in the same change. The interface is translated FR/EN/ES/DE.
- **The product name is changeable**: it lives in `studio/config.py` (`APP_NAME`, overridable by
  `STUDIO_APP_NAME`). Never hard-code it elsewhere in code; the package is `studio`, the
  environment prefix `STUDIO_`.
- **WanGP and Maestro are references only** (non-commercial licence): read them to understand,
  never copy code from them and never depend on them.
- **Models in scope**: Krea 2, Qwen Image 2.1 (Qwen-Image-Edit 2509 dropped on 2026-10-29),
  MOSS-Image SFT with its turbo LoRA (text to image, added on 2026-11-07), MiniMax H3 through
  FastH3, Gemma 4 as the only LLM, for the prompts and the creative assistant (26B-A4B, qualified
  on 2026-11-07; E4B dropped the same day). No LTX.
- **Nothing renders without a click**: no code path submits a job on its own.
- **The user's prompt is sent verbatim**; graph invariants (anchoring blocks) are re-appended by
  code. See `docs/LESSONS.md` § 2–3.
- **Simplest thing that works**: no feature, abstraction or option beyond what was asked.
- **Never trust a `success` status**: an engine is qualified only by a real render whose frames and
  audio were inspected on the target hardware; then, and only then, set `"qualified": true` in
  `studio/catalog.json`.
- **An engine never silently ignores a parameter**: unknown keys and a negative prompt the model
  would not use are refused with 422.
- Secrets (`HF_TOKEN`, cloud keys) come from the environment, are never logged and never written
  to the repository.

## Adding a model or an engine

1. Add the catalog entry (`studio/catalog.json`): exact repository, `allow` patterns, licence as
   read from the model card (or `"unverified"`), `gated`, `"qualified": false`.
2. Write a `Pipeline` subclass in `studio/pipelines/`, `register()` it, list its catalog ids in
   `models`, validate parameters in `validate()` (and return them normalised), import its module
   at the bottom of `studio/pipelines/__init__.py`. Import torch and diffusers inside functions.
3. Unit-test the parameter handling without a GPU; qualify the render on the GB10.
