"""Latent continuation (h3_continue, h3-r2v continue_from, video-stitch) without a GPU:
the latent arithmetic, the metadata a clip keeps, the parameters of a continuing clip,
the stitched take's sound in step with its image (real ffmpeg, the decoding replaced),
and FastVideo's latent preparation patch on stand-in modules (torch only)."""

import json
import shutil
import subprocess
import sys
from contextlib import contextmanager
from types import ModuleType, SimpleNamespace

import pytest

from studio.pipelines import h3, h3_continue
from studio.pipelines.montage import loudness, probe

from .test_h3 import calls, client, engines  # noqa: F401 (fixtures)
from .test_image_pipelines import rejected, run, upload

ffmpeg_needed = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


# ── Arithmetic ───────────────────────────────────────────────────────────────

def test_tail_is_the_first_group_and_one_chunk():
    assert h3_continue.TAIL_FRAMES == 22  # 1 + 4 + 17 frames, 0.92 s
    assert [h3_continue.frames_of(n) for n in (2, 7, 37, 72)] == [5, 22, 124, 243]
    assert h3_continue.frames_of(72) == h3.frames_for(10)
    with pytest.raises(ValueError, match="grid"):
        h3_continue.frames_of(8)


def test_a_stitched_run_stays_on_the_grid():
    """10 s clips: 72 latents, then 65 more per continuing clip; 243 + 221 frames each."""
    assert h3_continue.stitched_latents([72, 72, 72]) == 202
    assert h3_continue.frames_of(202) == 243 + 2 * (243 - 22)
    assert h3_continue.stitched_latents([72, 37]) == 102  # a 5 s clip after a 10 s one


def test_links_and_runs():
    meta = lambda cont=None: {"width": 1280, "height": 736, "latents": 72, "continues": cont}
    clips = ["outputs/a.mp4", "outputs/b.mp4", "outputs/c.mp4", "outputs/d.mp4"]
    metas = [meta(), meta("outputs/a.mp4"), meta("outputs/x.mp4"), meta("outputs/c.mp4")]
    linked = h3_continue.links(clips, metas)
    assert linked == [True, False, True]
    assert h3_continue.runs(linked) == [[0, 1], [2, 3]]
    assert h3_continue.links(clips[:2], [None, meta("outputs/a.mp4")]) == [False]  # no latents: a cut
    assert h3_continue.runs([False, False]) == [[0], [1], [2]]


def write_latents(video, width=1280, height=736, latents=72, continues=None):
    """A clip's latents file as far as read_meta sees it: the safetensors header."""
    meta = {"width": str(width), "height": str(height), "latents": str(latents)}
    if continues:
        meta["continues"] = continues
    head = json.dumps({"__metadata__": meta}).encode()
    h3_continue.latents_path(video).write_bytes(len(head).to_bytes(8, "little") + head)


def test_read_meta(tmp_path):
    video = tmp_path / "20261120-x.mp4"
    assert h3_continue.read_meta(video) is None
    write_latents(video, continues="outputs/h3-r2v/a.mp4")
    assert h3_continue.latents_path(video).name == "20261120-x.latents.safetensors"
    assert h3_continue.read_meta(video) == {"width": 1280, "height": 736, "latents": 72,
                                             "continues": "outputs/h3-r2v/a.mp4"}


# ── h3-r2v continue_from ─────────────────────────────────────────────────────

def previous_clip(settings, name="prev.mp4", **kw):
    video = settings.output_dir / "h3-r2v" / name
    video.parent.mkdir(parents=True, exist_ok=True)
    video.write_bytes(b"mp4")
    write_latents(video, **kw)
    return f"outputs/h3-r2v/{name}"


def test_a_continuing_clip_takes_the_size_of_the_clip_it_continues(client, engines, settings, monkeypatch):
    tails, installs = [], []
    monkeypatch.setattr(h3_continue, "install", lambda: installs.append(1))
    monkeypatch.setattr(h3_continue, "load_tail", lambda path: ("tail of", path.name))

    @contextmanager
    def tail(video, seed):
        tails.append((video, seed))
        yield
    monkeypatch.setattr(h3_continue, "tail", tail)
    prev = previous_clip(settings, width=736, height=1280)
    sheet = upload(client, 192, 108)
    job = run(client, "h3-r2v", {"prompt": "<Picture 1>", "references": [sheet], "continue_from": prev, "seed": 7})
    first, second = calls(engines)
    assert installs == [1] and tails == [(("tail of", "prev.mp4"), 7)]
    assert (first["width"], first["height"], second["width"], second["height"]) == (608, 1056, 736, 1280)
    assert first["pil_image"] is None and second["pil_image"] is None
    assert engines["refine"][-1] == (736, 1280)  # the upscaler aims at the previous clip's size
    assert first.get("keep") is None and callable(second["keep"])  # the final pass keeps its latents
    assert (job["params"]["width"], job["params"]["height"], job["params"]["aspect"]) == (736, 1280, "23:40")


def test_continue_from_refusals(client, settings):
    sheet = upload(client, 192, 108)
    prev = previous_clip(settings)
    bare = settings.output_dir / "h3-r2v" / "old.mp4"
    bare.write_bytes(b"mp4")
    base = {"prompt": "<Picture 1>", "references": [sheet]}
    assert "kept no latents" in rejected(client, "h3-r2v", {**base, "continue_from": "outputs/h3-r2v/old.mp4"})
    assert "neither a start image" in rejected(client, "h3-r2v", {**base, "continue_from": prev, "image": sheet})
    assert "neither a start image" in rejected(client, "h3-r2v", {**base, "continue_from": prev, "aspect": "16:9"})
    assert "reference of an H3 clip" in rejected(client, "h3-r2v", {**base, "continue_from": sheet})
    assert "<Picture 2>" in rejected(client, "h3-r2v", {**base, "prompt": "<Picture 2>", "continue_from": prev})


def test_every_h3_clip_keeps_its_latents(client, engines):
    run(client, "h3-t2v", {"prompt": "p"})
    assert callable(calls(engines)[-1]["keep"])


def test_upscale_scale_matches_upscale_target():
    width, height, scale = h3.upscale_target(736, 416)
    assert h3.upscale_scale(736, 416, (width, height)) == pytest.approx(scale, abs=0.01)


# ── video-stitch ─────────────────────────────────────────────────────────────

def clip(path, color, frames, freq=440, gain_db=-20):
    path.parent.mkdir(parents=True, exist_ok=True)
    seconds = frames / 24
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=128x96:r=24:d={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}", "-af", f"volume={gain_db}dB",
                    "-c:a", "aac", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-frames:v", str(frames), str(path)],
                   check=True)


@ffmpeg_needed
def test_stitch_decodes_a_run_once_and_keeps_the_sound_in_step(client, engines, settings, monkeypatch):
    """Clips a → b continue each other (one decode), c is a cut. The take has the run's frames
    (124 + 102) then c's (124), and each continuing clip's sound starts 22 frames in."""
    out = settings.output_dir / "h3-r2v"
    for name, color in (("a", "red"), ("b", "green"), ("c", "blue")):
        clip(out / f"{name}.mp4", color, 124)
    write_latents(out / "a.mp4", 128, 96, 37)
    write_latents(out / "b.mp4", 128, 96, 37, "outputs/h3-r2v/a.mp4")
    decoded = []

    def decode_run(self, paths, metas, base, ctx, models):
        decoded.append([p.name for p in paths])
        video = base.with_suffix(".mp4")
        clip(video, "yellow", h3_continue.frames_of(h3_continue.stitched_latents([m["latents"] for m in metas])))
        return video
    monkeypatch.setattr(h3.VideoStitch, "_decode_run", decode_run)
    clips = [f"outputs/h3-r2v/{n}.mp4" for n in "abc"]
    job = run(client, "video-stitch", {"clips": clips})
    assert job["params"]["links"] == [True, False]
    assert decoded == [["a.mp4", "b.mp4"]]
    path = settings.output_dir / job["outputs"][0].removeprefix("outputs/")
    info = probe(path)
    assert info["audio"] and abs(info["frames"] - (124 + 102 + 124)) <= 1, info
    lufs, seconds = loudness(path)
    assert abs(seconds - 350 / 24) < 0.06, seconds
    assert abs(lufs - (-18)) < 1.5, lufs
    assert not list((settings.output_dir / "video-stitch").glob(".*"))  # the work folder is gone


def test_stitch_refusals(client, settings):
    out = settings.output_dir / "h3-r2v"
    out.mkdir(parents=True, exist_ok=True)
    for name in ("a", "b"):
        (out / f"{name}.mp4").write_bytes(b"mp4")
    write_latents(out / "a.mp4", 1280, 736)
    write_latents(out / "b.mp4", 736, 1280, continues="outputs/h3-r2v/a.mp4")
    clips = ["outputs/h3-r2v/a.mp4", "outputs/h3-r2v/b.mp4"]
    assert "differ in size" in rejected(client, "video-stitch", {"clips": clips})
    assert "video references" in rejected(client, "video-stitch", {"clips": clips[:1]})
    assert "Unknown parameter" in rejected(client, "video-stitch", {"clips": clips, "prompt": "x"})


# ── FastVideo's latent preparation, patched (torch only) ─────────────────────

def fake_fastvideo(monkeypatch, torch):
    """Stand-ins for the FastVideo names h3_continue uses. The layout puts each reference in its
    own time slot ([text | refs | target audio | target video]), as Ref2VA does."""
    packing = ModuleType("packing")
    packing.MINIMAX_H3_KEYFRAME_NOISE_AUG = 0.999
    packing.h3_dit_patch_size = lambda args: (1, 2, 2)

    def patchify(latents, patch):
        _, c, t, h, w = latents.shape
        x = latents.reshape(1, c, t, h // 2, 2, w // 2, 2).permute(0, 2, 3, 5, 1, 4, 6)
        return x.reshape(-1, c * 4)
    packing.patchify_video_latents = patchify

    def build(tags, refs, frames, height, width, audio, patch):
        per = (height // 2) * (width // 2)
        rows = [r.num_latent_frames * (r.latent_height // 2) * (r.latent_width // 2) for r in refs]
        n_text, n_ref = len(tags), sum(rows)
        total = n_text + n_ref + audio * 2 + frames * per
        pos = torch.zeros(total, 3)
        pos[:n_text, 0] = torch.arange(n_text, dtype=torch.float32)
        at, time = n_text, float(n_text)
        for r, count in zip(refs, rows):
            frame = count // r.num_latent_frames
            for f in range(r.num_latent_frames):
                pos[at + f * frame: at + (f + 1) * frame, 0] = time + f
            at += count
            time += r.num_latent_frames
        pos[at:at + audio * 2, 0] = time
        for f in range(frames):
            pos[at + audio * 2 + f * per: at + audio * 2 + (f + 1) * per, 0] = time + f
        video = torch.cat((torch.arange(n_text, n_text + n_ref), torch.arange(at + audio * 2, total)))
        return SimpleNamespace(position_ids=pos, token_tags=torch.zeros(total), text_indices=torch.arange(n_text),
                               video_indices=video, audio_indices=torch.arange(at, at + audio * 2),
                               num_condition_video_rows=n_ref, num_condition_audio_rows=0,
                               num_video_latent_frames=frames, latent_height=height, latent_width=width,
                               num_audio_latents=audio)
    packing.build_ref2va_packed_sequence = build
    reference = ModuleType("reference")
    reference.MiniMaxH3PreparedReference = lambda **kw: SimpleNamespace(**kw)
    stages = ModuleType("stages")
    lp = ModuleType("latent_preparation")
    lp.MINIMAX_H3_LAYOUT_KEY = "layout"

    class Stage:
        ref2va = True
        scheduler = SimpleNamespace(scale_noise=lambda rows, sigma, noise: rows + 1000)

        def forward(self, batch, args):
            refs = batch.references
            layout = build(torch.zeros(3), refs, 4, 4, 4, 2, (1, 2, 2))
            batch.latents = torch.cat((torch.full((layout.num_condition_video_rows, 64), -1.0),
                                       torch.zeros(4 * 4, 64)))
            batch.extra = {"layout": layout}
            batch.references = None
            return batch
    lp.MiniMaxH3LatentPreparationStage = Stage
    stages.minimax_h3_latent_preparation = lp
    base = "fastvideo.pipelines.basic.minimax_h3"
    for name in ("fastvideo", "fastvideo.pipelines", "fastvideo.pipelines.basic", base):
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    monkeypatch.setitem(sys.modules, base + ".packing", packing)
    monkeypatch.setitem(sys.modules, base + ".reference", reference)
    monkeypatch.setitem(sys.modules, base + ".stages", stages)
    monkeypatch.setitem(sys.modules, base + ".stages.minimax_h3_latent_preparation", lp)
    monkeypatch.setattr(h3_continue, "_installed", False)
    return Stage


def test_the_tail_takes_the_time_of_the_target_first_frames(monkeypatch):
    """[text | sheet | tail | audio | video]: the tail rows sit after the sheet's, noised like a
    condition, at the time of the target's first k frames; every other row keeps its time."""
    torch = pytest.importorskip("torch")
    Stage = fake_fastvideo(monkeypatch, torch)
    h3_continue.install()
    sheet = SimpleNamespace(media_type="image", num_latent_frames=1, latent_height=4, latent_width=4)
    stage = Stage()
    plain = stage.forward(SimpleNamespace(references=[sheet]), None).extra["layout"]
    tail = torch.zeros(1, 16, 2, 8, 8)  # full size: resized to the 4×4 canvas
    with h3_continue.tail(tail, seed=3):
        batch = stage.forward(SimpleNamespace(references=[sheet]), None)
    layout = batch.extra["layout"]
    assert layout.num_condition_video_rows == 4 + 8
    assert batch.latents.shape == (4 + 8 + 16, 64)
    assert torch.all(batch.latents[:4] == -1) and torch.all(batch.latents[12:] == 0)
    assert torch.allclose(batch.latents[4:12], torch.full((8, 64), 1000.0), atol=10)  # noised tail
    pos = layout.position_ids
    target = layout.video_indices[12:]
    assert torch.equal(pos[target], plain.position_ids[plain.video_indices[4:]])
    assert torch.equal(pos[layout.audio_indices], plain.position_ids[plain.audio_indices])
    assert torch.equal(pos[layout.video_indices[4:12]], pos[target[:8]])  # tail frames 0, 1
    assert torch.equal(pos[layout.video_indices[:4]], plain.position_ids[plain.video_indices[:4]])
    plain_again = stage.forward(SimpleNamespace(references=[sheet]), None).extra["layout"]
    assert plain_again.num_condition_video_rows == 4  # no tail outside the block


def test_kept_latents_round_trip(tmp_path):
    torch = pytest.importorskip("torch")
    pytest.importorskip("safetensors")
    video = tmp_path / "clip.mp4"
    latents = torch.randn(1, 16, 72, 4, 6)
    h3_continue.save(video, latents, 96, 64, "outputs/h3-r2v/a.mp4")
    assert h3_continue.read_meta(video) == {"width": 96, "height": 64, "latents": 72, "continues": "outputs/h3-r2v/a.mp4"}
    tail = h3_continue.load_tail(video)
    assert tail.dtype == torch.float32 and tail.shape == (1, 16, 7, 4, 6)
    assert torch.allclose(tail, latents[:, :, -7:], atol=1e-2)
