"""In-app update of the Docker installation (the `updater` service of compose.yaml).

The studio container holds no git checkout and cannot rebuild its own image, so
this small service does it next to it: the repository is mounted at /repo and
the Docker socket lets it run `docker compose` on the host. It is reached by the
studio container only (no published port), which forwards `/api/update/*` here
and checks the job queue first.

- `GET /status` compares HEAD with the remote branch (`git ls-remote`, no fetch,
  cached a minute), and HEAD with the commit the running studio image was built
  from (image label `studio.commit`): a rebuild left undone is offered too.
- `POST /apply` refuses another branch and local changes, fast-forwards, then in
  the background: builds the image (the studio keeps working meanwhile), waits
  until no job is queued or running, recreates the studio container, and removes
  the previous image once nothing uses it.

git runs as the owner of the repository, never as root (a root-owned object in
.git breaks the user's own git). Python standard library only.
"""

import collections
import json
import os
import socket
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(os.environ.get("UPDATER_REPO", "/repo"))
BRANCH = os.environ.get("UPDATER_BRANCH") or "main"
SERVICE = os.environ.get("UPDATER_SERVICE", "studio")
STUDIO_URL = os.environ.get("UPDATER_STUDIO_URL", "http://studio:8090")
PORT = int(os.environ.get("UPDATER_PORT", "8091"))
STATUS_TTL = 60
JOB_POLL = 10  # seconds between two looks at the studio's queue before the restart
LABEL = "studio.commit"
TOKEN_HINT = ("If the repository is private, put a GitHub token that can read it in .env "
              "(STUDIO_GIT_TOKEN=...), then run docker compose up -d once.")


class UpdateError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=kw.pop("timeout", 120), **kw)


class Updater:
    def __init__(self, repo: Path = REPO, branch: str = BRANCH, service: str = SERVICE,
                 studio_url: str = STUDIO_URL, token: str | None = None):
        self.repo, self.branch, self.service, self.studio_url = repo, branch, service, studio_url
        self.token = token if token is not None else os.environ.get("UPDATER_GIT_TOKEN", "")
        self._cache: tuple[float, dict | None] = (0.0, None)
        self._lock = threading.Lock()
        self.state, self.error, self.target = "idle", None, None
        self.log: collections.deque[str] = collections.deque(maxlen=200)

    # ── git, as the owner of the repository ──────────────────────────────────
    def git(self, *args: str, network: bool = False) -> subprocess.CompletedProcess:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/tmp", "GIT_TERMINAL_PROMPT": "0"}
        pre: list[str] = []
        if network and self.token:
            # The token goes through the environment, never on a command line.
            env["UPDATER_GIT_TOKEN"] = self.token
            pre = ["-c", "credential.helper=",
                   "-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$UPDATER_GIT_TOKEN"; }; f']
        owner = self.repo.stat()
        as_owner = {}
        if os.geteuid() == 0 and owner.st_uid != 0:
            as_owner = {"user": owner.st_uid, "group": owner.st_gid, "extra_groups": []}
        return run(["git", "-C", str(self.repo), *pre, *args], env=env, **as_owner)

    def head(self) -> str:
        return self.git("rev-parse", "HEAD").stdout.strip()

    # ── docker ───────────────────────────────────────────────────────────────
    def docker(self, *args: str, timeout: float = 120) -> subprocess.CompletedProcess:
        return run(["docker", *args], timeout=timeout)

    def compose_args(self) -> list[str]:
        """`docker compose` options naming the project this container belongs to.

        Compose resolves the relative paths of compose.yaml (the data volume) against
        the project folder and hands them to the host's daemon, so it must see the
        repository at its host path: a symbolic link from that path to /repo gives
        the same configuration as a `docker compose` run on the host."""
        info = self.docker("inspect", "--format", "{{json .Config.Labels}}", socket.gethostname())
        if info.returncode != 0:
            raise UpdateError(500, f"Cannot inspect the updater container: {info.stderr.strip()[:300]}")
        labels = json.loads(info.stdout)
        project = labels.get("com.docker.compose.project")
        workdir = labels.get("com.docker.compose.project.working_dir")
        files = labels.get("com.docker.compose.project.config_files", "")
        if not project or not workdir:
            raise UpdateError(500, "The updater was not started by docker compose")
        host = Path(workdir)
        if host != self.repo:
            if not host.exists() and not host.is_symlink():
                host.parent.mkdir(parents=True, exist_ok=True)
                host.symlink_to(self.repo)
            if host.resolve() != self.repo.resolve():
                raise UpdateError(500, f"{workdir} exists inside the updater container: cannot map it to /repo")
        out = ["compose", "--progress", "plain", "-p", project, "--project-directory", workdir]
        for f in filter(None, files.split(",")):
            out += ["-f", f]
        return out

    def studio_container(self) -> dict | None:
        """Id, image and source commit of the running studio container, if any."""
        try:
            args = self.compose_args()
        except UpdateError:
            return None
        found = self.docker(*args, "ps", "-q", self.service)
        cid = found.stdout.strip().splitlines()[:1]
        if found.returncode != 0 or not cid:
            return None
        info = self.docker("inspect", "--format",
                           '{{.Image}} {{index .Config.Labels "' + LABEL + '"}}', cid[0])
        image, _, commit = info.stdout.strip().partition(" ")
        return {"id": cid[0], "image": image, "commit": commit or None}

    # ── status ───────────────────────────────────────────────────────────────
    def status(self) -> dict:
        out = {"mode": "docker", "state": self.state, "log": list(self.log)[-15:], "error": self.error,
               "target": self.target}
        if self.state != "idle":
            return out | {"available": False, "message": None}
        cached_at, cached = self._cache
        if cached is not None and time.time() - cached_at < STATUS_TTL:
            return out | cached
        if not (self.repo / ".git").exists():
            return out | {"available": False, "message": "The updater does not see the repository: "
                                                         "start it with docker compose from the clone"}
        local, branch = self.head(), self.git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        running = (self.studio_container() or {}).get("commit")
        info = {"branch": branch, "local": local, "remote": None, "running": running,
                "available": False, "message": None}
        if branch != self.branch:
            return out | info | {"message": f"On branch {branch}: in-app updates follow {self.branch}."}
        remote = self.git("ls-remote", "origin", f"refs/heads/{self.branch}", network=True)
        if remote.returncode != 0 or not remote.stdout.strip():
            return out | info | {"message": f"Cannot reach the remote repository: {remote.stderr.strip()[:300]} "
                                            + TOKEN_HINT}
        info["remote"] = remote.stdout.split()[0]
        # A remote commit already in our history means nothing to pull; one unknown here
        # means the remote moved on. A running image built from another commit than HEAD
        # (a pull without rebuild, a failed build) is offered too.
        moved = self.git("merge-base", "--is-ancestor", info["remote"], "HEAD").returncode != 0
        info["available"] = moved or (running is not None and running != local)
        if not moved and info["available"]:
            info["message"] = (f"The running image was built from {running[:7]}, the repository is at "
                               f"{local[:7]}: the update rebuilds it.")
        self._cache = (time.time(), info)
        return out | info

    # ── apply ────────────────────────────────────────────────────────────────
    def apply(self) -> dict:
        with self._lock:
            if self.state != "idle":
                raise UpdateError(409, "An update is already in progress")
            if self.git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() != self.branch:
                raise UpdateError(409, f"Not on {self.branch}: update by hand")
            if self.git("status", "--porcelain", "--untracked-files=no").stdout.strip():
                raise UpdateError(409, "Local changes in the repository folder: update by hand")
            args = self.compose_args()
            container = self.studio_container()
            before = self.head()
            pulled = self.git("pull", "--ff-only", "origin", self.branch, network=True)
            if pulled.returncode != 0:
                raise UpdateError(502, f"git pull failed: {pulled.stderr.strip()[:500]} " + TOKEN_HINT)
            after = self.head()
            self._cache = (0.0, None)
            running = (container or {}).get("commit")
            if before == after and (running is None or running == after):
                return {"updated": False, "from": before, "to": after, "rebuilding": False}
            self.state, self.error, self.target = "building", None, after
            self.log.clear()
            threading.Thread(target=self._rebuild, args=(args, after, container), daemon=True).start()
            return {"updated": True, "from": running or before, "to": after, "rebuilding": True}

    def _say(self, line: str) -> None:
        line = line.rstrip()
        if line:
            self.log.append(line)
            print(line, flush=True)

    def _compose(self, args: list[str], *cmd: str, commit: str) -> int:
        env = {k: v for k, v in os.environ.items() if not k.startswith("UPDATER_")}
        env["STUDIO_COMMIT"] = commit  # the build argument that becomes the studio.commit label
        proc = subprocess.Popen(["docker", *args, *cmd], cwd=str(self.repo), env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for line in proc.stdout:
            self._say(line)
        return proc.wait()

    def busy(self) -> int | None:
        """Jobs queued or running in the studio, None when it does not answer."""
        try:
            with urllib.request.urlopen(self.studio_url + "/api/health", timeout=10) as r:
                return int(json.load(r).get("queue", 0))
        except (OSError, ValueError):
            return None

    def _rebuild(self, args: list[str], commit: str, old: dict | None) -> None:
        try:
            self._say(f"Building the {self.service} image at {commit[:7]}")
            code = self._compose(args, "build", self.service, commit=commit)
            if code != 0:
                raise UpdateError(500, f"The image build failed (exit {code}); the studio keeps running "
                                       "the previous version. Details: docker compose logs updater")
            self.state = "waiting"
            while (n := self.busy()):
                self._say(f"Waiting for {n} job(s) to finish before restarting the studio")
                time.sleep(JOB_POLL)
            self.state = "restarting"
            self._say("Restarting the studio")
            code = self._compose(args, "up", "-d", "--no-deps", "--no-build", self.service, commit=commit)
            if code != 0:
                raise UpdateError(500, f"Restarting the studio failed (exit {code}). Details: docker compose logs updater")
            if old and old["image"]:
                # The previous image is left untagged by the build: drop it once its container is
                # gone. Refused (and kept) while anything still uses it.
                if self.docker("image", "rm", old["image"]).returncode == 0:
                    self._say("Previous image removed")
            self._say("Update done")
            self.state = "idle"
        except Exception as exc:  # noqa: BLE001 - any failure ends in the status, never in silence
            self.error = exc.detail if isinstance(exc, UpdateError) else f"Update failed: {exc}"
            self._say(self.error)
            self.state = "idle"
        finally:
            self._cache = (0.0, None)


def handler(updater: Updater):
    class Handler(BaseHTTPRequestHandler):
        def send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path != "/status":
                return self.send(404, {"detail": "not found"})
            self.send(200, updater.status())

        def do_POST(self):
            if self.path != "/apply":
                return self.send(404, {"detail": "not found"})
            try:
                self.send(200, updater.apply())
            except UpdateError as exc:
                self.send(exc.status, {"detail": exc.detail})

        def log_message(self, fmt, *args):  # status polls every few seconds: keep the log for the updates
            pass

    return Handler


if __name__ == "__main__":
    print(f"updater: following {BRANCH} on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), handler(Updater())).serve_forever()
