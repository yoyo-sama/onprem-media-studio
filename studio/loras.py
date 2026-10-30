"""LoRA files: list and upload. Port of the 1.4 updater's upload route.

Only MiniMax H3 takes LoRAs in 2.0 (studio/pipelines/h3_lora.py); its files
live in STUDIO_DATA_DIR/loras/h3/ and are referenced by file name. An upload
never replaces an existing file.
"""

import os
import tempfile
from pathlib import Path

FOLDERS = {"h3"}
SUFFIX = ".safetensors"
MAX_BYTES = 8 * 1024**3


def check_name(name: str) -> str:
    if not isinstance(name, str) or Path(name).name != name or name.startswith(".") or not name.endswith(SUFFIX) \
            or len(name) > 200 or len(name) <= len(SUFFIX):
        raise ValueError(f"The file name must be a bare name ending in {SUFFIX}")
    return name


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
