"""In-app update of the Docker installation: the updater service (docker/updater/server.py)
on a real git checkout, with docker replaced by fakes, and the studio's RemoteUpdater
talking to it over HTTP."""

import importlib.util
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from studio.main import create_app
from studio.update import RemoteUpdater, UpdateError

from .test_api import FakeLlm
from .test_update import SAME_ORIGIN, commit, git, repos  # noqa: F401 - the repos fixture

SERVER = Path(__file__).resolve().parent.parent / "docker" / "updater" / "server.py"
spec = importlib.util.spec_from_file_location("updater_server", SERVER)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class FakeDocker(server.Updater):
    """The updater with docker replaced: the studio container, compose runs and the queue."""

    def __init__(self, repo, running=None, queue=(), build_code=0):
        super().__init__(repo, "main", "studio", "http://unused", token="")
        self.running, self.queue, self.build_code = running, list(queue), build_code
        self.calls: list[tuple] = []
        self.removed: list[str] = []
        self.holds: list[float] = []

    def compose_args(self):
        return ["compose", "-p", "p"]

    def studio_container(self):
        return {"id": "c1", "image": "sha256:old", "commit": self.running}

    def _compose(self, args, *cmd, commit):
        self.calls.append((cmd[0], commit))
        if cmd[0] == "up":
            self.running = commit  # the recreated container runs the new image
        return self.build_code if cmd[0] == "build" else 0

    def busy(self):
        return self.queue.pop(0) if self.queue else 0

    def hold(self, seconds):
        self.holds.append(seconds)
        self.calls.append(("hold", seconds))

    def docker(self, *args, timeout=120):
        if args[:2] == ("image", "rm"):
            self.removed.append(args[2])
        return server.run(["true"])


def wait_idle(up, seconds=5.0):
    end = time.time() + seconds
    while up.state != "idle" and time.time() < end:
        time.sleep(0.02)
    assert up.state == "idle"


@pytest.fixture(autouse=True)
def fast_poll(monkeypatch):
    monkeypatch.setattr(server, "JOB_POLL", 0.01)


def test_status_offers_a_new_commit_then_rebuilds_after_the_queue_empties(repos):
    upstream, local = repos
    head = git(local, "rev-parse", "HEAD")
    up = FakeDocker(local, running=head, queue=[2, 1])
    status = up.status()
    assert status["mode"] == "docker" and status["state"] == "idle" and not status["available"]
    new = commit(upstream, "studio/x.py")
    git(upstream, "push", "-q", "origin", "main")
    up._cache = (0.0, None)
    status = up.status()
    assert status["available"] and status["remote"] == new and status["running"] == head
    result = up.apply()
    assert result == {"updated": True, "from": head, "to": new, "rebuilding": True}
    wait_idle(up)
    # Built first, then the queue held (renewed at each look) until no job was left,
    # restarted, previous image dropped.
    assert up.calls == [("build", new), ("hold", 60), ("hold", 60), ("hold", 60), ("up", new)] and up.queue == []
    assert up.removed == ["sha256:old"] and up.error is None
    assert git(local, "rev-parse", "HEAD") == new
    assert any("Waiting for 2 job(s)" in line for line in up.log)


def test_a_running_image_older_than_the_checkout_is_offered(repos):
    upstream, local = repos
    old = git(local, "rev-parse", "HEAD")
    new = commit(upstream, "a.txt")
    git(upstream, "push", "-q", "origin", "main")
    git(local, "pull", "-q", "--ff-only", "origin", "main")  # pulled by hand, never rebuilt
    up = FakeDocker(local, running=old)
    status = up.status()
    assert status["available"] and "rebuilds" in status["message"]
    assert up.apply() == {"updated": True, "from": old, "to": new, "rebuilding": True}
    wait_idle(up)
    assert up.calls == [("build", new), ("hold", 60), ("up", new)]


def test_nothing_to_do_when_up_to_date_or_built_by_hand(repos):
    _, local = repos
    head = git(local, "rev-parse", "HEAD")
    for running in (head, None):  # None: an image built by hand carries no commit
        up = FakeDocker(local, running=running)
        assert not up.status()["available"]
        assert up.apply() == {"updated": False, "from": head, "to": head, "rebuilding": False}
        assert up.calls == []


def test_a_failed_build_keeps_the_running_studio(repos):
    upstream, local = repos
    commit(upstream, "docker/Dockerfile")
    git(upstream, "push", "-q", "origin", "main")
    up = FakeDocker(local, running=git(local, "rev-parse", "HEAD"), build_code=1)
    up.apply()
    wait_idle(up)
    assert [c[0] for c in up.calls] == ["build"] and up.removed == [] and up.holds == []
    status = up.status()
    assert "build failed" in status["error"] and "previous version" in status["error"]
    # The image is still behind the checkout: the update stays on offer.
    assert status["available"]


def test_a_failed_restart_lifts_the_hold(repos, monkeypatch):
    upstream, local = repos
    commit(upstream, "studio/z.py")
    git(upstream, "push", "-q", "origin", "main")
    up = FakeDocker(local, running=git(local, "rev-parse", "HEAD"))
    monkeypatch.setattr(up, "_compose", lambda args, *cmd, commit: 0 if cmd[0] == "build" else 1)
    up.apply()
    wait_idle(up)
    assert up.holds == [60, 0] and "Restarting the studio failed" in up.error


def test_apply_refuses_dirty_other_branch_or_a_running_update(repos):
    upstream, local = repos
    up = FakeDocker(local)
    (local / "README.md").write_text("edited by hand")
    with pytest.raises(server.UpdateError, match="Local changes"):
        up.apply()
    git(local, "checkout", "-q", "README.md")
    git(local, "checkout", "-q", "-b", "feature")
    assert "follow main" in up.status()["message"]
    with pytest.raises(server.UpdateError, match="Not on main"):
        up.apply()
    git(local, "checkout", "-q", "main")
    up.state = "building"
    with pytest.raises(server.UpdateError, match="already in progress"):
        up.apply()


def test_an_unreachable_remote_names_the_token(repos):
    _, local = repos
    git(local, "remote", "set-url", "origin", str(local.parent / "missing.git"))
    status = FakeDocker(local).status()
    assert not status["available"] and "STUDIO_GIT_TOKEN" in status["message"]


@pytest.fixture
def sidecar(repos):
    upstream, local = repos
    up = FakeDocker(local, running=git(local, "rev-parse", "HEAD"))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.handler(up))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield upstream, up, f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()


def test_the_studio_forwards_to_the_updater(sidecar, settings, store):
    upstream, up, url = sidecar
    new = commit(upstream, "studio/y.py")
    git(upstream, "push", "-q", "origin", "main")
    busy = [1]
    remote = RemoteUpdater(url, lambda: busy[0])
    with TestClient(create_app(settings, models=store, pipelines={}, llm=FakeLlm(), updater=remote)) as client:
        status = client.get("/api/update/status").json()
        assert status["mode"] == "docker" and status["available"] and status["remote"] == new
        assert client.post("/api/update/apply").status_code == 403
        # The studio checks its own queue before asking the updater.
        refused = client.post("/api/update/apply", headers=SAME_ORIGIN)
        assert refused.status_code == 409 and "1 job" in refused.json()["detail"]
        busy[0] = 0
        assert client.post("/api/update/apply", headers=SAME_ORIGIN).json()["to"] == new
        wait_idle(up)
        again = client.post("/api/update/apply", headers=SAME_ORIGIN).json()
        assert again["updated"] is False


def test_busy_and_hold_talk_to_the_studio(settings, store):
    """The real busy() and hold() against a studio served over HTTP: downloads count as
    work, and a held studio refuses new jobs until the hold is lifted."""
    import uvicorn

    from .test_api import Echo
    app = create_app(settings, models=store, pipelines={"echo": Echo()}, llm=FakeLlm())
    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    web = uvicorn.Server(config)
    thread = threading.Thread(target=web.run, daemon=True)
    thread.start()
    while not web.started:
        time.sleep(0.01)
    port = web.servers[0].sockets[0].getsockname()[1]
    try:
        up = server.Updater(Path("."), "main", "studio", f"http://127.0.0.1:{port}", token="")
        assert up.busy() == 0
        up.hold(60)
        base = f"http://127.0.0.1:{port}"
        job = {"pipeline": "echo", "params": {"prompt": "x"}}
        refused = httpx.post(base + "/api/jobs", json=job)
        assert refused.status_code == 503 and "update" in refused.json()["detail"]
        assert httpx.get(base + "/api/health").json()["held"] is True
        # Without the studio's own Origin, the hold is refused like any cross-site write.
        assert httpx.post(base + "/api/update/hold", json={"seconds": 0}).status_code == 403
        up.hold(0)
        assert httpx.post(base + "/api/jobs", json=job).status_code == 201
    finally:
        web.should_exit = True
        thread.join(5)


def test_an_absent_updater_is_reported():
    remote = RemoteUpdater("http://127.0.0.1:9", lambda: 0)
    status = remote.status()
    assert status["mode"] == "none" and "docker compose up -d" in status["message"]
    with pytest.raises(UpdateError, match="does not answer"):
        remote.apply()
