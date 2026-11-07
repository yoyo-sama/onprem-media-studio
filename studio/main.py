"""HTTP and WebSocket API, plus the static front end. Run: python -m studio"""

import asyncio
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import gallery as gallery_api
from . import instructions, loras, update
from .assistant import chat as assistant_chat
from .assistant.roles import Roles
from .config import APP_VERSION, Settings
from .files import FileStore
from .gallery import Gallery
from .jobs import JobQueue
from .llm import LlamaServer, LlmError
from .models import ModelError, ModelStore
from .pipelines import REGISTRY, Pipeline, common

REPO_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = REPO_DIR / "web"


class FrontEnd(StaticFiles):
    """The pages and scripts, revalidated on every load (ETag, so a 304 when unchanged):
    after an update a browser never mixes a new page with a cached old script."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


class JobRequest(BaseModel):
    pipeline: str
    params: dict = {}
    origin: str | None = None


class ChatRequest(BaseModel):
    system: str
    prompt: str
    images: list[str] = []
    json_mode: bool = True
    temperature: float = 0.7


def gpu_info() -> dict:
    try:
        import torch
    except ImportError:
        return {"available": False, "reason": "torch not installed"}
    if not torch.cuda.is_available():
        return {"available": False, "reason": "no CUDA device"}
    return {"available": True, "name": torch.cuda.get_device_name(0),
            "capability": "%d.%d" % torch.cuda.get_device_capability(0),
            "memory_free": common.free_memory(), "memory_total": torch.cuda.mem_get_info()[1]}


def memory_info() -> dict | None:
    """System memory from /proc/meminfo, in bytes (None elsewhere). On a GB10 the
    GPU shares this memory, and CUDA's free figure leaves out the page cache the
    kernel gives back on demand: the page reads `available` instead (LESSONS.md)."""
    try:
        lines = Path("/proc/meminfo").read_text().splitlines()
    except OSError:
        return None
    kb = {k: int(v.split()[0]) for k, v in (line.split(":", 1) for line in lines if ":" in line)}
    if "MemTotal" not in kb or "MemAvailable" not in kb:
        return None
    return {"total": kb["MemTotal"] * 1024, "available": kb["MemAvailable"] * 1024}


def create_app(settings: Settings | None = None, models: ModelStore | None = None,
               pipelines: dict[str, Pipeline] | None = None, llm: LlamaServer | None = None,
               updater: update.Updater | update.RemoteUpdater | None = None) -> FastAPI:
    settings = settings or Settings()
    files = FileStore(settings.input_dir, settings.output_dir)
    models = models or ModelStore(settings)
    llm = llm or LlamaServer(settings, models)
    jobs = JobQueue(REGISTRY if pipelines is None else pipelines, models, files)
    gallery = Gallery(settings.output_dir, settings.data_dir, settings.gallery_scan)
    clients: set[asyncio.Queue] = set()
    loop: asyncio.AbstractEventLoop | None = None

    def broadcast(event: dict) -> None:
        # Called from worker threads: hand the event to the event loop.
        if loop is not None:
            for q in list(clients):
                loop.call_soon_threadsafe(q.put_nowait, event)

    def index_outputs(event: dict) -> None:
        # A finished job's files enter the gallery at once, before the job event
        # reaches the clients (listeners run in order), not at the next scan.
        job = event["job"]
        if job["status"] == "done":
            for ref in job["outputs"]:
                if ref.startswith("outputs/"):
                    gallery.index_key(ref.removeprefix("outputs/"))

    jobs.listeners += [index_outputs, broadcast]

    def busy() -> int:
        return sum(j.status in ("queued", "running") for j in list(jobs.jobs.values()))

    def before_restart() -> None:
        gallery.stop()
        llm.stop()

    if updater is None:
        updater = (update.RemoteUpdater(settings.updater_url, busy) if settings.updater_url
                   else update.Updater(REPO_DIR, settings.update_branch, busy, before_restart))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal loop
        loop = asyncio.get_running_loop()
        jobs.start()
        gallery.start()
        yield
        gallery.stop()
        jobs.stop()
        llm.stop()

    app = FastAPI(title=settings.app_name, version=APP_VERSION, lifespan=lifespan)
    app.state.jobs, app.state.models, app.state.llm, app.state.gallery = jobs, models, llm, gallery
    app.include_router(gallery_api.router(gallery))
    app.include_router(update.router(updater))
    app.include_router(loras.router(settings.loras_dir))
    app.include_router(instructions.router(instructions.Instructions(settings.data_dir / "instructions.json")))
    assistant = assistant_chat.Assistant(llm, Roles(settings.data_dir),
                                         assistant_chat.Conversations(settings.data_dir / "chats"), files,
                                         settings.app_name)
    app.include_router(assistant_chat.router(assistant))
    # A video engine that does not fit next to the LLM stops it; the next LLM request
    # starts it again (about 20 s).
    common.LOW_MEMORY.append(llm.stop)

    @app.get("/api/health")
    def health():
        return {"app": settings.app_name, "version": APP_VERSION, "gpu": gpu_info(), "memory": memory_info(),
                "llm": llm.state, "llm_model": llm.model_id, "queue": busy()}

    @app.get("/api/models")
    def list_models():
        return models.status()

    @app.get("/api/models/{model_id}/size")
    def model_size(model_id: str):
        try:
            return {"id": model_id, "bytes": models.pending_bytes(model_id)}
        except ModelError as exc:
            raise HTTPException(404 if model_id not in models.catalog else 502, str(exc))

    @app.post("/api/models/{model_id}/download", status_code=202)
    def download_model(model_id: str):
        try:
            models.entry(model_id)
        except ModelError as exc:
            raise HTTPException(404, str(exc))
        if models.installed(model_id):
            return {"id": model_id, "status": "installed"}

        def run():
            def progress(frac, msg):
                broadcast({"type": "model", "id": model_id, "progress": frac, "message": msg})
            try:
                models.download(model_id, progress)
            except ModelError as exc:
                broadcast({"type": "model", "id": model_id, "error": str(exc)})

        threading.Thread(target=run, name=f"download-{model_id}", daemon=True).start()
        return {"id": model_id, "status": "downloading"}

    @app.get("/api/pipelines")
    def list_pipelines():
        return [{"id": p.id, "models": p.needs(settings)} for p in jobs.pipelines.values()]

    @app.post("/api/inputs", status_code=201)
    async def upload_input(request: Request):
        """Raw image, video or sound bytes in the body; the answer's `ref` (and `kind`) goes in a job's file fields."""
        try:
            return files.save_input(await request.body())
        except ValueError as exc:
            raise HTTPException(422, str(exc))

    @app.get("/api/jobs")
    def list_jobs():
        return [j.public() for j in jobs.jobs.values()]

    @app.post("/api/jobs", status_code=201)
    def submit_job(req: JobRequest):
        try:
            return jobs.submit(req.pipeline, req.params, req.origin).public()
        except KeyError as exc:
            raise HTTPException(404, str(exc.args[0]))
        except ValueError as exc:
            raise HTTPException(422, str(exc))

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        if job_id not in jobs.jobs:
            raise HTTPException(404, f"Unknown job: {job_id}")
        return jobs.jobs[job_id].public()

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str):
        if job_id not in jobs.jobs:
            raise HTTPException(404, f"Unknown job: {job_id}")
        return jobs.cancel(job_id).public()

    @app.post("/api/llm/chat")
    def llm_chat(req: ChatRequest):
        try:
            return {"content": llm.chat(req.system, req.prompt, req.images, req.json_mode, req.temperature)}
        except (LlmError, ModelError) as exc:
            raise HTTPException(503, str(exc))

    @app.websocket("/api/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        q: asyncio.Queue = asyncio.Queue()
        clients.add(q)
        try:
            while True:
                await socket.send_json(await q.get())
        except WebSocketDisconnect:
            pass
        finally:
            clients.discard(q)

    app.mount("/inputs", StaticFiles(directory=settings.input_dir), name="inputs")
    app.mount("/outputs", StaticFiles(directory=settings.output_dir), name="outputs")
    if WEB_DIR.is_dir():
        app.mount("/", FrontEnd(directory=WEB_DIR, html=True), name="web")
    return app
