"""LoRA files: list, upload, and the stack a job sends. Port of the 1.4 updater's
upload route.

Each engine family that takes LoRAs has its folder, STUDIO_DATA_DIR/loras/<folder>/
(MiniMax H3: loras/h3/, applied by studio/pipelines/h3_lora.py; Krea 2, Qwen Image 2.1
and MOSS-Image: loras/krea2/, loras/qwen21/, loras/moss/, see image_lora.py). A job sends a stack,
`loras: [{"name": <file name>, "strength": <number>}]`, at most MAX_STACK entries,
which every engine validates with check_stack(). An upload never replaces an
existing file.
"""

import os
import tempfile
from pathlib import Path

FOLDERS = {"h3", "krea2", "qwen21", "moss"}
SUFFIX = ".safetensors"
MAX_BYTES = 8 * 1024**3
MAX_STACK = 4
MIN_STRENGTH, MAX_STRENGTH = -2.0, 2.0


def check_name(name: str) -> str:
    if not isinstance(name, str) or Path(name).name != name or name.startswith(".") or not name.endswith(SUFFIX) \
            or len(name) > 200 or len(name) <= len(SUFFIX):
        raise ValueError(f"The file name must be a bare name ending in {SUFFIX}")
    return name


def check_stack(loras, root: Path, folder: str) -> list[dict]:
    """Validated stack: [{"name", "strength"}], every file inside root/folder, each once."""
    if not isinstance(loras, list) or len(loras) > MAX_STACK:
        raise ValueError(f"loras must be a list of at most {MAX_STACK} entries")
    out = []
    for item in loras:
        if not isinstance(item, dict) or set(item) - {"name", "strength"}:
            raise ValueError('Each LoRA is {"name": <file name>, "strength": <number>}')
        name, strength = item.get("name"), item.get("strength", 1.0)
        try:
            check_name(name)
        except ValueError:
            raise ValueError(f"LoRA name must be a {SUFFIX} file name in loras/{folder}/, got {name!r}")
        if not (root / folder / name).is_file():
            raise ValueError(f"No such LoRA: loras/{folder}/{name}")
        if any(x["name"] == name for x in out):
            raise ValueError(f"LoRA {name} is listed twice: give it one strength instead")
        if isinstance(strength, bool) or not isinstance(strength, (int, float)) \
                or not MIN_STRENGTH <= strength <= MAX_STRENGTH:
            raise ValueError(f"LoRA strength must be a number between {MIN_STRENGTH:g} and {MAX_STRENGTH:g}")
        out.append({"name": name, "strength": float(strength)})
    return out


def describe(loras: list[dict]) -> str:
    """The stack for log lines and progress messages: "a.safetensors ×0.8, b.safetensors ×1"."""
    return ", ".join(f"{x['name']} ×{x['strength']:g}" for x in loras)


def listing(root: Path) -> dict:
    out = {}
    for folder in sorted(FOLDERS):
        path = root / folder
        files = sorted(path.glob("*" + SUFFIX)) if path.is_dir() else []
        out[folder] = [{"name": f.name, "size": f.stat().st_size} for f in files if not f.name.startswith(".")]
    return out


def router(root: Path):
    from fastapi import APIRouter, Depends, HTTPException, Request

    from .guard import same_origin

    api = APIRouter(prefix="/api/loras")

    @api.get("")
    def list_loras():
        return listing(root)

    @api.post("/{folder}", status_code=201, dependencies=[Depends(same_origin)])
    async def upload(folder: str, name: str, request: Request):
        """Raw file bytes in the body; written under a temporary name, then linked."""
        if folder not in FOLDERS:
            raise HTTPException(404, f"Unknown LoRA folder: {folder} (expected {', '.join(sorted(FOLDERS))})")
        try:
            check_name(name)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        dest_dir = root / folder
        dest_dir.mkdir(parents=True, exist_ok=True)
        final = dest_dir / name
        if final.exists():
            raise HTTPException(409, f"A LoRA named {name} already exists")
        fd, part = tempfile.mkstemp(dir=dest_dir, prefix=".upload-", suffix=".part")
        written = 0
        try:
            with os.fdopen(fd, "wb") as f:
                async for chunk in request.stream():
                    written += len(chunk)
                    if written > MAX_BYTES:
                        raise HTTPException(413, f"LoRA larger than {MAX_BYTES // 1024**3} GB")
                    f.write(chunk)
            if written == 0:
                raise HTTPException(422, "Empty file")
            os.chmod(part, 0o644)
            try:
                os.link(part, final)  # unlike rename, never replaces
            except FileExistsError:
                raise HTTPException(409, f"A LoRA named {name} already exists")
        finally:
            os.unlink(part)
        return {"folder": folder, "name": name, "size": written}

    return api
