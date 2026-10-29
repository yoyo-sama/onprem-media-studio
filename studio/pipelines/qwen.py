"""Qwen Image 2.1: image editing with reference images, and text to image.
(Qwen-Image-Edit 2509 was dropped on 2026-10-29: 2.1 covers every edit.)

Two ways to pass images:
- `images`: image to image, the images in the order the prompt cites them;
- `subjects` (1 or 2 sheets) + `setting` (the setting sheet) + `references`:
  a shot image. The engine orders the slots itself, subjects first and
  the setting after them, so a client cannot break the rules below.

Rules carried over from 1.4 (LESSONS.md § 5):
- at most two subjects per shot (#24);
- the first subject sheet is image 1 and sets the output size (#21). diffusers
  sizes the output from the *last* image by default, so without an explicit
  size it is computed here from image 1 and passed explicitly;
- guidance stays off (cfg 1, as qualified), so a negative prompt would never be
  used: it is refused rather than silently dropped.
"""

from . import Pipeline, common, register

MAX_SUBJECTS = 2
QWEN21_STEPS = 25          # value qualified in 1.4 (ComfyUI, euler/simple, cfg 1)
QWEN21_RESOLUTION = 1024   # side length the condition images are resized to, as in 1.4
QWEN21_MAX_IMAGES = 10     # model limit, proven in 1.4 (input image + 9 references)
QWEN21_MAX_REFS = 7        # shot: 2 sheets + 7 references, as in 1.4
# diffusers floors 2.1 sizes to a multiple of 32 (16x VAE, 2x2 patches): 1280×720
# rendered 1280×704 on the GB10. Refused instead of silently changed.
QWEN21_SIZE_MULTIPLE = 32
NO_NEGATIVE = "guidance is off for this engine, so a negative prompt is never used."


def _edit_images(params: dict, files) -> dict:
    """Validated image fields: `images`, the shot form, or nothing (text to image)."""
    shot = [k for k in ("subjects", "setting", "references") if k in params]
    if shot and "images" in params:
        raise ValueError("Send either images, or subjects and setting, not both")
    if not shot:
        if "images" not in params:
            return {}
        return {"images": common.image_refs(params, "images", files, 1, QWEN21_MAX_IMAGES)}
    out = {"subjects": common.image_refs(params, "subjects", files, 1, MAX_SUBJECTS)}
    if "setting" not in params:
        raise ValueError("setting is required with subjects: a shot needs its setting sheet")
    files.resolve(params["setting"])
    out["setting"] = params["setting"]
    out["references"] = common.image_refs(params, "references", files, 0, QWEN21_MAX_REFS)
    return out


def ordered_images(params: dict) -> list[str]:
    """Image slots in model order: subjects, then the setting, then extra references."""
    if "subjects" in params:
        return params["subjects"] + [params["setting"]] + params.get("references", [])
    return params.get("images", [])


def _load_images(params, ctx):
    return [common.open_image(ctx.files.resolve(ref)) for ref in ordered_images(params)]


class QwenImage21(Pipeline):
    id = "qwen-image-2.1"
    models = ["qwen-image-2.1"]

    def validate(self, params, files):
        common.check_keys(params, {"prompt", "images", "subjects", "setting", "references",
                                   "width", "height", "count", "seed"}, NO_NEGATIVE)
        out = {"prompt": common.prompt(params),
               **_edit_images(params, files)}
        editing = bool(ordered_images(out))
        if editing and len(ordered_images(out)) > QWEN21_MAX_IMAGES:
            raise ValueError(f"At most {QWEN21_MAX_IMAGES} images in all")
        if ("width" in params) != ("height" in params):
            raise ValueError("Send width and height together")
        if "width" in params or not editing:
            # Without size, an edit follows image 1 (see run()); text to image is square.
            out["width"] = common.integer(params, "width", 1024, 256, 2048, QWEN21_SIZE_MULTIPLE)
            out["height"] = common.integer(params, "height", 1024, 256, 2048, QWEN21_SIZE_MULTIPLE)
        # Batches with reference images were never qualified in 1.4.
        out["count"] = common.integer(params, "count", 1, 1, 1 if editing else 4)
        out["seed"] = common.seed(params)
        return out

    def run(self, params, models, ctx):
        images = _load_images(params, ctx)
        if "width" in params:
            width, height = params["width"], params["height"]
        else:
            width, height = common.fit_area(*images[0].size)
        ctx.progress(0, "Loading Qwen Image 2.1")
        pipe = common.load(self.id, lambda: _build_21(models["qwen-image-2.1"]))
        out = pipe(
            prompt=params["prompt"],
            image=images or None,
            width=width,
            height=height,
            num_inference_steps=QWEN21_STEPS,
            true_cfg_scale=1.0,
            num_images_per_prompt=params["count"],
            output_resolution=QWEN21_RESOLUTION,
            generator=common.generator(params["seed"]),
            callback_on_step_end=common.step_progress(ctx, QWEN21_STEPS, "Qwen Image 2.1"),
        ).images
        return common.save_images(out, ctx, params)


def _build_21(path):
    import torch
    from diffusers import QwenImage21Pipeline
    return QwenImage21Pipeline.from_pretrained(path, torch_dtype=torch.bfloat16).to(common.device())


register(QwenImage21())
