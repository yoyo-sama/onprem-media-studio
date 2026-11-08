"""Job queue: one worker, one GPU, jobs run in submission order.

A job exists only because a client posted it: nothing in the backend creates
one on its own (LESSONS.md, "nothing renders without a click").
"""

import itertools
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
    def __init__(self, pipelines: dict[str, Pipeline], models: ModelStore, files: FileStore):
        self.pipelines = pipelines
        self.models = models
        self.files = files
        self.output_dir: Path = files.roots["outputs"]
        self.jobs: dict[str, Job] = {}
        self.cancel_requests: set[str] = set()
        self.listeners: list[Listener] = []
        self._pending: queue.Queue[str | None] = queue.Queue()
        # Ids are unique across restarts: jobs live in memory, and a page that waited for
        # job-3 before a restart must not read another job-3 after it (LESSONS.md #47).
        self._boot = secrets.token_hex(3)
        self._ids = itertools.count(1)
        self._held_until = 0.0
        self._worker = threading.Thread(target=self._run, name="job-worker", daemon=True)

    def start(self) -> None:
        self._worker.start()

    def stop(self) -> None:
        self._pending.put(None)

    def emit(self, job: Job) -> None:
        event = {"type": "job", "job": job.public()}
        for listener in list(self.listeners):
            listener(event)

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
        params = self.pipelines[pipeline].validate(params, self.files)
        job = Job(id=f"job-{self._boot}-{next(self._ids)}", pipeline=pipeline, params=params, origin=origin)
        self.jobs[job.id] = job
        self._pending.put(job.id)
        self.emit(job)
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.jobs[job_id]
        if job.status == "queued":
            job.status, job.finished = "cancelled", time.time()
            self.emit(job)
        elif job.status == "running":
            self.cancel_requests.add(job_id)
        return job

    def _run(self) -> None:
        while (job_id := self._pending.get()) is not None:
            job = self.jobs[job_id]
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
                job.status, job.error = "error", f"{exc}"
                traceback.print_exc()
            finally:
                self.cancel_requests.discard(job_id)
                job.finished = time.time()
                self.emit(job)
