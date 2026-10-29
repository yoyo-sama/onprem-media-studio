"""In-app update for an installation that is a git checkout (bare metal).

Port of the 1.4 `updater` service: the status compares the local commit with the
remote branch (no fetch, cached for a minute); applying refuses a dirty tree, a
branch other than the update branch and running jobs, then fast-forwards. The
server then restarts itself in place (same process id, so systemd or a terminal
keeps it), unless the update changed the dependencies: the install script must
then run again, and the answer says so.

A Docker image is not a git checkout: it is updated by rebuilding the image.
"""

import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

STATUS_TTL = 60
# A change under these paths needs the install script, not just a restart.
REINSTALL_PATHS = ("pyproject.toml", "docker/", "scripts/install.sh")
DOCKER_HINT = ("This installation is not a git checkout (Docker image): update the repository with git pull, "
               "then rebuild with docker compose up -d --build.")


class UpdateError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def restart_in_place() -> None:
    """Replace this process with a fresh `python -m studio` (same arguments)."""
    sys.stdout.flush()
    sys.stderr.flush()
    os.execv(sys.executable, [sys.executable, *sys.orig_argv[1:]])


class Updater:
    def __init__(self, repo: Path, branch: str, busy: Callable[[], int],
                 before_restart: Callable[[], None] = lambda: None,
                 restart: Callable[[], None] = restart_in_place, restart_delay: float = 1.0):
        self.repo, self.branch, self.busy = repo, branch, busy
        self.before_restart, self.restart, self.restart_delay = before_restart, restart, restart_delay
        self._cache: tuple[float, dict | None] = (0.0, None)
        self._lock = threading.Lock()

    def git(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, timeout=60)

    def is_checkout(self) -> bool:
        try:
            return (self.repo / ".git").exists() and self.git("rev-parse", "HEAD").returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False  # no git on this machine

    def status(self) -> dict:
        cached_at, cached = self._cache
        if cached is not None and time.time() - cached_at < STATUS_TTL:
            return cached
        if not self.is_checkout():
            return {"mode": "none", "available": False, "message": DOCKER_HINT}
        local = self.git("rev-parse", "HEAD").stdout.strip()
        branch = self.git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        out = {"mode": "git", "branch": branch, "local": local, "remote": None, "available": False, "message": None}
        if branch != self.branch:
            out["message"] = f"On branch {branch}: in-app updates follow {self.branch}."
            return out
        remote = self.git("ls-remote", "origin", f"refs/heads/{self.branch}")
        if remote.returncode != 0 or not remote.stdout.strip():
            out["message"] = f"Cannot reach the remote repository: {remote.stderr.strip()[:300]}"
            return out
        out["remote"] = remote.stdout.split()[0]
        # A remote commit already in our history means nothing to pull (local is ahead or equal);
        # one unknown here means the remote moved on.
        out["available"] = self.git("merge-base", "--is-ancestor", out["remote"], "HEAD").returncode != 0
        self._cache = (time.time(), out)
        return out

    def apply(self) -> dict:
        with self._lock:
            if not self.is_checkout():
                raise UpdateError(409, DOCKER_HINT)
            if self.git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() != self.branch:
                raise UpdateError(409, f"Not on {self.branch}: update by hand")
            if self.git("status", "--porcelain", "--untracked-files=no").stdout.strip():
                raise UpdateError(409, "Local changes in the installation folder: update by hand")
            busy = self.busy()
            if busy:
                raise UpdateError(409, f"{busy} job(s) queued or running: wait for them or cancel them, "
                                       "the server restarts after an update")
            before = self.git("rev-parse", "HEAD").stdout.strip()
            pulled = self.git("pull", "--ff-only", "origin", self.branch)
            if pulled.returncode != 0:
                raise UpdateError(502, f"git pull failed: {pulled.stderr.strip()[:500]}")
            after = self.git("rev-parse", "HEAD").stdout.strip()
            self._cache = (0.0, None)
            changed = self.git("diff", "--name-only", before, after).stdout.split()
            reinstall = any(p.startswith(r) for p in changed for r in REINSTALL_PATHS)
            out = {"updated": before != after, "from": before, "to": after, "reinstall": reinstall,
                   "restarting": before != after and not reinstall}
            if reinstall:
                out["message"] = ("Dependencies changed: run scripts/install.sh again in the installation folder, "
                                  "it restarts the service when done.")
            if out["restarting"]:
                threading.Timer(self.restart_delay, self._restart).start()
            return out

    def _restart(self) -> None:
        self.before_restart()
        self.restart()


def router(updater: Updater):
    from fastapi import APIRouter, Depends
    from fastapi.responses import JSONResponse

    from .guard import same_origin

    api = APIRouter(prefix="/api/update")

    @api.get("/status")
    def status():
        return updater.status()

    @api.post("/apply", dependencies=[Depends(same_origin)])
    def apply():
        try:
            return updater.apply()
        except UpdateError as exc:
            return JSONResponse({"detail": exc.detail}, status_code=exc.status)

    return api
