"""scripts/docker-install.sh without Docker or a GPU: fake docker, curl and ss record their
calls and answer what each test sets, and the script's functions are called through bash."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "docker-install.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash not installed")

FAKE_DOCKER = """#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1 $2" in
  "info --format") [ -n "$FAKE_INFO_ERR" ] && { echo "$FAKE_INFO_ERR" >&2; exit 1; }; echo 28.5.1 ;;
  "compose version") [ -n "$FAKE_NO_COMPOSE" ] && exit 1; echo 2.40.0 ;;
  "compose --project-directory") echo "$FAKE_RUNNING" ;;
  "compose build") echo "STUDIO_COMMIT=$STUDIO_COMMIT" >> "$FAKE_LOG" ;;
  "run --rm") [ -n "$FAKE_NO_GPU" ] && { echo "could not select device driver" >&2; exit 125; }
              echo "GPU 0: NVIDIA GB10 (UUID: GPU-1)" ;;
esac
exit 0
"""

FAKE_CURL = """#!/bin/sh
echo "curl $*" >> "$FAKE_LOG"
case "$*" in
  *api/update/hold*) [ -n "$FAKE_HOLD" ] || exit 7; echo "$FAKE_HOLD" ;;
  *api/health*) [ -n "$FAKE_HEALTH" ] || exit 7; echo "$FAKE_HEALTH" ;;
esac
"""

FAKE_SS = """#!/bin/sh
[ -n "$FAKE_PORT_TAKEN" ] && echo "LISTEN 0 4096 0.0.0.0:8090 0.0.0.0:*"
exit 0
"""


@pytest.fixture
def env(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("docker", FAKE_DOCKER), ("curl", FAKE_CURL), ("ss", FAKE_SS)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    (bin_dir / "sleep").write_text("#!/bin/sh\nexit 0\n")
    (bin_dir / "sleep").chmod(0o755)
    repo = tmp_path / "repo"
    (repo / "docker").mkdir(parents=True)
    shutil.copy(ROOT / ".env.example", repo / ".env.example")
    shutil.copy(ROOT / "docker" / "Dockerfile", repo / "docker" / "Dockerfile")
    log = tmp_path / "calls.log"
    log.touch()
    return {"tmp": tmp_path, "repo": repo, "log": log,
            "base": {"HOME": str(tmp_path / "home"), "PATH": f"{bin_dir}:/usr/bin:/bin", "FAKE_LOG": str(log)}}


def bash(env: dict, code: str, **fake) -> subprocess.CompletedProcess:
    setup = f'source "{SCRIPT}"; REPO="{env["repo"]}"; ENV_FILE="$REPO/.env"; cd "$REPO"; '
    return subprocess.run(["bash", "-c", setup + code], capture_output=True, text=True,
                          env={**env["base"], **fake})


def test_env_example_lists_every_compose_variable():
    used = set(re.findall(r"\$\{(\w+)", (ROOT / "compose.yaml").read_text())) - {"STUDIO_COMMIT"}
    listed = set(re.findall(r"^#?(\w+)=", (ROOT / ".env.example").read_text(), re.M))
    assert used == listed


def test_env_value_follows_compose_precedence(env):
    (env["repo"] / ".env").write_text('STUDIO_HOST_PORT=8091\nSTUDIO_DATA="/srv/studio"\nSTUDIO_HOST_PORT=8096\n#HF_TOKEN=x\n')
    out = bash(env, "env_value STUDIO_HOST_PORT 8090; env_value STUDIO_DATA ./data; env_value HF_TOKEN none").stdout
    assert out.split() == ["8096", "/srv/studio", "none"]
    assert bash(env, "env_value STUDIO_HOST_PORT 8090", STUDIO_HOST_PORT="9000").stdout.strip() == "9000"


@pytest.mark.parametrize("value,expected", [
    (None, "{repo}/data"), ("./models", "{repo}/models"), ("big", "{repo}/big"),
    ("/srv/studio", "/srv/studio"), ("~/studio", "{home}/studio"),
])
def test_data_dir_is_resolved_as_compose_mounts_it(env, value, expected):
    if value is not None:
        (env["repo"] / ".env").write_text(f"STUDIO_DATA={value}\n")
    out = bash(env, "data_dir").stdout.strip()
    assert out == expected.format(repo=env["repo"], home=env["base"]["HOME"])


def test_check_docker(env):
    done = bash(env, "check_docker")
    assert done.returncode == 0 and "Docker Engine 28.5.1" in done.stdout and "Docker Compose 2.40.0" in done.stdout
    denied = bash(env, "check_docker", FAKE_INFO_ERR="permission denied while trying to connect to the Docker daemon socket")
    assert denied.returncode == 1 and "usermod -aG docker" in denied.stderr
    assert "docker compose' plugin" in bash(env, "check_docker", FAKE_NO_COMPOSE="1").stderr


def test_check_gpu_runs_nvidia_smi_in_the_base_image(env):
    done = bash(env, "check_gpu")
    assert done.returncode == 0 and "GPU 0: NVIDIA GB10" in done.stdout
    assert "--gpus all --entrypoint nvidia-smi nvcr.io/nvidia/pytorch:25.11-py3 -L" in env["log"].read_text()
    failed = bash(env, "check_gpu", FAKE_NO_GPU="1")
    assert failed.returncode == 1 and "NVIDIA Container Toolkit" in failed.stderr


def test_a_taken_port_is_refused_before_the_build(env):
    assert "port 8090 is free" in bash(env, "check_port").stdout
    taken = bash(env, "check_port", FAKE_PORT_TAKEN="1")
    assert taken.returncode == 1 and "STUDIO_HOST_PORT=8096" in taken.stderr
    (env["repo"] / ".env").write_text("STUDIO_HOST_PORT=80a\n")
    assert "must be a number" in bash(env, "check_port").stderr


def test_a_running_studio_with_jobs_is_never_recreated(env):
    busy = bash(env, "check_port", FAKE_RUNNING="abc123", FAKE_HEALTH='{"queue":1,"downloads":0,"held":false}')
    assert busy.returncode == 1 and "1 job(s) or download(s) in progress" in busy.stderr
    idle = bash(env, 'check_port; echo "RUNNING=$RUNNING"', FAKE_RUNNING="abc123",
                FAKE_HEALTH='{"queue":0,"downloads":0,"held":false}')
    assert idle.returncode == 0 and "RUNNING=1" in idle.stdout


def test_env_file_is_created_once_and_private(env):
    assert "created from .env.example" in bash(env, "write_env_file").stdout
    path = env["repo"] / ".env"
    assert path.stat().st_mode & 0o077 == 0 and "HF_TOKEN=" in path.read_text()
    path.write_text("HF_TOKEN=hf_x\n")
    path.chmod(0o644)
    kept = bash(env, "write_env_file").stdout
    assert "kept as is" in kept and "chmod 600 .env" in kept and path.read_text() == "HF_TOKEN=hf_x\n"


def test_start_builds_then_restarts_an_idle_studio(env):
    done = bash(env, "RUNNING=1; PORT=8090; start", FAKE_HOLD='{"held":true,"queue":0}', FAKE_HEALTH='{"queue":0}')
    assert done.returncode == 0 and "running: http://localhost:8090" in done.stdout
    calls = env["log"].read_text()
    assert calls.index("docker compose build") < calls.index("api/update/hold") < calls.index("docker compose up -d")
    assert "Origin: http://localhost:8090" in calls and '{"seconds": 120}' in calls


def test_start_stops_when_a_job_began_during_the_build(env):
    done = bash(env, "RUNNING=1; PORT=8090; start", FAKE_HOLD='{"held":true,"queue":2}')
    assert done.returncode == 1 and "2 job(s) started meanwhile" in done.stderr
    calls = env["log"].read_text()
    assert "docker compose up" not in calls and '{"seconds": 0}' in calls


def test_first_start_passes_the_commit_to_the_build(env):
    subprocess.run(["git", "init", "-q", str(env["repo"])], check=True)
    subprocess.run(["git", "-C", str(env["repo"]), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
                    "--allow-empty", "-m", "x"], check=True)
    head = subprocess.run(["git", "-C", str(env["repo"]), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    done = bash(env, "PORT=8090; start", FAKE_HEALTH='{"queue":0}')
    assert done.returncode == 0
    calls = env["log"].read_text()
    assert f"STUDIO_COMMIT={head}" in calls and "api/update/hold" not in calls


def test_options():
    run = lambda *a: subprocess.run(["bash", "-c", f'source "{SCRIPT}"; parse_args {" ".join(a)}; echo $CHECK_ONLY'],
                                    capture_output=True, text=True)
    assert run("--check").stdout.strip() == "1"
    assert run("--nope").returncode == 1
