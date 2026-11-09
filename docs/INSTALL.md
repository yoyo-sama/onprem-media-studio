# Bare-metal install (DGX OS and Ubuntu)

French version: [fr/INSTALL.md](fr/INSTALL.md).

`scripts/install.sh` installs the studio without Docker, as a systemd service, on DGX OS (GB10,
ARM64) or Ubuntu 22.04/24.04 (ARM64 or x86_64) with an NVIDIA GPU. Docker stays the way to test on
the GB10 (README); bare metal is the way to run it for good. Both update from the interface.

## Requirements

| What | Needed | Checked by |
|---|---|---|
| NVIDIA driver | 580 or later (CUDA 13.0) | `nvidia-smi` |
| CUDA toolkit | 13.x, with `nvcc` (DGX OS ships it in `/usr/local/cuda`) | `nvcc --version` |
| GPU | compute capability 8.0 or later; qualified on GB10 (12.1) only | `nvidia-smi` |
| Python | 3.11 or later (DGX OS 7 and Ubuntu 24.04: 3.12) | `python3` |
| Disk | about 300 GB for all models, in the data folder | `df` |
| Network | PyPI, GitHub, Hugging Face | — |
| sudo | for apt packages and the service | — |

## Install

```bash
git clone https://github.com/yoyo-sama/onprem-media-studio.git
cd onprem-media-studio
scripts/install.sh --check     # optional: checks the machine, changes nothing
scripts/install.sh             # the first run compiles llama.cpp and the FastVideo kernels: allow time
```

Options: `--data DIR` (models and renders, default `~/.local/share/studio`), `--port N`
(default 8090), `--skip-system` (apt packages already installed), `--no-service` (build only,
start by hand). The data folder and port are written once to `~/.config/studio/studio.env`; later
runs keep that file as it is.

For Krea 2 (gated on Hugging Face): accept its licence on the model page, then put the token in
`~/.config/studio/studio.env` (`HF_TOKEN=hf_...`, the file is readable by its owner only) and run
`sudo systemctl restart studio`.

## What the script does

Each step stops with a message saying what to fix; nothing is half-installed silently.

1. **Checks** the driver, the CUDA toolkit (major version 13, matching the torch build), the GPU,
   Python and the free disk space.
2. **apt packages** (only the missing ones): `git cmake ninja-build build-essential pkg-config
   ffmpeg curl python3-venv python3-dev`.
3. **Python environment** `.venv/` in the repository, with **torch 2.12.0** and torchvision 0.27.0
   from PyPI: on Linux these are the CUDA 13.0 builds, for ARM64 and x86_64, the versions
   FastVideo is pinned to. The script stops if torch does not see the GPU. Every later install is
   constrained to this torch (`.venv/studio-constraints.txt`).
4. **llama.cpp** (same release as the Docker image), `llama-server` built for this GPU's
   architecture into `.build/llama/`, behind a small wrapper that adds the CUDA toolkit's libraries
   to its own library path only.
5. **FastVideo** (same commit as the Docker image) and its kernels, built against the venv's torch
   for this GPU (`12.1a` on a GB10), installed without their dependencies; the dependencies come
   from `docker/fastvideo-requirements.txt`, as in the image.
6. **The studio package** in editable mode with its `inference` extra, then an import check.
7. **Configuration** `~/.config/studio/studio.env` (once).
8. **Service** `/etc/systemd/system/studio.service`, running as the user who ran the script, from
   the repository, enabled at boot and restarted; the script waits for `/api/health`.

A second run rebuilds only what changed (llama.cpp and FastVideo are skipped when their pinned
version and GPU architecture are already built), then restarts the service.

## Every day

```bash
systemctl status studio                 # state
journalctl -u studio -f                 # log
sudo systemctl restart studio           # after editing studio.env
curl -s localhost:8090/api/health       # app, GPU, LLM
```

## Updates

The interface offers an update when the `main` branch of the repository has new commits
(`docs/GALLERY.md` § In-app update). It refuses while jobs run, fast-forwards, then restarts the
server. When the update touched the dependencies (`pyproject.toml`, `docker/`, this script), it
asks instead to run `scripts/install.sh` again, which reinstalls and restarts the service. By
hand:

```bash
git pull --ff-only && scripts/install.sh
```

## Uninstall

```bash
sudo systemctl disable --now studio && sudo rm /etc/systemd/system/studio.service
rm -rf .venv .build ~/.config/studio      # keeps the models and renders
rm -rf ~/.local/share/studio              # models and renders, if you want them gone too
```

## Differences with the Docker image

| | Docker (`scripts/docker-install.sh`, README) | Bare metal (`scripts/install.sh`) |
|---|---|---|
| torch | NGC PyTorch 25.11 (2.10, CUDA 13.0) | PyPI 2.12.0 (CUDA 13.0), FastVideo's own version |
| CUDA toolkit | in the image | the system's (13.x) |
| Updates | from the interface: pull, image rebuild, container recreated (`updater` service) | from the interface: pull, restart in place |
| Data | `./data` (`STUDIO_DATA`) | `~/.local/share/studio` (`--data`) |

Both build llama.cpp and FastVideo at the same pinned versions (`tests/test_install.py` checks
it). Neither is qualified on the GB10 yet: renders must be inspected there first (LESSONS #1).
