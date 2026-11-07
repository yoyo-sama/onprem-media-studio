"""Reuse the models and LoRAs an AI Content Studio 1.4 install already downloaded.

    python -m studio.import14 <ComfyUI models folder>

AI Content Studio 1.4 runs ComfyUI files, which are mostly other formats (fp8, int8 convrot,
NVFP4 conversions of a single transformer): they cannot be loaded here and are downloaded
again. Two kinds of catalog files are taken from the 1.4 folder instead, and only once their
SHA-256 equals the one Hugging Face publishes for them:

- a file identical to the catalog one (the H3 latent upscaler);
- a sharded file rebuilt from a single ComfyUI file that holds the same tensors (the Qwen
  Image 2.1 text encoder): the shard's header is read from Hugging Face, the tensor bytes are
  copied from the local file, so a shard that does not come out byte for byte is discarded.

A reused file goes into its model folder, and the next download of that model fetches only
the rest. H3 LoRAs are copied into loras/h3, except speed-up LoRAs (turbo, lightning, n-step),
which the distilled FastH3 checkpoints do not need, and those the H3 converter rejects.
Nothing in the 1.4 folder is changed.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys
from pathlib import Path

from huggingface_hub import HfFileSystem

from .config import Settings
from .models import ModelStore, _matches
from .pipelines import h3_lora

CHUNK = 64 * 1024**2
MIN_REBUILD = 100 * 1024**2  # smaller files are not worth a header request
SPEEDUP = re.compile(r"turbo|lightning|lightx2v|\d+[-_ ]?steps?", re.IGNORECASE)
# Hugging Face name prefix -> ComfyUI one: the Qwen3-VL text encoder of Qwen Image 2.1 is
# "model.language_model.layers…" in the transformers shards and "model.layers…" in ComfyUI.
ALIASES = [("model.language_model.", "model.")]


def local_name(name: str, local: dict) -> str | None:
    """The name a Hugging Face tensor has in a local file, if it holds it."""
    if name in local:
        return name
    for hf, comfy in ALIASES:
        if name.startswith(hf) and comfy + name[len(hf):] in local:
            return comfy + name[len(hf):]
    return None


def read_header(path: Path) -> tuple[dict, int]:
    """Header of a local safetensors file and the offset where its data starts."""
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n > min(path.stat().st_size, 100 * 1024**2):
            raise ValueError(f"{path} is not a safetensors file")
        return json.loads(f.read(n)), 8 + n


def remote_header(repo: str, filename: str, revision: str, token: str | None) -> bytes:
    """The raw header block (length prefix included) of a safetensors file on the Hub."""
    with HfFileSystem(token=token).open(f"{repo}/{filename}", "rb", revision=revision) as f:
        prefix = f.read(8)
        return prefix + f.read(struct.unpack("<Q", prefix)[0])


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(CHUNK):
            h.update(block)
    return h.hexdigest()


def place(src: Path, dst: Path) -> None:
    """Hard link when both are on the same file system, copy otherwise."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".import")
    try:
        os.link(src, tmp)
    except OSError:
        shutil.copyfile(src, tmp)
    tmp.replace(dst)


def rebuild(raw_header: bytes, sources: list[tuple[Path, dict, int]], dst: Path, expected: str) -> bool:
    """Write a safetensors file with the given header from the tensors of one local file.

    Kept only if its SHA-256 is the expected one; returns whether it was."""
    header = json.loads(raw_header[8:])
    names = sorted((k for k in header if k != "__metadata__"), key=lambda k: header[k]["data_offsets"][0])
    for path, local, start in sources:
        src_names = {k: local_name(k, local) for k in names}
        if all(n and local[n].get("dtype") == header[k]["dtype"]
               and local[n].get("shape") == header[k]["shape"] for k, n in src_names.items()):
            break
    else:
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp, h, end = dst.with_name(dst.name + ".import"), hashlib.sha256(raw_header), 0
    try:
        with open(path, "rb") as src, open(tmp, "wb") as out:
            out.write(raw_header)
            for k in names:
                begin, stop = header[k]["data_offsets"]
                lbegin, lstop = local[src_names[k]]["data_offsets"]
                if begin != end or stop - begin != lstop - lbegin:
                    return False
                src.seek(start + lbegin)
                left = lstop - lbegin
                while left:
                    block = src.read(min(CHUNK, left))
                    if not block:
                        return False
                    out.write(block)
                    h.update(block)
                    left -= len(block)
                end = stop
        if h.hexdigest() != expected:
            return False
        tmp.replace(dst)
        return True
    finally:
        tmp.unlink(missing_ok=True)


def import_models(root: Path, store: ModelStore, say=print) -> None:
    files = [p for p in root.rglob("*") if p.is_file() and not p.is_symlink()]
    by_size: dict[int, list[Path]] = {}
    for p in files:
        by_size.setdefault(p.stat().st_size, []).append(p)
    tensors = []
    for p in files:
        if p.suffix == ".safetensors":
            try:
                tensors.append((p, *read_header(p)))
            except (OSError, ValueError, struct.error):
                pass
    hashes: dict[Path, str] = {}
    for mid, entry in store.catalog.items():
        if store.installed(mid):
            continue
        info = store.api.model_info(entry["repo"], revision=entry.get("revision"), files_metadata=True,
                                    token=store.settings.hf_token)
        target, left = store.path(mid), 0
        for s in info.siblings:
            rel, size = s.rfilename, s.size or 0
            if not _matches(rel, entry):
                continue
            dst = target / rel
            if dst.is_file():
                continue
            expected = s.lfs.sha256 if s.lfs else None
            if expected and _enough_space(target, size, store.settings):
                for p in by_size.get(size, []):
                    if p not in hashes:
                        hashes[p] = sha256(p)
                same = [p for p in by_size.get(size, []) if hashes[p] == expected]
                if same:
                    place(same[0], dst)
                    say(f"reused   {entry['label']}: {rel} ({size / 1024**3:.1f} GB) from {same[0].relative_to(root)}")
                    continue
                if tensors and rel.endswith(".safetensors") and size >= MIN_REBUILD:
                    try:
                        raw = remote_header(entry["repo"], rel, info.sha, store.settings.hf_token)
                    except Exception:  # gated without a token, offline: downloaded later instead
                        raw = None
                    if raw and rebuild(raw, tensors, dst, expected):
                        say(f"rebuilt  {entry['label']}: {rel} ({size / 1024**3:.1f} GB)")
                        continue
            left += size
        if left:
            say(f"download {entry['label']}: {left / 1024**3:.1f} GB still to download")


def _enough_space(folder: Path, size: int, settings: Settings) -> bool:
    folder.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(folder).free >= size + settings.disk_reserve


def import_loras(root: Path, dest: Path, say=print) -> None:
    folders = [d for d in (root / "loras").glob("*") if d.is_dir() and d.name.lower() == "h3"]
    for path in sorted(p for d in folders for p in d.glob("*.safetensors")):
        if SPEEDUP.search(path.stem):
            say(f"skipped  LoRA {path.name}: speed-up LoRA, FastH3 is already distilled")
        elif (dest / path.name).exists():
            say(f"skipped  LoRA {path.name}: already in loras/h3")
        else:
            try:
                h3_lora._convert(path)
            except ValueError as exc:
                say(f"skipped  LoRA {path.name}: {exc}")
                continue
            place(path, dest / path.name)
            say(f"imported LoRA {path.name}")


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(prog="python -m studio.import14", description=__doc__.split("\n\n")[0])
    parser.add_argument("models", type=Path, help="the ComfyUI models folder of the 1.4 install")
    args = parser.parse_args(argv)
    if not args.models.is_dir():
        sys.exit(f"Not a folder: {args.models}")
    settings = Settings()
    store = ModelStore(settings)
    import_models(args.models, store)
    import_loras(args.models, settings.loras_dir / "h3")


if __name__ == "__main__":
    main()
