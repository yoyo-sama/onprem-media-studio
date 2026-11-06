import json

import pytest

from studio.llm import CHAT_MAX_TOKENS, LlamaServer, LlmError


def test_command_uses_local_model_files(settings, store):
    cmd = LlamaServer(settings, store).command()
    assert cmd[0] == "llama-server"
    # Gemma 4 26B-A4B by default, for enrichment and the assistant alike.
    assert str(store.path("gemma4-26b-a4b") / "gemma-4-26B-A4B-it-Q4_0.gguf") in cmd
    assert str(store.path("gemma4-26b-a4b") / "mmproj-gemma-4-26B-A4B-it-Q8_0.gguf") in cmd
    # Bound to loopback: the studio API is the only way in.
    assert cmd[cmd.index("--host") + 1] == "127.0.0.1"
    # Room for the assistant's instructions and history, one slot.
    assert cmd[cmd.index("--ctx-size") + 1] == "32768"
    assert cmd[cmd.index("--parallel") + 1] == "1"
    # The chat thinks within a budget, then answers.
    assert cmd[cmd.index("--reasoning-budget") + 1] == "2048"


def test_smaller_model_by_setting(store, monkeypatch, settings):
    monkeypatch.setenv("STUDIO_LLM_MODEL", "gemma4-e4b")
    from studio.config import Settings
    cmd = LlamaServer(Settings(), store).command()
    assert str(store.path("gemma4-e4b") / "gemma-4-E4B-it-Q8_0.gguf") in cmd
    monkeypatch.setenv("STUDIO_LLM_MODEL", "gpt-x")
    with pytest.raises(LlmError, match="STUDIO_LLM_MODEL"):
        LlamaServer(Settings(), store)


def test_missing_binary_is_a_clear_error(settings, store, monkeypatch):
    monkeypatch.setenv("STUDIO_LLAMA_SERVER", "/nonexistent/llama-server")
    from studio.config import Settings
    server = LlamaServer(Settings(), store)
    with pytest.raises(LlmError, match="llama-server not found"):
        server.start()
    # The model was fetched first: the error is about the binary, not the weights.
    assert store.installed("gemma4-26b-a4b")


class FakeStream:
    """httpx.stream stand-in: the server-sent lines of a streamed completion."""

    def __init__(self, lines, status=200):
        self.lines, self.status_code, self.text = lines, status, "boom"
        self.body = None

    def __call__(self, method, url, json, timeout):
        self.body = json
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        pass

    def iter_lines(self):
        yield from self.lines


def sse(delta):
    return "data: " + json.dumps({"choices": [{"delta": delta}]})


def test_stream_gives_text_then_complete_tool_calls(settings, store, monkeypatch, capsys):
    fake = FakeStream([
        sse({"content": "Here "}), "", sse({"content": "you go."}),
        sse({"tool_calls": [{"index": 0, "id": "call_a", "function": {"name": "create_", "arguments": '{"pro'}}]}),
        sse({"tool_calls": [{"index": 0, "function": {"name": "image", "arguments": 'mpt": "a cat"}'}}]}),
        sse({"tool_calls": [{"index": 1, "function": {"name": "ask_choices", "arguments": "{}"}}]}),
        "data: " + json.dumps({"choices": [], "timings": {"prompt_n": 900, "prompt_ms": 1500, "predicted_n": 40, "predicted_ms": 800}}),
        "data: [DONE]",
    ])
    monkeypatch.setattr("studio.llm.httpx.stream", fake)
    server = LlamaServer(settings, store)
    monkeypatch.setattr(server, "start", lambda: None)
    out = list(server.stream([{"role": "user", "content": "hi"}], tools=[{"type": "function"}]))
    assert out == [("text", "Here "), ("text", "you go."),
                   ("tool", {"id": "call_a", "name": "create_image", "arguments": '{"prompt": "a cat"}'}),
                   ("tool", {"id": "call_1", "name": "ask_choices", "arguments": "{}"})]
    assert fake.body["stream"] is True and fake.body["tools"] == [{"type": "function"}]
    # A capped answer, thinking left to the server's budget: one once looped until the context was full.
    assert fake.body["max_tokens"] == CHAT_MAX_TOKENS
    assert "chat_template_kwargs" not in fake.body
    # One line per call in the container log, with llama-server's own timings.
    line = capsys.readouterr().out
    assert line.startswith("llm: chat ") and "(prompt 900 tokens in 1.5 s, 40 generated in 0.8 s)" in line


def test_stream_error_is_an_llm_error(settings, store, monkeypatch):
    monkeypatch.setattr("studio.llm.httpx.stream", FakeStream([], status=500))
    server = LlamaServer(settings, store)
    monkeypatch.setattr(server, "start", lambda: None)
    with pytest.raises(LlmError, match="500"):
        list(server.stream([]))


def test_stream_cut_at_the_cap_is_an_llm_error(settings, store, monkeypatch):
    cut = "data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "length"}]})
    monkeypatch.setattr("studio.llm.httpx.stream", FakeStream([sse({"content": "Long"}), cut, "data: [DONE]"]))
    server = LlamaServer(settings, store)
    monkeypatch.setattr(server, "start", lambda: None)
    out = []
    with pytest.raises(LlmError, match="cut at"):
        for event in server.stream([]):
            out.append(event)
    # The text written before the cut was given first.
    assert out == [("text", "Long")]


def test_compiler_calls_do_not_think(settings, store, monkeypatch, capsys):
    sent = {}

    class Resp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": "{}"}}], "timings": {"prompt_n": 10, "predicted_n": 5}}

    def post(url, json, timeout):
        sent.update(json)
        return Resp()

    monkeypatch.setattr("studio.llm.httpx.post", post)
    server = LlamaServer(settings, store)
    monkeypatch.setattr(server, "start", lambda: None)
    assert server.chat("sys", "hi") == "{}"
    # Gemma 4 thinks by default through llama-server: thousands of hidden tokens per call.
    assert sent["chat_template_kwargs"] == {"enable_thinking": False}
    assert sent["response_format"] == {"type": "json_object"}
    assert capsys.readouterr().out.startswith("llm: call ")
