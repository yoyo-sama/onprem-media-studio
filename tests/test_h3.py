"""MiniMax H3 video engines without a GPU: FastVideo is replaced by a fake engine
that records each request. What is checked is what the validated workflow and
1.4 fix: the 17n+5 grid, the two-pass geometry and refine schedule, the verbatim
prompt, <Picture N> numbering, the 5–15 s limit of FastVideo, the LoRA stack
maths, the FP8 fallback, and the upscaler's checkpoint layout."""

import json
import sys
import threading
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

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
        if self.log.get("fail_nvfp4") and self.spec.precision == "nvfp4":
            raise RuntimeError("CUDA error: no kernel image is available for execution on the device")
        if kw.get("save", True):
            kw["output"].write_bytes(b"mp4")
        frame = np.zeros((kw["height"], kw["width"], 3), dtype=np.uint8)
        return SimpleNamespace(video_path=str(kw["output"]) if kw.get("save", True) else None,
                               frames=None if self.state.get("latent") else [frame, frame],
                               samples="video-latents", audio="audio-latents")


@pytest.fixture
def engines(monkeypatch, settings):
    log = {"engines": []}

    def load(key, build, size=0):
        assert key[0] == "h3"
        engine = FakeEngine(key[1], log)
        log["engines"].append(engine)
        return engine

    monkeypatch.setattr(common, "load", load)
    monkeypatch.setattr(h3, "_reference", lambda path: ("ref", path.name))
    monkeypatch.setattr(h3, "refine_inputs", lambda *a: (log.setdefault("refine", a), ("latents", "audio"))[1])
    monkeypatch.setattr(h3, "_precision", {"fallback": False, "proven": False})
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
    assert engines["engines"][0].spec.precision == "nvfp4" and not engines["engines"][0].spec.ref2va
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


def test_r2v_preview_is_the_first_pass_only(client, engines):
    sheet = upload(client, 192, 108)
    job = run(client, "h3-r2v", {"prompt": "<Picture 1>", "references": [sheet], "preview": True})
    (call,) = calls(engines)
    assert (call["width"], call["height"], call["steps"]) == (736, 416, 8)
    assert call["latent"] is False and call.get("save", True)
    assert engines["engines"][0].spec.ref2va
    assert (job["params"]["width"], job["params"]["height"]) == (736, 416)


def test_r2v_two_passes(client, engines):
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
    ("h3-r2v", {"prompt": "p", "references": []}, "1 to 9"),
])
def test_parameter_errors(client, pipeline, params, message):
    assert message in rejected(client, pipeline, params)
    assert client.get("/api/jobs").json() == []


def test_r2v_cited_pictures_must_exist(client):
    sheets = [upload(client, 64, 64, c) for c in ("red", "green")]
    detail = rejected(client, "h3-r2v", {"prompt": "<Picture 1>, <Picture 3>", "references": sheets})
    assert "<Picture 3>" in detail
    assert "1 to 9" in rejected(client, "h3-r2v", {"prompt": "p", "references": sheets * 5})


def test_nothing_renders_without_a_submission(client, engines):
    upload(client, 64, 64)
    time.sleep(0.2)
    assert client.get("/api/jobs").json() == [] and engines["engines"] == []


def test_auto_precision_falls_back_to_fp8_once(client, engines, store):
    engines["fail_nvfp4"] = True
    job = run(client, "h3-t2v", {"prompt": "p"})
    nvfp4, fp8 = engines["engines"]
    assert nvfp4.spec.precision == "nvfp4" and fp8.spec.precision == "fp8"
    assert fp8.spec.model_dir == store.path("fasth3-v2-fp8")
    assert job["outputs"][0].endswith(".mp4")
    # The fallback sticks for the session: the next job asks for FP8 straight away.
    assert REGISTRY["h3-t2v"].needs(store.settings) == ["fasth3-v2-fp8"]
    run(client, "h3-t2v", {"prompt": "p"})
    assert engines["engines"][-1].spec.precision == "fp8"


def test_no_fallback_after_nvfp4_worked(client, engines):
    run(client, "h3-t2v", {"prompt": "p"})
    engines["fail_nvfp4"] = True
    resp = client.post("/api/jobs", json={"pipeline": "h3-t2v", "params": {"prompt": "p"}})
    job = wait_for(client, resp.json()["id"])
    assert job["status"] == "error" and "no kernel image" in job["error"]


def test_forced_precision(monkeypatch, settings):
    monkeypatch.setenv("STUDIO_H3_PRECISION", "fp8")
    from studio.config import Settings
    assert REGISTRY["h3-r2v"].needs(Settings()) == ["fasth3-omniref-fp8", "h3-latent-upscaler"]
    monkeypatch.setenv("STUDIO_H3_PRECISION", "fp4")
    with pytest.raises(ValueError):
        Settings()


# ── FastVideo adapter ────────────────────────────────────────────────────────

def test_environment_profiles(tmp_path, monkeypatch):
    nvfp4 = h3_runtime.EngineSpec(tmp_path, ref2va=True, precision="nvfp4")
    env = h3_runtime.environment(nvfp4)
    assert env["FASTVIDEO_H3_VSA_FP4"] == "1" and env["FASTVIDEO_LORA_SIDE_BRANCH"] == "1"
    assert env["FASTVIDEO_H3_VAE_NVFP4_DECODER"].endswith("vae_decoder_nvfp4/decoder-nvfp4.safetensors")
    assert "FASTVIDEO_H3_ADALN_TABLE" not in env  # would bypass the LoRA and the refine timesteps
    fp8 = h3_runtime.environment(h3_runtime.EngineSpec(tmp_path, ref2va=True, precision="fp8"))
    assert fp8["FASTVIDEO_H3_VSA_FP4"] == "0" and "FASTVIDEO_H3_VAE_NVFP4_DECODER" not in fp8
    # A fallback build must not inherit the NVFP4 settings of the previous one.
    monkeypatch.setattr(h3_runtime.os, "environ", {})
    h3_runtime._apply_env(env)
    h3_runtime._apply_env(fp8)
    assert "FASTVIDEO_NVFP4_MM_BACKEND" not in h3_runtime.os.environ
    v2 = h3_runtime.experimental(h3_runtime.EngineSpec(tmp_path, ref2va=False, precision="nvfp4"))
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


def test_lora_check():
    assert h3_lora.check([], Path("/nonexistent")) == []
    with pytest.raises(ValueError, match="at most"):
        h3_lora.check([{"name": "a.safetensors"}] * 5, Path("/nonexistent"))


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
