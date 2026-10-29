from types import SimpleNamespace

import pytest

from studio.config import Settings
from studio.models import ModelStore

FILES = {
    "gemma-4-E4B-it-Q8_0.gguf": 100,
    "mmproj-gemma-4-E4B-it-Q8_0.gguf": 10,
    "README.md": 1,
}


class FakeApi:
    """Stands in for HfApi: one repository, three files."""

    def __init__(self, fail: Exception | None = None):
        self.fail = fail

    def model_info(self, repo, files_metadata, token):
        if self.fail:
            raise self.fail
        return SimpleNamespace(
            sha="abc123",
            siblings=[SimpleNamespace(rfilename=f, size=s) for f, s in FILES.items()],
        )


class FakeFetch:
    def __init__(self, fail: Exception | None = None):
        self.fail = fail
        self.calls = []

    def __call__(self, repo_id, filename, revision, local_dir, token):
        self.calls.append(filename)
        if self.fail:
            raise self.fail
        (local_dir / filename).write_bytes(b"x" * FILES[filename])


@pytest.fixture
def settings(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("STUDIO_DISK_RESERVE_GB", "0")
    # The Docker image sets these; tests must not depend on where they run.
    monkeypatch.delenv("STUDIO_LLAMA_SERVER", raising=False)
    monkeypatch.delenv("HF_TOKEN", raising=False)
    return Settings()


@pytest.fixture
def fetch():
    return FakeFetch()


@pytest.fixture
def store(settings, fetch):
    return ModelStore(settings, api=FakeApi(), fetch=fetch)
