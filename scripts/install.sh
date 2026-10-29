#!/usr/bin/env bash
# Bare-metal install (and reinstall) of the studio on DGX OS (GB10, ARM64) or
# Ubuntu 22.04/24.04 with an NVIDIA GPU. Run from the repository, as the user
# the service will run as (sudo is asked for apt packages and the service):
#
#   scripts/install.sh            # check, build, install, start the service
#   scripts/install.sh --check    # only check the machine; changes nothing
#
# Idempotent: running it again after an update reinstalls what changed and
# restarts the service. Everything is built inside the repository (.venv/ and
# .build/); models and renders go to the data folder.
#
# Stack (docs/INSTALL.md): torch 2.12.0 from PyPI (the CUDA 13.0 build, as
# FastVideo's own GB10 stack), llama.cpp and FastVideo built from source for
# this GPU, the studio package in the venv, a systemd service.
set -euo pipefail

# Pinned versions: keep LLAMA_CPP_REF and FASTVIDEO_REF equal to the defaults
# of docker/Dockerfile (tests/test_install.py checks it).
LLAMA_CPP_REF=b11982
FASTVIDEO_REF=7203b4976eefcd70a52728ca1281797ce96734eb
TORCH_VERSION=2.12.0
TORCHVISION_VERSION=0.27.0
MIN_PYTHON=3.11
CUDA_MAJOR=13            # torch 2.12.0 on PyPI is built for CUDA 13.0: kernels need nvcc 13
MIN_DRIVER=580           # CUDA 13.0 needs driver 580 or later
SERVICE=studio
APT_PACKAGES=(git cmake ninja-build build-essential pkg-config ffmpeg curl python3-venv python3-dev)

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$REPO/.venv"
BUILD="$REPO/.build"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/studio/studio.env"

DATA_DIR="${STUDIO_DATA_DIR:-$HOME/.local/share/studio}"
PORT=8090
CHECK_ONLY=0
SKIP_SYSTEM=0
NO_SERVICE=0

section() { printf '\n=== %s ===\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: scripts/install.sh [--check] [--data DIR] [--port N] [--skip-system] [--no-service]

  --check        check the machine (GPU, driver, CUDA, Python, disk) and stop
  --data DIR     models and renders (default: $DATA_DIR); written once to $ENV_FILE
  --port N       listening port (default: 8090); written once to $ENV_FILE
  --skip-system  do not install apt packages (they must already be installed)
  --no-service   do not install or restart the systemd service
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) CHECK_ONLY=1 ;;
      --data) [ $# -ge 2 ] || die "--data needs a folder"; DATA_DIR="$2"; shift ;;
      --port) [ $# -ge 2 ] || die "--port needs a number"; PORT="$2"; shift ;;
      --skip-system) SKIP_SYSTEM=1 ;;
      --no-service) NO_SERVICE=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
  case "$PORT" in ''|*[!0-9]*) die "--port must be a number, got '$PORT'" ;; esac
}

# ── Checks ───────────────────────────────────────────────────────────────────

# Compute capability "12.1" → kernel architecture for FastVideo ("12.1a": the
# architecture-specific features its NVFP4 and attention kernels use, from
# Hopper on) and for llama.cpp ("121").
kernel_arch() {
  local major="${1%%.*}"
  if [ "$major" -ge 9 ]; then printf '%sa\n' "$1"; else printf '%s\n' "$1"; fi
}
cmake_arch() { printf '%s\n' "${1//./}"; }

version_ge() {  # version_ge 3.12 3.11 → true
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

find_nvcc() {
  if command -v nvcc >/dev/null 2>&1; then command -v nvcc; return 0; fi
  local c
  for c in /usr/local/cuda/bin/nvcc /usr/local/cuda-*/bin/nvcc; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

check_machine() {
  section "Machine"
  [ "$(uname -s)" = Linux ] || die "Linux only (found $(uname -s))."
  ARCH="$(uname -m)"
  case "$ARCH" in aarch64|x86_64) ;; *) die "unsupported CPU architecture: $ARCH (aarch64 or x86_64)" ;; esac
  # shellcheck disable=SC1091
  info "CPU: $ARCH, $(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown system}")"

  command -v nvidia-smi >/dev/null 2>&1 \
    || die "nvidia-smi not found: install the NVIDIA driver ($MIN_DRIVER or later) first. DGX OS ships it."
  local gpu
  gpu="$(nvidia-smi --query-gpu=name,compute_cap,driver_version --format=csv,noheader 2>/dev/null | head -n1)" \
    || die "nvidia-smi could not read the GPU: check the driver with 'nvidia-smi'."
  [ -n "$gpu" ] || die "no NVIDIA GPU found by nvidia-smi."
  GPU_NAME="$(printf '%s' "$gpu" | cut -d, -f1 | xargs)"
  COMPUTE_CAP="$(printf '%s' "$gpu" | cut -d, -f2 | xargs)"
  DRIVER="$(printf '%s' "$gpu" | cut -d, -f3 | xargs)"
  info "GPU: $GPU_NAME, compute capability $COMPUTE_CAP, driver $DRIVER"
  [ "${DRIVER%%.*}" -ge "$MIN_DRIVER" ] \
    || die "driver $DRIVER is too old for CUDA $CUDA_MAJOR: install driver $MIN_DRIVER or later."
  version_ge "$COMPUTE_CAP" 8.0 || die "compute capability $COMPUTE_CAP is too old (8.0 or later)."

  NVCC="$(find_nvcc)" || die "nvcc not found: install the CUDA $CUDA_MAJOR toolkit (DGX OS ships it in /usr/local/cuda)."
  local nvcc_version
  nvcc_version="$(sed -n 's/.*release \([0-9][0-9.]*\),.*/\1/p' < <("$NVCC" --version))"
  info "CUDA toolkit: $nvcc_version ($NVCC)"
  [ "${nvcc_version%%.*}" = "$CUDA_MAJOR" ] \
    || die "CUDA toolkit $nvcc_version found, $CUDA_MAJOR.x needed (torch $TORCH_VERSION is built for CUDA $CUDA_MAJOR.0)."
  export CUDA_HOME
  CUDA_HOME="$(dirname "$(dirname "$NVCC")")"

  PYTHON="$(command -v python3 || true)"
  [ -n "$PYTHON" ] || die "python3 not found."
  local py_version
  py_version="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  version_ge "$py_version" "$MIN_PYTHON" || die "Python $py_version found, $MIN_PYTHON or later needed."
  info "Python: $py_version ($PYTHON)"

  mkdir -p "$DATA_DIR"
  local free_gb
  free_gb="$(df -Pk "$DATA_DIR" | awk 'NR==2 {print int($4 / 1048576)}')"
  info "Data folder: $DATA_DIR ($free_gb GB free)"
  [ "$free_gb" -ge 300 ] || info "WARNING: models take up to about 300 GB; $free_gb GB free in $DATA_DIR."
}

# ── System packages ──────────────────────────────────────────────────────────

missing_packages() {
  local p
  for p in "${APT_PACKAGES[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || printf '%s\n' "$p"
  done
}

install_system_packages() {
  section "System packages"
  if [ "$SKIP_SYSTEM" = 1 ]; then info "skipped (--skip-system)"; return; fi
  command -v dpkg-query >/dev/null 2>&1 || die "not a Debian/Ubuntu system: install ${APT_PACKAGES[*]} by hand, then run again with --skip-system."
  local missing
  mapfile -t missing < <(missing_packages)
  if [ "${#missing[@]}" -eq 0 ]; then info "all present"; return; fi
  info "installing: ${missing[*]}"
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends "${missing[@]}"
}

# ── Python environment ───────────────────────────────────────────────────────

pip() { "$VENV/bin/python" -m pip "$@"; }

install_torch() {
  section "Python environment ($VENV)"
  [ -x "$VENV/bin/python" ] || "$PYTHON" -m venv "$VENV"
  pip install --quiet --upgrade pip
  pip install --quiet "torch==$TORCH_VERSION" "torchvision==$TORCHVISION_VERSION"
  "$VENV/bin/python" - "$CUDA_MAJOR" <<'EOF'
import sys
import torch
cuda = torch.version.cuda or "none"
assert cuda.split(".")[0] == sys.argv[1], f"torch {torch.__version__} is built for CUDA {cuda}, not {sys.argv[1]}"
assert torch.cuda.is_available(), "torch sees no GPU (driver?)"
print(f"  torch {torch.__version__}, CUDA {cuda}, {torch.cuda.get_device_name(0)}")
EOF
  # Every later install keeps this torch: no requirement may swap it for another build.
  pip list --format=freeze | grep -iE '^(torch|torchvision|triton|pytorch-triton)==' > "$VENV/studio-constraints.txt"
  export PIP_CONSTRAINT="$VENV/studio-constraints.txt"
}

# ── llama.cpp (Gemma 4 through llama-server) ─────────────────────────────────

build_llama() {
  section "llama.cpp $LLAMA_CPP_REF"
  local arch src out stamp
  arch="$(cmake_arch "$COMPUTE_CAP")"
  src="$BUILD/llama.cpp"
  out="$BUILD/llama"
  stamp="$LLAMA_CPP_REF sm_$arch"
  if [ -x "$out/llama-server.bin" ] && [ "$(cat "$out/.stamp" 2>/dev/null)" = "$stamp" ]; then
    info "already built ($stamp)"
    return
  fi
  rm -rf "$src"
  git clone --quiet --depth 1 --branch "$LLAMA_CPP_REF" https://github.com/ggml-org/llama.cpp "$src"
  cmake -S "$src" -B "$src/build" -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$arch" \
    -DCMAKE_CUDA_COMPILER="$NVCC" -DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF \
    -DCMAKE_BUILD_TYPE=Release
  cmake --build "$src/build" --target llama-server -j "$(nproc)"
  mkdir -p "$out"
  cp "$src/build/bin/llama-server" "$out/llama-server.bin"
  # The wrapper finds the CUDA libraries of this toolkit without putting them on
  # the studio's own library path (torch brings its own).
  cat > "$out/llama-server" <<EOF
#!/bin/sh
export LD_LIBRARY_PATH="$CUDA_HOME/lib64\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$out/llama-server.bin" "\$@"
EOF
  chmod +x "$out/llama-server"
  printf '%s\n' "$stamp" > "$out/.stamp"
  rm -rf "$src"
  "$out/llama-server" --version 2>&1 | head -n 2 | sed 's/^/  /'
}

# ── FastVideo (MiniMax H3) ───────────────────────────────────────────────────

build_fastvideo() {
  section "FastVideo ${FASTVIDEO_REF:0:12}"
  local arch src wheels stamp
  arch="$(kernel_arch "$COMPUTE_CAP")"
  src="$BUILD/fastvideo"
  wheels="$BUILD/wheels"
  stamp="$FASTVIDEO_REF $arch torch-$TORCH_VERSION"
  if [ "$(cat "$wheels/.stamp" 2>/dev/null)" = "$stamp" ] && "$VENV/bin/python" -c "import fastvideo, fastvideo_kernel" 2>/dev/null; then
    info "already built ($stamp)"
    return
  fi
  rm -rf "$src" "$wheels"
  git clone --quiet https://github.com/hao-ai-lab/FastVideo "$src"
  git -C "$src" checkout --quiet "$FASTVIDEO_REF"
  git -C "$src" submodule update --quiet --init --recursive fastvideo-kernel/include/cutlass fastvideo-kernel/include/tk
  pip install --quiet scikit-build-core cmake ninja setuptools wheel
  # Kernels are compiled against the venv's torch (no build isolation), for this GPU only.
  (cd "$src" && PATH="$CUDA_HOME/bin:$PATH" TORCH_CUDA_ARCH_LIST="$arch" MAX_JOBS="${MAX_JOBS:-4}" \
    "$VENV/bin/python" -m pip wheel --no-build-isolation --no-deps -w "$wheels" ./fastvideo-kernel .)
  # FastVideo pins torch==2.12.0 like us, but its other pins (tokenizers) clash with
  # transformers: installed without dependencies, docker/fastvideo-requirements.txt lists them.
  pip install --quiet --no-deps --force-reinstall "$wheels"/*.whl
  printf '%s\n' "$stamp" > "$wheels/.stamp"
  rm -rf "$src"
}

install_studio() {
  section "Studio package"
  pip install --quiet -r "$REPO/docker/fastvideo-requirements.txt"
  pip install --quiet -e "${REPO}[inference]"
  "$VENV/bin/python" -c "import diffusers, fastvideo, studio.main; print('  imports OK (diffusers', diffusers.__version__ + ')')"
}

# ── Configuration and service ────────────────────────────────────────────────

write_env_file() {
  section "Configuration ($ENV_FILE)"
  if [ -f "$ENV_FILE" ]; then
    info "kept as is (edit it by hand; --data and --port only apply to a new file)"
    return
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  umask 077  # it will hold HF_TOKEN
  cat > "$ENV_FILE" <<EOF
# Read by the $SERVICE service (systemd EnvironmentFile). Restart after a change:
#   sudo systemctl restart $SERVICE
STUDIO_DATA_DIR=$DATA_DIR
STUDIO_PORT=$PORT
STUDIO_LLAMA_SERVER=$BUILD/llama/llama-server
# Gated models (Krea 2): accept the licence on Hugging Face, then put your token here.
# HF_TOKEN=hf_...
EOF
  umask 022
  info "written"
}

service_unit() {
  cat <<EOF
[Unit]
Description=Local AI image and video studio ($REPO)
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=$REPO
EnvironmentFile=$ENV_FILE
Environment=PYTHONUNBUFFERED=1
Environment=CUDA_HOME=$CUDA_HOME
Environment=PATH=$CUDA_HOME/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$VENV/bin/python -m studio
Restart=on-failure
RestartSec=5
# A render can hold the GPU for minutes: let it be cancelled, not killed at once.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
}

install_service() {
  section "Service $SERVICE"
  if [ "$NO_SERVICE" = 1 ]; then
    info "skipped (--no-service). Run by hand: set -a; . $ENV_FILE; set +a; $VENV/bin/python -m studio"
    return
  fi
  command -v systemctl >/dev/null 2>&1 || die "systemd not found: run with --no-service and start the studio by hand."
  service_unit | sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet "$SERVICE"
  sudo systemctl restart "$SERVICE"
  local port url
  port="$(sed -n 's/^STUDIO_PORT=//p' "$ENV_FILE" | tail -n1)"
  url="http://localhost:${port:-8090}"
  for _ in $(seq 1 60); do
    if curl -fsS "$url/api/health" >/dev/null 2>&1; then
      info "running: $url"
      return
    fi
    sleep 1
  done
  die "the service did not answer on $url within 60 s: see 'journalctl -u $SERVICE -n 50'."
}

main() {
  parse_args "$@"
  check_machine
  if [ "$CHECK_ONLY" = 1 ]; then section "Check passed"; return; fi
  install_system_packages
  install_torch
  mkdir -p "$BUILD"
  build_llama
  build_fastvideo
  install_studio
  write_env_file
  install_service
  section "Done"
  info "Models download on first use into $DATA_DIR (Krea 2 needs HF_TOKEN in $ENV_FILE)."
}

# Sourced by the tests: define the functions only.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
