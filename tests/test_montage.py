"""Montage jobs (video-concat, image-grid, video-frames) through the real API,
on small clips made by ffmpeg. Skipped without ffmpeg."""

import json
import shutil
import subprocess
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from studio.main import create_app
from studio.pipelines import REGISTRY
from studio.pipelines.montage import probe

from .test_api import FakeLlm, wait_for

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture
def client(settings, store):
    pipelines = {k: REGISTRY[k] for k in ("video-concat", "image-grid", "video-frames")}
    with TestClient(create_app(settings, models=store, pipelines=pipelines, llm=FakeLlm())) as c:
        yield c


def make_clip(path, color, seconds=1, size="320x192", audio=True, gain_db=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s={size}:r=24:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-af", f"volume={gain_db}dB", "-c:a", "aac"]
    subprocess.run(args + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(path)], check=True)


def run(client, pipeline, params):
    res = client.post("/api/jobs", json={"pipeline": pipeline, "params": params, "origin": "storyboard"})
    assert res.status_code == 201, res.text
    job = wait_for(client, res.json()["id"])
    assert job["status"] == "done", job["error"]
    return job


def test_a_cancelled_montage_stops_ffmpeg():
    """A cancel stops the running ffmpeg within a second, not after its 900 s timeout."""
    from studio.jobs import Cancelled
    from studio.pipelines.montage import ffmpeg
    calls = []

    def check():
        calls.append(1)
        if len(calls) > 1:
            raise Cancelled()
    began = time.monotonic()
    with pytest.raises(Cancelled):
        ffmpeg("ffmpeg", "-v", "error", "-re", "-f", "lavfi", "-i", "nullsrc=d=60", "-f", "null", "-", check=check)
    assert time.monotonic() - began < 5


def test_concat_joins_clips_with_sound(client, settings):
    out = settings.output_dir
    make_clip(out / "h3-i2v" / "a.mp4", "red")
    make_clip(out / "h3-i2v" / "b.mp4", "blue", size="192x320")  # other aspect: letterboxed
    job = run(client, "video-concat", {"clips": ["outputs/h3-i2v/a.mp4", "outputs/h3-i2v/b.mp4"]})
    [ref] = job["outputs"]
    assert ref.startswith("outputs/video-concat/") and ref.endswith(".mp4")
    info = probe(settings.output_dir / ref.removeprefix("outputs/"))
    assert (info["width"], info["height"]) == (320, 192)
    assert info["audio"] and abs(info["frames"] - 48) <= 1  # AAC priming may add a frame


def level(path, start, length):
    from studio.pipelines.montage import ffmpeg
    import re as _re
    out = ffmpeg("ffmpeg", "-v", "info", "-nostats", "-ss", str(start), "-t", str(length), "-i", str(path),
                 "-af", "volumedetect", "-f", "null", "-", capture_stderr=True)
    return float(_re.search(r"mean_volume:\s*(-?[\d.]+) dB", out).group(1))


@pytest.mark.parametrize("smooth", [False, True])
def test_smooth_audio_matches_the_levels_of_a_continuous_take(client, settings, smooth):
    """Two clips 8 dB apart: a hard join keeps the jump, smooth_audio brings both to one level
    without moving the sound against the image."""
    make_clip(settings.output_dir / "h3-i2v" / "q.mp4", "red", gain_db=-8)
    make_clip(settings.output_dir / "h3-i2v" / "l.mp4", "blue")
    job = run(client, "video-concat", {"clips": ["outputs/h3-i2v/q.mp4", "outputs/h3-i2v/l.mp4"], "smooth_audio": smooth})
    path = settings.output_dir / job["outputs"][0].removeprefix("outputs/")
    jump = level(path, 1.2, 0.6) - level(path, 0.2, 0.6)
    assert (abs(jump) < 1) if smooth else (abs(jump - 8) < 1), jump
    assert abs(probe(path)["frames"] - 48) <= 1


def test_level_gains_bring_every_clip_to_the_take_loudness():
    """Every audible clip goes to TAKE_LUFS, a lift or a cut never beyond MAX_GAIN_DB, and a
    silent clip is left as it is."""
    from studio.pipelines.montage import MAX_GAIN_DB, TAKE_LUFS, level_gains
    assert level_gains([-33.0, -17.0]) == [TAKE_LUFS + 33.0, TAKE_LUFS + 17.0]
    assert level_gains([-60.0, -70.0]) == [MAX_GAIN_DB, 0.0]


def test_smooth_audio_lifts_a_quiet_take_to_the_take_loudness(client, settings):
    """Two clips of a quiet ambience: the smoothed take reaches TAKE_LUFS, its peaks held at
    -1 dBFS by the limiter, and the sound stays as long as the image."""
    from studio.pipelines.montage import TAKE_LUFS, loudness, ffmpeg
    import re as _re
    for name in ("a", "b"):
        make_clip(settings.output_dir / "h3-i2v" / f"{name}.mp4", "red", gain_db=-15)
    clips = ["outputs/h3-i2v/a.mp4", "outputs/h3-i2v/b.mp4"]
    path = settings.output_dir / run(client, "video-concat", {"clips": clips, "smooth_audio": True})["outputs"][0].removeprefix("outputs/")
    lufs, seconds = loudness(path)
    assert abs(lufs - TAKE_LUFS) < 1.5, lufs
    assert abs(seconds - 2) < 0.1, seconds
    out = ffmpeg("ffmpeg", "-v", "info", "-nostats", "-i", str(path), "-af", "volumedetect", "-f", "null", "-", capture_stderr=True)
    assert float(_re.search(r"max_volume:\s*(-?[\d.]+) dB", out).group(1)) <= -0.9


def true_peak(path):
    """True peak (dBTP, EBU R128) of a clip's sound."""
    from studio.pipelines.montage import ffmpeg
    import re as _re
    out = ffmpeg("ffmpeg", "-v", "info", "-nostats", "-i", str(path), "-af", "ebur128=peak=true:framelog=quiet",
                 "-f", "null", "-", capture_stderr=True)
    return float(_re.findall(r"Peak:\s*(-?[\d.]+|-inf) dBFS", out)[-1])


def test_smooth_audio_reaches_the_take_loudness_through_clicks(client, settings):
    """A quiet ambience with clicks at full scale (footsteps): the limiter takes back part of
    the lift, so the take is measured and lifted again until it reaches TAKE_LUFS."""
    from studio.pipelines.montage import TAKE_LUFS, loudness
    expr = "0.02*sin(2*PI*440*t)+if(lt(mod(t\\,0.25)\\,0.003)\\,0.99\\,0)"
    for name in ("a", "b"):
        path = settings.output_dir / "h3-i2v" / f"click-{name}.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x192:r=24:d=2",
                        "-f", "lavfi", "-i", f"aevalsrc={expr}:d=2:s=48000", "-c:a", "aac", "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", "-shortest", str(path)], check=True)
    clips = ["outputs/h3-i2v/click-a.mp4", "outputs/h3-i2v/click-b.mp4"]
    path = settings.output_dir / run(client, "video-concat", {"clips": clips, "smooth_audio": True})["outputs"][0].removeprefix("outputs/")
    lufs, seconds = loudness(path)
    assert abs(lufs - TAKE_LUFS) < 1.5, lufs
    assert abs(seconds - 4) < 0.15, seconds
    assert abs(probe(path)["frames"] - 96) <= 1
    peak = true_peak(path)
    assert peak <= -0.9, peak


def test_concat_without_sound_when_a_clip_has_none(client, settings):
    make_clip(settings.output_dir / "x" / "a.mp4", "red")
    make_clip(settings.output_dir / "x" / "b.mp4", "blue", audio=False)
    job = run(client, "video-concat", {"clips": ["outputs/x/a.mp4", "outputs/x/b.mp4"]})
    assert not probe(settings.output_dir / job["outputs"][0].removeprefix("outputs/"))["audio"]


@pytest.mark.parametrize("params", [
    {"clips": ["outputs/x/a.mp4"]},                        # one clip
    {"clips": ["outputs/x/a.mp4", "outputs/x/a.png"]},     # not a video
    {"clips": ["outputs/x/a.mp4", "outputs/x/a.mp4"], "prompt": "p"},
    {"clips": ["outputs/x/a.mp4", "outputs/x/a.mp4"], "smooth_audio": "yes"},
])
def test_concat_refuses(client, settings, params):
    make_clip(settings.output_dir / "x" / "a.mp4", "red")
    Image.new("RGB", (8, 8)).save(settings.output_dir / "x" / "a.png")
    assert client.post("/api/jobs", json={"pipeline": "video-concat", "params": params}).status_code == 422


def test_grid_lays_out_a_square(client, settings):
    folder = settings.output_dir / "qwen"
    folder.mkdir(parents=True)
    refs = []
    for n, color in enumerate(["red", "green", "blue", "white", "black"]):
        Image.new("RGB", (40, 20), color).save(folder / f"{n}.png")
        refs.append(f"outputs/qwen/{n}.png")
    job = run(client, "image-grid", {"images": refs})
    with Image.open(settings.output_dir / job["outputs"][0].removeprefix("outputs/")) as sheet:
        assert sheet.size == (120, 40)  # 5 images → 3 columns, 2 rows
        assert sheet.getpixel((50, 10)) == (0, 128, 0)
        assert sheet.getpixel((50, 30)) == (0, 0, 0)
        assert sheet.getpixel((100, 30)) == (255, 255, 255)  # empty cell


def test_frames_counted_from_the_end(client, settings):
    path = settings.output_dir / "h3-i2v" / "c.mp4"
    path.parent.mkdir(parents=True)
    # 24 frames: red for 12, then blue.
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=24:d=0.5",
                    "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=24:d=0.5", "-filter_complex",
                    "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(path)], check=True)
    job = run(client, "video-frames", {"video": "outputs/h3-i2v/c.mp4", "offsets": [0, 20, 30]})
    colors = []
    for ref in job["outputs"]:
        with Image.open(settings.output_dir / ref.removeprefix("outputs/")) as img:
            r, g, b = img.convert("RGB").getpixel((32, 32))
            colors.append("red" if r > b else "blue")
            meta = json.loads(img.text["studio"])
            assert meta["role"] == "frame" and meta["origin"] == "storyboard"
    assert colors == ["blue", "red", "red"]  # offset 30 is past the start: the first frame
    assert not list((settings.output_dir / ".frames").glob("*.png"))
    assets = client.get("/api/gallery/assets").json()["items"]
    assert not [a for a in assets if a["pipeline"] == "video-frames"]  # hidden from the app scope


def test_frames_refuse_bad_offsets(client, settings):
    make_clip(settings.output_dir / "x" / "a.mp4", "red")
    for offsets in ([], [-1], [100], [True], "0"):
        res = client.post("/api/jobs", json={"pipeline": "video-frames",
                                             "params": {"video": "outputs/x/a.mp4", "offsets": offsets}})
        assert res.status_code == 422
