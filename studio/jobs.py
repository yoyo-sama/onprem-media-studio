"""Job queue: one GPU worker, jobs run in submission order; the CPU jobs (montage,
`Pipeline.gpu = False`) run in order on a second worker, beside the GPU one.

A job exists only because a client posted it: nothing in the backend creates
one on its own (LESSONS.md, "nothing renders without a click").

The last jobs are kept in STUDIO_DATA_DIR/jobs.json, written at each change of
status. After a restart they are listed again; a job the restart cut (queued or
running) is read back as failed and `interrupted`, and runs again only on a click
(`retry`), never by itself.
"""

import itertools
import json
import os
import tempfile
import queue
import re
import secrets
import threading
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

from .files import FileStore
from .models import ModelStore
from .pipelines import Pipeline

Listener = Callable[[dict], None]
ORIGIN = re.compile(r"[a-z0-9_-]{1,40}")
HISTORY = 200  # jobs kept in jobs.json
INTERRUPTED = "the server restarted during this job, which was lost: launch it again"


class Cancelled(Exception):
    pass


class Held(RuntimeError):
    """The queue takes no new job for now (an update is about to restart the server)."""


@dataclass
class Job:
    id: str
    pipeline: str
    params: dict
    # The front-end feature that submitted the job (storyboard, relay, canvas…),
    # recorded with the outputs for the gallery; never read by a pipeline.
    origin: str | None = None
    status: str = "queued"  # queued | running | done | error | cancelled
    progress: float = 0.0
    message: str = ""
    outputs: list[str] = field(default_factory=list)
    error: str | None = None
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    # Cut by a restart (read back from jobs.json); `retried_as` names the job its
    # "launch again" click submitted.
    interrupted: bool = False
    retried_as: str | None = None
    # The parameters as the client sent them, before validate() normalised them: what
    # "launch again" submits (normalised ones hold computed keys a pipeline refuses).
    request: dict = field(default_factory=dict)

    def public(self) -> dict:
        return asdict(self)


class JobContext:
    """What a pipeline sees of its job: progress, cancellation, output folder."""

    def __init__(self, job: Job, queue_: "JobQueue"):
        self.job = job
        self._queue = queue_
        self.models = queue_.models
        self.files: FileStore = queue_.files
        self.output_dir: Path = queue_.output_dir

    def progress(self, frac: float, message: str = "") -> None:
        self.check()
        self.job.progress = max(0.0, min(1.0, frac))
        self.job.message = message
        self._queue.emit(self.job)

    def cancelled(self) -> bool:
        return self.job.id in self._queue.cancel_requests

    def check(self) -> None:
        if self.cancelled():
            raise Cancelled()


class JobQueue:
    def __init__(self, pipelines: dict[str, Pipeline], models: ModelStore, files: FileStore,
                 history: Path | None = None):
        self.pipelines = pipelines
        self.models = models
        self.files = files
        self.output_dir: Path = files.roots["outputs"]
        self.jobs: dict[str, Job] = {}
        self.cancel_requests: set[str] = set()
        self.listeners: list[Listener] = []
        # One queue per worker: the GPU engines, and the CPU jobs (montage).
        self._pending = {True: queue.Queue(), False: queue.Queue()}
        # Ids are unique across restarts: jobs live in memory, and a page that waited for
        # job-3 before a restart must not read another job-3 after it (LESSONS.md #47).
        self._boot = secrets.token_hex(3)
        self._ids = itertools.count(1)
        self._held_until = 0.0
        # Status changes and the worker's pick of the next job happen under this lock:
        # a cancel at the moment a job starts can no longer report "cancelled" for a job
        # that runs.
        self._lock = threading.RLock()
        self.history = history
        self._saved: dict[str, str] = {}
        self._restore()
        self._workers = [threading.Thread(target=self._run, args=(self._pending[gpu],), daemon=True,
                                          name="job-worker" if gpu else "job-worker-cpu") for gpu in (True, False)]

    def start(self) -> None:
        for worker in self._workers:
            worker.start()

    def stop(self) -> None:
        for pending in self._pending.values():
            pending.put(None)

    def emit(self, job: Job) -> None:
        event = {"type": "job", "job": job.public()}
        if self._saved.get(job.id) != job.status:
            self._save()
        for listener in list(self.listeners):
            listener(event)

    # ── History ──

    def _restore(self) -> None:
        if self.history is None:
            return
        try:
            saved = json.loads(self.history.read_text())
        except (OSError, ValueError):
            return
        for item in saved if isinstance(saved, list) else []:
            try:
                job = Job(**item)
            except TypeError:
                continue  # written by another version
            if job.status in ("queued", "running"):
                job.status, job.error, job.interrupted = "error", INTERRUPTED, True
                job.finished = job.finished or time.time()
            self.jobs[job.id] = job
        self._save()

    def _save(self) -> None:
        if self.history is None:
            return
        with self._lock:
            jobs = list(self.jobs.values())[-HISTORY:]
            self._saved = {j.id: j.status for j in jobs}
            try:
                self.history.parent.mkdir(parents=True, exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=self.history.parent, prefix=".jobs-")
                with os.fdopen(fd, "w") as f:
                    json.dump([j.public() for j in jobs], f, ensure_ascii=False)
                os.replace(tmp, self.history)
            except OSError as exc:
                print(f"jobs: history not written: {exc}", flush=True)

    def hold(self, seconds: float) -> None:
        """Refuse new jobs for `seconds` (0 lifts it). The Docker updater holds the queue
        while it waits for the running jobs and recreates the container, renewing the hold
        on every look: a click in that window would be accepted, then killed. The hold
        expires on its own if the updater stops renewing it."""
        self._held_until = time.time() + seconds if seconds > 0 else 0.0

    @property
    def held(self) -> bool:
        return time.time() < self._held_until

    def submit(self, pipeline: str, params: dict, origin: str | None = None) -> Job:
        if self.held:
            raise Held("An update is about to restart the server: new jobs are refused for a moment, "
                       "launch this one again once the update is done")
        if pipeline not in self.pipelines:
            raise KeyError(f"Unknown pipeline: {pipeline}")
        if origin is not None and not ORIGIN.fullmatch(origin):
            raise ValueError("origin must be 1 to 40 lowercase letters, digits, '-' or '_'")
        request = params
        params = self.pipelines[pipeline].validate(params, self.files)
        job = Job(id=f"job-{self._boot}-{next(self._ids)}", pipeline=pipeline, params=params, origin=origin,
                  request=request)
        with self._lock:
            self.jobs[job.id] = job
            self._pending[self.pipelines[pipeline].gpu].put(job.id)
            # Memory keeps what jobs.json keeps: the last HISTORY jobs, plus any still waiting
            # or running however old.
            finished = [j for j in self.jobs.values() if j.status not in ("queued", "running")]
            for old in finished[:max(0, len(self.jobs) - HISTORY)]:
                del self.jobs[old.id]
        self.emit(job)
        return job

    def retry(self, job_id: str) -> Job:
        """Submit an interrupted job again, same pipeline, parameters (seed included) and
        origin: the user's click on "launch again". Once only."""
        old = self.jobs[job_id]
        if not old.interrupted:
            raise ValueError("Only a job interrupted by a restart can be launched again this way")
        if old.retried_as:
            raise ValueError(f"Already launched again as {old.retried_as}")
        request = dict(old.request)
        if old.params.get("seed") is not None and request.get("seed") is None:
            request["seed"] = old.params["seed"]  # the seed the lost job drew: the same render
        job = self.submit(old.pipeline, request, old.origin)
        old.retried_as = job.id
        self._save()
        return job

    def cancel(self, job_id: str) -> Job:
        with self._lock:
            job = self.jobs[job_id]
            if job.status == "queued":
                job.status, job.finished = "cancelled", time.time()
            elif job.status == "running":
                self.cancel_requests.add(job_id)
                return job
            else:
                return job
        self.emit(job)
        return job

    def _run(self, pending: queue.Queue) -> None:
        while (job_id := pending.get()) is not None:
            job = self.jobs[job_id]
            with self._lock:
                if job.status != "queued":
                    continue
                job.status, job.started = "running", time.time()
            self.emit(job)
            ctx = JobContext(job, self)
            try:
                pipeline = self.pipelines[job.pipeline]
                # Missing models are fetched on first use, inside the job, so the
                # user sees the download in the same progress bar as the render.
                paths = self.models.ensure(pipeline.models, ctx.progress, ctx.cancelled)
                job.outputs = [self.files.ref(p) for p in pipeline.run(job.params, paths, ctx)]
                job.status, job.progress = "done", 1.0
            except Cancelled:
                job.status = "cancelled"
            except Exception as exc:
                if ctx.cancelled():  # e.g. a model download stopped by the cancel: not a failure
                    job.status = "cancelled"
                else:
                    job.status, job.error = "error", f"{exc}"
                    traceback.print_exc()
            finally:
                self.cancel_requests.discard(job_id)
                job.finished = time.time()
                self.emit(job)
