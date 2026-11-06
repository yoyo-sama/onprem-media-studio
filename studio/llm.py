"""Gemma 4 through llama.cpp's llama-server, replacing Ollama: prompt enrichment
and the creative assistant use the same model.

The server is started on the first request (model downloaded first if needed),
listens on 127.0.0.1 only, and speaks the OpenAI chat API. Vision works through
the mmproj file: images travel as base64 data URIs. STUDIO_LLM_MODEL chooses the
model: Gemma 4 26B-A4B by default, Gemma 4 E4B on a machine with less memory.
"""

import json
import subprocess
import threading
import time
from collections.abc import Iterator

import httpx

from .config import Settings
from .models import ModelStore

# Catalog id → (weights, vision projector).
LLM_FILES = {
    "gemma4-26b-a4b": ("gemma-4-26B-A4B-it-Q4_0.gguf", "mmproj-gemma-4-26B-A4B-it-Q8_0.gguf"),
    "gemma4-e4b": ("gemma-4-E4B-it-Q8_0.gguf", "mmproj-gemma-4-E4B-it-Q8_0.gguf"),
}
# Room for the assistant's instructions, tools and conversation history; one slot,
# so concurrent requests queue instead of splitting the context.
CTX_SIZE = 32768
# Longest answer of one chat turn. A turn left without a cap once thought in a loop
# until the context was full (29 220 tokens, 528 s on the GB10) and showed nothing.
CHAT_MAX_TOKENS = 4096


class LlmError(RuntimeError):
    pass


def log_call(kind: str, seconds: float, timings: dict | None, images: int = 0) -> None:
    """One line per Gemma call in the container log (`docker logs studio | grep llm:`),
    to tell a slow model from a slow render."""
    t = timings or {}
    line = f"llm: {kind} {seconds:.1f} s"
    if t:
        line += (f" (prompt {t.get('prompt_n', '?')} tokens in {t.get('prompt_ms', 0) / 1000:.1f} s,"
                 f" {t.get('predicted_n', '?')} generated in {t.get('predicted_ms', 0) / 1000:.1f} s)")
    if images:
        line += f", {images} image(s)"
    print(line, flush=True)


class LlamaServer:
    def __init__(self, settings: Settings, models: ModelStore, startup_timeout: float = 180):
        self.settings = settings
        self.models = models
        self.startup_timeout = startup_timeout
        self.url = f"http://127.0.0.1:{settings.llm_port}"
        self.proc: subprocess.Popen | None = None
        self._lock = threading.Lock()
        if settings.llm_model not in LLM_FILES:
            raise LlmError(f"STUDIO_LLM_MODEL must be one of {', '.join(LLM_FILES)}, not {settings.llm_model!r}")
        self.model_id = settings.llm_model

    @property
    def state(self) -> str:
        if self.proc is None:
            return "stopped"
        return "running" if self.proc.poll() is None else "exited"

    def command(self) -> list[str]:
        folder = self.models.path(self.model_id)
        weights, mmproj = LLM_FILES[self.model_id]
        return [
            self.settings.llama_server,
            "--model", str(folder / weights),
            "--mmproj", str(folder / mmproj),
            "--host", "127.0.0.1", "--port", str(self.settings.llm_port),
            "--ctx-size", str(CTX_SIZE), "--parallel", "1", "--n-gpu-layers", "99", "--jinja",
        ]

    def start(self) -> None:
        with self._lock:
            if self.state == "running":
                return
            self.models.ensure([self.model_id])
            began = time.time()
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
                        print(f"llm: {self.model_id} loaded in {time.time() - began:.1f} s", flush=True)
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
        # Gemma 4 thinks by default through llama-server: thousands of hidden tokens per
        # prompt compiled (44 to 81 s measured on the GB10). The compilers want the answer.
        body["chat_template_kwargs"] = {"enable_thinking": False}
        began = time.time()
        resp = httpx.post(f"{self.url}/v1/chat/completions", json=body, timeout=300)
        if resp.status_code != 200:
            raise LlmError(f"llama-server answered {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        log_call("call", time.time() - began, data.get("timings"), len(images or []))
        return data["choices"][0]["message"]["content"]

    def stream(self, messages: list[dict], tools: list[dict] | None = None,
               temperature: float = 0.6) -> Iterator[tuple[str, object]]:
        """A chat completion, streamed: ("text", chunk) as the answer is written, then
        ("tool", {"id", "name", "arguments"}) for each tool call once complete.
        Closing the iterator closes the connection, which stops the generation.
        An answer cut at CHAT_MAX_TOKENS raises LlmError once its text has been yielded."""
        self.start()
        # Without thinking, like the compile calls: with it, Gemma 4 wrote 8 000 hidden
        # tokens (150 s) for a three-line answer, and once looped until the context was full.
        body = {"messages": messages, "temperature": temperature, "stream": True,
                "max_tokens": CHAT_MAX_TOKENS, "chat_template_kwargs": {"enable_thinking": False}}
        if tools:
            body["tools"] = tools
        calls: dict[int, dict] = {}
        began, timings, finish = time.time(), None, None
        with httpx.stream("POST", f"{self.url}/v1/chat/completions", json=body, timeout=300) as resp:
            if resp.status_code != 200:
                resp.read()
                raise LlmError(f"llama-server answered {resp.status_code}: {resp.text[:300]}")
            for line in resp.iter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    timings = chunk.get("timings") or timings
                    choice = chunk["choices"][0]
                    finish = choice.get("finish_reason") or finish
                    delta = choice.get("delta") or {}
                except (ValueError, KeyError, IndexError, AttributeError):
                    continue
                if delta.get("content"):
                    yield "text", delta["content"]
                for part in delta.get("tool_calls") or []:
                    call = calls.setdefault(part.get("index", len(calls)), {"id": "", "name": "", "arguments": ""})
                    call["id"] = part.get("id") or call["id"]
                    fn = part.get("function") or {}
                    call["name"] += fn.get("name") or ""
                    call["arguments"] += fn.get("arguments") or ""
        log_call("chat", time.time() - began, timings)
        if finish == "length":
            raise LlmError(f"the answer was cut at {CHAT_MAX_TOKENS} tokens")
        for i, call in sorted(calls.items()):
            yield "tool", {**call, "id": call["id"] or f"call_{i}"}
