"""Gemma 4 E4B through llama.cpp's llama-server, replacing Ollama.

The server is started on the first request (model downloaded first if needed),
listens on 127.0.0.1 only, and speaks the OpenAI chat API. Vision works through
the mmproj file: images travel as base64 data URIs.
"""

import subprocess
import threading
import time

import httpx

from .config import Settings
from .models import ModelStore

MODEL_ID = "gemma4-e4b"
MODEL_FILE = "gemma-4-E4B-it-Q8_0.gguf"
MMPROJ_FILE = "mmproj-gemma-4-E4B-it-Q8_0.gguf"


class LlmError(RuntimeError):
    pass


class LlamaServer:
    def __init__(self, settings: Settings, models: ModelStore, startup_timeout: float = 180):
        self.settings = settings
        self.models = models
        self.startup_timeout = startup_timeout
        self.url = f"http://127.0.0.1:{settings.llm_port}"
        self.proc: subprocess.Popen | None = None
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        if self.proc is None:
            return "stopped"
        return "running" if self.proc.poll() is None else "exited"

    def command(self) -> list[str]:
        folder = self.models.path(MODEL_ID)
        return [
            self.settings.llama_server,
            "--model", str(folder / MODEL_FILE),
            "--mmproj", str(folder / MMPROJ_FILE),
            "--host", "127.0.0.1", "--port", str(self.settings.llm_port),
            "--ctx-size", "8192", "--n-gpu-layers", "99", "--jinja",
        ]

    def start(self) -> None:
        with self._lock:
            if self.state == "running":
                return
            self.models.ensure([MODEL_ID])
            try:
                self.proc = subprocess.Popen(self.command())
            except FileNotFoundError as exc:
                raise LlmError(f"llama-server not found ({self.settings.llama_server})") from exc
            deadline = time.time() + self.startup_timeout
            while time.time() < deadline:
                if self.proc.poll() is not None:
                    raise LlmError(f"llama-server exited with code {self.proc.returncode}")
                try:
                    if httpx.get(f"{self.url}/health", timeout=2).status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                time.sleep(1)
            self.stop()
            raise LlmError(f"llama-server not ready after {self.startup_timeout:.0f} s")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None

    def chat(self, system: str, prompt: str, images: list[str] | None = None,
             json_mode: bool = True, temperature: float = 0.7) -> str:
        """One system + user turn; `images` are raw base64 strings (no data: prefix)."""
        self.start()
        content: list[dict] | str = prompt
        if images:
            content = [{"type": "text", "text": prompt}] + [
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}} for b64 in images
            ]
        body = {
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
            "temperature": temperature,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        resp = httpx.post(f"{self.url}/v1/chat/completions", json=body, timeout=300)
        if resp.status_code != 200:
            raise LlmError(f"llama-server answered {resp.status_code}: {resp.text[:300]}")
        return resp.json()["choices"][0]["message"]["content"]
