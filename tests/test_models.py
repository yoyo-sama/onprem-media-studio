import json
from collections import namedtuple

import pytest

from studio import models as models_mod
from studio.models import MARKER, ModelError, ModelStore

from .conftest import FakeApi


def test_catalog_entries_are_complete(store):
    for entry in store.catalog.values():
        assert {"id", "label", "role", "repo", "allow", "gated", "license", "qualified"} <= entry.keys()
        assert isinstance(entry["qualified"], bool)
    # Qualified only by a real render inspected on the GB10: the FP8 fallbacks never rendered.
    assert not store.catalog["fasth3-v2-fp8"]["qualified"]
    assert not store.catalog["fasth3-omniref-fp8"]["qualified"]


def test_download_fetches_only_allowed_files_and_marks_complete(store, fetch):
    path = store.download("gemma4-e4b")
    assert sorted(fetch.calls) == ["gemma-4-E4B-it-Q8_0.gguf", "mmproj-gemma-4-E4B-it-Q8_0.gguf"]
    assert store.installed("gemma4-e4b")
    assert json.loads((path / MARKER).read_text()) == {"repo": "ggml-org/gemma-4-E4B-it-GGUF", "revision": "abc123"}


def test_installed_model_is_not_downloaded_again(store, fetch):
    store.download("gemma4-e4b")
    fetch.calls.clear()
    store.ensure(["gemma4-e4b"])
    assert fetch.calls == []


def test_interrupted_download_resumes_missing_files_only(store, fetch):
    folder = store.path("gemma4-e4b")
    folder.mkdir(parents=True)
    (folder / "gemma-4-E4B-it-Q8_0.gguf").write_bytes(b"x" * 100)
    assert not store.installed("gemma4-e4b")
    store.download("gemma4-e4b")
    assert fetch.calls == ["mmproj-gemma-4-E4B-it-Q8_0.gguf"]


def test_progress_is_reported(store):
    seen = []
    store.download("gemma4-e4b", lambda frac, msg: seen.append(frac))
    assert seen[-1] == 1.0
    assert seen == sorted(seen)


def test_cancel_stops_before_next_file(store, fetch):
    with pytest.raises(ModelError, match="cancelled"):
        store.download("gemma4-e4b", cancelled=lambda: True)
    assert fetch.calls == []
    assert not store.installed("gemma4-e4b")


def test_disk_space_is_checked_before_download(store, fetch, monkeypatch):
    Usage = namedtuple("Usage", "total used free")
    monkeypatch.setattr(models_mod.shutil, "disk_usage", lambda p: Usage(1000, 950, 50))
    with pytest.raises(ModelError, match="Not enough disk space"):
        store.download("gemma4-e4b")
    assert fetch.calls == []


def test_gated_repository_error_tells_how_to_fix(settings, fetch):
    store = ModelStore(settings, api=FakeApi(fail=RuntimeError("401")), fetch=fetch)
    with pytest.raises(ModelError, match="HF_TOKEN"):
        store.download("krea2-turbo")


def test_unknown_model(store):
    with pytest.raises(ModelError, match="Unknown model"):
        store.download("nope")
