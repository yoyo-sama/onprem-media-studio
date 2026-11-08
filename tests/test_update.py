"""In-app update on a real git checkout (a bare "origin" and a clone in tmp), and
the LoRA upload route."""

import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from studio import loras
from studio.main import create_app
from studio.update import Updater

from .test_api import FakeLlm

SAME_ORIGIN = {"Origin": "http://testserver"}


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


def commit(repo, name, text="x"):
    (repo / name).parent.mkdir(parents=True, exist_ok=True)
    (repo / name).write_text(text)
    git(repo, "add", name)
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", name)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repos(tmp_path):
    origin, upstream, local = tmp_path / "origin.git", tmp_path / "upstream", tmp_path / "local"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    subprocess.run(["git", "clone", "-q", str(origin), str(upstream)], check=True, capture_output=True)
    git(upstream, "checkout", "-q", "-b", "main")
    commit(upstream, "README.md")
    git(upstream, "push", "-q", "origin", "main")
    subprocess.run(["git", "clone", "-q", str(origin), str(local)], check=True)
    return upstream, local


class Restarts:
    def __init__(self):
        self.count = 0

    def __call__(self):
        self.count += 1


def updater(local, busy=0):
    restarts = Restarts()
    return Updater(local, "main", lambda: busy, restart=restarts, restart_delay=0), restarts


def test_status_and_fast_forward_then_restart(repos):
    upstream, local = repos
    up, restarts = updater(local)
    status = up.status()
    assert status["mode"] == "git" and not status["available"]
    new = commit(upstream, "studio/x.py")
    git(upstream, "push", "-q", "origin", "main")
    up._cache = (0.0, None)
    status = up.status()
    assert status["available"] and status["remote"] == new
    result = up.apply()
    assert result == {"updated": True, "from": status["local"], "to": new, "reinstall": False, "restarting": True}
    time.sleep(0.2)
    assert restarts.count == 1 and git(local, "rev-parse", "HEAD") == new
    assert not up.status()["available"]


def test_dependency_change_asks_for_the_install_script(repos):
    upstream, local = repos
    commit(upstream, "pyproject.toml")
    git(upstream, "push", "-q", "origin", "main")
    up, restarts = updater(local)
    result = up.apply()
    assert result["reinstall"] and not result["restarting"] and "install.sh" in result["message"]
    time.sleep(0.1)
    assert restarts.count == 0


def test_apply_refuses_busy_dirty_or_other_branch(repos):
    upstream, local = repos
    commit(upstream, "a.txt")
    git(upstream, "push", "-q", "origin", "main")
    up, _ = updater(local, busy=2)
    with pytest.raises(Exception, match="2 job"):
        up.apply()
    up, _ = updater(local)
    (local / "README.md").write_text("edited by hand")
    with pytest.raises(Exception, match="Local changes"):
        up.apply()
    git(local, "checkout", "-q", "README.md")
    git(local, "checkout", "-q", "-b", "feature")
    assert "follow main" in up.status()["message"]
    with pytest.raises(Exception, match="Not on main"):
        up.apply()


def test_a_docker_image_is_not_updated_in_place(tmp_path):
    up, _ = updater(tmp_path)
    assert up.status()["mode"] == "none" and "docker compose" in up.status()["message"]


@pytest.fixture
def client(settings, store, tmp_path):
    up, _ = updater(tmp_path)
    with TestClient(create_app(settings, models=store, pipelines={}, llm=FakeLlm(), updater=up)) as c:
        yield c


def test_update_routes(client):
    assert client.get("/api/update/status").json()["mode"] == "none"
    assert client.post("/api/update/apply").status_code == 403  # a cross-site form could not trigger it
    assert client.post("/api/update/apply", headers=SAME_ORIGIN).status_code == 409


def test_lora_upload(client, settings):
    assert client.get("/api/loras").json() == {"h3": [], "krea2": [], "moss": [], "qwen21": []}
    url = "/api/loras/h3?name=style.safetensors"
    assert client.post(url, content=b"weights").status_code == 403
    assert client.post(url, content=b"weights", headers=SAME_ORIGIN).json() == {"folder": "h3", "name": "style.safetensors",
                                                                                "size": 7}
    assert client.post(url, content=b"other", headers=SAME_ORIGIN).status_code == 409
    assert (settings.loras_dir / "h3" / "style.safetensors").read_bytes() == b"weights"
    for name in ("../x.safetensors", "x.bin", ".hidden.safetensors", ".safetensors"):
        assert client.post(f"/api/loras/h3?name={name}", content=b"w", headers=SAME_ORIGIN).status_code == 422, name
    assert client.post("/api/loras/ltx?name=x.safetensors", content=b"w", headers=SAME_ORIGIN).status_code == 404
    # A name with an engine prefix only goes to that engine's folder.
    resp = client.post("/api/loras/h3?name=krea_2_Unlocked.safetensors", content=b"w", headers=SAME_ORIGIN)
    assert resp.status_code == 422 and "loras/krea2/" in resp.json()["detail"]
    assert client.post("/api/loras/krea2?name=krea_2_Unlocked.safetensors", content=b"w",
                       headers=SAME_ORIGIN).status_code == 201
    assert client.get("/api/loras").json()["h3"] == [{"name": "style.safetensors", "size": 7}]
    assert client.get("/api/loras").json()["krea2"] == [{"name": "krea_2_Unlocked.safetensors", "size": 1}]
    assert [p.name for p in (settings.loras_dir / "h3").iterdir()] == ["style.safetensors"]  # no .part left


@pytest.mark.parametrize("name, folder", [
    ("H3_neon.safetensors", "h3"), ("h3_neon.safetensors", "h3"), ("Qwen_2.1-Unchained-V1.safetensors", "qwen21"),
    ("Qwen_2.1_Unlocked_V1.safetensors", "qwen21"), ("krea_2_Unlocked_V3.safetensors", "krea2"),
    ("Moss_gouache.safetensors", "moss"), ("retroanime.safetensors", None), ("Qwen_2.0_old.safetensors", None),
    ("H3neon.safetensors", None)])
def test_lora_folder_from_its_name(name, folder):
    assert loras.folder_for(name) == folder
