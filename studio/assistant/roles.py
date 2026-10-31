"""Roles of the creative assistant: one Markdown file each.

    ---
    id: director
    name: Director
    when: one sentence the router reads to pick this role
    tools: storyboard, reference_video
    ---
    The role's instructions (system prompt), sent as written.

The roles shipped with the app live in studio/assistant/roles/; a file with the same id in
STUDIO_DATA_DIR/roles/ replaces one, a new id adds one. Deleting the replacement
brings the original back. `_common.md` is not a role: it is the block the code
puts around every role (rules, tools, references), and is not replaceable.
"""

import os
import re
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

from .tools import GENERATION_TOOLS

BUILTIN_DIR = Path(__file__).with_name("roles")
ID = re.compile(r"[a-z0-9_]{1,40}")
MAX_CHARS = 20_000
MAX_ROLES = 24
DEFAULT_ROLE = "assistant"


class RoleError(ValueError):
    pass


@dataclass(frozen=True)
class Role:
    id: str
    name: str
    when: str
    tools: tuple[str, ...]
    prompt: str
    text: str           # the whole file, as edited in the settings
    builtin: bool       # shipped with the app
    replaced: bool      # a file in the data directory takes its place

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "when": self.when, "tools": list(self.tools),
                "text": self.text, "builtin": self.builtin, "replaced": self.replaced}


def parse(text: str, builtin: bool = False, replaced: bool = False) -> Role:
    """A role from its file text; RoleError says what is wrong."""
    if len(text) > MAX_CHARS:
        raise RoleError(f"A role must be at most {MAX_CHARS} characters long")
    m = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", text.replace("\r\n", "\n"), re.S)
    if not m:
        raise RoleError("A role starts with a header between two --- lines")
    head = {}
    for line in m.group(1).splitlines():
        if line.strip():
            key, sep, value = line.partition(":")
            if not sep:
                raise RoleError(f"Header line without a colon: {line!r}")
            head[key.strip()] = value.strip()
    for key in ("id", "name", "when"):
        if not head.get(key):
            raise RoleError(f"The header needs {key}")
    if not ID.fullmatch(head["id"]):
        raise RoleError("Role id: 1 to 40 lowercase letters, digits or underscores")
    tools = tuple(t.strip() for t in head.get("tools", "").split(",") if t.strip())
    unknown = [t for t in tools if t not in GENERATION_TOOLS]
    if unknown:
        raise RoleError(f"Unknown tool(s): {', '.join(unknown)} (known: {', '.join(GENERATION_TOOLS)})")
    prompt = m.group(2).strip()
    if not prompt:
        raise RoleError("The role's instructions are empty")
    return Role(head["id"], head["name"], head["when"], tools or tuple(GENERATION_TOOLS), prompt, text,
                builtin, replaced)


class Roles:
    def __init__(self, data_dir: Path, builtin_dir: Path = BUILTIN_DIR):
        self.user_dir = data_dir / "roles"
        self.builtin_dir = builtin_dir
        self._lock = threading.Lock()

    def common(self) -> str:
        return (self.builtin_dir / "_common.md").read_text()

    def _files(self, folder: Path) -> dict[str, Path]:
        if not folder.is_dir():
            return {}
        return {p.stem: p for p in sorted(folder.glob("*.md")) if not p.name.startswith("_")}

    def all(self) -> dict[str, Role]:
        """Every role by id, shipped ones first. A broken replacement falls back to the
        original (a broken new role is left out) instead of breaking the assistant."""
        builtin, user = self._files(self.builtin_dir), self._files(self.user_dir)
        out = {}
        for rid in [*builtin, *(r for r in user if r not in builtin)]:
            role = None
            if rid in user:
                try:
                    role = parse(user[rid].read_text(), rid in builtin, rid in builtin)
                except (RoleError, OSError):
                    pass
            if role is None and rid in builtin:
                role = parse(builtin[rid].read_text(), True)
            if role is not None and role.id == rid:
                out[rid] = role
        return out

    def get(self, rid: str) -> Role:
        roles = self.all()
        if rid not in roles:
            raise RoleError(f"Unknown role: {rid}")
        return roles[rid]

    def set(self, rid: str, text: str | None) -> dict[str, Role]:
        """Saves `text` as role `rid`, or removes the replacement when `text` is None."""
        if not ID.fullmatch(rid):
            raise RoleError("Role id: 1 to 40 lowercase letters, digits or underscores")
        with self._lock:
            path = self.user_dir / f"{rid}.md"
            if text is None:
                path.unlink(missing_ok=True)
                return self.all()
            role = parse(text)
            if role.id != rid:
                raise RoleError(f"The header says id: {role.id}, the file is {rid}")
            if rid not in self.all() and len(self.all()) >= MAX_ROLES:
                raise RoleError(f"At most {MAX_ROLES} roles")
            self.user_dir.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.user_dir, prefix=".role-")
            with os.fdopen(fd, "w") as f:
                f.write(text)
            os.replace(tmp, path)
            return self.all()
