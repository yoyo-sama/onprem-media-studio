"""The creative assistant's conversations: storage, role routing and one turn.

A turn: the user's message is stored; unless the user pinned a role, a short LLM
call picks the role best placed to answer (the current one is kept unless the
request clearly belongs to another); the role answers in a streamed completion
with its tools. Tool calls become cards (generation, question) or a handoff to
another role, which then answers in the same turn. Nothing here submits a job:
the browser runs a card only when the user clicks it, then reports its outputs
here so the next turns know them.
"""

import base64
import json
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path

from ..files import FileStore
from ..llm import LlmError
from ..models import ModelError
from . import tools as T
from .roles import DEFAULT_ROLE, Role, RoleError, Roles

CONV_ID = re.compile(r"c-[0-9]{13}-[0-9a-f]{6}")
CARD_ID = re.compile(r"C[0-9]{1,4}")
REF_ID = re.compile(r"(A[0-9]{1,4})|(C[0-9]{1,4})#([0-9]{1,2})")
MAX_TEXT = 8000
MAX_ATTACHMENTS = 6
MAX_IMAGES_SENT = 4           # images of the last user message sent to the LLM's vision
HISTORY_CHARS = 60_000        # conversation sent to the LLM, newest first
ROUTE_CONFIDENCE = 0.5        # below it, the current role keeps the conversation
CARD_STATUSES = {"proposed", "running", "done", "error", "cancelled", "opened", "launched", "answered"}
# The interface addresses the user informally in French, Spanish and German: the roles too.
LANGUAGES = {"en": "English", "fr": "French (informal: address the user as « tu », never « vous »)",
             "es": "Spanish (informal: address the user as « tú », never « usted »)",
             "de": "German (informal: address the user as « du », never « Sie »)"}
VIDEO = (".mp4", ".webm", ".mov")


class ChatError(ValueError):
    pass


LOST_JOB = "the server restarted during this job, which was lost: launch it again"


def _now() -> float:
    return round(time.time(), 3)


class Conversations:
    """One JSON file per conversation in STUDIO_DATA_DIR/chats/."""

    def __init__(self, folder: Path):
        self.folder = folder
        self._lock = threading.Lock()
        # Jobs live in the server's memory: a card left running before this start lost its job.
        self.started = time.time()

    def path(self, cid: str) -> Path:
        if not CONV_ID.fullmatch(cid or ""):
            raise ChatError(f"Unknown conversation: {cid}")
        return self.folder / f"{cid}.json"

    def new(self, role: str) -> dict:
        cid = f"c-{int(time.time() * 1000)}-{secrets.token_hex(3)}"
        return {"id": cid, "title": "", "created": _now(), "updated": _now(), "role": role,
                "next_card": 1, "next_attachment": 1, "messages": []}

    def load(self, cid: str) -> dict:
        try:
            conv = json.loads(self.path(cid).read_text())
        except (OSError, ValueError) as exc:
            raise ChatError(f"Unknown conversation: {cid}") from exc
        # Without this, a card whose render was lost to a restart stayed running, its
        # button disabled for good.
        for m in conv["messages"]:
            for card in m.get("cards") or []:
                st = card.get("state") or {}
                if st.get("status") == "running" and st.get("since", 0) < self.started:
                    card["state"] = {"status": "error", "error": LOST_JOB}
        return conv

    def save(self, conv: dict) -> None:
        """Write a conversation a turn kept in memory. A turn lasts as long as Gemma's
        answer, and the browser may report a card's render meanwhile (`update`): a card
        whose state on disk is newer than the turn's copy keeps the disk's state and
        arguments, merged into `conv` too, so the next save of the same turn keeps them."""
        with self._lock:
            try:
                stored = json.loads(self.path(conv["id"]).read_text())
            except (OSError, ValueError):
                stored = None
            if stored:
                newer = {c["id"]: c for m in stored.get("messages", []) for c in m.get("cards") or []}
                for m in conv["messages"]:
                    for card in m.get("cards") or []:
                        disk = newer.get(card["id"])
                        if disk and disk.get("changed", 0) > card.get("changed", 0):
                            card.update({k: disk[k] for k in ("state", "args", "changed") if k in disk})
            self._write(conv)

    def update(self, cid: str, change) -> dict:
        """Load, change and write a conversation as one step, so that a turn's save cannot
        fall between the load and the write. `change(conv)` returns what update returns."""
        with self._lock:
            conv = self.load(cid)
            out = change(conv)
            self._write(conv)
            return out

    def _write(self, conv: dict) -> None:
        conv["updated"] = _now()
        self.folder.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.folder, prefix=".chat-")
        with os.fdopen(fd, "w") as f:
            json.dump(conv, f, ensure_ascii=False)
        os.replace(tmp, self.path(conv["id"]))

    def listing(self) -> list[dict]:
        out = []
        for p in self.folder.glob("c-*.json") if self.folder.is_dir() else []:
            try:
                c = json.loads(p.read_text())
                out.append({k: c[k] for k in ("id", "title", "updated", "role")})
            except (OSError, ValueError, KeyError):
                continue
        return sorted(out, key=lambda c: -c["updated"])

    def delete(self, cid: str) -> None:
        self.path(cid).unlink(missing_ok=True)


def find_card(conv: dict, card_id: str) -> dict:
    for msg in conv["messages"]:
        for card in msg.get("cards", []):
            if card["id"] == card_id:
                return card
    raise ChatError(f"Unknown card: {card_id}")


# ── References ────────────────────────────────────────────────────────────────
# Images the user attached are A1, A2…; a card's outputs are C3#1, C3#2… (an H3 clip
# is followed by its last frame). The model names images by these ids only.

def references(conv: dict) -> list[tuple[str, str, str]]:
    """(id, kind, note) of every image and clip of the conversation, oldest first."""
    out = []
    for msg in conv["messages"]:
        for att in msg.get("attachments", []):
            out.append((att["id"], "image", "attached by the user"))
        for card in msg.get("cards", []):
            if card["tool"] not in T.GENERATION_TOOLS:
                continue
            outputs = card["state"].get("outputs") or []
            for k, ref in enumerate(outputs, 1):
                video = ref.lower().endswith(VIDEO)
                note = f"result {k} of card {card['id']} ({card['tool']})"
                if not video and k > 1 and outputs[k - 2].lower().endswith(VIDEO):
                    note = f"last frame of {card['id']}#{k - 1}"
                out.append((f"{card['id']}#{k}", "video" if video else "image", note))
    return out


def resolve_id(conv: dict, ref_id: str) -> str | None:
    """File reference (inputs/…, outputs/…) of an image id, None if it has none (yet)."""
    for msg in conv["messages"]:
        for att in msg.get("attachments", []):
            if att["id"] == ref_id:
                return att["ref"]
    m = REF_ID.fullmatch(ref_id)
    if m and m.group(2):
        try:
            outputs = find_card(conv, m.group(2))["state"].get("outputs") or []
        except ChatError:
            return None
        k = int(m.group(3))
        return outputs[k - 1] if 1 <= k <= len(outputs) else None
    return None


def known_id(conv: dict, ref_id: str) -> bool:
    """An attached image, or an output of a generation card (rendered or still to run:
    a card can wait for an earlier card's result)."""
    m = REF_ID.fullmatch(ref_id or "")
    if not m:
        return False
    if m.group(1):
        return any(a["id"] == ref_id for msg in conv["messages"] for a in msg.get("attachments", []))
    try:
        return find_card(conv, m.group(2))["tool"] in T.GENERATION_TOOLS and int(m.group(3)) >= 1
    except ChatError:
        return False


def references_text(conv: dict) -> str:
    rows = references(conv)
    pending = [c["id"] for msg in conv["messages"] for c in msg.get("cards", [])
               if c["tool"] in T.GENERATION_TOOLS and c["state"]["status"] in ("proposed", "running")]
    lines = [f"- {rid}: {kind}, {note}" for rid, kind, note in rows] or ["- (no image yet)"]
    if pending:
        lines.append(f"- Cards not rendered yet: {', '.join(pending)} (their results will be <card>#1, #2…)")
    return "\n".join(lines)


# ── Prompt building ───────────────────────────────────────────────────────────

def system_prompt(roles: Roles, role: Role, conv: dict, app_name: str, lang: str, handoff: str = "") -> str:
    others = "\n".join(f"- {r.id} ({r.name}): {r.when}" for r in roles.all().values() if r.id != role.id)
    common = roles.common()
    for key, value in {"app_name": app_name, "language": LANGUAGES.get(lang, "English"),
                       "engines": T.engines_text(list(role.tools)), "references": references_text(conv),
                       "role_name": role.name, "roles": others}.items():
        common = common.replace("{" + key + "}", value)
    out = f"{common}\n\n# Your role: {role.name}\n\n{role.prompt}"
    if handoff:
        out += f"\n\n# Handoff\n\nYou take over this conversation now. Goal: {handoff}"
    return out


def card_summary(card: dict) -> str:
    """What the model is told about a card it proposed (the tool's result)."""
    if card.get("invalid"):
        return f"Rejected, no card shown: {card['invalid']}. Fix the call if it is still needed."
    st = card["state"]
    if card["tool"] == "ask_choices":
        return ("Question shown to the user; their answer is their next message." if st["status"] != "answered"
                else f"The user answered: {st.get('answer', '')}")
    text = f"Card {card['id']} shown to the user"
    if card.get("warnings"):
        text += f" (adjusted: {'; '.join(card['warnings'])})"
    status = st["status"]
    if status == "proposed":
        return text + ". Not run yet: the user starts it with a click."
    if status == "opened":
        return text + ". The user opened it in the Studio form to go on there."
    if status == "launched":
        return text + ". The user launched the director with it: the step-by-step review goes on in the Studio."
    if status == "running":
        return text + ". Rendering now."
    if status == "done":
        n = len(st.get("outputs") or [])
        return text + f". Rendered: {n} file(s), ids {card['id']}#1 to {card['id']}#{n}."
    if status == "cancelled":
        return text + ". Cancelled by the user."
    return text + f". The render failed: {st.get('error') or 'unknown error'}."


def _image_part(files: FileStore, ref: str) -> dict | None:
    try:
        path = files.resolve(ref)
    except ValueError:
        return None
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(path.suffix.lower())
    if not mime:
        return None
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"}}


def history(conv: dict, files: FileStore) -> list[dict]:
    """The conversation as chat messages: consecutive turns of one side merged (chat
    templates want user and assistant to alternate), tool results after each call,
    the images of the last user message attached for the model's vision."""
    msgs: list[dict] = []
    last_user = max((i for i, m in enumerate(conv["messages"]) if m["type"] == "user"), default=-1)
    for i, m in enumerate(conv["messages"]):
        if m["type"] == "user":
            text = m["text"]
            if m.get("attachments"):
                text += "\n[Attached: " + ", ".join(a["id"] for a in m["attachments"]) + "]"
            content: list | str = text
            if i == last_user and m.get("attachments"):
                parts = [p for a in m["attachments"][:MAX_IMAGES_SENT] if (p := _image_part(files, a["ref"]))]
                if parts:
                    content = [{"type": "text", "text": text}, *parts]
            if msgs and msgs[-1]["role"] == "user" and isinstance(content, str) and isinstance(msgs[-1]["content"], str):
                msgs[-1]["content"] += "\n\n" + content
            else:
                msgs.append({"role": "user", "content": content})
        elif m["type"] == "assistant" and (m.get("text") or m.get("cards")):
            calls = [c for c in m.get("cards", []) if c.get("call_id")]
            entry = {"role": "assistant", "content": m.get("text", "")}
            if calls:
                entry["tool_calls"] = [{"id": c["call_id"], "type": "function",
                                        "function": {"name": c["tool"], "arguments": json.dumps(c.get("args") or {})}}
                                       for c in calls]
            prev = msgs[-1] if msgs else None
            if prev and prev["role"] == "assistant" and "tool_calls" not in prev:
                prev["content"] = (prev["content"] + "\n\n" + entry["content"]).strip()
                if calls:
                    prev["tool_calls"] = entry["tool_calls"]
            else:
                msgs.append(entry)
            for c in calls:
                msgs.append({"role": "tool", "tool_call_id": c["call_id"], "content": card_summary(c)})
    # Oldest messages dropped first, never splitting a call from its result.
    while len(json.dumps(msgs)) > HISTORY_CHARS and len(msgs) > 1:
        msgs.pop(0)
        while msgs and msgs[0]["role"] != "user":
            msgs.pop(0)
    return msgs


ROUTER_SYSTEM = """You route the messages of a creative image and video studio to the role best placed to answer.

Roles:
{roles}

The current role is {current}. Keep it unless the last user message clearly belongs to another role.
Answer with JSON only: {{"role": "<role id>", "confidence": <0 to 1>}}"""


def route(llm, roles: dict[str, Role], conv: dict, current: str | None) -> tuple[str, float]:
    """(role id, confidence) for the last user message; the current role when unsure."""
    listing = "\n".join(f"- {r.id}: {r.when}" for r in roles.values())
    lines = []
    for m in conv["messages"][-7:]:
        if m["type"] in ("user", "assistant"):
            who = "User" if m["type"] == "user" else f"Assistant ({m.get('role')})"
            lines.append(f"{who}: {m.get('text', '')[:600]}")
    try:
        raw = llm.chat(ROUTER_SYSTEM.format(roles=listing, current=current or "none"),
                       "\n".join(lines) or "(empty)", [], True, 0.0)
        data = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
        rid, conf = data.get("role"), float(data.get("confidence", 0))
    except (LlmError, ModelError, ValueError, TypeError, AttributeError):
        return current or DEFAULT_ROLE, 0.0
    if rid not in roles:
        return current or DEFAULT_ROLE, 0.0
    return rid, conf


# ── One turn ──────────────────────────────────────────────────────────────────

class Assistant:
    def __init__(self, llm, roles: Roles, conversations: Conversations, files: FileStore, app_name: str):
        self.llm, self.roles, self.conversations, self.files, self.app_name = llm, roles, conversations, files, app_name

    def prepare(self, body: dict) -> tuple[dict, dict]:
        """Checks a turn request and stores the user's message; ChatError if refused."""
        text = (body.get("text") or "").strip()
        attachments = body.get("attachments") or []
        if not text and not attachments:
            raise ChatError("Write a message or attach an image")
        if len(text) > MAX_TEXT:
            raise ChatError(f"A message is at most {MAX_TEXT} characters long")
        if not isinstance(attachments, list) or len(attachments) > MAX_ATTACHMENTS:
            raise ChatError(f"At most {MAX_ATTACHMENTS} images per message")
        for ref in attachments:
            self.files.resolve(ref)  # ValueError → 422
        roles = self.roles.all()
        pinned = body.get("role")
        if pinned is not None and pinned not in roles:
            raise ChatError(f"Unknown role: {pinned}")
        conv = (self.conversations.load(body["conversation"]) if body.get("conversation")
                else self.conversations.new(pinned or DEFAULT_ROLE))
        if conv.get("role") not in roles:
            conv["role"] = DEFAULT_ROLE
        answer_to = body.get("answer_to")
        if answer_to:
            card = find_card(conv, answer_to)
            if card["tool"] != "ask_choices":
                raise ChatError(f"{answer_to} is not a question")
            card["state"], card["changed"] = {"status": "answered", "answer": text}, time.time()
        atts = []
        for ref in attachments:
            atts.append({"id": f"A{conv['next_attachment']}", "ref": ref})
            conv["next_attachment"] += 1
        user = {"type": "user", "text": text, "attachments": atts, "time": _now()}
        if answer_to:
            user["answer_to"] = answer_to
        conv["messages"].append(user)
        if not conv["title"]:
            conv["title"] = (text or "Image")[:60]
        self.conversations.save(conv)
        return conv, {"pinned": pinned, "lang": body.get("lang", "en"), "answer_to": answer_to}

    def turn(self, conv: dict, opts: dict):
        """Events of one turn, as dicts: conversation, role, text, card, error, done."""
        yield {"type": "conversation", "id": conv["id"], "title": conv["title"],
               "message": conv["messages"][-1]}
        roles = self.roles.all()
        current = conv["role"]
        if opts["pinned"]:
            target, auto = opts["pinned"], False
        elif opts["answer_to"]:
            target, auto = current, True
        else:
            target, conf = route(self.llm, roles, conv, current)
            auto = True
            if target != current and conf < ROUTE_CONFIDENCE and any(m["type"] == "assistant" for m in conv["messages"]):
                target = current
        if target != current:
            yield from self._switch(conv, current, target, auto)
        yield {"type": "role", "role": conv["role"], "auto": auto, "changed": False}
        handoff, goal = 0, ""
        while True:
            role = roles[conv["role"]]
            msg = {"type": "assistant", "role": role.id, "text": "", "cards": [], "time": _now()}
            next_role = None
            try:
                system = system_prompt(self.roles, role, conv, self.app_name, opts["lang"], goal)
                tools = T.specs(tools_of(role))
                for kind, value in self.llm.stream([{"role": "system", "content": system}, *history(conv, self.files)],
                                                   tools):
                    if kind == "text":
                        msg["text"] += value
                        yield {"type": "text", "delta": value}
                    elif value["name"] == "handoff" and handoff == 0 and next_role is None:
                        args = _json(value["arguments"])
                        if args.get("role") in roles and args["role"] != role.id:
                            next_role, goal = args["role"], str(args.get("goal") or "")[:500]
                    else:
                        card = self._card(conv, value)
                        if card:
                            msg["cards"].append(card)
                            yield {"type": "card", "card": card}
                # Gemma sometimes writes the call as JSON in its text instead of calling
                # the tool: the block becomes the card it meant, and leaves the text.
                if not msg["cards"] and next_role is None:
                    calls, msg["text"] = text_tool_calls(msg["text"], [n for n in tools_of(role) if n != "handoff"])
                    for call in calls:
                        card = self._card(conv, call)
                        msg["cards"].append(card)
                        yield {"type": "card", "card": card}
            except (LlmError, ModelError) as exc:
                # Kept in the conversation, so a failed answer does not vanish on reload.
                msg["error"] = str(exc)
                yield {"type": "error", "message": str(exc)}
                next_role = None
            finally:
                if msg["text"].strip() or msg["cards"] or msg.get("error"):
                    msg["text"] = msg["text"].strip()
                    conv["messages"].append(msg)
                self.conversations.save(conv)
            if not next_role:
                break
            handoff += 1
            yield from self._switch(conv, conv["role"], next_role, True, goal)
            yield {"type": "role", "role": conv["role"], "auto": True, "changed": False}
        yield {"type": "done"}

    def _switch(self, conv: dict, old: str, new: str, auto: bool, goal: str = ""):
        event = {"type": "role", "from": old, "to": new, "auto": auto, "time": _now()}
        if goal:
            event["goal"] = goal
        conv["messages"].append(event)
        conv["role"] = new
        self.conversations.save(conv)
        yield {"type": "role", "role": new, "from": old, "auto": auto, "changed": True, "goal": goal}

    def _card(self, conv: dict, call: dict) -> dict | None:
        card = {"id": f"C{conv['next_card']}", "tool": call["name"], "call_id": call["id"],
                "args": {}, "warnings": [], "state": {"status": "proposed"}, "changed": time.time()}
        try:
            if call["name"] == "handoff":
                raise T.ToolError("one handoff per answer, to another known role")
            card["args"], card["warnings"] = T.normalize(call["name"], call["arguments"], lambda r: known_id(conv, r))
            # Gemma often leaves out the photo the user just attached for a sheet: the
            # message's only image is that photo.
            if call["name"] == "character_sheet" and not card["args"].get("photo"):
                user = next((m for m in reversed(conv["messages"]) if m["type"] == "user"), None)
                atts = (user or {}).get("attachments") or []
                if len(atts) == 1:
                    card["args"]["photo"] = [atts[0]["id"]]
                    card["warnings"].append(f"photo {atts[0]['id']} taken from the attached image")
        except T.ToolError as exc:
            card["invalid"] = str(exc)
            card["args"] = _json(call["arguments"])
        conv["next_card"] += 1
        return card


def tools_of(role: Role) -> list[str]:
    return T.CONVERSATION_TOOLS + list(role.tools)


# A JSON object in a ```json fence, or alone at the end of the text.
JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```|(?:^|\n)(\{.*\})\s*$", re.S)
NAME_KEYS = ("name", "tool", "type", "function")
ARG_KEYS = ("arguments", "args", "parameters", "props", "input")


def text_tool_calls(text: str, allowed: list[str]) -> tuple[list[dict], str]:
    """Tool calls the model wrote as JSON in its text ({"type": "video_from_image",
    "props": {...}} and the like), and the text without them. Only the tools of the
    role; anything else stays text."""
    calls, kept, last = [], [], 0
    for m in JSON_BLOCK.finditer(text):
        try:
            data = json.loads(m.group(1) or m.group(2))
        except ValueError:
            continue
        if not isinstance(data, dict):
            continue
        if isinstance(data.get("function"), dict):
            data = data["function"]
        name = next((data[k] for k in NAME_KEYS if isinstance(data.get(k), str) and data[k] in allowed), None)
        args = next((data[k] for k in ARG_KEYS if k in data), None)
        if isinstance(args, str):
            args = _json(args)
        if not name or not isinstance(args, dict):
            continue
        calls.append({"id": f"text_{len(calls) + 1}", "name": name, "arguments": args})
        kept.append(text[last:m.start()])
        last = m.end()
    kept.append(text[last:])
    return calls, "".join(kept).strip() if calls else text


def _json(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        out = json.loads(raw or "{}")
        return out if isinstance(out, dict) else {}
    except ValueError:
        return {}


def update_card(conversations: Conversations, files: FileStore, cid: str, card_id: str, body: dict) -> dict:
    """The browser reports what became of a card: running, done with its outputs, error…"""
    if not CARD_ID.fullmatch(card_id):
        raise ChatError(f"Unknown card: {card_id}")
    return conversations.update(cid, lambda conv: _set_card(conv, files, card_id, body))


def _set_card(conv: dict, files: FileStore, card_id: str, body: dict) -> dict:
    card = find_card(conv, card_id)
    status = body.get("status")
    if status not in CARD_STATUSES:
        raise ChatError(f"status must be one of {', '.join(sorted(CARD_STATUSES))}")
    outputs = body.get("outputs") or []
    if not isinstance(outputs, list) or len(outputs) > 64:
        raise ChatError("outputs must be a list of file references")
    for ref in outputs:
        files.resolve(ref)
    state = {"status": status}
    if status == "running":
        state["since"] = time.time()
    if outputs:
        state["outputs"] = outputs
    if body.get("error"):
        state["error"] = str(body["error"])[:500]
    if isinstance(body.get("args"), dict) and card["tool"] in T.GENERATION_TOOLS:
        # The user edited the card before running it: what ran is what the model must know.
        card["args"], _ = T.normalize(card["tool"], body["args"], lambda r: known_id(conv, r))
    card["state"], card["changed"] = state, time.time()
    return card


# ── HTTP ──────────────────────────────────────────────────────────────────────

def router(assistant: Assistant):
    from fastapi import APIRouter, Depends, HTTPException
    from fastapi.responses import StreamingResponse
    from pydantic import BaseModel

    from ..guard import same_origin

    class TurnBody(BaseModel):
        conversation: str | None = None
        text: str = ""
        attachments: list[str] = []
        role: str | None = None
        answer_to: str | None = None
        lang: str = "en"

    class RoleBody(BaseModel):
        text: str

    class CardBody(BaseModel):
        status: str
        outputs: list[str] = []
        error: str | None = None
        args: dict | None = None

    api = APIRouter(prefix="/api")
    write = [Depends(same_origin)]
    roles, conversations, files = assistant.roles, assistant.conversations, assistant.files

    def fail(exc: Exception):
        raise HTTPException(404 if "Unknown" in str(exc) else 422, str(exc))

    @api.get("/roles")
    def list_roles():
        return [r.public() for r in roles.all().values()]

    @api.put("/roles/{rid}", dependencies=write)
    def put_role(rid: str, body: RoleBody):
        try:
            return [r.public() for r in roles.set(rid, body.text).values()]
        except RoleError as exc:
            raise HTTPException(422, str(exc))

    @api.delete("/roles/{rid}", dependencies=write)
    def delete_role(rid: str):
        try:
            return [r.public() for r in roles.set(rid, None).values()]
        except RoleError as exc:
            raise HTTPException(422, str(exc))

    @api.get("/chats")
    def list_chats():
        return conversations.listing()

    @api.get("/chats/{cid}")
    def get_chat(cid: str):
        try:
            return conversations.load(cid)
        except ChatError as exc:
            fail(exc)

    @api.delete("/chats/{cid}", dependencies=write)
    def delete_chat(cid: str):
        try:
            conversations.delete(cid)
        except ChatError as exc:
            fail(exc)
        return {"deleted": cid}

    @api.post("/chats/{cid}/cards/{card_id}", dependencies=write)
    def set_card(cid: str, card_id: str, body: CardBody):
        try:
            return update_card(conversations, files, cid, card_id, body.model_dump())
        except (ChatError, T.ToolError, ValueError) as exc:
            fail(exc)

    @api.post("/chat", dependencies=write)
    def chat(body: TurnBody):
        try:
            conv, opts = assistant.prepare(body.model_dump())
        except (ChatError, ValueError) as exc:
            fail(exc)

        def events():
            for event in assistant.turn(conv, opts):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return api
