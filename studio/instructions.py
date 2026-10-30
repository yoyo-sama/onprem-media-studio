"""Gemma instructions edited in the interface, one per engine.

The default instructions live in the front end (web/js/prompts.js, ADR 0001); this
module only stores the texts the user replaced, in STUDIO_DATA_DIR/instructions.json,
so every browser and both pages use the same ones. Removing an entry brings the
default back.
"""

import json
import os
import re
import tempfile
import threading
from pathlib import Path

NAME = re.compile(r"[a-z0-9_]{1,40}")
MAX_CHARS = 20_000
MAX_ENTRIES = 32


class Instructions:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def all(self) -> dict[str, str]:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return {}
        return {k: v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}

    def set(self, name: str, text: str | None) -> dict[str, str]:
        """Stores `text` for `name`, or removes it when `text` is None."""
        if not NAME.fullmatch(name):
            raise ValueError("Instruction name: 1 to 40 lowercase letters, digits or underscores")
        if text is not None and not (text.strip() and len(text) <= MAX_CHARS):
            raise ValueError(f"The instruction must be 1 to {MAX_CHARS} characters long")
        with self._lock:
            data = self.all()
            if text is None:
                data.pop(name, None)
            else:
                if name not in data and len(data) >= MAX_ENTRIES:
                    raise ValueError(f"At most {MAX_ENTRIES} instructions")
                data[name] = text
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".instructions-")
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)
            return data


def router(store: Instructions):
    from fastapi import APIRouter, Depends, HTTPException
    from pydantic import BaseModel

    from .guard import same_origin

    class Body(BaseModel):
        text: str

    api = APIRouter(prefix="/api/instructions")

    @api.get("")
    def listing():
        return store.all()

    @api.put("/{name}", dependencies=[Depends(same_origin)])
    def put(name: str, body: Body):
        try:
            return store.set(name, body.text)
        except ValueError as exc:
            raise HTTPException(422, str(exc))

    @api.delete("/{name}", dependencies=[Depends(same_origin)])
    def delete(name: str):
        try:
            return store.set(name, None)
        except ValueError as exc:
            raise HTTPException(422, str(exc))

    return api
