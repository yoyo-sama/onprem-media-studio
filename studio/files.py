"""Input and output files, addressed by references a client can send back.

A reference is the URL path of the file without its leading slash:
`inputs/<name>` for an uploaded image, video or sound, `outputs/<path>` for a render. A shot
image can therefore use the sheets rendered by earlier jobs as its references
without the client ever downloading and uploading them again.
"""

import hashlib
import io
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, UnidentifiedImageError

MAX_UPLOAD = 50 * 1024**2
MAX_MEDIA_UPLOAD = 200 * 1024**2  # a reference clip or sound for MiniMax H3
FORMATS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}
# ffprobe container name -> extension of a video, and of a sound without picture.
MEDIA_FORMATS = {"mov,mp4,m4a,3gp,3g2,mj2": (".mp4", ".m4a"), "matroska,webm": (".webm", None),
                 "wav": (None, ".wav"), "mp3": (None, ".mp3"), "flac": (None, ".flac"), "ogg": (None, ".ogg")}
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
VIDEO_EXTENSIONS = (".mp4", ".webm", ".mov")
AUDIO_EXTENSIONS = (".wav", ".mp3", ".m4a", ".flac", ".ogg")


def media_kind(ref: str) -> str | None:
    """"image", "video" or "audio" from a reference's extension (the server names uploads)."""
    name = str(ref).lower()
    for kind, extensions in (("image", IMAGE_EXTENSIONS), ("video", VIDEO_EXTENSIONS), ("audio", AUDIO_EXTENSIONS)):
        if name.endswith(extensions):
            return kind
    return None


def probe_media(data: bytes) -> tuple[str, str]:
    """Kind ("video" or "audio") and extension of a clip or a sound, read by ffprobe."""
    if shutil.which("ffprobe") is None:
        raise ValueError("Not a readable image (videos and sounds need ffprobe, which is not installed)")
    with tempfile.NamedTemporaryFile() as tmp:
        tmp.write(data)
        tmp.flush()
        done = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                               "format=format_name:stream=codec_type:stream_disposition=attached_pic",
                               "-of", "json", tmp.name], capture_output=True, timeout=60)
    if done.returncode:
        raise ValueError("Not a readable image, video or sound")
    out = json.loads(done.stdout or b"{}")
    streams = out.get("streams", [])
    # Cover art in a sound file is a video stream marked as an attached picture.
    video = any(s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic") for s in streams)
    audio = any(s.get("codec_type") == "audio" for s in streams)
    video_ext, audio_ext = MEDIA_FORMATS.get(out.get("format", {}).get("format_name", ""), (None, None))
    if video and video_ext:
        return "video", video_ext
    if audio and not video and audio_ext:
        return "audio", audio_ext
    raise ValueError("Unsupported file: images in PNG, JPEG or WebP, videos in MP4, MOV or WebM, "
                     "sounds in WAV, MP3, M4A, FLAC or Ogg")


class FileStore:
    def __init__(self, input_dir: Path, output_dir: Path, loras_dir: Path | None = None):
        self.roots = {"inputs": input_dir, "outputs": output_dir}
        # LoRA files are not references a client can send: the engines read them by name.
        self.loras_dir = loras_dir or input_dir.parent / "loras"
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
        """Store an uploaded image, clip or sound under a content hash: the same file
        uploaded twice is one file. Anything that is not an image goes to ffprobe."""
        if len(data) > MAX_MEDIA_UPLOAD:
            raise ValueError(f"File too large ({len(data) // 1024**2} MB, limit {MAX_MEDIA_UPLOAD // 1024**2} MB)")
        try:
            with Image.open(io.BytesIO(data)) as img:
                fmt, (width, height) = img.format, img.size
                img.verify()
        except (UnidentifiedImageError, OSError, SyntaxError):
            return self._save_media(data)
        if len(data) > MAX_UPLOAD:
            raise ValueError(f"Image too large ({len(data) // 1024**2} MB, limit {MAX_UPLOAD // 1024**2} MB)")
        if fmt not in FORMATS:
            raise ValueError(f"Unsupported image format {fmt} (PNG, JPEG or WebP)")
        return {"ref": self._write(data, FORMATS[fmt]), "kind": "image", "width": width, "height": height}

    def _save_media(self, data: bytes) -> dict:
        kind, ext = probe_media(data)
        return {"ref": self._write(data, ext), "kind": kind}

    def _write(self, data: bytes, ext: str) -> str:
        path = self.roots["inputs"] / (hashlib.sha256(data).hexdigest()[:16] + ext)
        if not path.exists():
            path.write_bytes(data)
        return self.ref(path)
