"""MOSS-Image through the real API, with the resident engine replaced by a fake that records
each render: what each mode sends (steps, guidance, turbo LoRA), what is refused, and the
pinned revision. The LoRA hooks and the step callback are checked on tiny torch modules
when torch is installed."""

import json
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from studio.main import create_app
from studio.models import MARKER
from studio.pipelines import REGISTRY, common, moss

from .test_api import FakeLlm, wait_for


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.step_delay = 0.0

    def render(self, prompt, width, height, steps, guidance, turbo, count, seed, callback):
        self.calls.append(dict(prompt=prompt, width=width, height=height, steps=steps, guidance=guidance,
                               turbo=turbo, count=count, seed=seed))
        for step in range(steps):
            time.sleep(self.step_delay)
            callback(None, step, 0, {})
        return [Image.new("RGB", (width, height), "gray")] * count


@pytest.fixture
def engine(monkeypatch):
    fake = FakeEngine()
    monkeypatch.setattr(common, "load", lambda key, build, size=0: fake)
    return fake


@pytest.fixture
def client(settings, store, engine):
    for model_id in store.catalog:
        store.path(model_id).mkdir(parents=True)
        (store.path(model_id) / MARKER).write_text("{}")
    with TestClient(create_app(settings, models=store, pipelines=REGISTRY, llm=FakeLlm())) as c:
        yield c


def submit(client, params):
    return client.post("/api/jobs", json={"pipeline": "moss-image", "params": params})


def run(client, params):
    resp = submit(client, params)
    assert resp.status_code == 201, resp.text
    job = wait_for(client, resp.json()["id"])
    assert job["status"] == "done", job
    return job


@pytest.mark.parametrize("mode, steps, guidance, turbo", [
    (None, 8, 1.0, True), ("preview", 4, 1.0, True), ("standard", 8, 1.0, True), ("quality", 25, 3.0, False)])
def test_each_mode_sends_its_settings(client, engine, settings, mode, steps, guidance, turbo):
    params = {"prompt": '  A poster titled "THE LAST LIGHT"  ', "width": 1280, "height": 720, "seed": 42}
    if mode:
        params["mode"] = mode
    job = run(client, params)
    call = engine.calls[-1]
    assert (call["steps"], call["guidance"], call["turbo"]) == (steps, guidance, turbo)
    assert call["prompt"] == params["prompt"]  # verbatim
    assert (call["width"], call["height"], call["seed"], call["count"]) == (1280, 720, 42, 1)
    assert job["params"]["mode"] == (mode or "standard")
    out = job["outputs"][0]
    assert out.startswith("outputs/moss-image/")
    meta = json.loads(Image.open(settings.output_dir / out[len("outputs/"):]).text["studio"])
    assert meta["params"]["mode"] == (mode or "standard")


def test_both_models_are_needed():
    assert REGISTRY["moss-image"].models == ["moss-image-sft", "moss-image-turbo-lora"]


@pytest.mark.parametrize("params", [
    {"prompt": "x", "mode": "turbo"},
    {"prompt": "x", "negative": "blurry"},
    {"prompt": "x", "negative_prompt": "blurry"},
    {"prompt": "x", "steps": 12},
    {"prompt": "x", "width": 1000},
    {"prompt": "x", "count": 5},
    {"prompt": " "},
])
def test_refused(client, engine, params):
    assert submit(client, params).status_code == 422
    assert engine.calls == []


def test_revision_is_pinned(store):
    # MOSS's pipeline code is imported from its model folder: the commit the bench ran.
    for model_id in REGISTRY["moss-image"].models:
        assert len(store.catalog[model_id]["revision"]) == 40
    store.catalog["gemma4-26b-a4b"].pop("revision", None)
    store.remote_files("gemma4-26b-a4b")
    assert store.api.revisions[-1] is None  # no pin: the latest commit
    store.catalog["gemma4-26b-a4b"]["revision"] = "f972bd4"
    assert store.remote_files("gemma4-26b-a4b")[0] == store.api.revisions[-1] == "f972bd4"


# ── LoRA hooks and step callback, on tiny modules ─────────────────────────────

torch = pytest.importorskip("torch")


class TinyTransformer(torch.nn.Module):
    def __init__(self):
        super().__init__()
        block = torch.nn.Module()
        block.proj = torch.nn.ModuleDict({"q": torch.nn.Linear(4, 4, bias=False)})
        self.layers = torch.nn.ModuleList([block])

    def forward(self, x):
        return self.layers[0].proj["q"](x)


def lora_file(tmp_path, keys):
    from safetensors.torch import save_file
    path = tmp_path / "lora.safetensors"
    save_file(keys, str(path))
    return path


def test_lora_is_a_side_branch_removed_after_the_render(tmp_path):
    model = TinyTransformer()
    down, up = torch.ones(2, 4), torch.full((4, 2), 0.5)
    path = lora_file(tmp_path, {"diffusion_model.layers.0.proj.q.lora_down.weight": down,
                                "diffusion_model.layers.0.proj.q.lora_up.weight": up,
                                "diffusion_model.layers.0.proj.q.alpha": torch.tensor(1.0)})
    lora = moss.read_lora(path, model)
    assert set(lora) == {"layers.0.proj.q"} and lora["layers.0.proj.q"][2] == 0.5  # alpha / rank
    x = torch.ones(1, 4)
    plain = model(x)
    with moss.lora_hooks(model, lora):
        hooked = model(x)
    # up(down(x)) = 0.5 · 2 · 4 = 4 per output, times alpha/rank 0.5
    assert torch.allclose(hooked - plain, torch.full((1, 4), 2.0))
    assert torch.equal(model(x), plain)  # the weights were never touched


def test_a_lora_key_that_matches_no_layer_refuses_the_file(tmp_path):
    path = lora_file(tmp_path, {"diffusion_model.layers.0.proj.q.lora_down.weight": torch.ones(2, 4),
                                "diffusion_model.layers.0.proj.q.lora_up.weight": torch.ones(4, 2),
                                "diffusion_model.layers.9.proj.k.lora_down.weight": torch.ones(2, 4)})
    with pytest.raises(ValueError, match="match no layer"):
        moss.read_lora(path, TinyTransformer())


def test_step_callback_counts_steps_and_restores_the_scheduler():
    class Scheduler:
        def step(self, output, timestep, latents, return_dict=False):
            return (latents + output,)
    pipe = SimpleNamespace(scheduler=Scheduler())
    seen = []
    with moss.step_callback(pipe, lambda p, step, t, tensors: seen.append((step, t))):
        for t in (900, 500):
            pipe.scheduler.step(1, t, 0, return_dict=False)
    assert seen == [(0, 900), (1, 500)]
    assert "step" not in vars(pipe.scheduler)
