"""Upscale ×2 (upscale-2x) through the real API, with the SPAN network replaced by a
pixel doubling: what is checked is the job's contract (one click, one file, twice the
size, the clip's frame count, rate and sound kept, nothing left behind on failure),
not the network's pictures, which only a render on the GB10 can judge."""

import json
import shutil
import subprocess

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from studio.main import create_app
from studio.models import MARKER
from studio.pipelines import REGISTRY, common, upscale
from studio.pipelines.upscale import video_info

from .test_api import FakeLlm, wait_for
from .test_image_pipelines import upload

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def double(frame):
    return frame.repeat(2, axis=0).repeat(2, axis=1)


@pytest.fixture
def fake(monkeypatch):
    calls = []
    monkeypatch.setattr(common, "load", lambda key, build, size=0: calls.append(key) or "model")
    monkeypatch.setattr(upscale, "upscale_frame", lambda model, frame: calls.append(frame.shape) or double(frame))
    return calls


@pytest.fixture
def client(settings, store, fake):
    path = store.path(upscale.MODEL)
    path.mkdir(parents=True)
    (path / MARKER).write_text("{}")
    with TestClient(create_app(settings, models=store, pipelines={"upscale-2x": REGISTRY["upscale-2x"]},
                               llm=FakeLlm())) as c:
        yield c


def submit(client, params):
    return client.post("/api/jobs", json={"pipeline": "upscale-2x", "params": params, "origin": "studio"})


def run(client, params, status="done"):
    res = submit(client, params)
    assert res.status_code == 201, res.text
    job = wait_for(client, res.json()["id"])
    assert job["status"] == status, job["error"]
    return job


def make_clip(path, size="160x96", seconds=1, audio=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=s={size}:r=24:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "aac"]
    subprocess.run(args + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(path)], check=True)


def test_nothing_runs_without_a_submission(client, fake):
    upload(client, 64, 48)
    assert client.get("/api/jobs").json() == [] and fake == []


@pytest.mark.parametrize("params, message", [
    ({}, "source must be"),
    ({"source": "inputs/none.png"}, "No such file"),
    ({"source": "x", "prompt": "sharper"}, "Unknown parameter(s): prompt"),
    ({"source": "x", "negative": "blur"}, "negative is not accepted"),
])
def test_bad_parameters_are_refused(client, params, message):
    res = submit(client, params)
    assert res.status_code == 422 and message in res.json()["detail"]


def test_a_sound_is_refused(client, settings):
    (settings.output_dir / "a.wav").write_bytes(b"RIFF")
    res = submit(client, {"source": "outputs/a.wav"})
    assert res.status_code == 422 and "neither an image nor a video" in res.json()["detail"]


def test_an_image_too_large_is_refused(client):
    res = submit(client, {"source": upload(client, upscale.MAX_IMAGE_EDGE + 1, 16)})
    assert res.status_code == 422 and "at most 4096 px" in res.json()["detail"]


def test_an_image_comes_out_twice_as_large(client, settings, fake):
    src = upload(client, 64, 48, "red")
    job = run(client, {"source": src})
    [ref] = job["outputs"]
    assert ref.startswith("outputs/upscale-2x/") and ref.endswith(".png")
    with Image.open(settings.output_dir / ref.removeprefix("outputs/")) as img:
        assert img.size == (128, 96)
        assert img.getpixel((5, 5)) == (255, 0, 0)
        meta = json.loads(img.text["studio"])
    assert meta["pipeline"] == "upscale-2x" and meta["params"] == {"source": src}
    assert fake == ["upscale-2x", (48, 64, 3)]  # the network saw the image once, in RGB


@needs_ffmpeg
def test_a_video_keeps_its_frames_rate_and_sound(client, settings, fake):
    make_clip(settings.output_dir / "h3-i2v" / "clip.mp4")
    job = run(client, {"source": "outputs/h3-i2v/clip.mp4"})
    [ref] = job["outputs"]
    assert ref.startswith("outputs/upscale-2x/") and ref.endswith(".mp4")
    info = video_info(settings.output_dir / ref.removeprefix("outputs/"))
    assert (info["width"], info["height"], info["rate"]) == (320, 192, "24/1")
    assert info["frames"] == 24 and info["audio"]
    assert fake.count((96, 160, 3)) == 24


@needs_ffmpeg
def test_a_silent_video_stays_silent(client, settings):
    make_clip(settings.output_dir / "v" / "mute.mp4", audio=False)
    job = run(client, {"source": "outputs/v/mute.mp4"})
    assert not video_info(settings.output_dir / job["outputs"][0].removeprefix("outputs/"))["audio"]


@needs_ffmpeg
def test_a_failed_video_leaves_no_file(client, settings, monkeypatch):
    make_clip(settings.output_dir / "v" / "clip.mp4")
    seen = []

    def breaks(model, frame):
        seen.append(1)
        if len(seen) == 3:
            raise RuntimeError("out of memory")
        return double(frame)
    monkeypatch.setattr(upscale, "upscale_frame", breaks)
    job = run(client, {"source": "outputs/v/clip.mp4"}, status="error")
    assert "out of memory" in job["error"]
    assert not list((settings.output_dir / "upscale-2x").glob("*.mp4"))


@needs_ffmpeg
def test_a_video_too_large_is_refused(client, settings):
    make_clip(settings.output_dir / "v" / "big.mp4", size="1922x16", seconds=0.1, audio=False)
    res = submit(client, {"source": "outputs/v/big.mp4"})
    assert res.status_code == 422 and "at most 1920 px" in res.json()["detail"]


def test_frames_are_converted_for_the_network():
    torch = pytest.importorskip("torch")

    class Net:
        dtype = torch.float32

        def __call__(self, x):
            assert x.shape == (1, 3, 2, 3) and x.dtype == torch.float32 and float(x.max()) <= 1
            return torch.nn.functional.interpolate(x, scale_factor=2, mode="nearest")
    common_device = common.device
    try:
        common.device = lambda: "cpu"
        frame = np.arange(18, dtype=np.uint8).reshape(2, 3, 3) * 10
        out = upscale.upscale_frame(Net(), frame)
    finally:
        common.device = common_device
    assert out.shape == (4, 6, 3) and out.dtype == np.uint8
    assert (out[::2, ::2] == frame).all()
