"""Input and output files, addressed by references a client can send back.

A reference is the URL path of the file without its leading slash:
`inputs/<name>` for an uploaded image, `outputs/<path>` for a render. A shot
image can therefore use the sheets rendered by earlier jobs as its references
without the client ever downloading and uploading them again.
"""

import hashlib
import io
from pathlib import Path

from PIL import Image, UnidentifiedImageError

MAX_UPLOAD = 50 * 1024**2
FORMATS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}


class FileStore:
    def __init__(self, input_dir: Path, output_dir: Path):
        self.roots = {"inputs": input_dir, "outputs": output_dir}
        for root in self.roots.values():
            root.mkdir(parents=True, exist_ok=True)

    def resolve(self, ref) -> Path:
        """Path of an existing file; ValueError for anything else (the API answers 422)."""
        if not isinstance(ref, str) or "/" not in ref:
            raise ValueError(f"Not a file reference: {ref!r} (expected inputs/<name> or outputs/<path>)")
        kind, rel = ref.split("/", 1)
        if kind not in self.roots:
            raise ValueError(f"Not a file reference: {ref!r} (expected inputs/<name> or outputs/<path>)")
        root = self.roots[kind].resolve()
        path = (root / rel).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError(f"No such file: {ref}")
        return path

    def ref(self, path: Path) -> str:
        for kind, root in self.roots.items():
            if path.resolve().is_relative_to(root.resolve()):
                return f"{kind}/{path.resolve().relative_to(root.resolve()).as_posix()}"
        raise ValueError(f"{path} is outside the data directory")

    def save_input(self, data: bytes) -> dict:
        """Store an uploaded image under a content hash: the same image uploaded twice is one file."""
        if len(data) > MAX_UPLOAD:
            raise ValueError(f"Image too large ({len(data) // 1024**2} MB, limit {MAX_UPLOAD // 1024**2} MB)")
        try:
            with Image.open(io.BytesIO(data)) as img:
                fmt, (width, height) = img.format, img.size
                img.verify()
        except (UnidentifiedImageError, OSError, SyntaxError) as exc:
            raise ValueError(f"Not a readable image: {exc}") from exc
        if fmt not in FORMATS:
            raise ValueError(f"Unsupported image format {fmt} (PNG, JPEG or WebP)")
        path = self.roots["inputs"] / (hashlib.sha256(data).hexdigest()[:16] + FORMATS[fmt])
        if not path.exists():
            path.write_bytes(data)
        return {"ref": self.ref(path), "width": width, "height": height}
