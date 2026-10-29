import pytest

from studio.llm import LlamaServer, LlmError


def test_command_uses_local_model_files(settings, store):
    cmd = LlamaServer(settings, store).command()
    assert cmd[0] == "llama-server"
    assert str(store.path("gemma4-e4b") / "gemma-4-E4B-it-Q8_0.gguf") in cmd
    assert str(store.path("gemma4-e4b") / "mmproj-gemma-4-E4B-it-Q8_0.gguf") in cmd
    # Bound to loopback: the studio API is the only way in.
    assert cmd[cmd.index("--host") + 1] == "127.0.0.1"


def test_missing_binary_is_a_clear_error(settings, store, monkeypatch):
    monkeypatch.setenv("STUDIO_LLAMA_SERVER", "/nonexistent/llama-server")
    from studio.config import Settings
    server = LlamaServer(Settings(), store)
    with pytest.raises(LlmError, match="llama-server not found"):
        server.start()
    # The model was fetched first: the error is about the binary, not the weights.
    assert store.installed("gemma4-e4b")
