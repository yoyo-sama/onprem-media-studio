"""Pipeline contract. Each generation engine (Krea 2, Qwen Edit, H3) is one
Pipeline subclass registered in REGISTRY; the job queue knows nothing else.

Real pipelines arrive in steps 2 (image) and 3 (video) of the roadmap.
"""

from pathlib import Path


class Pipeline:
    id: str = ""
    models: list[str] = []  # catalog ids, downloaded before run() if missing

    def validate(self, params: dict) -> None:
        """Reject bad parameters at submission time, before the job is queued."""

    def run(self, params: dict, models: dict[str, Path], ctx) -> list[Path]:
        """Render and return the files written under ctx.output_dir."""
        raise NotImplementedError


REGISTRY: dict[str, Pipeline] = {}


def register(pipeline: Pipeline) -> Pipeline:
    REGISTRY[pipeline.id] = pipeline
    return pipeline
