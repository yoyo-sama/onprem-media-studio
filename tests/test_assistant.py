import io
import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from studio.assistant import chat as C
from studio.assistant import tools as T
from studio.assistant.roles import BUILTIN_DIR, RoleError, Roles, parse
from studio.files import FileStore
from studio.llm import LlmError
from studio.main import create_app

SAME_ORIGIN = {"Origin": "http://testserver"}
ROOT = Path(__file__).resolve().parent.parent


def _png():
    buf = io.BytesIO()
    Image.new("RGB", (1, 1), (255, 0, 0)).save(buf, "PNG")
    return buf.getvalue()


PNG = _png()


# ── Roles ─────────────────────────────────────────────────────────────────────

def test_shipped_roles():
    roles = Roles(Path("/nonexistent")).all()
    assert list(roles) == ["ad_director", "assistant", "campaign", "casting", "director", "localisation", "transitions"]
    for role in roles.values():
        assert role.builtin and not role.replaced and role.when and role.prompt
        assert set(role.tools) <= set(T.GENERATION_TOOLS)
    # Instructions stay short enough for the model to follow (ANALYSIS: 3 000 to 6 000 characters).
    assert all(len(r.text) < 6000 for r in roles.values())
    common = (BUILTIN_DIR / "_common.md").read_text()
    for key in ("{app_name}", "{language}", "{engines}", "{references}", "{role_name}", "{roles}"):
        assert key in common


def test_role_replaced_added_and_restored(tmp_path):
    roles = Roles(tmp_path)
    text = "---\nid: director\nname: My director\nwhen: stories\ntools: storyboard\n---\nBe brief."
    roles.set("director", text)
    d = roles.get("director")
    assert (d.name, d.tools, d.prompt, d.replaced) == ("My director", ("storyboard",), "Be brief.", True)
    roles.set("poet", "---\nid: poet\nname: Poet\nwhen: poems\n---\nWrite verse.")
    poet = roles.get("poet")
    assert not poet.builtin and poet.tools == tuple(T.GENERATION_TOOLS)  # no tools line: all of them
    roles.set("director", None)
    assert roles.get("director").name == "Director"
    # A broken replacement on disk falls back to the original instead of breaking the assistant.
    (tmp_path / "roles" / "director.md").write_text("broken")
    assert roles.get("director").name == "Director"


@pytest.mark.parametrize("text, error", [
    ("no header", "header"),
    ("---\nid: x\nname: X\n---\nBody", "when"),
    ("---\nid: Bad\nname: X\nwhen: w\n---\nBody", "Role id"),
    ("---\nid: x\nname: X\nwhen: w\ntools: paint\n---\nBody", "Unknown tool"),
    ("---\nid: x\nname: X\nwhen: w\n---\n  ", "empty"),
])
def test_role_checks(text, error):
    with pytest.raises(RoleError, match=error):
        parse(text)


def test_role_id_must_match_file(tmp_path):
    with pytest.raises(RoleError, match="header says"):
        Roles(tmp_path).set("other", "---\nid: poet\nname: P\nwhen: w\n---\nBody")


# ── Tools ─────────────────────────────────────────────────────────────────────

def test_styles_match_the_front_end():
    out = subprocess.run(["node", "-e", "const P=require('./web/js/prompts.js');"
                          "console.log(JSON.stringify(Object.keys(P.STYLE_PACKS)))"],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    assert json.loads(out) == T.STYLES


def test_markets_match_the_front_end():
    src = (ROOT / "web/js/generate.js").read_text()
    block = src[src.index("export const MARKETS"):]
    found = [k for k in T.MARKETS if f"  {k}: {{" in block]
    assert found == T.MARKETS


def test_normalize_fills_defaults_and_clamps():
    args, warnings = T.normalize("create_image", '{"prompt": " a cat ", "count": 9, "ratio": "21:9", "x": 1}',
                                 lambda r: True)
    assert args == {"prompt": "a cat", "engine": "krea2", "mode": "standard", "ratio": "16:9", "count": 4, "style": "none"}
    assert any("count 9" in w for w in warnings) and any("21:9" in w for w in warnings)
    assert any("ignored: x" in w for w in warnings)


def test_reference_video_keeps_twelve_references_and_their_kinds_in_order():
    """9 images, then the clips and sounds the card adds (FastH3 OmniRef's 12)."""
    refs = [f"A{n}" for n in range(1, 10)] + ["C2#1", "inputs/a.mp4", "inputs/b.wav"]
    kinds = ["character", "object", "object", "setting", "object", "object", "object", "object", "character",
             "motion", "character", "voice"]
    args, warnings = T.normalize("reference_video", {"brief": "A1 runs", "references": refs, "kinds": kinds,
                                                     "music": "a slow piano score"}, lambda r: True)
    assert args["references"] == refs and args["kinds"] == kinds and not warnings
    assert args["music"] == "a slow piano score"


def test_normalize_flags_unknown_images_and_refuses_bad_calls():
    args, warnings = T.normalize("video_from_image", {"prompt": "slow push-in", "image": "A9"}, lambda r: False)
    assert args["duration"] == 5 and warnings == ["A9 is not in the reference table"]
    with pytest.raises(T.ToolError, match="image is missing"):
        T.normalize("video_from_image", {"prompt": "x"}, lambda r: True)
    with pytest.raises(T.ToolError, match="unknown tool"):
        T.normalize("paint", {}, lambda r: True)
    with pytest.raises(T.ToolError, match="at least 2"):
        T.normalize("image_sequence", {"prompt": "x", "images": ["A1"]}, lambda r: True)
    with pytest.raises(T.ToolError, match="not JSON"):
        T.normalize("create_image", "{oops", lambda r: True)


def test_tool_specs_are_openai_functions():
    spec = T.specs(["create_image"])[0]
    assert spec["type"] == "function" and spec["function"]["name"] == "create_image"
    assert spec["function"]["parameters"]["required"] == ["prompt"]


# ── Conversation ──────────────────────────────────────────────────────────────

class ScriptedLlm:
    """Router answers (chat) and streamed answers (stream), in order."""

    state = "stopped"
    model_id = "gemma4-26b-a4b"

    def __init__(self, routes=(), streams=()):
        self.routes, self.streams = list(routes), list(streams)
        self.calls = []

    def chat(self, system, prompt, images, json_mode, temperature):
        self.calls.append(("route", system, prompt))
        return json.dumps(self.routes.pop(0)) if self.routes else '{"role": "assistant", "confidence": 0}'

    def stream(self, messages, tools=None, temperature=0.6):
        self.calls.append(("stream", messages, tools))
        for event in self.streams.pop(0) if self.streams else []:
            if isinstance(event, Exception):
                raise event
            yield event

    def stop(self):
        pass


def tool(name, args, cid="call_1"):
    return ("tool", {"id": cid, "name": name, "arguments": json.dumps(args)})


@pytest.fixture
def files(tmp_path):
    return FileStore(tmp_path / "input", tmp_path / "output")


def make(tmp_path, files, llm):
    return C.Assistant(llm, Roles(tmp_path), C.Conversations(tmp_path / "chats"), files, "Test Studio")


def run(assistant, body):
    conv, opts = assistant.prepare(body)
    return conv, list(assistant.turn(conv, opts))


def test_failed_answer_stays_in_the_conversation(tmp_path, files):
    llm = ScriptedLlm(streams=[[LlmError("the answer was cut at 4096 tokens")], [("text", "Again.")]])
    a = make(tmp_path, files, llm)
    conv, events = run(a, {"text": "A bathroom sheet", "role": "assistant"})
    assert {"type": "error", "message": "the answer was cut at 4096 tokens"} in events
    saved = C.Conversations(tmp_path / "chats").load(conv["id"])
    assert saved["messages"][-1]["error"] == "the answer was cut at 4096 tokens"
    # An answer that holds only its error is not sent back to the model.
    run(a, {"conversation": conv["id"], "text": "Try again", "role": "assistant"})
    assert [m["role"] for m in llm.calls[-1][1]] == ["system", "user"]


def test_turn_routes_streams_and_makes_cards(tmp_path, files):
    ref = files.save_input(PNG)["ref"]
    llm = ScriptedLlm(routes=[{"role": "ad_director", "confidence": 0.9}],
                      streams=[[("text", "Two "), ("text", "variants."),
                                tool("edit_image", {"instruction": "warmer light, keep <image1>", "image": "A1"}),
                                tool("ask_choices", {"question": "Which mood?", "options": ["Warm", "Cold"]}, "call_2"),
                                tool("create_image", {"count": 2}, "call_3")]])
    a = make(tmp_path, files, llm)
    conv, events = run(a, {"text": "Improve my ad", "attachments": [ref], "lang": "fr"})
    kinds = [e["type"] for e in events]
    assert kinds[0] == "conversation" and kinds[-1] == "done"
    assert {"type": "role", "role": "ad_director", "from": "assistant", "auto": True, "changed": True, "goal": ""} in events
    assert "".join(e["delta"] for e in events if e["type"] == "text") == "Two variants."
    cards = [e["card"] for e in events if e["type"] == "card"]
    assert [c["id"] for c in cards] == ["C1", "C2", "C3"]
    assert cards[0]["args"]["image"] == "A1" and not cards[0]["warnings"]
    assert cards[1]["tool"] == "ask_choices"
    assert "prompt is missing" in cards[2]["invalid"]
    # The answering role got its own instructions, the common block filled in, its tools only.
    _, messages, tools = llm.calls[1]
    system = messages[0]["content"]
    assert "Ad art director" in system and "Answer in French (informal: address the user as « tu »" in system and "Test Studio" in system
    assert "- A1: image, attached by the user" in system and "{" + "references}" not in system
    assert {t["function"]["name"] for t in tools} == {"ask_choices", "handoff", "edit_image", "create_image"}
    # The last user message carries its image for the model's vision.
    assert messages[1]["content"][1]["type"] == "image_url"
    saved = C.Conversations(tmp_path / "chats").load(conv["id"])
    assert saved["role"] == "ad_director" and saved["messages"][-1]["text"] == "Two variants."


def test_unsure_router_keeps_the_current_role(tmp_path, files):
    llm = ScriptedLlm(routes=[{"role": "director", "confidence": 0.9}, {"role": "casting", "confidence": 0.3}],
                      streams=[[("text", "Story?")], [("text", "Shots.")]])
    a = make(tmp_path, files, llm)
    conv, _ = run(a, {"text": "A short film"})
    conv, events = run(a, {"conversation": conv["id"], "text": "with a detective"})
    assert conv["role"] == "director"
    assert not any(e.get("changed") for e in events if e["type"] == "role")


def test_pinned_role_and_answers_skip_the_router(tmp_path, files):
    llm = ScriptedLlm(streams=[[tool("ask_choices", {"question": "Q?", "options": ["a", "b"]})], [("text", "ok")]])
    a = make(tmp_path, files, llm)
    conv, _ = run(a, {"text": "hello", "role": "casting"})
    assert conv["role"] == "casting"
    conv, _ = run(a, {"conversation": conv["id"], "text": "a", "answer_to": "C1"})
    assert all(c[0] == "stream" for c in llm.calls)
    assert C.find_card(conv, "C1")["state"] == {"status": "answered", "answer": "a"}
    # The model sees its question's result before the answer.
    _, messages, _ = llm.calls[1]
    tool_msg = next(m for m in messages if m["role"] == "tool")
    assert tool_msg["content"] == "The user answered: a"


def test_handoff_switches_role_in_the_same_turn(tmp_path, files):
    llm = ScriptedLlm(routes=[{"role": "assistant", "confidence": 1}],
                      streams=[[("text", "Over to the director."), tool("handoff", {"role": "director", "goal": "board it"})],
                               [("text", "Scenes first.")]])
    a = make(tmp_path, files, llm)
    conv, events = run(a, {"text": "Storyboard my script"})
    assert conv["role"] == "director"
    assert any(e["type"] == "role" and e.get("changed") and e["goal"] == "board it" for e in events)
    system = llm.calls[2][1][0]["content"]
    assert "# Your role: Director" in system and "Goal: board it" in system
    texts = [m["text"] for m in conv["messages"] if m["type"] == "assistant"]
    assert texts == ["Over to the director.", "Scenes first."]


def test_a_call_written_as_json_text_becomes_its_card(tmp_path, files):
    ref = files.save_input(PNG)["ref"]
    written = ('You want the cat falling asleep.\n\n```json\n{\n  "type": "video_from_image",\n  "props": {\n'
               '    "image": "A1",\n    "prompt": "The cat slowly closes its eyes",\n    "duration": 5\n  }\n}\n```')
    llm = ScriptedLlm(streams=[[("text", written)]])
    a = make(tmp_path, files, llm)
    conv, events = run(a, {"text": "a 5 s video where the cat falls asleep", "attachments": [ref], "role": "director"})
    cards = [e["card"] for e in events if e["type"] == "card"]
    assert len(cards) == 1 and cards[0]["tool"] == "video_from_image" and not cards[0].get("invalid")
    assert cards[0]["args"]["image"] == "A1" and cards[0]["args"]["duration"] == 5
    assert conv["messages"][-1]["text"] == "You want the cat falling asleep."
    # A tool the role does not have, or plain JSON, stays text.
    assert C.text_tool_calls('```json\n{"name": "campaign", "arguments": {"brief": "x"}}\n```', ["storyboard"])[0] == []
    assert C.text_tool_calls('{"a": 1}', ["storyboard"]) == ([], '{"a": 1}')
    calls, rest = C.text_tool_calls('Here.\n{"function": {"name": "storyboard", "arguments": "{\\"brief\\": \\"x\\"}"}}',
                                    ["storyboard"])
    assert calls[0]["name"] == "storyboard" and calls[0]["arguments"] == {"brief": "x"} and rest == "Here."
    # The instructions say a card is a call, never JSON in the text.
    assert "Never write a card, a tool call or JSON in your message" in llm.calls[0][1][0]["content"]


def test_card_results_feed_the_reference_table(tmp_path, files):
    llm = ScriptedLlm(streams=[[tool("video_from_image", {"prompt": "push in", "image": "C9#1"})],
                               [tool("join_videos", {"clips": ["C1#1", "C1#1"]})]])
    a = make(tmp_path, files, llm)
    conv, events = run(a, {"text": "go", "role": "transitions"})
    card = next(e["card"] for e in events if e["type"] == "card")
    assert card["warnings"] == ["C9#1 is not in the reference table"]
    out = files.roots["outputs"] / "h3-i2v"
    out.mkdir()
    (out / "a.mp4").write_bytes(b"x")
    (out / "a.png").write_bytes(PNG)
    C.update_card(a.conversations, files, conv["id"], "C1",
                  {"status": "done", "outputs": ["outputs/h3-i2v/a.mp4", "outputs/h3-i2v/a.png"]})
    conv = a.conversations.load(conv["id"])
    assert C.references(conv) == [("C1#1", "video", "result 1 of card C1 (video_from_image)"),
                                  ("C1#2", "image", "last frame of C1#1")]
    assert C.resolve_id(conv, "C1#2") == "outputs/h3-i2v/a.png"
    conv, events = run(a, {"conversation": conv["id"], "text": "join"})
    assert next(e["card"] for e in events if e["type"] == "card")["warnings"] == []
    tool_msg = next(m for m in llm.calls[-1][1] if m["role"] == "tool")
    assert "Rendered: 2 file(s), ids C1#1 to C1#2" in tool_msg["content"]
    with pytest.raises(ValueError):
        C.update_card(a.conversations, files, conv["id"], "C1", {"status": "done", "outputs": ["outputs/none.png"]})
    with pytest.raises(C.ChatError, match="status"):
        C.update_card(a.conversations, files, conv["id"], "C1", {"status": "won"})


def test_history_alternates_and_merges(tmp_path, files):
    conv = C.Conversations(tmp_path).new("assistant")
    conv["messages"] = [
        {"type": "user", "text": "a"}, {"type": "user", "text": "b"},
        {"type": "assistant", "role": "assistant", "text": "x", "cards": []},
        {"type": "role", "from": "assistant", "to": "director"},
        {"type": "assistant", "role": "director", "text": "y", "cards": []},
    ]
    assert C.history(conv, files) == [{"role": "user", "content": "a\n\nb"}, {"role": "assistant", "content": "x\n\ny"}]


def test_refused_turns(tmp_path, files):
    a = make(tmp_path, files, ScriptedLlm())
    with pytest.raises(C.ChatError, match="Write a message"):
        a.prepare({"text": " "})
    with pytest.raises(C.ChatError, match="Unknown role"):
        a.prepare({"text": "x", "role": "nobody"})
    with pytest.raises(ValueError):
        a.prepare({"text": "x", "attachments": ["inputs/missing.png"]})
    with pytest.raises(C.ChatError, match="Unknown conversation"):
        a.prepare({"text": "x", "conversation": "../etc"})


# ── HTTP ──────────────────────────────────────────────────────────────────────

def test_chat_api(settings, store):
    llm = ScriptedLlm(routes=[{"role": "assistant", "confidence": 1}],
                      streams=[[("text", "Hi."), tool("create_image", {"prompt": "a red fox"})]])
    with TestClient(create_app(settings, models=store, pipelines={}, llm=llm)) as c:
        assert c.post("/api/chat", json={"text": "hi"}, headers={"Origin": "http://evil.example"}).status_code == 403
        assert c.post("/api/chat", json={"text": ""}, headers=SAME_ORIGIN).status_code == 422
        res = c.post("/api/chat", json={"text": "a fox"}, headers=SAME_ORIGIN)
        assert res.headers["content-type"].startswith("text/event-stream")
        events = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]
        cid = events[0]["id"]
        assert [e["type"] for e in events] == ["conversation", "role", "text", "card", "done"]
        assert c.get("/api/chats").json()[0]["id"] == cid
        assert c.get(f"/api/chats/{cid}").json()["title"] == "a fox"
        assert c.post(f"/api/chats/{cid}/cards/C1", json={"status": "running"}, headers=SAME_ORIGIN).json()["state"] == {"status": "running"}
        assert c.post(f"/api/chats/{cid}/cards/C7", json={"status": "running"}, headers=SAME_ORIGIN).status_code == 404
        assert c.post(f"/api/chats/{cid}/cards/C1", json={"status": "launched"}, headers=SAME_ORIGIN).json()["state"] == {"status": "launched"}
        assert c.post(f"/api/chats/{cid}/cards/C1", json={"status": "flying"}, headers=SAME_ORIGIN).status_code == 422
        assert [r["id"] for r in c.get("/api/roles").json()][:2] == ["ad_director", "assistant"]
        text = "---\nid: assistant\nname: Front desk\nwhen: anything\n---\nHello."
        roles = c.put("/api/roles/assistant", json={"text": text}, headers=SAME_ORIGIN).json()
        assert next(r for r in roles if r["id"] == "assistant")["replaced"] is True
        assert c.put("/api/roles/assistant", json={"text": "bad"}, headers=SAME_ORIGIN).status_code == 422
        c.delete("/api/roles/assistant", headers=SAME_ORIGIN)
        assert next(r for r in c.get("/api/roles").json() if r["id"] == "assistant")["name"] == "General assistant"
        assert c.delete(f"/api/chats/{cid}", headers=SAME_ORIGIN).json() == {"deleted": cid}
        assert c.get(f"/api/chats/{cid}").status_code == 404
        assert c.get("/api/health").json()["llm_model"] == "gemma4-26b-a4b"


def test_a_sheet_card_without_its_photo_takes_the_attached_image(tmp_path, files):
    ref = files.save_input(PNG)["ref"]
    llm = ScriptedLlm(streams=[[tool("character_sheet", {"description": "an anime girl"})]])
    conv, events = run(make(tmp_path, files, llm), {"text": "a sheet from this image", "attachments": [ref], "role": "casting"})
    card = next(e["card"] for e in events if e["type"] == "card")
    assert card["args"]["photo"] == ["A1"] and card["warnings"] == ["photo A1 taken from the attached image"]


def test_character_sheet_takes_a_photo():
    args, warnings = T.normalize("character_sheet", {"description": "a red coat", "photo": ["A1"]}, lambda r: True)
    assert args["photo"] == ["A1"] and not warnings
    args, _ = T.normalize("character_sheet", {"description": "a red coat"}, lambda r: True)
    assert "photo" not in args


def test_storyboard_card_takes_the_conversation_sheets():
    args, warnings = T.normalize("storyboard", {"brief": "x", "subject_sheets": ["C2#1", "A1"], "setting_sheet": ["C9#1"]},
                                 lambda r: r != "C9#1")
    assert args["subject_sheets"] == ["C2#1", "A1"] and args["setting_sheet"] == ["C9#1"]
    assert warnings == ["C9#1 is not in the reference table"]
    _, warnings = T.normalize("storyboard", {"brief": "x", "setting_sheet": ["A1", "A2"]}, lambda r: True)
    assert warnings == ["setting_sheet: only the first 1 kept"]
