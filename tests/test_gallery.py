"""Gallery: keys, metadata, listing, writes and the rules carried over from the
1.4 service (no overwrite, no definitive delete, no index wipe on an empty folder)."""

import json
import os
import shutil
import subprocess
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin

from studio.gallery import Gallery, GalleryError, extract, png_metadata
from studio.main import create_app
from studio.pipelines import common

from .test_api import FakeLlm

OLD = 1_000_000_000  # mtime far in the past: older than the "still being written" window
SAME_ORIGIN = {"Origin": "http://testserver"}


def png(path, meta=None, size=(8, 6), mtime=OLD):
    path.parent.mkdir(parents=True, exist_ok=True)
    info = PngImagePlugin.PngInfo()
    if meta is not None:
        info.add_text("studio", json.dumps(meta))
    Image.new("RGB", size, "red").save(path, pnginfo=info)
    os.utime(path, (mtime, mtime))
    return path


@pytest.fixture
def gallery(tmp_path):
    g = Gallery(tmp_path / "output", tmp_path / "data")
    yield g
    g.db.close()


def meta(prompt, pipeline="krea2-t2i", origin="text2image", seed=7, **extra):
    return {"pipeline": pipeline, "origin": origin, "params": {"prompt": prompt, "seed": seed}, **extra}


# ── Keys ─────────────────────────────────────────────────────────────────────

def test_keys_stay_inside_the_output_folder(gallery, tmp_path):
    root = gallery.root
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.png").touch()
    (root / "a b").mkdir()
    (root / "a b" / "it's é.png").touch()
    (root / "x.png").touch()
    os.symlink(outside / "secret.png", root / "lnk.png")
    os.symlink(outside, root / "dirlink")
    os.symlink("x.png", root / "inner.png")
    assert gallery.path("x.png") and gallery.path("a b/it's é.png") and gallery.path("A.PNG")
    for key in ("", "/x.png", "../x.png", "a/../x.png", "a//x.png", "./x.png", "x\0.png", "a\\x.png",
                ".hidden.png", "a/.h/x.png", ".trash/1-abc/x.png", "c.txt", "x", "x" * 1030 + ".png",
                "lnk.png", "inner.png", "dirlink/secret.png", "\udc80.png", None, 5):
        assert gallery.path(key) is None, key
    assert gallery.path(".trash/1-abc/x.png", trash=True)
    for key in ("/.trash/x.png", ".trash/../x.png", ".trash/.h/x.png", "a/.trash/x.png"):
        assert gallery.path(key, trash=True) is None, key


def test_rename_names(gallery):
    assert gallery.renamed("krea2-t2i/a.png", "b é (1).PNG") == "krea2-t2i/b é (1).PNG"
    assert gallery.renamed("x.mp4", "y.MP4") == "y.MP4"
    assert gallery.renamed("a.png", "x" * 146 + ".png")
    for name in ("../x.png", "a/b.png", "a\\b.png", ".cache.png", ".png", "x.exe", "x.jpg", "x.png.exe",
                 "x" * 147 + ".png", "x\0.png", "x\n.png", "x\x7f.png", "x\x85.png", "", None, 5):
        with pytest.raises(GalleryError) as err:
            gallery.renamed("krea2-t2i/a.png", name)
        assert err.value.status == 400, name


def test_key_lists_and_tag_names(gallery):
    assert gallery.keys([]) == []
    for keys, trash, status in ((["x.png", "x.png"], False, 400), ([".trash/1-a/x.png"], False, 400),
                                (["x.png"], True, 400), ("x.png", False, 400),
                                ([f"k{i}.png" for i in range(101)], False, 413)):
        with pytest.raises(GalleryError) as err:
            gallery.keys(keys, trash=trash)
        assert err.value.status == status, keys
    assert gallery.tag_name("  Été  ") == "Été"
    for name in ("", "   ", "x" * 41, "a\tb", None, 3):
        with pytest.raises(GalleryError):
            gallery.tag_name(name)


# ── Metadata ─────────────────────────────────────────────────────────────────

def test_png_metadata_written_by_the_engines_is_read_back(tmp_path):
    params = {"prompt": "a fox", "seed": 42, "width": 8}
    ctx = SimpleNamespace(output_dir=tmp_path, job=SimpleNamespace(pipeline="krea2-t2i", origin="campaign", id="job-1"))
    (path,) = common.save_images([Image.new("RGB", (8, 6))], ctx, params)
    found = extract(path, "krea2-t2i/" + path.name)
    assert (found["prompt"], found["seed"], found["pipeline"], found["origin"]) == ("a fox", 42, "krea2-t2i", "campaign")
    assert (found["w"], found["h"], found["app"], found["meta_ok"]) == (8, 6, 1, 1)
    (last,) = common.save_images([Image.new("RGB", (8, 6))], ctx, params, role="last-frame", stem="clip")
    assert last.name == "clip-1.png" and extract(last, "x/clip-1.png")["app"] == 0


def test_damaged_png_is_listed_without_metadata(tmp_path):
    path = png(tmp_path / "a.png", meta("p"))
    data = path.read_bytes()
    i = data.index(b"tEXt")
    path.write_bytes(data[:i - 4] + (10**6).to_bytes(4, "big") + data[i:])  # chunk longer than the file
    with pytest.raises(ValueError):
        png_metadata(path)
    assert extract(path, "krea2-t2i/a.png")["meta_ok"] == 0
    assert extract(path, "krea2-t2i/a.png")["pipeline"] == "krea2-t2i"  # from the folder


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_video_metadata_is_tagged_then_read_back(tmp_path):
    video = tmp_path / "h3-t2v" / "clip.mp4"
    video.parent.mkdir()
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=24", "-t", "1",
                    "-pix_fmt", "yuv420p", str(video)], check=True)
    ctx = SimpleNamespace(job=SimpleNamespace(pipeline="h3-t2v", origin="text2video"))
    common.tag_video(video, ctx, {"prompt": "é \"q\"", "seed": 3, "loras": [{"name": "s.safetensors", "strength": 1}]})
    assert sorted(os.listdir(video.parent)) == ["clip.mp4"]
    found = extract(video, "h3-t2v/clip.mp4")
    assert (found["prompt"], found["seed"], found["loras"], found["origin"]) == ("é \"q\"", 3, ["s.safetensors"], "text2video")
    assert (found["w"], found["h"]) == (64, 48) and found["duration"] == pytest.approx(1, abs=0.1)


# ── Scan and listing ─────────────────────────────────────────────────────────

def test_scan_indexes_lists_and_pages(gallery):
    for i in range(5):
        png(gallery.root / "krea2-t2i" / f"{i}.png", meta(f"red fox number {i}"), mtime=OLD + i)
    png(gallery.root / "qwen-edit-2509" / "e.png", meta("a snowy owl", "qwen-edit-2509", "image2image"), mtime=OLD + 10)
    png(gallery.root / "h3-t2v" / "c-1.png", meta("clip", "h3-t2v", role="last-frame"), mtime=OLD + 11)
    png(gallery.root / ".trash" / "1-a" / "t.png", meta("trashed by hand"))
    png(gallery.root / "fresh.png", meta("still being written"), mtime=time.time())
    (gallery.root / "notes.txt").write_text("ignored")
    gallery.scan()
    health = gallery.health()
    assert (health["indexed"], health["app"], health["warning"]) == (7, 6, None)

    page = gallery.page({"limit": 4})
    assert [a["key"] for a in page["items"]] == ["qwen-edit-2509/e.png", "krea2-t2i/4.png", "krea2-t2i/3.png",
                                                 "krea2-t2i/2.png"]
    assert page["counts"] == {"image": 6, "video": 0}
    rest = gallery.page({"limit": 4, "cursor": page["next"]})
    assert [a["key"] for a in rest["items"]] == ["krea2-t2i/1.png", "krea2-t2i/0.png"] and rest["next"] is None
    with pytest.raises(GalleryError):
        gallery.page({"cursor": page["next"], "sort": "old"})  # a cursor of another order
    assert len(gallery.page({"scope": "all"})["items"]) == 7  # with the last frame

    first = page["items"][0]
    assert first["url"].startswith("/outputs/qwen-edit-2509/e.png?v=") and first["ref"] == "outputs/qwen-edit-2509/e.png"
    assert (first["prompt"], first["pipeline"], first["origin"], first["seed"]) == ("a snowy owl", "qwen-edit-2509",
                                                                                  "image2image", 7)
    assert [a["key"] for a in gallery.page({"q": "fox 3"})["items"]] == ["krea2-t2i/3.png"]
    assert [a["key"] for a in gallery.page({"q": "OWL"})["items"]] == ["qwen-edit-2509/e.png"]
    assert len(gallery.page({"pipeline": "krea2-t2i"})["items"]) == 5
    assert len(gallery.page({"origin": "image2image"})["items"]) == 1
    facets = gallery.facets("app")
    assert facets["pipelines"][0] == {"id": "krea2-t2i", "count": 5}
    days = gallery.dates({"unit": "day"})["periods"]
    assert sum(p["count"] for p in days) == 6 and all(p["end"] - p["start"] == 86400000 for p in days)
    assert gallery.dates({"unit": "week"})["periods"][0]["end"] - gallery.dates({"unit": "week"})["periods"][0]["start"] == 7 * 86400000


def test_long_prompts_are_cut_in_lists_only(gallery):
    png(gallery.root / "a.png", meta("x" * 1000))
    gallery.scan()
    assert len(gallery.page({})["items"][0]["prompt"]) == 400
    assert len(gallery.detail("a.png")["prompt"]) == 1000


def test_a_file_not_indexed_yet_is_indexed_on_demand(gallery):
    png(gallery.root / "new.png", meta("just written"), mtime=time.time())
    assert gallery.detail("new.png")["prompt"] == "just written"


def test_empty_or_missing_folder_never_wipes_the_index(gallery):
    png(gallery.root / "a.png", meta("keep me"))
    gallery.scan()
    os.remove(gallery.root / "a.png")
    gallery.scan()
    assert gallery.health()["indexed"] == 1 and "nothing removed" in gallery.health()["warning"]
    png(gallery.root / "b.png", meta("another"))
    gallery.scan()  # the folder is not empty any more: a.png is really gone
    assert [a["key"] for a in gallery.page({})["items"]] == ["b.png"]


def test_thumbnails_are_small_webp_and_cached(gallery):
    png(gallery.root / "big.png", meta("p"), size=(1280, 720))
    gallery.scan()
    data = gallery.thumb("big.png")
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    assert len(os.listdir(gallery.thumbs)) == 1 and gallery.thumb("big.png") == data
    with pytest.raises(GalleryError) as err:
        gallery.thumb("missing.png")
    assert err.value.status == 404


# ── Writes ───────────────────────────────────────────────────────────────────

def test_tags_and_favourites_survive_rename_trash_and_restore(gallery):
    for name in ("a.png", "b.png"):
        png(gallery.root / name, meta(name))
    gallery.scan()
    gallery.tag(["a.png"], ["Keep", "été"], [])
    assert gallery.tag(["a.png"], ["KEEP"], [])["assets"][0]["tags"] == ["Keep", "été"]  # case-insensitive
    gallery.set_fav(["a.png"], True)
    gallery.rename("a.png", "a2.png")
    assert not (gallery.root / "a.png").exists() and (gallery.root / "a2.png").exists()
    with pytest.raises(GalleryError) as err:
        gallery.rename("a2.png", "b.png")
    assert err.value.status == 409 and (gallery.root / "b.png").exists()

    trash_key = gallery.trash(["a2.png"])["trashed"][0]["trashKey"]
    assert trash_key.startswith(".trash/") and (gallery.root / trash_key).exists()
    assert gallery.page({})["counts"]["image"] == 1 and len(gallery.page({"scope": "trash"})["items"]) == 1
    png(gallery.root / "a2.png", meta("same name taken meanwhile"))
    restored = gallery.restore([trash_key])["restored"][0]["key"]
    assert restored == "a2_restored.png"
    row = gallery.detail(restored)
    assert row["fav"] and row["tags"] == ["Keep", "été"]
    assert os.listdir(gallery.root / ".trash") == []  # the emptied .trash/<id>/ is pruned, .trash stays
    assert {t["name"]: t["count"] for t in gallery.facets("app")["tags"]} == {"Keep": 1, "été": 1}


def test_a_rename_during_a_scan_keeps_the_row(gallery, monkeypatch):
    png(gallery.root / "a.png", meta("p"))
    gallery.scan()
    gallery.tag(["a.png"], ["guard"], [])
    real = gallery.walk

    def renamed_meanwhile():
        gallery.rename("a.png", "a2.png")
        return real()
    monkeypatch.setattr(gallery, "walk", renamed_meanwhile)
    gallery.scan()
    assert gallery.detail("a2.png")["tags"] == ["guard"]


def test_session_files_cannot_be_renamed(gallery):
    png(gallery.root / "s.png", meta("shot", origin="storyboard"))
    gallery.scan()
    with pytest.raises(GalleryError) as err:
        gallery.rename("s.png", "t.png")
    assert err.value.status == 409


def test_the_gallery_module_never_deletes_a_file_for_good():
    import inspect

    import studio.gallery as module
    source = inspect.getsource(module)
    assert "rmtree" not in source and "os.remove(" not in source
    assert source.count("os.unlink(") == 2  # both in _move, right after a link


# ── HTTP ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(settings, store):
    app = create_app(settings, models=store, pipelines={}, llm=FakeLlm())
    with TestClient(app) as c:
        yield c


def test_http_routes(client, settings):
    png(settings.output_dir / "krea2-t2i" / "a.png", meta("a red fox"))
    client.app.state.gallery.scan()
    assert client.get("/api/gallery/health").json()["indexed"] == 1
    items = client.get("/api/gallery/assets", params={"q": "fox"}).json()["items"]
    assert items[0]["key"] == "krea2-t2i/a.png"
    assert client.get(items[0]["url"]).status_code == 200
    thumb = client.get(items[0]["thumb"])
    assert thumb.headers["content-type"] == "image/webp" and "immutable" in thumb.headers["cache-control"]
    assert client.get("/api/gallery/asset", params={"key": "../x.png"}).status_code == 400
    assert client.get("/api/gallery/assets", params={"type": "gif"}).status_code == 400

    body = {"keys": ["krea2-t2i/a.png"], "fav": True}
    assert client.post("/api/gallery/fav", json=body).status_code == 403  # no Origin, no Referer
    assert client.post("/api/gallery/fav", json=body, headers={"Origin": "http://evil.example"}).status_code == 403
    assert client.post("/api/gallery/fav", json=body, headers={**SAME_ORIGIN, "Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/api/gallery/fav", json=body, headers=SAME_ORIGIN).json() == {"ok": True, "changed": 1}
    assert client.get("/api/gallery/assets", params={"fav": "1"}).json()["counts"]["image"] == 1
    bad = client.post("/api/gallery/fav", json={"keys": "x", "fav": True}, headers=SAME_ORIGIN)
    assert bad.status_code == 400 and bad.json()["detail"] == "keys must be a list"
    trashed = client.post("/api/gallery/trash", json={"keys": ["krea2-t2i/a.png"]}, headers=SAME_ORIGIN).json()
    assert trashed["trashed"][0]["key"] == "krea2-t2i/a.png"


def test_inputs_are_listed_read_only_newest_first(client, settings):
    inputs = settings.input_dir
    png(inputs / "old.png", mtime=OLD)
    png(inputs / "new.png", mtime=OLD + 60)
    (inputs / "voice.wav").write_bytes(b"RIFF")  # sounds are not shown
    (inputs / ".hidden.png").write_bytes(b"x")
    shutil.copy(inputs / "old.png", inputs / "clip.mp4")  # a clip, by its extension
    page = client.get("/api/gallery/inputs").json()
    assert [a["key"] for a in page["items"]] == ["inputs/new.png", "inputs/old.png"]
    assert page["counts"] == {"image": 2, "video": 1} and page["next"] is None
    a = page["items"][0]
    assert a["ref"] == "inputs/new.png" and a["input"] and a["type"] == "image"
    assert client.get(a["url"]).status_code == 200
    assert client.get(a["thumb"]).headers["content-type"] == "image/webp"
    first = client.get("/api/gallery/inputs", params={"limit": 1}).json()
    assert [x["filename"] for x in first["items"]] == ["new.png"] and first["next"] == "1"
    rest = client.get("/api/gallery/inputs", params={"limit": 1, "cursor": first["next"]}).json()
    assert [x["filename"] for x in rest["items"]] == ["old.png"] and rest["next"] is None
    assert client.get("/api/gallery/inputs", params={"type": "video"}).json()["items"][0]["filename"] == "clip.mp4"
    for name in ("../outputs/x.png", "voice.wav", ".hidden.png", "missing.png"):
        assert client.get("/api/gallery/input-thumb", params={"name": name}).status_code == 404
    assert client.get("/api/gallery/inputs", params={"type": "audio"}).status_code == 400


def test_a_finished_job_enters_the_gallery_at_once(settings, store):
    from .test_api import Echo

    class Painter(Echo):
        id = "painter"
        models = []

        def run(self, params, models, ctx):
            return common.save_images([Image.new("RGB", (4, 4))], ctx, params)

    app = create_app(settings, models=store, pipelines={"painter": Painter()}, llm=FakeLlm())
    with TestClient(app) as c, c.websocket_connect("/api/ws") as ws:
        c.post("/api/jobs", json={"pipeline": "painter", "params": {"prompt": "now"}, "origin": "canvas"})
        # The gallery is up to date when the "done" event reaches a client.
        while (done := ws.receive_json()["job"])["status"] != "done":
            pass
        (item,) = c.get("/api/gallery/assets").json()["items"]
        assert (item["prompt"], item["origin"], item["ref"]) == ("now", "canvas", done["outputs"][0])
        bad = c.post("/api/jobs", json={"pipeline": "painter", "params": {"prompt": "x"}, "origin": "Bad Origin"})
        assert bad.status_code == 422
