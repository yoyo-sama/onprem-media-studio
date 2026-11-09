"""MiniMax H3 video engines without a GPU: FastVideo is replaced by a fake engine
that records each request. What is checked is what the validated workflow and
1.4 fix: the 17n+5 grid, the two-pass geometry and refine schedule, the verbatim
prompt, <Picture N> numbering, the 5–15 s limit of FastVideo, the LoRA stack
maths, and the upscaler's checkpoint layout."""

import json
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from studio import loras
from studio.main import create_app
from studio.models import MARKER
from studio.pipelines import REGISTRY, common, h3, h3_lora, h3_runtime

from .test_api import FakeLlm, wait_for
from .test_image_pipelines import rejected, run, upload

CONTRACTS = {
    "fasth3-v2": {"num_inference_steps": 9, "video_scheduler_shift": 10.0, "audio_scheduler_shift": 3.0},
    "fasth3-omniref": {"num_inference_steps": 8, "video_scheduler_shift": 12.0, "audio_scheduler_shift": 3.0,
                       "pdd_steps": 32, "grid_max_t": 0.999},
}


# ── Pure functions ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("seconds,frames", [(5, 124), (6, 158), (10, 243), (15, 362), (1, 39)])
def test_frames_follow_the_17n_plus_5_grid(seconds, frames):
    assert h3.frames_for(seconds) == frames
    assert frames % 17 == 5


def test_latent_frames():
    assert h3.latent_frames(124) == 37  # > 32: the upscaler chunks a 5 s clip


def test_two_pass_geometry_of_the_validated_workflow():
    assert h3.size_for((16, 9), h3.PASS1_MEGAPIXELS) == (736, 416)
    width, height, scale = h3.upscale_target(736, 416)
    assert (width, height) == (1280, 736)
    assert scale == pytest.approx(1.7557, abs=1e-3)
    assert h3.size_for((16, 9), h3.FINAL_MEGAPIXELS) == (1280, 736)  # t2v/i2v render at the same size


def test_refine_schedule_maps_to_pdd_nodes():
    # beta / 3 steps / denoise 0.4 at shift 12 lands on fine-grid nodes 19, 25, 30, 32
    assert h3.pdd_indices(h3.REFINE_SIGMAS, 12.0) == (19, 25, 30, 32)
    assert h3.node_sigma(0, 12.0) == pytest.approx(0.999)
    assert h3.node_sigma(32, 12.0) == 0
    assert h3.node_sigma(19, 12.0) == pytest.approx(h3.REFINE_SIGMAS[0], abs=2e-3)
    # The trained 8-step plan of the first pass is every fourth node.
    assert h3.node_sigma(4, 12.0) > h3.node_sigma(8, 12.0) > h3.node_sigma(28, 12.0)


@pytest.mark.parametrize("value", ["16-9", "0:9", "16:3:1", 169, "9:40"])
def test_bad_aspect(value):
    with pytest.raises(ValueError):
        h3.parse_aspect(value)


# ── Fake FastVideo ───────────────────────────────────────────────────────────

class FakeEngine:
    def __init__(self, spec, log):
        self.spec, self.log, self.calls, self.state = spec, log, [], {}
        self.closed = False

    def close(self):
        self.closed = True

    def overrides(self, latent_output=False, pdd_step_indices=None):
        engine = self

        class Scope:
            def __enter__(self):
                engine.state = {"latent": latent_output, "pdd": pdd_step_indices}

            def __exit__(self, *exc):
                engine.state = {}
        return Scope()

    def generate(self, ctx, **kw):
        self.calls.append({**kw, **self.state})
        if self.log.get("fail"):
            raise RuntimeError("CUDA error: no kernel image is available for execution on the device")
        # What report_stages makes FastVideo say: each step, then the decoding.
        seen = self.log.setdefault("progress", [])
        for step in range(1, kw["steps"] + 1):
            kw["progress"]("denoise", step, kw["steps"])
            seen.append((round(ctx.job.progress, 3), ctx.job.message))
        if not self.state.get("latent"):
            kw["progress"]("decode", 0, 1)
            seen.append((round(ctx.job.progress, 3), ctx.job.message))
        if kw.get("save", True):
            kw["output"].write_bytes(b"mp4")
        frame = np.zeros((kw["height"], kw["width"], 3), dtype=np.uint8)
        return SimpleNamespace(video_path=str(kw["output"]) if kw.get("save", True) else None,
                               frames=None if self.state.get("latent") else [frame, frame],
                               samples="video-latents", audio="audio-latents")


@pytest.fixture
def engines(monkeypatch, settings):
    log = {"engines": []}

    def load(key, build, size=0, alone=False):
        assert alone
        assert key[0] == "h3"
        engine = FakeEngine(key[1], log)
        log["engines"].append(engine)
        return engine

    monkeypatch.setattr(common, "load", load)
    monkeypatch.setattr(h3, "_reference", lambda path: ("ref", path.name))
    monkeypatch.setattr(h3, "refine_inputs", lambda *a: (log.setdefault("refine", a), ("latents", "audio"))[1])
    return log


@pytest.fixture
def client(settings, store, engines):
    for model_id in store.catalog:
        store.path(model_id).mkdir(parents=True)
        (store.path(model_id) / MARKER).write_text("{}")
        for prefix, terms in CONTRACTS.items():
            if model_id.startswith(prefix):
                (store.path(model_id) / "fastvideo_inference.json").write_text(json.dumps(terms))
    (settings.loras_dir / "h3").mkdir(parents=True)
    (settings.loras_dir / "h3" / "style.safetensors").write_bytes(b"x")
    app = create_app(settings, models=store, pipelines=REGISTRY, llm=FakeLlm())
    with TestClient(app) as c:
        yield c


def calls(engines):
    return [call for engine in engines["engines"] for call in engine.calls]


# ── Engines through the API ──────────────────────────────────────────────────

def test_engines_are_registered(client):
    ids = {p["id"] for p in client.get("/api/pipelines").json()}
    assert {"h3-t2v", "h3-i2v", "h3-r2v"} <= ids


def test_t2v_renders_verbatim_at_the_final_size(client, engines):
    prompt = "  A potter at the wheel, \"quoted\" "
    job = run(client, "h3-t2v", {"prompt": prompt})
    (call,) = calls(engines)
    assert call["prompt"] == prompt
    assert (call["width"], call["height"], call["frames"], call["steps"]) == (1280, 736, 124, 9)
    assert call["seed"] == job["params"]["seed"]
    assert not engines["engines"][0].spec.ref2va
    assert engines["engines"][0].spec.model_dir.name == "fasth3-v2-nvfp4"
    video, last = job["outputs"]
    assert video.startswith("outputs/h3-t2v/") and video.endswith(".mp4")
    assert last.endswith(".png") and client.get("/" + last).status_code == 200


def test_i2v_follows_the_first_image_and_fl2va_passes_the_last(client, engines):
    first, last = upload(client, 1920, 1080), upload(client, 1920, 1080, "black")
    run(client, "h3-i2v", {"prompt": "p", "image": first})
    run(client, "h3-i2v", {"prompt": "<Picture 1> then <Picture 2>", "image": first, "last_image": last,
                           "duration": 10})
    i2v, fl2va = calls(engines)
    assert (i2v["width"], i2v["height"]) == (1280, 736)
    assert i2v["pil_image"].size == (1920, 1080) and i2v["last_image"] is None
    assert fl2va["last_image"] is not None and fl2va["frames"] == 243


def test_i2v_refuses_picture_2_without_a_last_image(client):
    first = upload(client, 64, 64)
    assert "<Picture 2>" in rejected(client, "h3-i2v", {"prompt": "to <Picture 2>", "image": first})
    assert "image is required" in rejected(client, "h3-i2v", {"prompt": "p"})


def test_i2v_images_must_be_readable_images(client, settings):
    """A file that is not an image is a 422 with its reason, never a 500."""
    first = upload(client, 64, 64)
    broken = settings.output_dir / "broken.png"
    broken.write_bytes(b"not a png")
    (settings.output_dir / "clip.mp4").write_bytes(b"x")
    assert "not a readable image" in rejected(client, "h3-i2v", {"prompt": "p", "image": "outputs/broken.png"})
    assert "is not an image" in rejected(client, "h3-i2v", {"prompt": "p", "image": "outputs/clip.mp4"})
    assert "last_image" in rejected(client, "h3-i2v", {"prompt": "p", "image": first, "last_image": "outputs/clip.mp4"})
    assert "not a readable image" in rejected(client, "h3-i2v", {"prompt": "p", "image": first,
                                                                 "last_image": "outputs/broken.png"})


def test_r2v_preview_is_the_first_pass_only(client, engines):
    sheet = upload(client, 192, 108)
    job = run(client, "h3-r2v", {"prompt": "<Picture 1>", "references": [sheet], "preview": True})
    (call,) = calls(engines)
    assert (call["width"], call["height"], call["steps"]) == (736, 416, 8)
    assert call["latent"] is False and call.get("save", True)
    assert engines["engines"][0].spec.ref2va
    assert (job["params"]["width"], job["params"]["height"]) == (736, 416)


def test_r2v_two_passes(client, engines, capsys):
    sheets = [upload(client, 192, 108, c) for c in ("red", "green")]
    job = run(client, "h3-r2v", {"prompt": "<Subject 1> in <Picture 1> and <Picture 2>", "references": sheets})
    first, second = calls(engines)
    assert (first["width"], first["height"], first["steps"]) == (736, 416, 8)
    assert first["latent"] is True and first["save"] is False
    assert [r[0] for r in first["references"]] == ["ref", "ref"]
    assert (second["width"], second["height"]) == (1280, 736)
    assert second["pdd"] == (19, 25, 30, 32) and second["steps"] == 3
    assert (second["latents"], second["audio_latents"]) == ("latents", "audio")
    assert second["references"] == first["references"] and second["seed"] == first["seed"]
    video, pass1 = engines["refine"][0], engines["refine"][5]
    assert video == "video-latents" and pass1 == (736, 416)
    assert len(job["outputs"]) == 2 and len(engines["engines"]) == 1  # one generator for both passes
    log = capsys.readouterr().out
    assert "render: h3-r2v 1280×736, 124 frames, 2 reference(s) in " in log
    assert all(part in log for part in ("references ", "pass 1 ", "upscale ", "pass 2 and decoding "))


def test_t2v_progress_follows_the_denoising_steps_then_the_decoding(client, engines):
    run(client, "h3-t2v", {"prompt": "p"})
    seen = engines["progress"]
    assert len(seen) == 9 + 1
    assert seen[0] == (0.189, "Rendering 1280×736, 124 frames: step 1/9")
    assert seen[8] == (0.9, "Rendering 1280×736, 124 frames: step 9/9")
    assert seen[9] == (0.9, "Rendering 1280×736, 124 frames: decoding the video")
    assert [p for p, _ in seen] == sorted(p for p, _ in seen)


def test_r2v_progress_covers_both_passes(client, engines):
    sheet = upload(client, 192, 108)
    run(client, "h3-r2v", {"prompt": "<Picture 1>", "references": [sheet]})
    seen = engines["progress"]
    # Pass 1: 8 steps from 0.1 to 0.5, no decoding (it ends on latents); pass 2: 3 steps
    # from 0.6 to 0.9, then the decoding.
    assert [p for p, _ in seen] == [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.7, 0.8, 0.9, 0.9]
    assert seen[7][1] == "Pass 1: 736×416, 124 frames: step 8/8"
    assert seen[-1][1] == "Pass 2 at 1280×736: decoding the video"
    engines["progress"].clear()
    run(client, "h3-r2v", {"prompt": "<Picture 1>", "references": [sheet], "preview": True})
    assert [p for p, _ in engines["progress"]][-2:] == [0.9, 0.9]


def test_r2v_stops_the_llm_first_and_t2v_keeps_it(client, engines, monkeypatch, capsys):
    """Gemma next to a two-pass r2v pushed the GB10 into swap: an r2v stops it before
    rendering, a t2v (19 GiB left with Gemma loaded) keeps it."""
    stops = []
    monkeypatch.setattr(common.POOL, "low_memory", [lambda: stops.append(len(engines["engines"])) or True])
    run(client, "h3-t2v", {"prompt": "a kite"})
    assert stops == []
    sheets = [upload(client, 192, 108, "red")]
    run(client, "h3-r2v", {"prompt": "<Picture 1> walks", "references": sheets})
    assert stops == [1]  # before the r2v engine was loaded
    assert "engine: LLM stopped to leave its memory to h3-r2v" in capsys.readouterr().out


@pytest.mark.parametrize("pipeline,params,message", [
    ("h3-t2v", {"prompt": "p", "duration": 3}, "5 to 15 s"),
    ("h3-t2v", {"prompt": "p", "duration": 16}, "between 5 and 15"),
    ("h3-t2v", {"prompt": "x" * 7001}, "7000-character"),
    ("h3-t2v", {"prompt": "p", "negative_prompt": "blur"}, "cfg 1"),
    ("h3-t2v", {"prompt": "p", "width": 1344, "height": 800}, "canvas"),
    ("h3-t2v", {"prompt": "p", "width": 1280}, "together"),
    ("h3-t2v", {"prompt": "p", "aspect": "8:1"}, "1:4 to 4:1"),
    ("h3-t2v", {"prompt": "p", "steps": 4}, "Unknown parameter"),
    ("h3-t2v", {"prompt": "p", "loras": [{"name": "../style.safetensors"}]}, "file name"),
    ("h3-t2v", {"prompt": "p", "loras": [{"name": "missing.safetensors"}]}, "No such LoRA"),
    ("h3-t2v", {"prompt": "p", "loras": [{"name": "style.safetensors", "strength": 5}]}, "between -2 and 2"),
    ("h3-r2v", {"prompt": "p", "references": []}, "non-empty list"),
])
def test_parameter_errors(client, pipeline, params, message):
    assert message in rejected(client, pipeline, params)
    assert client.get("/api/jobs").json() == []


def test_r2v_cited_pictures_must_exist(client):
    sheets = [upload(client, 64, 64, c) for c in ("red", "green")]
    detail = rejected(client, "h3-r2v", {"prompt": "<Picture 1>, <Picture 3>", "references": sheets})
    assert "<Picture 3>" in detail
    assert "at most 9 image" in rejected(client, "h3-r2v", {"prompt": "p", "references": sheets * 5})


def media(client, tmp_path, kind, seconds=1):
    """Upload a small clip (silent picture) or sound made by ffmpeg; its reference."""
    path = tmp_path / ("clip.mp4" if kind == "video" else "sound.wav")
    source = (["-f", "lavfi", "-i", f"color=c=blue:s=64x64:r=24:d={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p"]
              if kind == "video" else ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"])
    subprocess.run(["ffmpeg", "-v", "error", "-y", *source, str(path)], check=True)
    resp = client.post("/api/inputs", content=path.read_bytes())
    assert resp.status_code == 201, resp.text
    assert resp.json()["kind"] == kind
    return resp.json()["ref"]


needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@needs_ffmpeg
def test_uploads_take_clips_and_sounds(client, tmp_path):
    clip, sound = media(client, tmp_path, "video"), media(client, tmp_path, "audio")
    assert clip.endswith(".mp4") and sound.endswith(".wav")
    resp = client.post("/api/inputs", content=b"not a media file")
    assert resp.status_code == 422 and "image, video or sound" in resp.json()["detail"]


@needs_ffmpeg
def test_r2v_sends_images_clips_and_sounds_in_order(client, engines, tmp_path):
    sheet = upload(client, 192, 108)
    clip, sound = media(client, tmp_path, "video"), media(client, tmp_path, "audio")
    run(client, "h3-r2v", {"prompt": "<Subject 1> in <Picture 1>, moving as in <Video 1>, voice <Audio 1>",
                           "references": [sheet, clip, sound], "preview": True})
    (call,) = calls(engines)
    assert [name for _, name in call["references"]] == [Path(r).name for r in (sheet, clip, sound)]


@needs_ffmpeg
def test_r2v_reference_limits_per_kind(client, tmp_path):
    sheet = upload(client, 64, 64)
    clip, sound = media(client, tmp_path, "video"), media(client, tmp_path, "audio")
    assert "at most 3 video" in rejected(client, "h3-r2v", {"prompt": "p", "references": [clip] * 4})
    assert "at most 3 audio" in rejected(client, "h3-r2v", {"prompt": "p", "references": [sheet] + [sound] * 4})
    assert "at most 12" in rejected(client, "h3-r2v", {"prompt": "p", "references": [sheet] * 9 + [clip] * 3 + [sound]})
    assert "image or video" in rejected(client, "h3-r2v", {"prompt": "p", "references": [sound]})
    assert "<Video 2>" in rejected(client, "h3-r2v", {"prompt": "<Video 2>", "references": [sheet, clip]})
    assert "<Audio 1>" in rejected(client, "h3-r2v", {"prompt": "<Audio 1>", "references": [sheet, clip]})


def test_a_reference_clip_goes_silent_as_frames(monkeypatch, tmp_path):
    """FastVideo would adopt a clip's soundtrack as an <Audio N> the prompt does not define."""
    made = []
    package = ModuleType("fastvideo.pipelines.basic.minimax_h3")
    package.MiniMaxH3Reference = lambda **kw: made.append(kw) or kw
    reference = ModuleType("fastvideo.pipelines.basic.minimax_h3.reference")
    reference.decode_reference_video = lambda p: ("frames", 25.0, ("waveform", 48000))
    for name, module in {"fastvideo": ModuleType("fastvideo"), "fastvideo.pipelines": ModuleType("x"),
                         "fastvideo.pipelines.basic": ModuleType("x"), package.__name__: package,
                         reference.__name__: reference}.items():
        monkeypatch.setitem(sys.modules, name, module)
    h3._reference(tmp_path / "clip.mp4")
    h3._reference(tmp_path / "voice.wav")
    assert made == [{"source": "frames", "media_type": "video", "fps": 25.0},
                    {"source": str(tmp_path / "voice.wav"), "media_type": "audio"}]


def test_nothing_renders_without_a_submission(client, engines):
    upload(client, 64, 64)
    time.sleep(0.2)
    assert client.get("/api/jobs").json() == [] and engines["engines"] == []


def test_an_engine_failure_is_reported(client, engines):
    engines["fail"] = True
    resp = client.post("/api/jobs", json={"pipeline": "h3-t2v", "params": {"prompt": "p"}})
    job = wait_for(client, resp.json()["id"])
    assert job["status"] == "error" and "no kernel image" in job["error"]
    assert len(engines["engines"]) == 1  # no retry on another checkpoint


# ── FastVideo adapter ────────────────────────────────────────────────────────

def test_environment_profiles(tmp_path, monkeypatch):
    env = h3_runtime.environment(h3_runtime.EngineSpec(tmp_path, ref2va=True))
    assert env["FASTVIDEO_H3_VSA_FP4"] == "1" and env["FASTVIDEO_LORA_SIDE_BRANCH"] == "1"
    assert env["FASTVIDEO_H3_VAE_NVFP4_DECODER"].endswith("vae_decoder_nvfp4/decoder-nvfp4.safetensors")
    assert "FASTVIDEO_H3_ADALN_TABLE" not in env  # would bypass the LoRA and the refine timesteps
    v2_env = h3_runtime.environment(h3_runtime.EngineSpec(tmp_path, ref2va=False))
    assert v2_env["FASTVIDEO_H3_VSA_FP4"] == "1" and "FASTVIDEO_H3_VAE_NVFP4_DECODER" not in v2_env
    # A V2 build must not inherit the OmniRef settings of the previous one.
    monkeypatch.setattr(h3_runtime.os, "environ", {})
    h3_runtime._apply_env(env)
    h3_runtime._apply_env(v2_env)
    assert "FASTVIDEO_H3_VAE_NVFP4_DECODER" not in h3_runtime.os.environ
    assert "FASTVIDEO_H3_REF2VA_MEMO_ENTRIES" not in h3_runtime.os.environ
    v2 = h3_runtime.experimental(h3_runtime.EngineSpec(tmp_path, ref2va=False))
    assert v2["VSA_tile_size"] == 64 and v2["h3_vsa_fp4"]["enabled"]


@pytest.fixture
def fake_fastvideo(monkeypatch):
    api = ModuleType("fastvideo.api")
    for name in ("GenerationRequest", "InputConfig", "OutputConfig", "SamplingConfig"):
        setattr(api, name, lambda **kw: SimpleNamespace(**kw))
    monkeypatch.setitem(sys.modules, "fastvideo", ModuleType("fastvideo"))
    monkeypatch.setitem(sys.modules, "fastvideo.api", api)


class FakeGenerator:
    def __init__(self, delay=0.0):
        self.fastvideo_args = SimpleNamespace(output_type="pil",
                                              pipeline_config=SimpleNamespace(pdd_step_indices=(0, 4, 32)))
        self.interrupted = threading.Event()
        self.delay = delay
        self.executor = SimpleNamespace(interrupt=self.interrupted.set)
        self.seen = None

    def generate(self, request):
        self.seen = (request, self.fastvideo_args.output_type, self.fastvideo_args.pipeline_config.pdd_step_indices)
        if self.delay and self.interrupted.wait(self.delay):
            raise RuntimeError("generation cancelled by interrupt()")
        return "result"


class FakeCtx:
    def __init__(self):
        self.cancel = False

    def cancelled(self):
        return self.cancel

    def check(self):
        if self.cancel:
            raise KeyboardInterrupt  # stands for jobs.Cancelled


def make_engine(generator):
    engine = object.__new__(h3_runtime.Engine)
    engine.generator = generator
    return engine


def test_overrides_apply_to_one_request_then_restore(fake_fastvideo, tmp_path):
    gen = FakeGenerator()
    engine = make_engine(gen)
    with engine.overrides(latent_output=True, pdd_step_indices=(19, 25, 30, 32)):
        engine.generate(FakeCtx(), prompt="p", width=736, height=416, frames=124, steps=3, seed=1,
                        output=tmp_path / "x.mp4", save=False, latents="L")
    request, output_type, indices = gen.seen
    assert (output_type, indices) == ("latent", (19, 25, 30, 32))
    assert request.negative_prompt == "" and request.sampling.guidance_scale == 1.0
    assert request.inputs.latents == "L" and request.output.return_frames is True
    assert gen.fastvideo_args.output_type == "pil"
    assert gen.fastvideo_args.pipeline_config.pdd_step_indices == (0, 4, 32)


def test_reference_size_follows_comfyui_max(monkeypatch):
    """Image references only ever shrink to a 2048 px short edge, as in the validated
    ComfyUI workflow; FastVideo's own rule upscales a 1344×768 image to 3584×2048."""
    assert h3_runtime.reference_size(1344, 768) == (768, 1344)
    assert h3_runtime.reference_size(4096, 3072) == (2048, 2720)
    assert h3_runtime.reference_size(1000, 1000) == (992, 992)
    with pytest.raises(ValueError, match="1:4"):
        h3_runtime.reference_size(5000, 1000)
    reference = SimpleNamespace(MINIMAX_H3_CANVAS_MULTIPLE=32,
                                resolve_reference_image_size=lambda w, h: (2048, 3584))
    for name in ("fastvideo", "fastvideo.pipelines", "fastvideo.pipelines.basic"):
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    package = ModuleType("fastvideo.pipelines.basic.minimax_h3")
    package.reference = reference
    monkeypatch.setitem(sys.modules, "fastvideo.pipelines.basic.minimax_h3", package)
    h3_runtime._size_references_like_comfyui()
    assert reference.resolve_reference_image_size(1344, 768) == (768, 1344)


def test_cancel_interrupts_fastvideo(fake_fastvideo, tmp_path):
    gen = FakeGenerator(delay=5)
    ctx = FakeCtx()
    threading.Timer(0.2, lambda: setattr(ctx, "cancel", True)).start()
    with pytest.raises(KeyboardInterrupt):
        make_engine(gen).generate(ctx, prompt="p", width=32, height=32, frames=124, steps=8, seed=1,
                                  output=tmp_path / "x.mp4")
    assert gen.interrupted.is_set()


def fake_h3_stages(monkeypatch, steps):
    """FastVideo's two H3 stages as far as report_stages sees them: a denoising loop
    that steps its scheduler once per entry of the schedule, and a video decoder."""
    class Scheduler:
        timesteps = list(range(steps))

        def __init__(self):
            self.stepped = 0

        def step(self, velocity, timestep, latents, return_dict=False):
            self.stepped += 1
            return (latents + velocity,)

    class Denoising:
        def __init__(self):
            self.scheduler = Scheduler()

        def forward(self, batch, fastvideo_args):
            for t in self.scheduler.timesteps:
                batch = self.scheduler.step(1, t, batch)[0]
            return batch

    class Decoding:
        def forward(self, batch, fastvideo_args):
            return f"decoded {batch}"

    denoising = SimpleNamespace(MiniMaxH3DenoisingStage=Denoising)
    decoding = SimpleNamespace(MiniMaxH3VideoDecodingStage=Decoding)
    stages = SimpleNamespace(minimax_h3_denoising=denoising, minimax_h3_decoding=decoding)
    for name in ("fastvideo.pipelines", "fastvideo.pipelines.basic", "fastvideo.pipelines.basic.minimax_h3"):
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    monkeypatch.setitem(sys.modules, "fastvideo.pipelines.basic.minimax_h3.stages", stages)
    return Denoising, Decoding


def test_fastvideo_stages_report_steps_and_decoding(fake_fastvideo, monkeypatch, tmp_path):
    """FastVideo has no step callback: the wrapped stages report each scheduler step out of
    the schedule's length, then the decoding, to the request that runs, and to no other."""
    Denoising, Decoding = fake_h3_stages(monkeypatch, 8)
    h3_runtime.report_stages()
    h3_runtime.report_stages()  # a second engine does not wrap them twice
    heard = []

    class Generator(FakeGenerator):
        def generate(self, request):
            stage = Denoising()
            latents = stage.forward(0, self.fastvideo_args)
            assert "step" not in vars(stage.scheduler) and stage.scheduler.stepped == 8
            return Decoding().forward(latents, self.fastvideo_args)

    engine = make_engine(Generator())
    out = engine.generate(FakeCtx(), prompt="p", width=32, height=32, frames=124, steps=9, seed=1,
                          output=tmp_path / "x.mp4", progress=lambda *a: heard.append(a))
    assert out == "decoded 8"  # same calls, same results
    assert heard == [("denoise", n, 8) for n in range(1, 9)] + [("decode", 0, 1)]
    heard.clear()
    with engine.overrides(latent_output=True):
        engine.generate(FakeCtx(), prompt="p", width=32, height=32, frames=124, steps=9, seed=1,
                        output=tmp_path / "x.mp4", progress=lambda *a: heard.append(a))
    assert heard[-1] == ("denoise", 8, 8)  # latent output: nothing is decoded
    Denoising().forward(0, None)  # outside a request nobody listens
    assert h3_runtime._progress is None


# ── LoRA stack ───────────────────────────────────────────────────────────────

def test_lora_stack_is_the_exact_sum():
    torch = pytest.importorskip("torch")
    g = torch.Generator().manual_seed(0)
    a1, b1 = torch.randn(4, 16, generator=g), torch.randn(8, 4, generator=g)
    a2, b2 = torch.randn(2, 16, generator=g), torch.randn(8, 2, generator=g)
    first = {"blocks.0.attn.to_q.lora_A.weight": a1, "blocks.0.attn.to_q.lora_B.weight": b1,
             "blocks.0.attn.to_q.alpha": torch.tensor(2.0)}
    second = {"blocks.0.attn.to_q.lora_A.weight": a2, "blocks.0.attn.to_q.lora_B.weight": b2,
              "blocks.1.ff.fc_in.lora_A.weight": a2, "blocks.1.ff.fc_in.lora_B.weight": b2}
    merged = h3_lora.fold([(first, 0.6), (second, -1.0)])
    delta = merged["blocks.0.attn.to_q.lora_B.weight"] @ merged["blocks.0.attn.to_q.lora_A.weight"]
    expected = 0.6 * (2.0 / 4) * (b1 @ a1) - 1.0 * (b2 @ a2)
    assert torch.allclose(delta, expected, atol=1e-5)
    assert merged["blocks.0.attn.to_q.lora_A.weight"].shape == (6, 16)
    assert "blocks.0.attn.to_q.alpha" not in merged  # strength 1, alpha folded in
    assert torch.allclose(merged["blocks.1.ff.fc_in.lora_B.weight"] @ merged["blocks.1.ff.fc_in.lora_A.weight"],
                          -(b2 @ a2), atol=1e-5)


def test_lora_stack_check(tmp_path):
    (tmp_path / "h3").mkdir()
    for name in "abcde":
        (tmp_path / "h3" / f"{name}.safetensors").write_bytes(b"x")
    assert loras.check_stack([], tmp_path, "h3") == []
    stack = loras.check_stack([{"name": "a.safetensors", "strength": 0.8}, {"name": "b.safetensors"}], tmp_path, "h3")
    assert stack == [{"name": "a.safetensors", "strength": 0.8}, {"name": "b.safetensors", "strength": 1.0}]
    assert loras.describe(stack) == "a.safetensors ×0.8, b.safetensors ×1"
    with pytest.raises(ValueError, match="at most 4"):
        loras.check_stack([{"name": f"{n}.safetensors"} for n in "abcde"], tmp_path, "h3")
    with pytest.raises(ValueError, match="twice"):
        loras.check_stack([{"name": "a.safetensors"}, {"name": "a.safetensors", "strength": 0.5}], tmp_path, "h3")
    with pytest.raises(ValueError, match="No such LoRA: loras/qwen21/a.safetensors"):
        loras.check_stack([{"name": "a.safetensors"}], tmp_path, "qwen21")
    for bad in ({"name": ".a.safetensors"}, {"name": "a.bin"}, {"name": "a.safetensors", "weight": 1},
                {"name": "a.safetensors", "strength": True}, {"name": "a.safetensors", "strength": -2.5}):
        with pytest.raises(ValueError):
            loras.check_stack([bad], tmp_path, "h3")


def test_engine_log_line_names_the_stack():
    spec = h3_runtime.EngineSpec(model_dir=Path("/m/fasth3"), ref2va=False, lora=Path("/c/0123.safetensors"),
                                 lora_names="a.safetensors ×0.8, b.safetensors ×1")
    assert str(spec) == "fasth3 + LoRA a.safetensors ×0.8, b.safetensors ×1"
    # The description is not part of the generator's identity: the merged file is.
    assert spec == h3_runtime.EngineSpec(model_dir=Path("/m/fasth3"), ref2va=False, lora=Path("/c/0123.safetensors"))


# ── Latent upscaler ──────────────────────────────────────────────────────────

def test_upscaler_layout_matches_the_checkpoint():
    torch = pytest.importorskip("torch")
    from studio.pipelines import h3_upscaler
    with torch.device("meta"):
        model = h3_upscaler.LatentUpscaler3D()
    state = model.state_dict()
    assert len(model.in_blocks) == len(model.out_blocks) == 18
    assert state["conv_in.weight"].shape == (512, 24, 3, 3, 3)
    assert state["embed.0.weight"].shape == (64, 1)
    assert state["in_blocks.0.emb_layers.1.weight"].shape == (1024, 64)
    assert state["in_blocks.1.dwconv.weight"].shape == (512, 1, 5, 1, 1)
    assert "in_blocks.0.out_norm.weight" in state and "out_blocks.17.out_layers.2.weight" in state
    assert state["conv_out.weight"].shape == (24, 512, 3, 3, 3)


def test_upscaler_chunks_blend_back_to_the_whole_clip(monkeypatch):
    torch = pytest.importorskip("torch")
    import torch.nn.functional as F
    from studio.pipelines import h3_upscaler
    model = object.__new__(h3_upscaler.LatentUpscaler3D)
    # A per-frame operation: the chunked result must equal the one-pass result.
    monkeypatch.setattr(h3_upscaler.LatentUpscaler3D, "segment",
                        lambda self, x, scale, size: F.interpolate(x, size=size, mode="nearest") * scale)
    x = torch.randn(1, 24, 37, 2, 3)
    out = h3_upscaler.LatentUpscaler3D.forward(model, x, 2.0, 4, 6)
    assert out.shape == (1, 24, 37, 4, 6)
    assert torch.allclose(out, F.interpolate(x, size=(37, 4, 6), mode="nearest") * 2.0, atol=1e-5)


def test_refine_inputs_noise_to_the_first_refine_node(monkeypatch, tmp_path):
    torch = pytest.importorskip("torch")
    from studio.pipelines import h3_upscaler
    for component, channels in (("vae", 24), ("audio_vae", 32)):
        (tmp_path / component).mkdir()
        (tmp_path / component / "config.json").write_text(json.dumps(
            {"latents_mean": [0.5] * channels, "latents_std": [2.0] * channels}))

    class Up(torch.nn.Module):
        def forward(self, x, scale, height, width):
            self.args, self.x = (scale, height, width), x
            return torch.nn.functional.interpolate(x, size=(x.shape[2], height, width))

    up = Up()
    monkeypatch.setattr(h3_upscaler, "load", lambda path, device: up)
    monkeypatch.setattr(common, "device", lambda: "cpu")
    monkeypatch.setattr(torch.cuda, "empty_cache", lambda: None)
    video, audio = torch.full((1, 24, 37, 26, 46), 2.5), torch.full((2, 32, 200), 4.5)
    latents, audio_latents = h3.refine_inputs(video, audio, tmp_path, tmp_path / "up.safetensors",
                                              CONTRACTS["fasth3-omniref"], (736, 416), 7)
    assert latents.shape == (1, 24, 37, 46, 80) and audio_latents.shape == (2, 32, 200)
    assert up.args[1:] == (46, 80) and up.args[0] == pytest.approx(1.7557, abs=1e-3)
    # The upscaler gets the DiT latents normalised a second time, as its ComfyUI node
    # does ((2.5 - 0.5) / 2 = 1.0, then (1.0 - 0.5) / 2 = 0.25), and its output is
    # denormalised once: fed DiT-space latents, it renders pink mush on the GB10.
    assert torch.allclose(up.x.float(), torch.full_like(up.x.float(), 0.25))
    sv, sa = h3.node_sigma(19, 12.0), h3.node_sigma(19, 3.0)
    gen = torch.Generator("cpu").manual_seed(7)
    noise_v, noise_a = torch.randn(latents.shape, generator=gen), torch.randn(audio_latents.shape, generator=gen)
    # Normalised latents are 1.0 (video) and 2.0 (audio); FastVideo multiplies the rows by sigma.
    assert torch.allclose(latents * sv, (1 - sv) * 1.0 + sv * noise_v, atol=1e-2)
    assert torch.allclose(audio_latents * sa, (1 - sa) * 2.0 + sa * noise_a, atol=1e-5)


def test_qualification_cases_are_valid_jobs(settings):
    """tools/qualify/video_cases.json must submit cleanly, or the GB10 run stops halfway."""
    from studio.files import FileStore
    from .test_image_pipelines import png
    cases = json.loads((Path(__file__).parent.parent / "tools/qualify/video_cases.json").read_text())["cases"]
    files = FileStore(settings.input_dir, settings.output_dir)
    ref = files.save_input(png(192, 108))["ref"]
    for case in cases:
        params = {k: ([ref for _ in v] if isinstance(v, list) else ref if str(v).startswith("@") else v)
                  for k, v in case["params"].items()}
        REGISTRY[case["pipeline"]].validate(params, files)


def test_status_page_names_minimax_h3(client):
    # The MiniMax H3 licence asks products built on it to show its name.
    assert "MiniMax H3" in client.get("/").text


def test_fastvideo_weights_are_read_whole(tmp_path):
    torch = pytest.importorskip("torch")
    from safetensors.torch import save_file
    from studio.pipelines.h3_runtime import WholeFile
    save_file({"a": torch.ones(2, 3), "b": torch.zeros(4)}, str(tmp_path / "w.safetensors"))
    with WholeFile(str(tmp_path / "w.safetensors"), framework="pt", device="cpu") as f:
        assert sorted(f.keys()) == ["a", "b"]
        assert f.get_tensor("a").shape == (2, 3)


def test_the_nvfp4_export_is_read_by_ranges_as_safetensors_reads_it(tmp_path):
    torch = pytest.importorskip("torch")
    from safetensors import safe_open
    from safetensors.torch import save_file
    from studio.pipelines.h3_runtime import RangeFile
    tensors = {"a::weight": torch.randint(0, 255, (3, 5), dtype=torch.uint8),
               "a::scale": torch.randn(4, dtype=torch.float32).to(torch.float8_e4m3fn),
               "a::alpha": torch.randn(2, 2, dtype=torch.bfloat16),
               "b::empty": torch.zeros(0, 3), "b::index": torch.arange(7, dtype=torch.int64)}
    path = str(tmp_path / "export.safetensors")
    save_file(tensors, path, metadata={"skip_blocks": "[1, 2]"})
    with RangeFile(path, framework="pt", device="cpu") as f, safe_open(path, framework="pt") as ref:
        assert sorted(f.keys()) == sorted(ref.keys()) and f.metadata() == ref.metadata()
        for key in ref.keys():
            got, want = f.get_tensor(key), ref.get_tensor(key)
            assert got.dtype == want.dtype and got.shape == want.shape
            assert got.view(torch.uint8).tolist() == want.view(torch.uint8).tolist()


def test_range_reads_replace_safe_open_only_while_the_export_loads(monkeypatch):
    import types
    safetensors = pytest.importorskip("safetensors")
    from studio.pipelines import h3_runtime
    seen = []

    def load_export(model, path, device):
        from safetensors import safe_open
        seen.append(safe_open)
        return 350
    nvfp4 = types.SimpleNamespace(load_minimax_h3_nvfp4_dit_export=load_export)
    loader = types.SimpleNamespace(safe_open=None)
    for name, module in {"fastvideo": types.ModuleType("fastvideo"),
                         "fastvideo.layers": types.ModuleType("l"), "fastvideo.models": types.ModuleType("m"),
                         "fastvideo.layers.quantization": types.SimpleNamespace(nvfp4_config=nvfp4),
                         "fastvideo.layers.quantization.nvfp4_config": nvfp4,
                         "fastvideo.models.loader": types.SimpleNamespace(weight_utils=loader),
                         "fastvideo.models.loader.weight_utils": loader}.items():
        monkeypatch.setitem(sys.modules, name, module)
    mapped = safetensors.safe_open
    h3_runtime._read_weights_whole()
    h3_runtime._read_weights_whole()  # a second engine does not wrap it twice
    assert nvfp4.load_minimax_h3_nvfp4_dit_export(None, "x", "cuda") == 350
    assert seen == [h3_runtime.RangeFile] and safetensors.safe_open is mapped
    assert loader.safe_open is h3_runtime.WholeFile


def test_an_h3_engine_is_named_shortly_in_the_log(monkeypatch, capsys):
    from studio.pipelines.h3_runtime import EngineSpec
    monkeypatch.setattr(common, "POOL", common.EnginePool())
    monkeypatch.setattr(common, "free_memory", lambda: 200 * 1024**3)
    spec = EngineSpec(model_dir=Path("/data/models/fasth3-omniref-nvfp4"), ref2va=True)
    common.load(("h3", spec), lambda: object(), alone=True)
    assert capsys.readouterr().out.startswith("engine: h3 fasth3-omniref-nvfp4 loaded in ")
