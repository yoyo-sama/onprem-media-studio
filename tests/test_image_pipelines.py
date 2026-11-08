"""Image engines through the real API, with the diffusers pipeline replaced by a
fake that records what it was called with. What is checked is what 1.4 learned
the hard way: no negative prompt reaches Krea 2, the prompt arrives verbatim,
image slots follow subjects → setting → references, the output size follows
image 1, and at most two subjects share a shot."""

import io
import json
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from studio.main import create_app
from studio.models import MARKER
from studio.pipelines import REGISTRY, common, qwen

from .test_api import FakeLlm, wait_for


class FakeDiffusersPipeline:
    def __init__(self):
        self.calls = []
        self.step_delay = 0.0

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        for step in range(kwargs["num_inference_steps"]):
            time.sleep(self.step_delay)
            kwargs["callback_on_step_end"](self, step, 0, {})
        size = (kwargs["width"], kwargs["height"])
        return SimpleNamespace(images=[Image.new("RGB", size, "gray")] * kwargs.get("num_images_per_prompt", 1))


@pytest.fixture
def fake(monkeypatch):
    pipe = FakeDiffusersPipeline()
    loaded = []
    monkeypatch.setattr(common, "load", lambda key, build, size=0: loaded.append(key) or pipe)
    monkeypatch.setattr(common, "generator", lambda seed: ("generator", seed))
    pipe.loaded = loaded
    return pipe


@pytest.fixture
def client(settings, store, fake):
    for model_id in store.catalog:  # every model already on disk: no download in these tests
        store.path(model_id).mkdir(parents=True)
        (store.path(model_id) / MARKER).write_text("{}")
    app = create_app(settings, models=store, pipelines=REGISTRY, llm=FakeLlm())
    with TestClient(app) as c:
        yield c


def png(width, height, color="white"):
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, "PNG")
    return buf.getvalue()


def upload(client, width, height, color="white"):
    resp = client.post("/api/inputs", content=png(width, height, color))
    assert resp.status_code == 201, resp.text
    return resp.json()["ref"]


def run(client, pipeline, params):
    resp = client.post("/api/jobs", json={"pipeline": pipeline, "params": params})
    assert resp.status_code == 201, resp.text
    job = wait_for(client, resp.json()["id"])
    assert job["status"] == "done", job
    return job


def rejected(client, pipeline, params):
    resp = client.post("/api/jobs", json={"pipeline": pipeline, "params": params})
    assert resp.status_code == 422, resp.text
    return resp.json()["detail"]


def test_engines_are_registered(client):
    ids = {p["id"] for p in client.get("/api/pipelines").json()}
    assert {"krea2-t2i", "qwen-image-2.1"} <= ids
    assert "qwen-edit-2509" not in ids  # dropped on 2026-10-29: Qwen Image 2.1 covers every edit


def test_no_job_without_a_submission(client, fake):
    upload(client, 64, 64)  # an upload is not a render
    time.sleep(0.2)
    assert client.get("/api/jobs").json() == [] and fake.calls == []


# ── Uploads and references ───────────────────────────────────────────────────

def test_upload_is_content_addressed_and_served(client):
    ref = upload(client, 40, 30)
    assert ref.startswith("inputs/") and ref.endswith(".png")
    assert upload(client, 40, 30) == ref
    assert client.get("/" + ref).content == png(40, 30)


def test_upload_rejects_non_images(client):
    assert client.post("/api/inputs", content=b"not an image").status_code == 422


@pytest.mark.parametrize("ref", ["inputs/../catalog.json", "models/x.png", "outputs/missing.png", 3, "x"])
def test_bad_references_are_rejected_before_queueing(client, ref):
    detail = rejected(client, "qwen-image-2.1", {"prompt": "p", "images": [ref]})
    assert detail.startswith(("Not a file reference", "No such file"))
    assert client.get("/api/jobs").json() == []


# ── Krea 2 ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("key", ["negative", "negative_prompt"])
def test_krea2_refuses_a_negative_prompt(client, key):
    assert "never encodes a negative prompt" in rejected(client, "krea2-t2i", {"prompt": "a fox", key: "blurry"})


def test_krea2_renders_the_prompt_verbatim_without_guidance(client, fake):
    prompt = "  A fox in the snow, \"quoted\", trailing space "
    job = run(client, "krea2-t2i", {"prompt": prompt, "width": 1920, "height": 1088, "count": 2})
    call = fake.calls[-1]
    assert call["prompt"] == prompt
    assert call["guidance_scale"] == 0.0 and call["num_inference_steps"] == 8
    assert "negative_prompt" not in call
    assert (call["width"], call["height"], call["num_images_per_prompt"]) == (1920, 1088, 2)
    assert len(job["outputs"]) == 2
    # The seed was drawn at submission and recorded with the job and in the file.
    assert call["generator"] == ("generator", job["params"]["seed"])
    with Image.open(io.BytesIO(client.get("/" + job["outputs"][0]).content)) as img:
        meta = json.loads(img.text["studio"])
    assert meta == {"pipeline": "krea2-t2i", "origin": None, "params": job["params"]}


@pytest.mark.parametrize("params", [
    {"prompt": "   "},
    {"prompt": "p", "width": 1000},
    {"prompt": "p", "count": 5},
    {"prompt": "p", "seed": -1},
    {"prompt": "p", "steps": 20},
])
def test_krea2_parameter_errors(client, params):
    rejected(client, "krea2-t2i", params)


def test_cancel_during_render(client, fake):
    fake.step_delay = 0.2
    job = client.post("/api/jobs", json={"pipeline": "krea2-t2i", "params": {"prompt": "p"}}).json()
    wait_for(client, job["id"], ("running",))
    client.post(f"/api/jobs/{job['id']}/cancel")
    assert wait_for(client, job["id"])["status"] == "cancelled"


# ── Qwen Image 2.1 ───────────────────────────────────────────────────────────

def test_21_text_to_image(client, fake):
    run(client, "qwen-image-2.1", {"prompt": "p", "width": 1344, "height": 768, "count": 3})
    call = fake.calls[-1]
    assert call["image"] is None and (call["width"], call["height"]) == (1344, 768)
    assert call["num_images_per_prompt"] == 3 and call["sigmas"] == qwen.LIGHTNING_SIGMAS
    assert call["num_inference_steps"] == 4
    assert call["true_cfg_scale"] == 1.0 and "negative_prompt" not in call


def test_21_shot_orders_subjects_then_setting_and_sizes_from_image_1(client, fake):
    subject_a, subject_b = upload(client, 192, 108, "red"), upload(client, 100, 100, "green")
    setting = upload(client, 90, 160, "blue")  # different ratio: the size must not follow it
    run(client, "qwen-image-2.1", {"prompt": "p", "subjects": [subject_a, subject_b], "setting": setting})
    call = fake.calls[-1]
    assert [img.getpixel((0, 0)) for img in call["image"]] == [(255, 0, 0), (0, 128, 0), (0, 0, 255)]
    assert (call["width"], call["height"]) == common.fit_area(192, 108) == (1376, 768)
    assert fake.loaded[-1] == "qwen-image-2.1"


def test_21_image_to_image_follows_image_1(client, fake):
    ref = upload(client, 80, 60)
    run(client, "qwen-image-2.1", {"prompt": "Replace the sign text with HOLA", "images": [ref]})
    assert len(fake.calls[-1]["image"]) == 1
    assert (fake.calls[-1]["width"], fake.calls[-1]["height"]) == common.fit_area(80, 60)


def test_at_most_two_subjects_per_shot(client):
    refs = [upload(client, 10 + i, 10) for i in range(4)]
    rejected(client, "qwen-image-2.1", {"prompt": "p", "subjects": refs[:3], "setting": refs[3]})


def test_21_shot_with_references(client, fake):
    subject, setting = upload(client, 192, 108, "red"), upload(client, 108, 192, "blue")
    refs = [upload(client, 30, 30, "green"), upload(client, 30, 30, "yellow")]
    run(client, "qwen-image-2.1", {"prompt": "p", "subjects": [subject], "setting": setting, "references": refs})
    call = fake.calls[-1]
    assert [img.getpixel((0, 0)) for img in call["image"]] == [
        (255, 0, 0), (0, 0, 255), (0, 128, 0), (255, 255, 0)]
    assert (call["width"], call["height"]) == common.fit_area(192, 108)
    assert call["num_images_per_prompt"] == 1


def test_21_edit_with_explicit_shot_size(client, fake):
    ref = upload(client, 50, 50)
    run(client, "qwen-image-2.1", {"prompt": "<image1> at dusk", "images": [ref], "width": 1344, "height": 768})
    assert (fake.calls[-1]["width"], fake.calls[-1]["height"]) == (1344, 768)
    assert fake.calls[-1]["prompt"] == "<image1> at dusk"


@pytest.mark.parametrize("params", [
    {"prompt": "p", "subjects": ["A"]},                        # no setting
    {"prompt": "p", "images": ["A"], "subjects": ["A"], "setting": "A"},
    {"prompt": "p", "images": ["A"], "count": 2},              # no batch with references
    {"prompt": "p", "images": ["A"] * 11},                     # ten images at most
    {"prompt": "p", "subjects": ["A"], "setting": "A", "references": ["A"] * 8},
    {"prompt": "p", "width": 1024},                            # width without height
    {"prompt": "p", "width": 1280, "height": 720},             # 720 would render as 704
    {"prompt": "p", "negative_prompt": "blurry"},
])
def test_21_parameter_errors(client, params):
    ref = upload(client, 20, 20)
    params = json.loads(json.dumps(params).replace('"A"', json.dumps(ref)))
    rejected(client, "qwen-image-2.1", params)


def test_a_sheet_rendered_by_one_job_feeds_the_next(client, fake):
    """The storyboard chain: Krea 2 sheets, then a shot that uses them as references."""
    sheet = run(client, "krea2-t2i", {"prompt": "subject sheet", "width": 1920, "height": 1088})["outputs"][0]
    setting = run(client, "krea2-t2i", {"prompt": "setting sheet", "width": 1920, "height": 1088})["outputs"][0]
    run(client, "qwen-image-2.1", {"prompt": "shot", "subjects": [sheet], "setting": setting})
    assert len(fake.calls[-1]["image"]) == 2
    assert fake.loaded == ["krea2-t2i", "krea2-t2i", "qwen-image-2.1"]


def test_qualification_cases_are_valid_jobs(settings):
    """tools/qualify/image_cases.json must submit cleanly, or the GB10 run stops halfway."""
    from pathlib import Path
    from studio.files import FileStore
    cases = json.loads((Path(__file__).parent.parent / "tools/qualify/image_cases.json").read_text())["cases"]
    files = FileStore(settings.input_dir, settings.output_dir)
    ref = files.save_input(png(192, 108))["ref"]
    for case in cases:
        params = json.loads(json.dumps(case["params"]))
        for key, value in params.items():
            if isinstance(value, list):
                params[key] = [ref if str(v).startswith("@") else v for v in value]
            elif str(value).startswith("@"):
                params[key] = ref
        REGISTRY[case["pipeline"]].validate(params, files)


class Closable:
    def __init__(self, name, log):
        self.name, self.log = name, log

    def close(self):
        self.log.append(self.name)


def test_pipelines_stay_resident_while_memory_allows(monkeypatch, capsys):
    gb = 1024**3
    free = {"bytes": 80 * gb}
    closed = []
    monkeypatch.setattr(common, "POOL", common.EnginePool())
    monkeypatch.setattr(common, "free_memory", lambda: free["bytes"])
    krea = common.load("krea2", lambda: Closable("krea2", closed), 34 * gb)
    free["bytes"] -= 34 * gb
    qwen = common.load("qwen", lambda: Closable("qwen", closed), 30 * gb)
    free["bytes"] -= 30 * gb
    assert list(common.POOL.resident) == ["krea2", "qwen"] and closed == []
    # Back to Krea 2: still resident, not rebuilt, and now the most recently used.
    assert common.load("krea2", lambda: pytest.fail("rebuilt")) is krea
    assert list(common.POOL.resident) == ["qwen", "krea2"]

    def release(name, size):
        def close():
            closed.append(name)
            free["bytes"] += size
        return close
    qwen.close, krea.close = release("qwen", 30 * gb), release("krea2", 34 * gb)
    # A 64 GB video engine does not fit: the least recently used goes first, then the next.
    common.load("h3", lambda: Closable("h3", closed), 64 * gb)
    assert closed == ["qwen", "krea2"] and list(common.POOL.resident) == ["h3"]
    # Each load is one line of the container log, naming what it freed.
    lines = capsys.readouterr().out.splitlines()
    assert [l.split(" loaded")[0] for l in lines] == ["engine: krea2", "engine: qwen", "engine: h3"]
    assert lines[-1].endswith("after freeing qwen, krea2")


def test_a_video_engine_is_loaded_alone(monkeypatch):
    closed = []
    monkeypatch.setattr(common, "POOL", common.EnginePool())
    monkeypatch.setattr(common, "free_memory", lambda: 200 * 1024**3)
    common.load("krea2", lambda: Closable("krea2", closed), 34 * 1024**3)
    common.load("qwen", lambda: Closable("qwen", closed), 30 * 1024**3)
    common.load("h3", lambda: Closable("h3", closed), alone=True)
    assert closed == ["krea2", "qwen"] and list(common.POOL.resident) == ["h3"]


def test_a_pipeline_is_built_even_when_nothing_is_left_to_free(monkeypatch):
    monkeypatch.setattr(common, "POOL", common.EnginePool())
    monkeypatch.setattr(common, "free_memory", lambda: 0)
    assert common.load("krea2", lambda: "pipe", 34 * 1024**3) == "pipe"


def test_torch_cache_is_given_back_before_memory_is_measured(monkeypatch):
    # The last render's cached blocks counted as used made Krea 2 unload Qwen on the GB10.
    gb = 1024**3
    free = {"bytes": 30 * gb}
    closed = []
    monkeypatch.setattr(common, "POOL", common.EnginePool())
    common.POOL.resident["qwen"] = Closable("qwen", closed)
    monkeypatch.setattr(common, "free_memory", lambda: free["bytes"])
    monkeypatch.setattr(common, "_empty_cache", lambda: free.update(bytes=free["bytes"] + 25 * gb))
    common.load("krea2", lambda: Closable("krea2", closed), 34 * gb)
    assert closed == [] and list(common.POOL.resident) == ["qwen", "krea2"]


def test_text_encoders_are_loaded_whole_by_transformers(tmp_path, monkeypatch):
    # diffusers passes disable_mmap to its own models only: transformers ones are built here.
    import json
    import sys
    import types
    calls = {}

    class PreTrainedModel:
        @classmethod
        def from_pretrained(cls, path, **kwargs):
            calls[cls.__name__] = (path, kwargs)
            return cls.__name__

    class TextModel(PreTrainedModel):
        pass

    class Tokenizer:
        pass

    class Pipeline:
        @classmethod
        def from_pretrained(cls, path, **kwargs):
            calls["pipeline"] = kwargs
            return types.SimpleNamespace(to=lambda device: ("on", device))

    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(bfloat16="bf16"))
    monkeypatch.setitem(sys.modules, "transformers", types.SimpleNamespace(
        PreTrainedModel=PreTrainedModel, TextModel=TextModel, Tokenizer=Tokenizer))
    monkeypatch.setattr(common, "device", lambda: "cuda")
    (tmp_path / "model_index.json").write_text(json.dumps({
        "_class_name": "Krea2Pipeline", "text_encoder": ["transformers", "TextModel"],
        "tokenizer": ["transformers", "Tokenizer"], "vae": ["diffusers", "AutoencoderKL"]}))
    assert common.from_pretrained(Pipeline, tmp_path) == ("on", "cuda")
    assert calls["TextModel"] == (tmp_path / "text_encoder", {"dtype": "bf16", "disable_mmap": True})
    assert calls["pipeline"] == {"torch_dtype": "bf16", "disable_mmap": True, "text_encoder": "TextModel"}


def test_render_log_splits_encoding_steps_and_decoding(monkeypatch, capsys):
    monkeypatch.setattr(common.time, "time", lambda: 20.0)
    common.log_render("krea2-t2i", "1920×1088 ×1", 0.0, [5.0, 7.0, 9.0, 11.0])
    assert capsys.readouterr().out.strip() == ("render: krea2-t2i 1920×1088 ×1 in 20.0 s: text encoding and first "
                                               "step 5.0 s, 3 more steps × 2.00 s, decoding 9.0 s")
