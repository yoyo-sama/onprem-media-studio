#!/usr/bin/env bash
# Docker install (and reinstall) of the studio on DGX OS (GB10) or Ubuntu with an NVIDIA GPU.
# Run from the repository, as a user who can run docker:
#
#   scripts/docker-install.sh            # check, create .env and the data folder, build, start
#   scripts/docker-install.sh --check    # only check the machine; changes nothing
#
# Idempotent: an existing .env is never changed, and when the studio already runs the script
# refuses to recreate its container while a job runs or a model downloads (the restart would
# kill it). The bare-metal install is scripts/install.sh.
set -euo pipefail

SERVICE=studio
MIN_FREE_GB=300   # all models, as the README says
HEALTH_WAIT=120   # seconds for /api/health after the start

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO/.env"
CHECK_ONLY=0
RUNNING=0
PORT=8090

section() { printf '\n=== %s ===\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: scripts/docker-install.sh [--check]

  --check   check Docker, GPU access from a container, port and disk, and stop. The GPU check
            pulls the base image of docker/Dockerfile, which the build needs anyway.

Settings (port, data folder, tokens) live in .env, created from .env.example on the first run.
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) CHECK_ONLY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
  done
}

# ── Settings, read as docker compose reads them ──────────────────────────────

# env_value KEY DEFAULT: the shell's value first, then the last KEY= line of .env, then DEFAULT
# (docker compose gives the shell precedence over .env too).
env_value() {
  local key="$1" default="$2" value=""
  if [ -n "${!key:-}" ]; then
    value="${!key}"
  elif [ -f "$ENV_FILE" ]; then
    value="$(sed -n "s/^[[:space:]]*$key=//p" "$ENV_FILE" | tail -n1)"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  fi
  printf '%s\n' "${value:-$default}"
}

# The data folder as compose mounts it: relative to the repository, ~ for the home folder.
data_dir() {
  local dir
  dir="$(env_value STUDIO_DATA ./data)"
  # shellcheck disable=SC2088  # matches a literal ~ as written in .env
  case "$dir" in
    "~") dir="$HOME" ;;
    "~/"*) dir="$HOME/${dir#\~/}" ;;
    /*) ;;
    *) dir="$REPO/${dir#./}" ;;
  esac
  printf '%s\n' "$dir"
}

# ── Checks ───────────────────────────────────────────────────────────────────

check_docker() {
  section "Docker"
  command -v docker >/dev/null 2>&1 \
    || die "docker not found: install Docker Engine and the NVIDIA Container Toolkit (DGX OS ships both)."
  local err
  if ! err="$(docker info --format '{{.ServerVersion}}' 2>&1)"; then
    case "$err" in
      *"permission denied"*)
        die "$(id -un) cannot use docker: run 'sudo usermod -aG docker $(id -un)', log out and back in, then run this script again." ;;
      *) die "the Docker daemon does not answer: $err" ;;
    esac
  fi
  info "Docker Engine $err"
  local compose
  compose="$(docker compose version --short 2>/dev/null)" \
    || die "the 'docker compose' plugin (v2) is missing: install docker-compose-plugin."
  info "Docker Compose $compose"
}

base_image() {
  sed -n 's/^ARG BASE_IMAGE=//p' "$REPO/docker/Dockerfile" | head -n1
}

check_gpu() {
  section "GPU in a container"
  local image gpus
  image="$(base_image)"
  [ -n "$image" ] || die "no BASE_IMAGE in docker/Dockerfile."
  info "nvidia-smi in $image (pulled once if missing, the build needs it anyway)"
  gpus="$(docker run --rm --gpus all --entrypoint nvidia-smi "$image" -L 2>&1)" \
    || die "no GPU in a container: install the NVIDIA Container Toolkit, then 'sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker'. Docker said: $(printf '%s' "$gpus" | tail -n 3)"
  printf '%s\n' "$gpus" | grep '^GPU' | sed 's/^/  /'
}

# Jobs queued or running plus model downloads in the running studio (the count the updater waits
# on, docker/updater/server.py); nothing when no studio answers on the port.
busy_count() {
  local json queue downloads
  json="$(cat)"
  queue="$(printf '%s' "$json" | sed -n 's/.*"queue":[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  downloads="$(printf '%s' "$json" | sed -n 's/.*"downloads":[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  [ -n "$queue$downloads" ] && printf '%s\n' "$(( ${queue:-0} + ${downloads:-0} ))"
  return 0
}

studio_busy() {  # studio_busy PORT
  curl -fsS --max-time 10 "http://localhost:$1/api/health" 2>/dev/null | busy_count || true
}

# hold_studio PORT SECONDS: the studio refuses new jobs for SECONDS (0 lifts it), as the updater
# asks before its restart. Prints the jobs still running; nothing when the studio does not answer.
hold_studio() {
  local reply
  reply="$(curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' -H "Origin: http://localhost:$1" \
    -d "{\"seconds\": $2}" "http://localhost:$1/api/update/hold" 2>/dev/null)" || return 0
  printf '%s' "$reply" | sed -n 's/.*"queue":[[:space:]]*\([0-9][0-9]*\).*/\1/p'
}

studio_running() {
  [ -n "$(docker compose --project-directory "$REPO" ps --status running -q "$SERVICE" 2>/dev/null)" ]
}

port_taken() {  # port_taken N: something listens on TCP port N
  command -v ss >/dev/null 2>&1 || return 1
  [ -n "$(ss -Hltn "sport = :$1" 2>/dev/null)" ]
}

check_port() {
  section "Studio"
  PORT="$(env_value STUDIO_HOST_PORT 8090)"
  case "$PORT" in ''|*[!0-9]*) die "STUDIO_HOST_PORT must be a number, got '$PORT'." ;; esac
  if studio_running; then
    local busy
    busy="$(studio_busy "$PORT")"
    if [ -n "$busy" ] && [ "$busy" -gt 0 ]; then
      die "the studio has $busy job(s) or download(s) in progress: recreating its container now would kill them. Run this script again once they are done."
    fi
    RUNNING=1
    info "already running on port $PORT, no job in progress: rebuilt, then restarted if still idle"
    return
  fi
  if port_taken "$PORT"; then
    die "port $PORT is already in use (AI Content Studio 1.4 uses 8090): set STUDIO_HOST_PORT=8096 in .env (or any free port), then run this script again."
  fi
  info "port $PORT is free"
}

check_disk() {
  local dir probe free_gb
  dir="$(data_dir)"
  probe="$dir"
  while [ ! -d "$probe" ]; do probe="$(dirname "$probe")"; done
  free_gb="$(df -Pk "$probe" | awk 'NR==2 {print int($4 / 1048576)}')"
  info "data folder: $dir ($free_gb GB free)"
  [ "$free_gb" -ge "$MIN_FREE_GB" ] \
    || info "WARNING: models take up to about $MIN_FREE_GB GB; $free_gb GB free there. Set STUDIO_DATA in .env to use another disk."
}

# ── Install ──────────────────────────────────────────────────────────────────

write_env_file() {
  section "Configuration (.env)"
  if [ -f "$ENV_FILE" ]; then
    info "kept as is"
    if [ -n "$(find "$ENV_FILE" -perm /077 2>/dev/null)" ]; then
      info "WARNING: .env is readable by other users and may hold tokens: chmod 600 .env"
    fi
    return
  fi
  (umask 077 && cp "$REPO/.env.example" "$ENV_FILE")
  info "created from .env.example, readable by you only"
}

make_data_dir() {
  local dir
  dir="$(data_dir)"
  # Created here so it belongs to you; Docker would create a missing one as root.
  [ -d "$dir" ] || { mkdir -p "$dir"; info "created $dir"; }
}

start() {
  section "Build and start"
  info "the first build compiles llama.cpp and the FastVideo kernels: allow time"
  local commit=""
  commit="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
  # Built first, while a running studio keeps working. The commit becomes the image's
  # studio.commit label, which the in-app update compares with the repository.
  STUDIO_COMMIT="$commit" docker compose build
  if [ "$RUNNING" = 1 ]; then
    # A job may have started during the build: hold the queue, then restart only if idle.
    local busy
    busy="$(hold_studio "$PORT" 120)"
    if [ -n "$busy" ] && [ "$busy" -gt 0 ]; then
      hold_studio "$PORT" 0 >/dev/null
      die "the image is built, but $busy job(s) started meanwhile: run this script again once they are done (the build is cached)."
    fi
  fi
  STUDIO_COMMIT="$commit" docker compose up -d
  local url="http://localhost:$PORT"
  for _ in $(seq 1 "$HEALTH_WAIT"); do
    if curl -fsS --max-time 5 "$url/api/health" >/dev/null 2>&1; then
      info "running: $url"
      return
    fi
    sleep 1
  done
  die "the studio did not answer on $url within $HEALTH_WAIT s: see 'docker compose logs $SERVICE'."
}

next_steps() {
  section "Done"
  info "Models download on first use into $(data_dir)."
  [ -n "$(env_value HF_TOKEN '')" ] \
    || info "Krea 2 needs HF_TOKEN in .env (accept its licence on Hugging Face first), then: docker compose up -d"
  [ -n "$(env_value STUDIO_GIT_TOKEN '')" ] \
    || info "In-app updates of a private repository need STUDIO_GIT_TOKEN in .env, then: docker compose up -d"
}

main() {
  parse_args "$@"
  cd "$REPO"
  check_docker
  check_port
  check_disk
  check_gpu
  if [ "$CHECK_ONLY" = 1 ]; then section "Check passed"; return; fi
  write_env_file
  make_data_dir
  start
  next_steps
}

# Sourced by the tests: define the functions only.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
