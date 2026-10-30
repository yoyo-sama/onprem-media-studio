"""scripts/install.sh without a GPU: its machine checks run against fake
nvidia-smi and nvcc, its pure functions are called through bash, and its pinned
versions must match the Docker image's."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "install.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash not installed")


def bash(code: str, env: dict | None = None, path: Path | None = None) -> subprocess.CompletedProcess:
    base = {"HOME": str(path or ROOT), "PATH": f"{path}:/usr/bin:/bin" if path else "/usr/bin:/bin"}
    return subprocess.run(["bash", "-c", f'source "{SCRIPT}"; {code}'], capture_output=True, text=True,
                          env={**base, **(env or {})})


def fake_tools(tmp_path: Path, gpu="NVIDIA GB10, 12.1, 580.95.05", nvcc="13.0") -> Path:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "nvidia-smi").write_text(f"#!/bin/sh\necho '{gpu}'\n")
    (bin_dir / "nvcc").write_text(f"#!/bin/sh\necho 'Cuda compilation tools, release {nvcc}, V{nvcc}.88'\n")
    for tool in bin_dir.iterdir():
        tool.chmod(0o755)
    python = shutil.which("python3")
    (bin_dir / "python3").symlink_to(python)
    return bin_dir


def test_pinned_versions_match_the_docker_image():
    script, dockerfile = SCRIPT.read_text(), (ROOT / "docker" / "Dockerfile").read_text()
    for name in ("LLAMA_CPP_REF", "FASTVIDEO_REF"):
        pinned = re.search(rf"^{name}=(\S+)", script, re.M).group(1)
        assert re.search(rf"^ARG {name}={re.escape(pinned)}$", dockerfile, re.M), name


def test_architectures():
    out = bash('kernel_arch 12.1; kernel_arch 9.0; kernel_arch 8.9; cmake_arch 12.1; cmake_arch 8.9').stdout.split()
    assert out == ["12.1a", "9.0a", "8.9", "121", "89"]
    assert bash("version_ge 3.12 3.11 && version_ge 3.11 3.11 && ! version_ge 3.10 3.11").returncode == 0


def test_check_accepts_a_gb10(tmp_path):
    bin_dir = fake_tools(tmp_path)
    done = bash(f'DATA_DIR="{tmp_path}/data"; check_machine', path=bin_dir)
    assert done.returncode == 0, done.stderr
    assert "GPU: NVIDIA GB10, compute capability 12.1, driver 580.95.05" in done.stdout
    assert "CUDA toolkit: 13.0" in done.stdout


@pytest.mark.parametrize("gpu,nvcc,error", [
    ("NVIDIA GB10, 12.1, 570.10", "13.0", "driver 570.10 is too old"),
    ("NVIDIA GB10, 12.1, 580.95.05", "12.8", "CUDA toolkit 12.8 found, 13.x needed"),
    ("Tesla V100, 7.0, 580.95.05", "13.0", "compute capability 7.0 is too old"),
])
def test_check_refuses_with_a_reason(tmp_path, gpu, nvcc, error):
    done = bash(f'DATA_DIR="{tmp_path}/data"; check_machine', path=fake_tools(tmp_path, gpu, nvcc))
    assert done.returncode == 1 and error in done.stderr, done.stderr


def test_check_without_a_driver(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    (empty / "python3").symlink_to(shutil.which("python3"))
    done = bash(f'DATA_DIR="{tmp_path}/data"; check_machine', path=empty)
    assert done.returncode == 1 and "nvidia-smi not found" in done.stderr


def test_service_unit(tmp_path):
    unit = bash('CUDA_HOME=/usr/local/cuda; service_unit').stdout
    assert f"WorkingDirectory={ROOT}" in unit and f"ExecStart={ROOT}/.venv/bin/python -m studio" in unit
    assert "EnvironmentFile=" in unit and "Restart=on-failure" in unit and "Environment=CUDA_HOME=/usr/local/cuda" in unit


def test_env_file_is_written_once_and_private(tmp_path):
    env = {"XDG_CONFIG_HOME": str(tmp_path / "cfg")}
    code = f'ENV_FILE="{tmp_path}/cfg/studio/studio.env"; DATA_DIR=/srv/studio; PORT=8096; write_env_file'
    assert bash(code, env).returncode == 0
    path = tmp_path / "cfg" / "studio" / "studio.env"
    text = path.read_text()
    assert "STUDIO_DATA_DIR=/srv/studio" in text and "STUDIO_PORT=8096" in text and "# HF_TOKEN=" in text
    assert path.stat().st_mode & 0o077 == 0
    path.write_text(text + "HF_TOKEN=hf_x\n")
    assert "kept as is" in bash(code, env).stdout and "HF_TOKEN=hf_x" in path.read_text()


def test_options():
    assert bash("parse_args --port 80a").returncode == 1
    assert bash("parse_args --nope").returncode == 1
    assert bash('parse_args --data /x --port 9000 --no-service --skip-system; echo "$DATA_DIR $PORT $NO_SERVICE $SKIP_SYSTEM"'
                ).stdout.strip() == "/x 9000 1 1"
