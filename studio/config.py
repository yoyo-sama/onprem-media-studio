"""Runtime settings, read once from environment variables.

The display name lives here and only here: renaming the product means changing
APP_NAME (or setting STUDIO_APP_NAME), never hunting for strings in the code.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "OnPrem Media Studio"
APP_VERSION = "2.0.0.dev0"


def _path(var: str, default: Path) -> Path:
    return Path(os.environ.get(var, default)).expanduser().resolve()


@dataclass(frozen=True)
class Settings:
    app_name: str = field(default_factory=lambda: os.environ.get("STUDIO_APP_NAME") or APP_NAME)
    data_dir: Path = field(default_factory=lambda: _path("STUDIO_DATA_DIR", Path.home() / ".local/share/studio"))
    host: str = field(default_factory=lambda: os.environ.get("STUDIO_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.environ.get("STUDIO_PORT", "8090")))
    # Gated repositories (Krea 2) need a token; it is read here and never logged.
    hf_token: str | None = field(default_factory=lambda: os.environ.get("HF_TOKEN") or None)
    llama_server: str = field(default_factory=lambda: os.environ.get("STUDIO_LLAMA_SERVER", "llama-server"))
    llm_port: int = field(default_factory=lambda: int(os.environ.get("STUDIO_LLM_PORT", "8095")))
    # Catalog id of the LLM (prompt enrichment and the assistant); gemma4-26b-a4b is the
    # only one listed.
    llm_model: str = field(default_factory=lambda: os.environ.get("STUDIO_LLM_MODEL", "gemma4-26b-a4b"))
    # Seconds between two scans of the output folder by the gallery.
    gallery_scan: float = field(default_factory=lambda: float(os.environ.get("STUDIO_GALLERY_SCAN", "60")))
    # Branch the in-app update follows (bare-metal git checkout; under Docker, the updater's).
    update_branch: str = field(default_factory=lambda: os.environ.get("STUDIO_UPDATE_BRANCH", "main"))
    # Docker: the `updater` service of compose.yaml, which pulls and rebuilds the image.
    updater_url: str = field(default_factory=lambda: os.environ.get("STUDIO_UPDATER_URL", ""))
    # Free disk space kept after any download, in bytes.
    disk_reserve: int = field(default_factory=lambda: int(os.environ.get("STUDIO_DISK_RESERVE_GB", "20")) * 1024**3)

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def input_dir(self) -> Path:
        return self.data_dir / "input"

    @property
    def loras_dir(self) -> Path:
        return self.data_dir / "loras"

    @property
    def output_dir(self) -> Path:
        return self.data_dir / "output"
