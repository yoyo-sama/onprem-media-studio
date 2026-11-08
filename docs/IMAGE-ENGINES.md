# Image engines

French version: [fr/IMAGE-ENGINES.md](fr/IMAGE-ENGINES.md). Lessons behind each rule:
[LESSONS.md](LESSONS.md) § 4–5.

Three engines, each a job pipeline (`studio/pipelines/`), on diffusers 0.42.1 with the
official weights. Qwen-Image-Edit 2509 was dropped on 2026-10-29 (not required): Qwen Image 2.1
covers every edit the 1.4 did with 2509. MOSS-Image was added on 2026-11-07 for text in the
image (see [MOSS-Image](#moss-image)).

| Pipeline id | Model (catalog id) | diffusers class | Fixed settings |
|---|---|---|---|
| `krea2-t2i` | Krea 2 Turbo (`krea2-turbo`) | `Krea2Pipeline` | 8 steps, `guidance_scale=0` |
| `qwen-image-2.1` | Qwen Image 2.1 (`qwen-image-2.1`: text encoder, VAE, processor) with the Lightning v2 RL transformer (`qwen-image-2.1-lightning`) | `QwenImage21Pipeline` | 4 steps on the Lightning sigmas, scheduler without dynamic shifting, `true_cfg_scale=1`, condition images at 1024 |
| `moss-image` | MOSS-Image SFT (`moss-image-sft`) + turbo LoRA (`moss-image-turbo-lora`) | `MOSSImagePipeline` (the model's own code) | per `mode`: 4 or 8 steps with the turbo LoRA and no guidance, or 25 steps at guidance 3 |

Krea 2 keeps the settings qualified in 1.4 (`workflows/api/krea2_t2i.json`). Qwen Image 2.1 ran the
1.4 ones (25 steps) until 2026-11-07, then took the step-distilled transformer of
[lightx2v/Qwen-Image-2.1-Lightning-v2-RL](https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning-v2-RL)
(LESSONS #46). MOSS-Image runs the settings of its GB10 bench, one set per `mode`. Steps and guidance are not parameters: a distilled model breaks colour first
when under-stepped (LESSONS #2), and nobody asked to tune them.

Only one engine stays in GPU memory: starting a job on another engine unloads the previous one.

## Division of work with the front end

The backend runs final prompts. Compiling them (sheet templates, the keyframe anchoring block,
style text, campaign suffixes, Gemma enrichment) is the front end's job (ADR 0001), ported from
the 1.4 `js/engine.js` in step 4. The engines own what is true of the model whatever the prompt:

| Rule (LESSONS) | Where it is enforced |
|---|---|
| Nothing renders without a click (#5) | Only `POST /api/jobs` creates a job; an upload creates none |
| Prompt sent verbatim (#6) | Engines pass `prompt` untouched: never stripped, rewritten or completed |
| Krea 2 never encodes a negative (#18) | `guidance_scale=0` (no unconditional pass); `negative` is refused with 422 |
| No negative with Qwen at cfg 1 | Refused with 422, rather than silently dropped |
| Subject sheet is image 1 (#21) | Shot form `subjects` + `setting`: the engine orders the slots |
| Output size follows image 1 (#21) | Computed by the engine from image 1 and passed explicitly (see below) |
| Two subjects per shot at most (#24) | `subjects` takes 1 or 2 sheets |
| Anchoring block on every path (#7), setting named twice (#22), no "storyboard" words (#20), sheet template by kind (#25) | Front end (prompt compilers), step 4 |

**Output size of an edit.** In 1.4 an image-to-image edit kept the ratio of its input image.
diffusers sizes the output from the **last** image by default, which in a shot is the setting
sheet. Without an explicit `width`/`height`, the engine therefore computes the size from image 1
itself: about 1 MP at its ratio, multiples of 32 (the 1.4 formula `round(sqrt(1024²·r)/32)·32`).
Shots are usually given an explicit size (1.4 rendered its Qwen 2.1 keyframes at the shot ratio,
1344×768).

## Images: upload and references

```bash
curl -s --data-binary @photo.png localhost:8090/api/inputs
# {"ref": "inputs/3f9a…c1.png", "width": 1280, "height": 720}
```

The body is the raw image (PNG, JPEG or WebP, 50 MB at most). A clip (MP4, MOV, WebM) or a
sound (WAV, MP3, M4A, FLAC, Ogg), 200 MB at most, is accepted too, for the references of
`h3-r2v` ([H3.md](H3.md)): ffprobe reads it, and the answer is `{"ref", "kind"}` (`kind` is
`image`, `video` or `audio`; an image's answer also has its size). Other engines refuse a
reference that is not an image. Uploads are stored under a content
hash in `<data>/input/`. A **reference** is the file's URL path without the leading slash:
`inputs/<name>` for an upload, `outputs/<path>` for a render (a job's `outputs` are references).
A shot can thus use the sheets rendered by earlier jobs directly. References are checked when the
job is submitted: a missing file is a 422, not a failed job.

## Parameters

Unknown parameters are refused (422), so a typo never goes unnoticed. `seed` is optional
everywhere (0 to 2³²−1); when absent it is drawn at submission and kept in the job's `params`.
Every PNG carries the job's pipeline and parameters as JSON in a `studio` text chunk.

### `krea2-t2i`

| Parameter | Default | Rule |
|---|---|---|
| `prompt` | required | Verbatim |
| `width`, `height` | 1024 | 256–2048, multiple of 16 |
| `count` | 1 | 1–4 images of one seed (1.4 "variants") |
| `loras` | `[]` | Up to 4 files of `loras/krea2/` with their strengths: [Style LoRAs](#style-loras) |

### `qwen-image-2.1`

Without images it is text to image (`width`/`height` default 1024, `count` 1–4). Sizes are
multiples of **32** (256–2048): diffusers floors 2.1 sizes to 32, so 1280×720 would come out
1280×704; use 1344×768 for 16:9, 768×1344 for 9:16. With `images`
(1–10) or the shot form `subjects` (1–2) + `setting` + `references` (0–7 extra images after the
setting, as in 1.4: 2 sheets + 7), it edits: `count` is 1, size from image 1 unless `width` and
`height` are both given. The prompt cites images as `<image1>`, `<image2>`… in slot order.
`loras`: up to 4 files of `loras/qwen21/`, in both forms ([Style LoRAs](#style-loras)).

### `moss-image`

Text to image only. `mode` picks the steps and guidance, nothing else does:

| `mode` | Settings | GB10 bench, 1024² |
|---|---|---|
| `preview` | turbo LoRA, 4 steps, guidance 1 (no negative pass) | about 11 s; a poster title had a doubled word on 2 seeds of 3 |
| `standard` (default) | turbo LoRA, 8 steps, guidance 1 | about 19 s; text exact on 3 seeds of 3, pulls towards warm sunset light |
| `quality` | SFT alone, 25 steps, guidance 3, the model's negative branch (empty prompt, block 22 skipped) | about 72 s; text exact, the most faithful light and atmosphere |

`width`, `height` 256–2048, multiples of 16 (default 1024); `count` 1–4. A `negative` is refused:
the quality mode's negative branch is part of the model's settings. Text to draw goes in double
quotes in the prompt; the model also reads the official JSON layout prompt (boxes per item).
`loras`: up to 4 files of `loras/moss/`, in every mode ([Style LoRAs](#style-loras)).

## MOSS-Image

`OpenMOSS-Team/MOSS-Image-SFT` (Apache-2.0): a 5.1B single-stream DiT in bf16 (10.2 GB), the
Qwen3.5-9B text encoder (16.8 GB) and the FLUX.2 small-decoder VAE, about 28 GB on disk plus
1.2 GB for the turbo LoRA (`akhaliq/MOSS-Image-SFT-4-steps`, file
`moss_image_sft_4step_v2.0.safetensors`, Apache-2.0). Peak memory in the bench: 30–34.5 GB.
Chosen by the project owner on 2026-11-07 after `tools/qualify/moss_bench.py` on promaxgb10-95c7
(Fizgig, KOOK, the DMD LoRAs and Kromoss were set aside there).

- **Code.** diffusers 0.42 has no MOSS pipeline: `studio/pipelines/moss.py` imports
  `pipeline_moss_image.py` from the downloaded model folder. The catalog pins both repositories
  to the commits the bench ran (`revision`), so a new upstream commit changes nothing until the
  catalog does. That file has no step callback: progress and cancellation hook the scheduler's
  `step`.
- **Turbo LoRA unmerged.** fp32, rank 128, applied as forward hooks for the render and removed
  after it. Its deltas are below bf16's rounding step and would vanish if merged (the authors'
  warning; the same lesson as the H3 LoRAs, LESSONS #30). A key that matches no layer refuses
  the file.
- **Seeds.** The noise is drawn on the CPU, as in the bench: a seed gives the image of the bench
  sheets.
- **Not used:** `lora.safetensors` of the turbo repository (rewritten in place by its author),
  the destripe LoRA (SFT's banding is invisible by eye at these step counts).

## Style LoRAs

Every image engine takes a stack of up to 4 LoRAs, `loras: [{"name": <file>, "strength": -2…2}]`,
as MiniMax H3 does ([H3.md](H3.md)); `[]` or no key renders without LoRA. Each engine reads
its own folder, uploaded from the Models panel: `loras/krea2/` (Krea 2), `loras/qwen21/`
(Qwen Image 2.1, text to image and edits), `loras/moss/` (MOSS-Image); a file of another folder
is refused at submission. The storyboard and campaign flows send no image LoRA.

- **Never merged.** A LoRA's deltas are mostly below bf16's rounding step (LESSONS #30):
  each one runs as a side branch next to the weights, which stay as qualified. Krea 2 and
  Qwen load the stack as PEFT adapters weighted with `set_adapters` (`image_lora.py`); they
  stay loaded while the next render asks for the same files, and a render without LoRA
  unloads them, so it runs the engine exactly as qualified. MOSS-Image, whose pipeline is the
  model's own code, adds one fp32 forward hook per layer and LoRA for the render, on top of
  its turbo LoRA in the turbo modes, as it already did for the turbo LoRA.
- **Formats.** Krea 2 and Qwen files are read by the engine's diffusers loader (ComfyUI
  `diffusion_model.`, kohya `lora_unet_`/`lora_down`, AI-Toolkit, diffusers/PEFT). MOSS reads
  ComfyUI (`diffusion_model.`) and diffusers (`transformer.`) files, `lora_down`/`lora_up` or
  `lora_A`/`lora_B`, with the `.alpha` keys or the alpha of the file's diffusers metadata.
- **Nothing silently dropped.** diffusers only warns about keys that land on no layer and
  renders without them; here a file with any such key (text encoder keys included) fails the
  job and names a few of them.
- **On the distilled engines.** Community LoRAs are trained on Qwen Image 2.1 base, Krea 2 and
  MOSS-Image SFT/Base at full step counts; here they run on Lightning (4 steps), Krea 2 Turbo
  (8 steps) and the MOSS turbo modes. None of the three compiles its transformer, so a LoRA
  costs no recompilation. How each LoRA holds at these step counts is judged on the render.
- **Checked before loading.** Every file of a stack is checked against the plain layers before
  any is loaded: once an adapter is in, its layers are PEFT wrappers, no longer `Linear`, and
  checking the next file against them refused every stack of two on the GB10.

## The 1.4 features on these engines

| 1.4 feature | Jobs |
|---|---|
| Text2Image | `krea2-t2i`, ratio table 16:9 1280×720, 9:16 720×1280, 1:1 1024², 4:5 832×1040; or `qwen-image-2.1` without images, at multiples of 32 (16:9 1344×768); or `moss-image` (new in 2.0) with the Krea 2 ratio table and its `mode` |
| Image2Image / localisation | `qwen-image-2.1` with `images` (input image + up to 9 references); one job per market |
| Campaign images | `krea2-t2i`: poster 832×1216 and thumbnail 1280×720 (variants), social 1024×1024 (1), seeds `seed+200`, `+201`, `+202`; the teaser video comes with step 3 |
| Subject and setting sheets | `krea2-t2i` at 1920×1088, one image each |
| Shot images (keyframes) | `qwen-image-2.1` with `subjects` = the subject sheet(s), `setting` = the setting sheet |

## Speed

Weights are read whole, never memory-mapped; no engine runs through `torch.compile` any more
(LESSONS #43, #46); measures and benches in [H3.md](H3.md#memory-and-cancellation) and
[LESSONS.md](LESSONS.md) #42–43. Loads on the GB10, page cache dropped: Krea 2 34 s (253 s
before), Qwen Image 2.1 with Lightning 26–41 s. Renders: Krea 2 at 1280×720 about 20 s per image;
Qwen Image 2.1 at 1344×768 (4 steps) 7 s for text to image, 13 s for a shot image with one
subject, 16 s with two (40–50 s at 25 steps). `tools/qualify/qwen_fast_bench.sh` measures them.

## Upscale ×2

`upscale-2x` makes a copy of an image or a video twice as wide and twice as tall. It runs on the
"⇱ Upscale ×2" click in the gallery lightbox, never after a render on its own; the copy reaches
the gallery as a new file (titled "Upscale ×2"), the source is left as it was.

| | |
|---|---|
| Parameter | `source`: one image or video reference (`outputs/…` or `inputs/…`); nothing else, no prompt |
| Limits | image at most 4096 px on its long side (8192 px out), video at most 1920 px (3840 px out); refused with 422 beyond |
| Network | SPAN, weights `2xNomosUni_span_multijpg` (catalog id `span-2x-nomosuni`, 4.3 MB), loaded through spandrel 0.4.2, float16 on the GPU, kept in memory |
| Video | decoded by ffmpeg to RGB, upscaled frame by frame, encoded H.264 CRF 18 at the source frame rate, the sound copied unchanged; nothing is kept if the job fails |
| Output | PNG (`studio` metadata: `params.source`) or tagged MP4 under `outputs/upscale-2x/` |

Licences: weights CC BY 4.0 (Philip Hofmann, credited in `NOTICE`), SPAN network code
Apache-2.0, spandrel MIT (its main package carries only permissively licensed architectures).
Commercial use is allowed with the credit.

**Why not NVIDIA's upscalers** (checked on 2026-11-05/06): none runs on the GB10.

- DLSS 5 is a real-time game feature: it reads the colour and motion vectors a game engine
  produces each frame, through Streamline (Windows 10+, DirectX 11/12, Vulkan) or the Unreal
  Engine 5 plugin, on GeForce RTX 50. It also relights skin and materials, which a faithful
  copy must not do.
- The community ComfyUI bridges to DLSS 5 drive NVIDIA's Windows NGX DLLs (an undocumented
  feature 18) in a fake D3D12 pipeline; on Linux they run them under Wine, x86-64 only. The
  DLLs cannot be shipped in our image.
- The RTX Video SDK is Windows only; its Linux counterpart `nvidia-vfx` (Maxine Video Effects)
  ships x86_64 and Windows wheels only, and NVIDIA answered on the DGX Spark forum that there
  is "currently no plan to add NVIDIA VFX support on Spark".

SPAN was chosen from a third-party measurement on a DGX Spark (ai-muninn.com, 2026-08-07): 362
H3 frames from 960×540 to 1920×1080 in 49 s with SPAN against 316 s with Real-ESRGAN, no visible
difference reported. Our own measure on the GB10:

```bash
docker compose up -d --build          # spandrel is a new dependency of the image
python tools/qualify/run_upscale.py   # latest Krea 2 and Qwen images and the latest H3 video
docker logs studio 2>&1 | grep 'render: upscale-2x'
```

Measured on gb10-demo on 2026-11-06 (model already downloaded): a 1920×1088 image (Krea 2 or
Qwen) to 3840×2176 in 0.4 to 1.2 s of network, 3 to 4 s for the whole job; a 5 s H3 clip
(124 frames, 1280×736) to 2560×1472 in 20 s, 16 s of which in the network (6.1 frames/s
overall), the sound kept.

The script posts one job per source as the click does and writes `qualify-upscale.json` (each
source next to its copy); the log line gives the network's own time and, for a video, frames per
second. The project owner compared the four copies with their sources at 100 % on 2026-11-06
and accepted them: `span-2x-nomosuni` is `"qualified": true`.

## Qualification

An engine is qualified only by a real render whose images were looked at (LESSONS #1), on the
GB10, against 1.4. `tools/qualify/image_cases.json` holds 12 cases built from the 1.4 prompt
compilers themselves (`node tools/qualify/export_1_4_prompts.js ../dellaicontent`): Text2Image,
the three campaign formats, human, non-human and setting sheets, one- and two-subject shots,
image to image with and without an extra reference, and Qwen 2.1 text to image.

```bash
docker compose up -d --build
python tools/qualify/run_image_cases.py            # writes qualify-images.json
```

The script posts the cases one by one, as a click would, chaining shots onto the sheets it just
rendered, and records status, time and output URLs. Then look at every image next to the 1.4
render of the same prompt, with the checks of LESSONS #2 (edges, gradients, saturation) and these:

- sheets: one subject, nothing written on the image, the lion on four legs and unclothed (#25);
- shots: the subject's identity and costume from the sheet, the setting recognisable (#22), one
  instance of each subject, no collage of the sheets (#7), a film still and not a board (#20);
- shot size: 1344×768.

Only then set `"qualified": true` for the model in `studio/catalog.json`. Seeds do not reproduce
1.4 pixels (different runtime and weights format); compare quality, not pixels.

## Known gaps

- **MOSS-Image qualification (promaxgb10-95c7, 2026-11-07):** the three modes rendered through
  the app came out pixel-identical to the bench images at the same seed (preview 10 s,
  standard 18 s, quality 69 s at 1024², engine load 36 s), a cancelled render left no LoRA hook
  behind, and the project owner accepted them on 2026-11-08: both catalog entries are
  `"qualified": true`. Known limits: Preview may double a word of a title, Standard pulls
  towards warm sunset light.
- **Qualification (gb10-demo, 2026-10-29/30):** every Krea 2 (7/7) and Qwen Image 2.1 (4/4) case
  rendered, and the project owner accepted the renders on 2026-10-30: both models are
  `"qualified": true`. There was no side-by-side comparison with 1.4; a difference found later is
  fixed then.
- **LoRA loading on NGC 25.11:** peft 0.19+ refuses its torchao 0.14, so peft is pinned below 0.19.
- **Style LoRAs (promaxgb10-95c7, 2026-11-08):** six community LoRAs, two per engine (Krea 2:
  krea/Krea-2-LoRA-retroanime in diffusers format, gokaygokay/Krea-2-Realism-LoRA in the Krea
  trainer format; Qwen: two DiffSynth files; MOSS: one ComfyUI and one diffusers file) rendered
  alone and stacked by two at seed 42; a render without LoRA after them was pixel-identical to the
  one before on each engine; a strength change on the same files changed the image without
  reloading. Cost per step: Krea 2 2.66 s, 3.17 s with one LoRA, 3.65 s with two; Qwen 1.25 s,
  1.63 s, 1.83 s; MOSS standard 2.13 s, 2.92 s, 3.70 s. A style LoRA mostly shows only with its
  trigger words in the prompt (retroanime: "Purple retro anime style"; MOSS gouache:
  "moss_vgouache_style", which MOSS may also write into the image). The 1.4 Krea 2 LoRAs are not
  imported by `studio.import14`: upload them from the Models panel.
- **Qwen Image 2.1 with Lightning (2026-11-07):** benched on promaxgb10-95c7, 5 cases × 3 seeds:
  identity of both sheet subjects kept in every shot image; more contrast and saturation than
  the 25-step base, and stray structures in text to image (2 seeds out of 3). Renders through
  the server equal the bench pixel for pixel; accepted by the project owner, `"qualified": true`.
- **Qwen Image 2.1 licence:** Qwen Research License, non-commercial use only. Since 2509
  (Apache-2.0) was dropped, every edit and every shot image depends on it.
