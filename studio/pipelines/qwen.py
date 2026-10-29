"""Qwen image editing: Qwen-Image-Edit 2509 (Lightning, 4 steps) and Qwen Image
2.1 (also text to image).

Two ways to pass images:
- `images`: image to image, the images in the order the prompt cites them;
- `subjects` (1 or 2 sheets) + `setting` (the setting sheet), plus `references`
  on 2.1: a shot image. The engine orders the slots itself, subjects first and
  the setting after them, so a client cannot break the rules below.

Rules carried over from 1.4 (LESSONS.md § 5):
- at most two subjects per shot, with both engines (#24);
- the first subject sheet is image 1 and sets the output size; the setting only
  conditions (#21). diffusers sizes the output from the *last* image by default,
  so the size is always computed here from image 1 and passed explicitly;
- guidance stays off (cfg 1, as qualified), so a negative prompt would never be
  used: it is refused rather than silently dropped.
"""

import math

from . import Pipeline, common, register

MAX_SUBJECTS = 2
NO_NEGATIVE = "guidance is off for this engine, so a negative prompt is never used."


def _edit_images(params: dict, files, max_images: int, max_refs: int, min_images: int) -> dict:
    """Validated image fields: either `images` or the shot form."""
    shot = [k for k in ("subjects", "setting", "references") if k in params]
    if shot and "images" in params:
        raise ValueError("Send either images, or subjects and setting, not both")
    if not shot:
        if min_images == 0 and "images" not in params:
            return {}
        return {"images": common.image_refs(params, "images", files, min_images, max_images)}
    out = {"subjects": common.image_refs(params, "subjects", files, 1, MAX_SUBJECTS)}
    if "setting" not in params:
        raise ValueError("setting is required with subjects: a shot needs its setting sheet")
    files.resolve(params["setting"])
    out["setting"] = params["setting"]
    if max_refs:
        out["references"] = common.image_refs(params, "references", files, 0, max_refs)
    return out


def ordered_images(params: dict) -> list[str]:
    """Image slots in model order: subjects, then the setting, then extra references."""
    if "subjects" in params:
        return params["subjects"] + [params["setting"]] + params.get("references", [])
    return params.get("images", [])


def _load_images(params, ctx):
    return [common.open_image(ctx.files.resolve(ref)) for ref in ordered_images(params)]


# ── Qwen-Image-Edit 2509 + Lightning 4 steps ─────────────────────────────────

EDIT_2509_STEPS = 4
# Scheduler of the Lightning distillation (shift 3), from the official
# Qwen-Image-Lightning diffusers example; 1.4 used ModelSamplingAuraFlow shift 3.
LIGHTNING_SCHEDULER = {
    "base_image_seq_len": 256,
    "base_shift": math.log(3),
    "invert_sigmas": False,
    "max_image_seq_len": 8192,
    "max_shift": math.log(3),
    "num_train_timesteps": 1000,
    "shift": 1.0,
    "shift_terminal": None,
    "stochastic_sampling": False,
    "time_shift_type": "exponential",
    "use_beta_sigmas": False,
    "use_dynamic_shifting": True,
    "use_exponential_sigmas": False,
    "use_karras_sigmas": False,
}
LIGHTNING_FILE = "Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"


class QwenEdit2509(Pipeline):
    id = "qwen-edit-2509"
    models = ["qwen-image-edit-2509", "qwen-image-edit-2509-lightning"]

    def validate(self, params, files):
        # The model's text encoder takes three images: two subjects + the setting at most.
        common.check_keys(params, {"prompt", "images", "subjects", "setting", "seed"}, NO_NEGATIVE)
        return {"prompt": common.prompt(params), **_edit_images(params, files, 3, 0, 1),
                "seed": common.seed(params)}

    def run(self, params, models, ctx):
        images = _load_images(params, ctx)
        width, height = common.fit_area(*images[0].size)
        ctx.progress(0, "Loading Qwen-Image-Edit 2509")
        pipe = common.load(self.id, lambda: _build_2509(models))
        out = pipe(
            image=images,
            prompt=params["prompt"],
            width=width,
            height=height,
            num_inference_steps=EDIT_2509_STEPS,
            true_cfg_scale=1.0,
            generator=common.generator(params["seed"]),
            callback_on_step_end=common.step_progress(ctx, EDIT_2509_STEPS, "Qwen Edit 2509"),
        ).images
        return common.save_images(out, ctx, params)


def _build_2509(models):
    import torch
    from diffusers import FlowMatchEulerDiscreteScheduler, QwenImageEditPlusPipeline
    pipe = QwenImageEditPlusPipeline.from_pretrained(
        models["qwen-image-edit-2509"], torch_dtype=torch.bfloat16,
        scheduler=FlowMatchEulerDiscreteScheduler.from_config(LIGHTNING_SCHEDULER))
    pipe.load_lora_weights(models["qwen-image-edit-2509-lightning"], weight_name=LIGHTNING_FILE)
    pipe.fuse_lora()
    return pipe.to(common.device())


# ── Qwen Image 2.1 ───────────────────────────────────────────────────────────

QWEN21_STEPS = 25          # value qualified in 1.4 (ComfyUI, euler/simple, cfg 1)
QWEN21_RESOLUTION = 1024   # side length the condition images are resized to, as in 1.4
QWEN21_MAX_IMAGES = 10     # model limit, proven in 1.4 (input image + 9 references)
QWEN21_MAX_REFS = 7        # shot: 2 sheets + 7 references, as in 1.4


class QwenImage21(Pipeline):
    id = "qwen-image-2.1"
    models = ["qwen-image-2.1"]

    def validate(self, params, files):
        common.check_keys(params, {"prompt", "images", "subjects", "setting", "references",
                                   "width", "height", "count", "seed"}, NO_NEGATIVE)
        out = {"prompt": common.prompt(params),
               **_edit_images(params, files, QWEN21_MAX_IMAGES, QWEN21_MAX_REFS, 0)}
        editing = bool(ordered_images(out))
        if editing and len(ordered_images(out)) > QWEN21_MAX_IMAGES:
            raise ValueError(f"At most {QWEN21_MAX_IMAGES} images in all")
        if ("width" in params) != ("height" in params):
            raise ValueError("Send width and height together")
        if "width" in params or not editing:
            # Without size, an edit follows image 1 (see run()); text to image is square.
            out["width"] = common.integer(params, "width", 1024, 256, 2048, 16)
            out["height"] = common.integer(params, "height", 1024, 256, 2048, 16)
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


register(QwenEdit2509())
register(QwenImage21())
