from fastapi.testclient import TestClient

from studio.main import create_app

from .test_api import FakeLlm

SAME_ORIGIN = {"Origin": "http://testserver"}


def make_client(settings, store):
    return TestClient(create_app(settings, models=store, pipelines={}, llm=FakeLlm()))


def test_instruction_is_stored_listed_and_removed(settings, store):
    with make_client(settings, store) as c:
        assert c.get("/api/instructions").json() == {}
        assert c.put("/api/instructions/krea2", json={"text": "Mine"}, headers=SAME_ORIGIN).json() == {"krea2": "Mine"}
    # Kept on disk: a restart (another app) still has it.
    with make_client(settings, store) as c:
        assert c.get("/api/instructions").json() == {"krea2": "Mine"}
        assert c.delete("/api/instructions/krea2", headers=SAME_ORIGIN).json() == {}
        assert c.get("/api/instructions").json() == {}


def test_instruction_checks(settings, store):
    with make_client(settings, store) as c:
        assert c.put("/api/instructions/krea2", json={"text": "x"}, headers={"Origin": "http://evil.example"}).status_code == 403
        assert c.put("/api/instructions/Bad-Name", json={"text": "x"}, headers=SAME_ORIGIN).status_code == 422
        assert c.put("/api/instructions/krea2", json={"text": "  "}, headers=SAME_ORIGIN).status_code == 422
        assert c.put("/api/instructions/krea2", json={"text": "x" * 20_001}, headers=SAME_ORIGIN).status_code == 422


def test_model_size_route(settings, store):
    with make_client(settings, store) as c:
        assert c.get("/api/models/gemma4-e4b/size").json() == {"id": "gemma4-e4b", "bytes": 110}
        assert c.get("/api/models/nope/size").status_code == 404
