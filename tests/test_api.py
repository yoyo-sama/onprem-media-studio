import time

import pytest
from fastapi.testclient import TestClient

from studio.main import create_app
from studio.pipelines import Pipeline


class Echo(Pipeline):
    """Test pipeline: writes its prompt to a file; needs the gemma model."""

    id = "echo"
    models = ["gemma4-e4b"]

    def validate(self, params):
        if not params.get("prompt"):
            raise ValueError("prompt is required")

    def run(self, params, models, ctx):
        assert models["gemma4-e4b"].is_dir()
        out = ctx.output_dir / f"{ctx.job.id}.txt"
        for i in range(3):
            if params.get("wait"):
                time.sleep(0.2)
            ctx.progress(i / 3, f"step {i}")
        out.write_text(params["prompt"])
        return [out]


class FakeLlm:
    state = "stopped"

    def chat(self, system, prompt, images, json_mode, temperature):
        return '{"prompt": "%s"}' % prompt.upper()

    def stop(self):
        pass


@pytest.fixture
def client(settings, store):
    app = create_app(settings, models=store, pipelines={"echo": Echo()}, llm=FakeLlm())
    with TestClient(app) as c:
        yield c


def wait_for(client, job_id, statuses=("done", "error", "cancelled")):
    for _ in range(100):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in statuses:
            return job
        time.sleep(0.05)
    raise AssertionError(f"job stuck: {job}")


def test_health_names_the_app(client):
    body = client.get("/api/health").json()
    assert body["app"] == "OnPrem Media Studio"
    assert "gpu" in body and body["llm"] == "stopped"


def test_app_name_is_configurable(settings, store, monkeypatch):
    monkeypatch.setenv("STUDIO_APP_NAME", "Renamed Studio")
    from studio.config import Settings
    app = create_app(Settings(), models=store, pipelines={}, llm=FakeLlm())
    with TestClient(app) as c:
        assert c.get("/api/health").json()["app"] == "Renamed Studio"


def test_job_downloads_missing_models_then_renders(client, fetch, settings):
    job = client.post("/api/jobs", json={"pipeline": "echo", "params": {"prompt": "hello"}}).json()
    done = wait_for(client, job["id"])
    assert done["status"] == "done", done
    assert "gemma-4-E4B-it-Q8_0.gguf" in fetch.calls
    assert open(done["outputs"][0]).read() == "hello"


def test_websocket_streams_job_events(client):
    with client.websocket_connect("/api/ws") as ws:
        job = client.post("/api/jobs", json={"pipeline": "echo", "params": {"prompt": "hi"}}).json()
        statuses = []
        while "done" not in statuses:
            event = ws.receive_json()
            if event["type"] == "job" and event["job"]["id"] == job["id"]:
                statuses.append(event["job"]["status"])
        assert statuses[0] == "queued" and "running" in statuses


def test_invalid_params_are_rejected_before_queueing(client):
    resp = client.post("/api/jobs", json={"pipeline": "echo", "params": {}})
    assert resp.status_code == 422
    assert client.get("/api/jobs").json() == []


def test_unknown_pipeline(client):
    assert client.post("/api/jobs", json={"pipeline": "nope"}).status_code == 404


def test_cancel_running_job(client):
    job = client.post("/api/jobs", json={"pipeline": "echo", "params": {"prompt": "x", "wait": True}}).json()
    wait_for(client, job["id"], ("running",))
    client.post(f"/api/jobs/{job['id']}/cancel")
    assert wait_for(client, job["id"])["status"] == "cancelled"


def test_nothing_runs_without_a_submission(client):
    time.sleep(0.2)
    assert client.get("/api/jobs").json() == []


def test_models_endpoint_lists_catalog(client):
    ids = {m["id"] for m in client.get("/api/models").json()}
    assert {"gemma4-e4b", "krea2-turbo", "qwen-image-edit-2509", "fasth3-omniref-nvfp4"} <= ids


def test_llm_chat(client):
    resp = client.post("/api/llm/chat", json={"system": "s", "prompt": "cat"})
    assert resp.json() == {"content": '{"prompt": "CAT"}'}
