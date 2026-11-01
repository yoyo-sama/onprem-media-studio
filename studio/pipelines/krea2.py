"""Krea 2 Turbo: text to image. Also renders the campaign images and the
subject and setting sheets, whose prompts and sizes come from the client.

Settings are those qualified in 1.4 (`workflows/api/krea2_t2i.json`): 8 steps,
no guidance. Krea 2 never encodes a negative prompt (LESSONS.md #18): in 1.4 it
was routed through ConditioningZeroOut, here `guidance_scale=0` skips the
unconditional pass entirely, and a `negative` parameter is refused rather than
silently dropped.
"""

import time

from . import Pipeline, common, register

STEPS = 8
GUIDANCE = 0.0  # Krea 2 convention: 0 disables guidance (ComfyUI cfg 1)


class Krea2TextToImage(Pipeline):
    id = "krea2-t2i"
    models = ["krea2-turbo"]

    def validate(self, params, files):
        common.check_keys(params, {"prompt", "width", "height", "count", "seed"},
                          "Krea 2 never encodes a negative prompt.")
        return {
            "prompt": common.prompt(params),
            "width": common.integer(params, "width", 1024, 256, 2048, 16),
            "height": common.integer(params, "height", 1024, 256, 2048, 16),
            "count": common.integer(params, "count", 1, 1, 4),
            "seed": common.seed(params),
        }

    def run(self, params, models, ctx):
        ctx.progress(0, "Loading Krea 2")
        pipe = common.load(self.id, lambda: _build(models["krea2-turbo"]),
                           common.disk_size(models["krea2-turbo"]), files=models["krea2-turbo"])
        steps = common.step_progress(ctx, STEPS, "Krea 2")
        began = time.time()
        images = pipe(
            prompt=params["prompt"],
            width=params["width"],
            height=params["height"],
            num_inference_steps=STEPS,
            guidance_scale=GUIDANCE,
            num_images_per_prompt=params["count"],
            generator=common.generator(params["seed"]),
            callback_on_step_end=steps,
        ).images
        common.log_render(self.id, f"{params['width']}×{params['height']} ×{params['count']}", began, steps.marks)
        return common.save_images(images, ctx, params)


def _build(path):
    import torch
    from diffusers import Krea2Pipeline
    return Krea2Pipeline.from_pretrained(path, torch_dtype=torch.bfloat16, **common.LOAD_OPTIONS).to(common.device())


register(Krea2TextToImage())
