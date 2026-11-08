import json
import time

import pytest
from fastapi.testclient import TestClient

from studio.main import create_app
from studio.pipelines import Pipeline


class Echo(Pipeline):
    """Test pipeline: writes its prompt to a file; needs the gemma model."""

    id = "echo"
    models = ["gemma4-26b-a4b"]

    def validate(self, params, files):
        if not params.get("prompt"):
            raise ValueError("prompt is required")
        return params

    def run(self, params, models, ctx):
        assert models["gemma4-26b-a4b"].is_dir()
        out = ctx.output_dir / f"{ctx.job.id}.txt"
        for i in range(3):
            if params.get("wait"):
                time.sleep(0.2)
            ctx.progress(i / 3, f"step {i}")
        out.write_text(params["prompt"])
        return [out]


class FakeLlm:
    state = "stopped"
    model_id = "gemma4-26b-a4b"

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
    assert body["queue"] == 0
    assert body["memory"] is None or 0 < body["memory"]["available"] <= body["memory"]["total"]


MEMINFO = "MemTotal:       127535272 kB\nMemFree:         3500000 kB\nMemAvailable:   115000000 kB\n"


def test_unified_memory_counts_reclaimable_cache():
    from studio.pipelines.common import available_memory
    gb10_total = 127535272 * 1024  # CUDA total on a GB10 equals the RAM total
    assert available_memory(3 * 1024**3, gb10_total, MEMINFO) == 115000000 * 1024


def test_discrete_gpu_keeps_cuda_free_memory():
    from studio.pipelines.common import available_memory
    assert available_memory(20 * 1024**3, 32 * 1024**3, MEMINFO) == 20 * 1024**3


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
    assert "gemma-4-26B-A4B-it-Q4_0.gguf" in fetch.calls
    assert done["outputs"][0] == f"outputs/{job['id']}.txt"
    assert client.get("/" + done["outputs"][0]).text == "hello"


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
    assert {"gemma4-26b-a4b", "krea2-turbo", "qwen-image-2.1", "fasth3-omniref-nvfp4"} <= ids


def test_llm_chat(client):
    resp = client.post("/api/llm/chat", json={"system": "s", "prompt": "cat"})
    assert resp.json() == {"content": '{"prompt": "CAT"}'}


def test_front_end_is_revalidated(settings, store):
    from studio.main import WEB_DIR
    if not WEB_DIR.is_dir():
        pytest.skip("no web/ folder")
    with TestClient(create_app(settings, models=store, pipelines={}, llm=FakeLlm())) as client:
        res = client.get("/js/studio.js")
        assert res.status_code == 200 and res.headers["cache-control"] == "no-cache"
        again = client.get("/js/studio.js", headers={"If-None-Match": res.headers["etag"]})
        assert again.status_code == 304


def test_job_ids_differ_from_one_start_to_the_next(settings, store):
    """Jobs live in memory: a page that waited for a job before a restart must get a 404
    for it after, never another job that took the same id."""
    ids = []
    for _ in range(2):
        app = create_app(settings, models=store, pipelines={"echo": Echo()}, llm=FakeLlm())
        with TestClient(app) as c:
            ids.append(c.post("/api/jobs", json={"pipeline": "echo", "params": {"prompt": "x"}}).json()["id"])
    assert ids[0] != ids[1] and all(i.startswith("job-") and i.endswith("-1") for i in ids)


def test_a_held_queue_refuses_new_jobs(client):
    origin = {"Origin": "http://testserver"}
    assert client.post("/api/update/hold", json={"seconds": 30}).status_code == 403
    assert client.post("/api/update/hold", json={"seconds": 900}, headers=origin).status_code == 422
    assert client.post("/api/update/hold", json={"seconds": 30}, headers=origin).json()["held"] is True
    refused = client.post("/api/jobs", json={"pipeline": "echo", "params": {"prompt": "x"}})
    assert refused.status_code == 503 and "update" in refused.json()["detail"]
    client.post("/api/update/hold", json={"seconds": 0}, headers=origin)
    job = client.post("/api/jobs", json={"pipeline": "echo", "params": {"prompt": "x"}}).json()
    assert wait_for(client, job["id"])["status"] == "done"


class Seeded(Echo):
    """Echo with a seed drawn at validation, and a computed key the client may not send."""

    id = "seeded"

    def validate(self, params, files):
        if set(params) - {"prompt", "seed", "wait"}:
            raise ValueError("Unknown parameter")
        out = dict(super().validate(params, files))
        out["seed"] = params.get("seed", 1234)
        out["computed"] = len(params["prompt"])
        return out


def test_jobs_cut_by_a_restart_come_back_interrupted_and_run_again_on_a_click(settings, store):
    origin = {"Origin": "http://testserver"}
    pipes = {"echo": Echo(), "seeded": Seeded()}
    app = create_app(settings, models=store, pipelines=pipes, llm=FakeLlm())
    with TestClient(app) as c:
        done = c.post("/api/jobs", json={"pipeline": "echo", "params": {"prompt": "a"}}).json()
        wait_for(c, done["id"])
    # A job running when the server stopped: what jobs.json holds at that moment.
    history = settings.data_dir / "jobs.json"
    saved = json.loads(history.read_text())
    saved.append({**saved[0], "id": "job-old-9", "pipeline": "seeded", "status": "running", "outputs": [],
                  "params": {"prompt": "b", "seed": 1234, "computed": 1}, "request": {"prompt": "b"}})
    history.write_text(json.dumps(saved))

    app = create_app(settings, models=store, pipelines=pipes, llm=FakeLlm())
    with TestClient(app) as c:
        jobs = {j["id"]: j for j in c.get("/api/jobs").json()}
        assert jobs[done["id"]]["status"] == "done" and not jobs[done["id"]]["interrupted"]
        lost = c.get("/api/jobs/job-old-9").json()
        assert lost["status"] == "error" and lost["interrupted"] and "restarted" in lost["error"]
        # Nothing ran by itself: the lost job waits for a click.
        assert all(j["status"] != "queued" for j in jobs.values())
        assert c.post(f"/api/jobs/{done['id']}/retry", headers=origin).status_code == 422
        assert c.post("/api/jobs/job-old-9/retry").status_code == 403
        again = c.post("/api/jobs/job-old-9/retry", headers=origin).json()
        # The parameters as first sent, with the seed the lost job had drawn.
        assert again["request"] == {"prompt": "b", "seed": 1234} and again["params"]["seed"] == 1234
        assert wait_for(c, again["id"])["status"] == "done"
        assert c.get("/api/jobs/job-old-9").json()["retried_as"] == again["id"]
        assert c.post("/api/jobs/job-old-9/retry", headers=origin).status_code == 422
