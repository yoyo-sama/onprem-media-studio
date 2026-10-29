"""HTTP and WebSocket API, plus the static front end. Run: python -m studio"""

import asyncio
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import APP_VERSION, Settings
from .files import FileStore
from .jobs import JobQueue
from .llm import LlamaServer, LlmError
from .models import ModelError, ModelStore
from .pipelines import REGISTRY, Pipeline

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


class JobRequest(BaseModel):
    pipeline: str
    params: dict = {}


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
    free, total = torch.cuda.mem_get_info()
    return {"available": True, "name": torch.cuda.get_device_name(0),
            "capability": "%d.%d" % torch.cuda.get_device_capability(0),
            "memory_free": free, "memory_total": total}


def create_app(settings: Settings | None = None, models: ModelStore | None = None,
               pipelines: dict[str, Pipeline] | None = None, llm: LlamaServer | None = None) -> FastAPI:
    settings = settings or Settings()
    files = FileStore(settings.input_dir, settings.output_dir)
    models = models or ModelStore(settings)
    llm = llm or LlamaServer(settings, models)
    jobs = JobQueue(REGISTRY if pipelines is None else pipelines, models, files)
    clients: set[asyncio.Queue] = set()
    loop: asyncio.AbstractEventLoop | None = None

    def broadcast(event: dict) -> None:
        # Called from worker threads: hand the event to the event loop.
        if loop is not None:
            for q in list(clients):
                loop.call_soon_threadsafe(q.put_nowait, event)

    jobs.listeners.append(broadcast)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal loop
        loop = asyncio.get_running_loop()
        jobs.start()
        yield
        jobs.stop()
        llm.stop()

    app = FastAPI(title=settings.app_name, version=APP_VERSION, lifespan=lifespan)
    app.state.jobs, app.state.models, app.state.llm = jobs, models, llm

    @app.get("/api/health")
    def health():
        return {"app": settings.app_name, "version": APP_VERSION, "gpu": gpu_info(), "llm": llm.state}

    @app.get("/api/models")
    def list_models():
        return models.status()

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
        return [{"id": p.id, "models": p.models} for p in jobs.pipelines.values()]

    @app.post("/api/inputs", status_code=201)
    async def upload_input(request: Request):
        """Raw image bytes in the body; the answer's `ref` goes in a job's image fields."""
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
            return jobs.submit(req.pipeline, req.params).public()
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
        app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app
