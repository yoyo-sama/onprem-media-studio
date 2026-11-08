import json
from collections import namedtuple

import pytest

from studio import models as models_mod
from studio.models import MARKER, ModelError, ModelStore

from .conftest import FakeApi, FakeFetch


def test_catalog_entries_are_complete(store):
    for entry in store.catalog.values():
        assert {"id", "label", "role", "repo", "allow", "gated", "license", "qualified"} <= entry.keys()
        assert isinstance(entry["qualified"], bool)


def test_qualified_models_are_pinned_to_the_commit_qualified(store):
    """A new upstream commit must change nothing until it is qualified again (LESSONS #49)."""
    for entry in store.catalog.values():
        if entry["qualified"]:
            assert len(entry.get("revision", "")) == 40, entry["id"]


def test_download_fetches_only_allowed_files_and_marks_complete(store, fetch):
    path = store.download("gemma4-26b-a4b")
    assert sorted(fetch.calls) == ["gemma-4-26B-A4B-it-Q4_0.gguf", "mmproj-gemma-4-26B-A4B-it-Q8_0.gguf"]
    assert store.installed("gemma4-26b-a4b")
    # The commit the catalog pins, recorded with the files.
    assert json.loads((path / MARKER).read_text()) == {"repo": "ggml-org/gemma-4-26B-A4B-it-GGUF",
                                                       "revision": store.catalog["gemma4-26b-a4b"]["revision"]}


def test_installed_model_is_not_downloaded_again(store, fetch):
    store.download("gemma4-26b-a4b")
    fetch.calls.clear()
    store.ensure(["gemma4-26b-a4b"])
    assert fetch.calls == []


def test_interrupted_download_resumes_missing_files_only(store, fetch):
    folder = store.path("gemma4-26b-a4b")
    folder.mkdir(parents=True)
    (folder / "gemma-4-26B-A4B-it-Q4_0.gguf").write_bytes(b"x" * 100)
    assert not store.installed("gemma4-26b-a4b")
    store.download("gemma4-26b-a4b")
    assert fetch.calls == ["mmproj-gemma-4-26B-A4B-it-Q8_0.gguf"]


def test_progress_is_reported(store):
    seen = []
    store.download("gemma4-26b-a4b", lambda frac, msg: seen.append(frac))
    assert seen[-1] == 1.0
    assert seen == sorted(seen)


def test_cancel_stops_before_next_file(store, fetch):
    with pytest.raises(ModelError, match="cancelled"):
        store.download("gemma4-26b-a4b", cancelled=lambda: True)
    assert fetch.calls == []
    assert not store.installed("gemma4-26b-a4b")


def test_disk_space_is_checked_before_download(store, fetch, monkeypatch):
    Usage = namedtuple("Usage", "total used free")
    monkeypatch.setattr(models_mod.shutil, "disk_usage", lambda p: Usage(1000, 950, 50))
    with pytest.raises(ModelError, match="Not enough disk space"):
        store.download("gemma4-26b-a4b")
    assert fetch.calls == []


def test_gated_repository_error_tells_how_to_fix(settings, fetch):
    store = ModelStore(settings, api=FakeApi(fail=RuntimeError("401")), fetch=fetch)
    with pytest.raises(ModelError, match="HF_TOKEN"):
        store.download("krea2-turbo")


def test_gated_file_error_is_a_model_error(settings):
    # A gated repository answers model_info without a token, then refuses the files.
    store = ModelStore(settings, api=FakeApi(), fetch=FakeFetch(fail=RuntimeError("401 gated")))
    store.catalog["gemma4-26b-a4b"]["gated"] = True
    with pytest.raises(ModelError, match="HF_TOKEN"):
        store.download("gemma4-26b-a4b")
    assert not store.installed("gemma4-26b-a4b")
    assert store.downloading == {}


def test_unknown_model(store):
    with pytest.raises(ModelError, match="Unknown model"):
        store.download("nope")


def test_pending_bytes_counts_missing_files_only(store, fetch):
    assert store.pending_bytes("gemma4-26b-a4b") == 110
    folder = store.path("gemma4-26b-a4b")
    folder.mkdir(parents=True)
    (folder / "gemma-4-26B-A4B-it-Q4_0.gguf").write_bytes(b"x" * 100)
    assert store.pending_bytes("gemma4-26b-a4b") == 10
    store.download("gemma4-26b-a4b")
    assert store.pending_bytes("gemma4-26b-a4b") == 0
    assert fetch.calls == ["mmproj-gemma-4-26B-A4B-it-Q8_0.gguf"]
