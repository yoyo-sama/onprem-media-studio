"""Model catalog and automatic download from Hugging Face.

A model is installed when its folder holds a `.complete` marker, written only
after every file arrived: an interrupted download is never mistaken for an
installed model, and the next attempt resumes it.
"""

import json
import shutil
import threading
from fnmatch import fnmatch
from pathlib import Path
from typing import Callable

from huggingface_hub import HfApi, hf_hub_download

from .config import Settings

CATALOG = Path(__file__).with_name("catalog.json")
MARKER = ".complete"

Progress = Callable[[float, str], None]


class ModelError(RuntimeError):
    pass


def _matches(path: str, entry: dict) -> bool:
    return any(fnmatch(path, p) for p in entry["allow"])


def _gated_hint(entry: dict) -> str:
    if not entry.get("gated"):
        return ""
    return (f" This repository is gated: set HF_TOKEN and accept its license at "
            f"https://huggingface.co/{entry['repo']}.")


class ModelStore:
    def __init__(self, settings: Settings, api: HfApi | None = None, fetch=hf_hub_download):
        self.settings = settings
        self.api = api or HfApi()
        self.fetch = fetch
        self.catalog = {m["id"]: m for m in json.loads(CATALOG.read_text())["models"]}
        self._locks = {mid: threading.Lock() for mid in self.catalog}
        self.downloading: dict[str, float] = {}

    def entry(self, model_id: str) -> dict:
        if model_id not in self.catalog:
            raise ModelError(f"Unknown model: {model_id}")
        return self.catalog[model_id]

    def path(self, model_id: str) -> Path:
        self.entry(model_id)
        return self.settings.models_dir / model_id

    def installed(self, model_id: str) -> bool:
        return (self.path(model_id) / MARKER).is_file()

    def status(self) -> list[dict]:
        return [
            {**m, "installed": self.installed(m["id"]), "progress": self.downloading.get(m["id"])}
            for m in self.catalog.values()
        ]

    def remote_files(self, model_id: str) -> tuple[str, list[tuple[str, int]]]:
        """Revision and (path, size) of every file the catalog asks for."""
        entry = self.entry(model_id)
        try:
            info = self.api.model_info(entry["repo"], files_metadata=True, token=self.settings.hf_token)
        except Exception as exc:  # gated, offline, renamed repository
            raise ModelError(f"Cannot read {entry['repo']}: {str(exc).rstrip('.')}.{_gated_hint(entry)}") from exc
        files = [(s.rfilename, s.size or 0) for s in info.siblings if _matches(s.rfilename, entry)]
        if not files:
            raise ModelError(f"No file of {entry['repo']} matches {entry['allow']}")
        return info.sha, files

    def download(self, model_id: str, progress: Progress | None = None,
                 cancelled: Callable[[], bool] | None = None) -> Path:
        progress = progress or (lambda frac, msg: None)
        target = self.path(model_id)
        with self._locks[model_id]:
            if self.installed(model_id):
                return target
            entry = self.entry(model_id)
            revision, files = self.remote_files(model_id)
            todo = [(p, size) for p, size in files if not (target / p).is_file()]
            needed = sum(size for _, size in todo)
            target.mkdir(parents=True, exist_ok=True)
            free = shutil.disk_usage(target).free
            if needed + self.settings.disk_reserve > free:
                raise ModelError(
                    f"Not enough disk space for {entry['label']}: {needed / 1024**3:.1f} GB needed, "
                    f"{free / 1024**3:.1f} GB free ({self.settings.disk_reserve / 1024**3:.0f} GB kept in reserve)")
            total = sum(size for _, size in files) or 1
            done = total - needed
            self.downloading[model_id] = done / total
            try:
                for rel, size in todo:
                    if cancelled and cancelled():
                        raise ModelError(f"Download of {entry['label']} cancelled")
                    progress(done / total, f"Downloading {entry['label']}: {rel}")
                    try:
                        self.fetch(repo_id=entry["repo"], filename=rel, revision=revision,
                                   local_dir=target, token=self.settings.hf_token)
                    except Exception as exc:
                        # Metadata of a gated repository is public: without a token the
                        # failure only shows up here, on the first file.
                        raise ModelError(
                            f"Cannot download {rel} from {entry['repo']}: {str(exc).rstrip('.')}.{_gated_hint(entry)}") from exc
                    done += size
                    self.downloading[model_id] = done / total
            finally:
                self.downloading.pop(model_id, None)
            (target / MARKER).write_text(json.dumps({"repo": entry["repo"], "revision": revision}))
            progress(1.0, f"{entry['label']} installed")
            return target

    def ensure(self, model_ids: list[str], progress: Progress | None = None,
               cancelled: Callable[[], bool] | None = None) -> dict[str, Path]:
        """Download what is missing, in order, and return every model's folder."""
        return {mid: self.download(mid, progress, cancelled) for mid in model_ids}
