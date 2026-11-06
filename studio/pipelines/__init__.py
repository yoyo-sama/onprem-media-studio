"""Pipeline contract. Each generation engine (Krea 2, Qwen Image 2.1, H3, the ×2 upscaler) is one
Pipeline subclass registered in REGISTRY; the job queue knows nothing else.

Pipelines receive final prompts: prompt compilation (sheet templates, shot
anchoring blocks) belongs to the front end (ADR 0001). A pipeline owns what is
true of its model whatever the prompt: steps, guidance, image slot order, size.
"""

from pathlib import Path


class Pipeline:
    id: str = ""
    models: list[str] = []  # catalog ids, downloaded before run() if missing

    def validate(self, params: dict, files) -> dict:
        """Reject bad parameters at submission time, before the job is queued, and
        return them normalised (defaults filled in, seed drawn) as the job keeps them.
        `files` is the FileStore that resolves image references."""
        return params

    def needs(self, settings) -> list[str]:
        """Catalog ids to download before run(); `models` unless the choice
        depends on a setting (the H3 precision)."""
        return self.models

    def run(self, params: dict, models: dict[str, Path], ctx) -> list[Path]:
        """Render and return the files written under ctx.output_dir."""
        raise NotImplementedError


REGISTRY: dict[str, Pipeline] = {}


def register(pipeline: Pipeline) -> Pipeline:
    REGISTRY[pipeline.id] = pipeline
    return pipeline


from . import h3, krea2, montage, qwen, upscale  # noqa: E402,F401  (each module registers its engines)
