# Image engines

French version: [fr/IMAGE-ENGINES.md](fr/IMAGE-ENGINES.md). Lessons behind each rule:
[LESSONS.md](LESSONS.md) § 4–5.

Three engines, each a job pipeline (`studio/pipelines/`), all on diffusers 0.42.1 with the
official weights:

| Pipeline id | Model (catalog id) | diffusers class | Fixed settings |
|---|---|---|---|
| `krea2-t2i` | Krea 2 Turbo (`krea2-turbo`) | `Krea2Pipeline` | 8 steps, `guidance_scale=0` |
| `qwen-edit-2509` | Qwen-Image-Edit 2509 + Lightning 4-step LoRA (`qwen-image-edit-2509`, `qwen-image-edit-2509-lightning`) | `QwenImageEditPlusPipeline` | 4 steps, `true_cfg_scale=1`, Lightning scheduler (shift 3), LoRA fused at load |
| `qwen-image-2.1` | Qwen Image 2.1 (`qwen-image-2.1`) | `QwenImage21Pipeline` | 25 steps, `true_cfg_scale=1`, condition images at 1024 |

These are the settings qualified in 1.4 (`workflows/api/krea2_t2i.json`, `qwen_edit_dual.json`,
`qwen21_*.json`). Steps and guidance are not parameters: a distilled model breaks colour first
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
| No negative with Qwen at cfg 1 | Refused with 422 on both Qwen engines, rather than silently dropped |
| Subject sheet is image 1 (#21) | Shot form `subjects` + `setting`: the engine orders the slots |
| Output size follows image 1 (#21) | Computed by the engine from image 1 and passed explicitly (see below) |
| Two subjects per shot at most (#24) | `subjects` takes 1 or 2 sheets, on both engines |
| Anchoring block on every path (#7), setting named twice (#22), no "storyboard" words (#20), sheet template by kind (#25) | Front end (prompt compilers), step 4 |

**Output size of an edit.** In 1.4 the 2509 graph took its latent from image 1 (the subject
sheet), so the shot had the sheet's ratio. diffusers sizes the output from the **last** image by
default, which in a shot is the setting sheet. The engines therefore compute the size from
image 1 themselves: about 1 MP at its ratio, multiples of 32 (the 1.4 formula
`round(sqrt(1024²·r)/32)·32`). Qwen-Image-Edit 2509 always does so, as qualified; Qwen Image 2.1
accepts an explicit `width`/`height` (1.4 rendered its keyframes at the shot ratio, 1344×768).

## Images: upload and references

```bash
curl -s --data-binary @photo.png localhost:8090/api/inputs
# {"ref": "inputs/3f9a…c1.png", "width": 1280, "height": 720}
```

The body is the raw image (PNG, JPEG or WebP, 50 MB at most). Uploads are stored under a content
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

### `qwen-edit-2509`

Either `images` (image to image: 1 to 3 images, in the order the prompt cites them) or the shot
form `subjects` (1–2 subject sheets) + `setting` (the setting sheet). No size and no count: the
output follows image 1 and 1.4 never batched this engine.

### `qwen-image-2.1`

Without images it is text to image (`width`/`height` default 1024, `count` 1–4). With `images`
(1–10) or the shot form `subjects` (1–2) + `setting` + `references` (0–7 extra images after the
setting, as in 1.4: 2 sheets + 7), it edits: `count` is 1, size from image 1 unless `width` and
`height` are both given. The prompt cites images as `<image1>`, `<image2>`… in slot order.

## The 1.4 features on these engines

| 1.4 feature | Jobs |
|---|---|
| Text2Image | `krea2-t2i` (or `qwen-image-2.1` without images), ratio table 16:9 1280×720, 9:16 720×1280, 1:1 1024², 4:5 832×1040 |
| Image2Image / localisation | `qwen-edit-2509` with `images`, or `qwen-image-2.1` with `images` (input image + up to 9 references); one job per market |
| Campaign images | `krea2-t2i`: poster 832×1216 and thumbnail 1280×720 (variants), social 1024×1024 (1), seeds `seed+200`, `+201`, `+202`; the teaser video comes with step 3 |
| Subject and setting sheets | `krea2-t2i` at 1920×1088, one image each |
| Shot images (keyframes) | `qwen-edit-2509` or `qwen-image-2.1` with `subjects` = the subject sheet(s), `setting` = the setting sheet |

## Qualification

An engine is qualified only by a real render whose images were looked at (LESSONS #1), on the
GB10, against 1.4. `tools/qualify/image_cases.json` holds 14 cases built from the 1.4 prompt
compilers themselves (`node tools/qualify/export_1_4_prompts.js ../dellaicontent`): Text2Image,
the three campaign formats, human, non-human and setting sheets, one- and two-subject shots on
both Qwen engines, image to image on both, and Qwen 2.1 text to image.

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
- shot size: the ratio of the subject sheet (2509) or 1344×768 (2.1).

Only then set `"qualified": true` for the model in `studio/catalog.json`. Seeds do not reproduce
1.4 pixels (different runtime and weights format); compare quality, not pixels.

## Known gaps

- **Not run on a GPU yet.** The engines are unit-tested with a fake diffusers pipeline and
  smoke-tested on CPU with tiny random diffusers models; the first real render happens on the GB10.
- **Krea 2 repository layout unverified:** the repository is gated, so its `model_index.json` was
  not readable from here. If `Krea2Pipeline.from_pretrained` fails on it, the catalog `allow`
  patterns are the first thing to check.
- **Style LoRAs** (1.4 Krea 2 and sheet LoRAs) are not ported yet.
- **Qwen Image 2.1 licence:** Qwen Research License, non-commercial use only.
