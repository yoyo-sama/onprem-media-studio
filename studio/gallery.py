"""Gallery: an SQLite/FTS5 index of the output folder, with thumbnails, tags,
favourites, renaming and a trash. Port of the 1.4 `gallery` service
(docs/GALLERY.md), now a module of the same server.

Rules kept from 1.4:
- files are never rewritten: tags and favourites live in SQLite only;
- nothing is ever deleted for good: the trash is `output/.trash/`, purged by
  hand; renaming, trashing and restoring link the file to its new name, then
  unlink the old one, so an existing file is never overwritten;
- a scan that finds an empty or missing output folder deletes no row;
- the gallery never submits a job.

Metadata comes from the `studio` text chunk of a PNG and the `studio` tag of an
MP4, both written by the engines: {"pipeline", "params", "origin", "role"}.
"""

import base64
import contextlib
import datetime
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time
import traceback
import unicodedata
from pathlib import Path
from urllib.parse import quote

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXT = {".mp4", ".webm", ".mov"}
FRESH_SECONDS = 5      # a younger file may still be written: the next scan takes it
PAGE_MAX = 200
MAX_KEYS = 100
THUMB_SIZE = 320
PROMPT_EXCERPT = 400
TRASH = ".trash"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Files that front-end sessions refer to by name (storyboard and Relay): a rename would break them.
LOCKED_ORIGINS = {"storyboard", "relay"}
SCOPES = {"app": "trashed_at IS NULL AND app = 1", "all": "trashed_at IS NULL", "trash": "trashed_at IS NOT NULL"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('image','video')),
  mtime INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL,
  w INTEGER, h INTEGER, duration REAL, prompt TEXT, pipeline TEXT, origin TEXT,
  loras TEXT NOT NULL DEFAULT '[]', seed INTEGER, app INTEGER NOT NULL DEFAULT 1,
  meta_ok INTEGER NOT NULL DEFAULT 1, fav INTEGER NOT NULL DEFAULT 0, trashed_at INTEGER, orig_key TEXT);
CREATE INDEX IF NOT EXISTS assets_list ON assets (trashed_at, type, mtime DESC, key DESC);
CREATE INDEX IF NOT EXISTS assets_pipeline ON assets (pipeline);
CREATE INDEX IF NOT EXISTS assets_fav ON assets (fav) WHERE fav = 1;
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, tag_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS asset_tags_tag ON asset_tags (tag_id);
CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
  prompt, key, pipeline, tokenize = 'unicode61 remove_diacritics 2');
PRAGMA user_version = 1;
"""


class GalleryError(Exception):
    """An error the API answers with `status`; `extra` goes into the JSON body."""

    def __init__(self, status: int, detail: str, extra: dict | None = None):
        super().__init__(detail)
        self.status, self.detail, self.extra = status, detail, extra or {}


def bad(detail: str) -> GalleryError:
    return GalleryError(400, detail)


def now_ms() -> int:
    return int(time.time() * 1000)


def kind_of(key: str) -> str:
    return "image" if os.path.splitext(key)[1].lower() in IMAGE_EXT else "video"


def has_control(text: str) -> bool:
    return any(unicodedata.category(c) in ("Cc", "Cs") for c in text)


# ── Metadata ─────────────────────────────────────────────────────────────────

def png_metadata(path: Path) -> dict | None:
    """The `studio` tEXt chunk, read before the image data; None if absent, raises if damaged."""
    with open(path, "rb") as f:
        if f.read(8) != PNG_SIGNATURE:
            raise ValueError("not a PNG")
        while True:
            head = f.read(8)
            if len(head) < 8:
                raise ValueError("truncated PNG")
            length, chunk = struct.unpack(">I4s", head)
            if chunk in (b"IDAT", b"IEND"):
                return None
            if chunk == b"tEXt" and length < 1 << 24:
                data = f.read(length)
                if len(data) < length:
                    raise ValueError("truncated chunk")
                name, _, value = data.partition(b"\0")
                if name == b"studio":
                    return json.loads(value.decode("latin-1"))
                f.seek(4, 1)
            else:
                f.seek(length + 4, 1)


def probe_video(path: Path) -> tuple[dict | None, int | None, int | None, float | None]:
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
                          str(path)], capture_output=True, timeout=20)
    if out.returncode:
        raise ValueError("ffprobe failed")
    info = json.loads(out.stdout)
    video = next(s for s in info["streams"] if s.get("codec_type") == "video")
    fmt = info.get("format") or {}
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    meta = json.loads(tags["studio"]) if "studio" in tags else None
    duration = fmt.get("duration")
    return meta, video.get("width"), video.get("height"), float(duration) if duration else None


def extract(path: Path, key: str) -> dict:
    out = {"w": None, "h": None, "duration": None, "prompt": None, "pipeline": None, "origin": None,
           "loras": [], "seed": None, "app": 1, "meta_ok": 1}
    try:
        meta = None
        if kind_of(key) == "image":
            from PIL import Image
            with Image.open(path) as img:
                out["w"], out["h"] = img.size
            if key.lower().endswith(".png"):
                meta = png_metadata(path)
        else:
            meta, out["w"], out["h"], out["duration"] = probe_video(path)
        if isinstance(meta, dict):
            params = meta.get("params") if isinstance(meta.get("params"), dict) else {}
            if isinstance(params.get("prompt"), str):
                out["prompt"] = params["prompt"]
            if type(params.get("seed")) is int:
                out["seed"] = params["seed"]
            loras = params.get("loras")
            if isinstance(loras, list):
                out["loras"] = [x["name"] for x in loras if isinstance(x, dict) and isinstance(x.get("name"), str)]
            for field in ("pipeline", "origin"):
                if isinstance(meta.get(field), str):
                    out[field] = meta[field]
            # The last frame of a clip is kept for chaining (Relay), not shown by default.
            if meta.get("role") == "last-frame":
                out["app"] = 0
    except Exception:  # damaged file: listed anyway, retried only once it changes
        out["meta_ok"] = 0
    if out["pipeline"] is None and "/" in key:
        out["pipeline"] = key.split("/", 1)[0]  # outputs/<pipeline>/… without metadata
    return out


def make_thumb(path: Path, kind: str, duration: float | None) -> bytes:
    from PIL import Image
    if kind == "image":
        img = Image.open(path)
    else:
        frame = b""
        for at in ("0.5", "0") if (duration or 0) > 1 else ("0",):
            frame = subprocess.run(["ffmpeg", "-v", "error", "-ss", at, "-i", str(path), "-frames:v", "1",
                                    "-f", "image2pipe", "-c:v", "png", "-"], capture_output=True, timeout=20).stdout
            if frame:
                break
        img = Image.open(io.BytesIO(frame))
    img.thumbnail((THUMB_SIZE, THUMB_SIZE))
    img = img.convert("RGBA" if img.mode in ("RGBA", "LA", "PA") or "transparency" in img.info else "RGB")
    out = io.BytesIO()
    img.save(out, "WEBP", quality=75)
    return out.getvalue()


# ── The gallery ──────────────────────────────────────────────────────────────

class Gallery:
    def __init__(self, root: Path, data_dir: Path, scan_interval: float = 60):
        self.root = Path(os.path.normpath(root))
        self.thumbs = data_dir / "cache" / "thumbs"
        self.thumbs.mkdir(parents=True, exist_ok=True)
        self.root.mkdir(parents=True, exist_ok=True)
        self.scan_interval = scan_interval
        self.lock = threading.RLock()
        self.thumb_slots = threading.Semaphore(4)
        self.state = {"scanning": False, "last": None, "seconds": 0.0, "warning": None}
        self._stop = threading.Event()
        self.db = sqlite3.connect(data_dir / "gallery.db", check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.execute("PRAGMA synchronous = NORMAL")
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript(SCHEMA)

    # ── Keys ──

    def path(self, key, trash: bool = False) -> Path | None:
        """Absolute path of a valid key with no symlink on the way, else None.
        A key is the POSIX path under the output folder, without leading slash;
        only a trash key may start with `.trash/`."""
        if not isinstance(key, str) or not 1 <= len(key) <= 1024 or "\0" in key or "\\" in key or key[0] == "/":
            return None
        try:
            key.encode("utf-8")
        except UnicodeEncodeError:
            return None
        for i, part in enumerate(key.split("/")):
            if part in ("", ".", "..") or (part[0] == "." and not (trash and i == 0 and part == TRASH)):
                return None
        if os.path.splitext(key)[1].lower() not in IMAGE_EXT | VIDEO_EXT:
            return None
        joined = os.path.join(self.root, key)
        if os.path.realpath(joined) != os.path.normpath(os.path.join(os.path.realpath(self.root), key)):
            return None
        return Path(joined)

    @contextlib.contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN")
            try:
                yield
            except BaseException:
                self.db.execute("ROLLBACK")
                raise
            self.db.execute("COMMIT")

    def row(self, key: str):
        with self.lock:
            return self.db.execute("SELECT * FROM assets WHERE key = ?", (key,)).fetchone()

    # ── Indexing ──

    def _upsert(self, key: str, st: os.stat_result, meta: dict) -> None:
        cols = ("type", "mtime", "mtime_ns", "size", "w", "h", "duration", "prompt", "pipeline", "origin",
                "loras", "seed", "app", "meta_ok")
        values = (kind_of(key), st.st_mtime_ns // 1_000_000, st.st_mtime_ns, st.st_size, meta["w"], meta["h"],
                  meta["duration"], meta["prompt"], meta["pipeline"], meta["origin"], json.dumps(meta["loras"]),
                  meta["seed"], meta["app"], meta["meta_ok"])
        searchable = " ".join(x for x in (meta["pipeline"], meta["origin"]) if x)
        with self.transaction():
            row = self.db.execute("SELECT id FROM assets WHERE key = ?", (key,)).fetchone()
            if row:
                asset_id = row["id"]
                self.db.execute("UPDATE assets SET " + ", ".join(c + " = ?" for c in cols) + " WHERE id = ?",
                                values + (asset_id,))
                self.db.execute("DELETE FROM assets_fts WHERE rowid = ?", (asset_id,))
            else:
                asset_id = self.db.execute(
                    "INSERT INTO assets (key, " + ", ".join(cols) + ") VALUES (?" + ", ?" * len(cols) + ")",
                    (key,) + values).lastrowid
            self.db.execute("INSERT INTO assets_fts (rowid, prompt, key, pipeline) VALUES (?, ?, ?, ?)",
                            (asset_id, meta["prompt"], key, searchable))

    def index_file(self, key: str, path: Path, st: os.stat_result) -> bool:
        """Read metadata outside the lock, store it under the lock after a new
        stat; False if the file changed meanwhile."""
        meta = extract(path, key)
        with self.lock:
            again = os.lstat(path)
            if (again.st_mtime_ns, again.st_size) != (st.st_mtime_ns, st.st_size):
                return False
            self._upsert(key, again, meta)
        return True

    def index_key(self, key: str) -> bool:
        """Index one file now (a job just wrote it)."""
        path = self.path(key)
        if path is None:
            return False
        try:
            return self.index_file(key, path, os.lstat(path))
        except OSError:
            return False

    def _delete(self, asset_id: int) -> None:
        with self.transaction():
            self.db.execute("DELETE FROM assets_fts WHERE rowid = ?", (asset_id,))
            self.db.execute("DELETE FROM assets WHERE id = ?", (asset_id,))

    def walk(self) -> dict[str, os.stat_result]:
        """{key: lstat} of the indexable files: no symlink, no name starting with a dot."""
        found, stack = {}, [str(self.root)]
        while stack:
            try:
                entries = os.scandir(stack.pop())
            except OSError:
                continue
            with entries:
                for entry in entries:
                    try:
                        if entry.name[0] == "." or entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif (os.path.splitext(entry.name)[1].lower() in IMAGE_EXT | VIDEO_EXT
                              and entry.is_file(follow_symlinks=False)):
                            key = os.path.relpath(entry.path, self.root).replace(os.sep, "/")
                            found[key] = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
        return found

    def scan(self) -> None:
        started = time.time()
        self.state["scanning"] = True
        try:
            if not self.root.is_dir():
                self.state["warning"] = f"Output folder not found ({self.root}): nothing removed from the index."
                return
            with self.lock:
                known = {r["key"]: (r["mtime_ns"], r["size"]) for r in
                         self.db.execute("SELECT key, mtime_ns, size FROM assets WHERE trashed_at IS NULL")}
                trashed = [r["key"] for r in self.db.execute("SELECT key FROM assets WHERE trashed_at IS NOT NULL")]
            found = self.walk()
            for key, st in found.items():
                if time.time() - st.st_mtime < FRESH_SECONDS or known.get(key) == (st.st_mtime_ns, st.st_size):
                    continue
                path = self.path(key)
                try:
                    if path:
                        self.index_file(key, path, st)
                except OSError:
                    pass
            if not found and (known or trashed):
                self.state["warning"] = (f"Output folder is empty while the index holds {len(known) + len(trashed)} "
                                         "file(s): nothing removed from the index.")
                return
            self.state["warning"] = None
            # Trash rows go only once their .trash/… file is gone (manual purge).
            for key in [k for k in known if k not in found] + trashed:
                with self.lock:
                    # Re-read by key under the lock: renamed or trashed since the snapshot, it is not ours to drop.
                    row = self.db.execute("SELECT id FROM assets WHERE key = ?", (key,)).fetchone()
                    if row and not os.path.lexists(os.path.join(self.root, key)):
                        self._delete(row["id"])
        finally:
            self.state.update(scanning=False, last=now_ms(), seconds=round(time.time() - started, 2))

    def start(self) -> None:
        def loop():
            while not self._stop.is_set():
                try:
                    self.scan()
                except Exception:
                    traceback.print_exc()
                self._stop.wait(self.scan_interval)
        self.state["scanning"] = True
        threading.Thread(target=loop, name="gallery-scan", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    # ── Reading ──

    def _tags(self, ids: list[int]) -> dict[int, list[str]]:
        out: dict[int, list[str]] = {}
        with self.lock:
            for i in range(0, len(ids), 500):
                part = ids[i:i + 500]
                for r in self.db.execute(
                        "SELECT asset_id, name FROM asset_tags JOIN tags ON tags.id = tag_id "
                        f"WHERE asset_id IN ({','.join('?' * len(part))}) ORDER BY name", part):
                    out.setdefault(r["asset_id"], []).append(r["name"])
        return out

    @staticmethod
    def asset(row, tags: dict, full: bool = False) -> dict:
        key, version = row["key"], row["mtime"]
        folder, _, name = key.rpartition("/")
        prompt = row["prompt"]
        return {
            "key": key, "filename": name, "folder": folder, "type": row["type"],
            "url": "/outputs/" + quote(key) + f"?v={version}",
            "ref": "outputs/" + key,
            "thumb": f"/api/gallery/thumb?key={quote(key, safe='')}&v={version}",
            "ts": version, "prompt": prompt if full or prompt is None else prompt[:PROMPT_EXCERPT],
            "pipeline": row["pipeline"], "origin": row["origin"], "loras": json.loads(row["loras"]),
            "seed": row["seed"], "w": row["w"], "h": row["h"], "duration": row["duration"], "size": row["size"],
            "fav": bool(row["fav"]), "tags": tags.get(row["id"], []),
            "trash": {"origKey": row["orig_key"], "at": row["trashed_at"]} if row["trashed_at"] is not None else None,
        }

    def health(self) -> dict:
        with self.lock:
            indexed, app, trashed = self.db.execute(
                "SELECT count(*) FILTER (WHERE trashed_at IS NULL), "
                "count(*) FILTER (WHERE trashed_at IS NULL AND app = 1), "
                "count(*) FILTER (WHERE trashed_at IS NOT NULL) FROM assets").fetchone()
        return {"ok": True, "indexed": indexed, "app": app, "trashed": trashed, "scanning": self.state["scanning"],
                "lastScanMs": self.state["last"], "scanSeconds": self.state["seconds"],
                "warning": self.state["warning"]}

    @staticmethod
    def _int(value, name: str) -> int:
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise bad(f"Invalid {name}")
        if abs(number) > 1 << 62:
            raise bad(f"Invalid {name}")
        return number

    def _where(self, f: dict) -> tuple[str, list]:
        """WHERE clause of a filter (everything but the type)."""
        scope = f.get("scope") or "app"
        if scope not in SCOPES:
            raise bad("Invalid scope")
        where, args = [SCOPES[scope]], []
        if f.get("pipeline") == "none":
            where.append("pipeline IS NULL")
        elif f.get("pipeline"):
            where.append("pipeline = ?")
            args.append(f["pipeline"])
        if f.get("origin"):
            where.append("origin = ?")
            args.append(f["origin"])
        if f.get("tag"):
            where.append("id IN (SELECT asset_id FROM asset_tags JOIN tags ON tags.id = tag_id WHERE tags.name = ?)")
            args.append(f["tag"])
        if f.get("fav"):
            where.append("fav = 1")
        for name, op in (("from", ">="), ("to", "<")):
            if f.get(name) is not None:
                where.append(f"mtime {op} ?")
                args.append(self._int(f[name], name))
        words = re.findall(r"\w+", f.get("q") or "")[:8]
        if words:
            where.append("id IN (SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?)")
            args.append(" AND ".join('"%s"*' % w.replace('"', '""') for w in words))
        return " AND ".join(where), args

    @staticmethod
    def _kind(f: dict) -> str:
        kind = f.get("type") or "image"
        if kind not in ("image", "video"):
            raise bad("Invalid type")
        return kind

    def page(self, f: dict) -> dict:
        """One page of assets, newest first (or oldest with sort=old), and the
        count of each type under the same filters."""
        kind, (where, args) = self._kind(f), self._where(f)
        sort = f.get("sort") or "new"
        if sort not in ("new", "old"):
            raise bad("Invalid sort")
        limit = self._int(f.get("limit") or 60, "limit")
        if not 1 <= limit <= PAGE_MAX:
            raise bad("Invalid limit")
        after, after_args = "", []
        if f.get("cursor"):
            cursor = f["cursor"]
            try:
                c = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
                assert len(c) == 3 and c[0] == sort and type(c[1]) is int and isinstance(c[2], str)
            except Exception:
                raise bad("Invalid cursor")
            after, after_args = f" AND (mtime, key) {'<' if sort == 'new' else '>'} (?, ?)", [c[1], c[2]]
        order = "DESC" if sort == "new" else "ASC"
        with self.lock:
            counts = {"image": 0, "video": 0}
            counts.update({r[0]: r[1] for r in self.db.execute(
                f"SELECT type, count(*) FROM assets WHERE {where} GROUP BY type", args)})
            rows = self.db.execute(
                f"SELECT * FROM assets WHERE {where} AND type = ?{after} ORDER BY mtime {order}, key {order} LIMIT ?",
                args + [kind] + after_args + [limit + 1]).fetchall()
            more = len(rows) > limit
            rows = rows[:limit]
            tags = self._tags([r["id"] for r in rows])
        cursor = None
        if more:
            cursor = base64.urlsafe_b64encode(json.dumps([sort, rows[-1]["mtime"], rows[-1]["key"]]).encode()
                                              ).decode().rstrip("=")
        return {"items": [self.asset(r, tags) for r in rows], "next": cursor, "counts": counts}

    def detail(self, key: str) -> dict:
        trash = isinstance(key, str) and key.startswith(TRASH + "/")
        path = self.path(key, trash=trash)
        if path is None:
            raise bad("Invalid key")
        row = self.row(key)
        if row is None and not trash and path.is_file():  # present but not indexed yet
            self.index_key(key)
            row = self.row(key)
        if row is None or (row["trashed_at"] is not None) != trash:
            raise GalleryError(404, "Unknown file")
        return self.asset(row, self._tags([row["id"]]), full=True)

    def thumb(self, key: str) -> bytes:
        trash = isinstance(key, str) and key.startswith(TRASH + "/")
        path = self.path(key, trash=trash)
        if path is None:
            raise bad("Invalid key")
        row = self.row(key)
        if row is None or (row["trashed_at"] is not None) != trash:
            raise GalleryError(404, "Unknown file")
        name = hashlib.sha1(f"{key}|{row['mtime_ns']}|{row['size']}".encode()).hexdigest() + ".webp"
        cache = self.thumbs / name
        with self.thumb_slots:
            try:
                return cache.read_bytes()
            except OSError:
                pass
            try:
                data = make_thumb(path, row["type"], row["duration"])
            except Exception as exc:
                print(f"gallery: no thumbnail for {key}: {exc}")
                raise GalleryError(404, "No thumbnail for this file")
            fd, tmp = tempfile.mkstemp(dir=self.thumbs, suffix=".tmp")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, cache)
        return data

    def dates(self, f: dict) -> dict:
        """Periods holding assets, newest first, in the client's local time
        (`tz` = Date.getTimezoneOffset(), minutes). A week runs Monday to Monday."""
        kind, (where, args) = self._kind(f), self._where(f)
        unit = f.get("unit") or "day"
        if unit not in ("day", "week", "month"):
            raise bad("Invalid unit")
        tz = self._int(f.get("tz") or 0, "tz")
        if abs(tz) > 1500:
            raise bad("Invalid tz")
        with self.lock:
            rows = self.db.execute(
                f"SELECT (mtime - ?) / 86400000, count(*) FROM assets WHERE {where} AND type = ? GROUP BY 1",
                [tz * 60000] + args + [kind]).fetchall()
        epoch = 719163  # date(1970, 1, 1).toordinal()
        periods: dict[tuple[int, int], int] = {}
        for day, count in rows:
            if unit == "day":
                start, end = day, day + 1
            elif unit == "week":  # 1970-01-01 was a Thursday
                start = day - (day + 3) % 7
                end = start + 7
            else:
                first = datetime.date.fromordinal(day + epoch).replace(day=1)
                start = first.toordinal() - epoch
                end = (first + datetime.timedelta(days=32)).replace(day=1).toordinal() - epoch
            periods[(start, end)] = periods.get((start, end), 0) + count
        return {"unit": unit, "periods": [
            {"start": s * 86400000 + tz * 60000, "end": e * 86400000 + tz * 60000, "count": n}
            for (s, e), n in sorted(periods.items(), reverse=True)]}

    def facets(self, scope: str) -> dict:
        if scope not in SCOPES:
            raise bad("Invalid scope")
        where = SCOPES[scope]
        with self.lock:
            pipelines = self.db.execute(
                f"SELECT pipeline, count(*) FROM assets WHERE {where} GROUP BY 1 ORDER BY 2 DESC, 1").fetchall()
            origins = self.db.execute(f"SELECT origin, count(*) FROM assets WHERE {where} AND origin IS NOT NULL "
                                      "GROUP BY 1 ORDER BY 2 DESC, 1").fetchall()
            tags = self.db.execute(
                "SELECT tags.name, count(assets.id) FROM tags LEFT JOIN asset_tags ON tag_id = tags.id "
                f"LEFT JOIN assets ON assets.id = asset_id AND assets.{where.replace(' AND ', ' AND assets.')} "
                "GROUP BY tags.id ORDER BY tags.name").fetchall()
        return {"pipelines": [{"id": a, "count": b} for a, b in pipelines],
                "origins": [{"id": a, "count": b} for a, b in origins],
                "tags": [{"name": a, "count": b} for a, b in tags]}

    # ── Writing ──

    def keys(self, keys, trash: bool = False) -> list[str]:
        """Validated key list, before anything is read or moved."""
        if not isinstance(keys, list):
            raise bad("keys must be a list")
        if len(keys) > MAX_KEYS:
            raise GalleryError(413, f"More than {MAX_KEYS} keys")
        for key in keys:
            if self.path(key, trash=trash) is None or key.startswith(TRASH + "/") != trash:
                raise bad("Invalid key")
        if len(set(keys)) != len(keys):
            raise bad("Duplicate key")
        return keys

    def _rows(self, keys: list[str], trash: bool = False, on_disk: bool = False) -> list:
        """Rows of the keys, in or out of the trash as asked; 404 otherwise. Under the lock."""
        rows = []
        for key in keys:
            row = self.db.execute("SELECT * FROM assets WHERE key = ?", (key,)).fetchone()
            if (row is None or (row["trashed_at"] is not None) != trash
                    or (on_disk and not os.path.lexists(os.path.join(self.root, key)))):
                raise GalleryError(404, f"Unknown file: {key}")
            rows.append(row)
        return rows

    @staticmethod
    def tag_name(value) -> str:
        name = value.strip() if isinstance(value, str) else ""
        if not 1 <= len(name) <= 40 or has_control(name):
            raise bad("Invalid tag name")
        return name

    def _tag_id(self, name: str, create: bool) -> int | None:
        """Tag id, compared with full Unicode case folding (SQLite's NOCASE is ASCII only)."""
        for tag_id, existing in self.db.execute("SELECT id, name FROM tags"):
            if existing.casefold() == name.casefold():
                return tag_id
        if not create:
            return None
        return self.db.execute("INSERT INTO tags (name, created) VALUES (?, ?)", (name, now_ms())).lastrowid

    def _move(self, row, dest: str, sets: str = "", args: tuple = ()) -> None:
        """Move a row's file to `dest` and its row in one transaction. os.link never
        overwrites; the source is unlinked only once the link exists."""
        src, dst = os.path.join(self.root, row["key"]), os.path.join(self.root, dest)
        with self.transaction():
            self.db.execute("UPDATE assets SET key = ?" + sets + " WHERE id = ?", (dest,) + tuple(args) + (row["id"],))
            self.db.execute("UPDATE assets_fts SET key = ? WHERE rowid = ?", (dest, row["id"]))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.link(src, dst, follow_symlinks=False)
            try:
                os.unlink(src)
            except FileNotFoundError:
                pass  # removed by someone else meanwhile: the file lives at dst, which is what we wanted
            except OSError:
                os.unlink(dst)  # source still there: take back the new name, roll back
                raise

    def set_fav(self, keys, fav) -> dict:
        keys = self.keys(keys)
        if type(fav) is not bool:
            raise bad("fav must be true or false")
        with self.transaction():
            changed = sum(self.db.execute("UPDATE assets SET fav = ? WHERE id = ? AND fav != ?",
                                          (int(fav), r["id"], int(fav))).rowcount for r in self._rows(keys))
        return {"ok": True, "changed": changed}

    def create_tag(self, name) -> dict:
        name = self.tag_name(name)
        with self.transaction():
            tag_id = self._tag_id(name, True)
            row = self.db.execute(
                "SELECT name, (SELECT count(*) FROM asset_tags JOIN assets ON assets.id = asset_id "
                "WHERE tag_id = tags.id AND trashed_at IS NULL) FROM tags WHERE id = ?", (tag_id,)).fetchone()
        return {"ok": True, "tag": {"name": row[0], "count": row[1]}}

    def tag(self, keys, add, remove) -> dict:
        keys = self.keys(keys)
        if not isinstance(add, list) or not isinstance(remove, list):
            raise bad("add and remove must be lists")
        add, remove = [self.tag_name(x) for x in add], [self.tag_name(x) for x in remove]
        with self.transaction():
            rows = self._rows(keys)
            for name in add:
                tag_id = self._tag_id(name, True)
                self.db.executemany("INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?, ?)",
                                    [(r["id"], tag_id) for r in rows])
            for name in remove:
                tag_id = self._tag_id(name, False)
                if tag_id:
                    self.db.executemany("DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?",
                                        [(r["id"], tag_id) for r in rows])
        tags = self._tags([r["id"] for r in rows])
        return {"ok": True, "assets": [{"key": r["key"], "tags": tags.get(r["id"], [])} for r in rows]}

    def renamed(self, key: str, name) -> str:
        """Key of `name` in the folder of `key`: same extension, 150 characters at most."""
        if (not isinstance(name, str) or not 1 <= len(name) <= 150 or name[0] == "." or "/" in name
                or "\\" in name or has_control(name)
                or os.path.splitext(name)[1].lower() != os.path.splitext(key)[1].lower()):
            raise bad("Invalid name")
        folder = key.rpartition("/")[0]
        new = f"{folder}/{name}" if folder else name
        if self.path(new) is None:
            raise bad("Invalid name")
        return new

    def rename(self, key, name) -> dict:
        if self.path(key) is None:
            raise bad("Invalid key")
        dest = self.renamed(key, name)
        with self.lock:
            row = self._rows([key], on_disk=True)[0]
            if row["origin"] in LOCKED_ORIGINS:
                raise GalleryError(409, "This file belongs to a storyboard or Relay session, which refers to it "
                                        "by name: it cannot be renamed.")
            try:
                self._move(row, dest)
            except (FileExistsError, sqlite3.IntegrityError):
                raise GalleryError(409, "A file already has this name")
            row = self.row(dest)
            return {"ok": True, "asset": self.asset(row, self._tags([row["id"]]), full=True)}

    def trash(self, keys) -> dict:
        keys = self.keys(keys)
        done = []
        with self.lock:
            rows = self._rows(keys, on_disk=True)
            for row in rows:  # a .trash that became a symlink is refused before anything moves
                if self.path(f"{TRASH}/0-000000/{row['key']}", trash=True) is None:
                    raise bad("Invalid key")
            try:
                for row in rows:
                    at = now_ms()
                    dest = f"{TRASH}/{at}-{secrets.token_hex(3)}/{row['key']}"
                    self._move(row, dest, ", orig_key = ?, trashed_at = ?", (row["key"], at))
                    done.append({"key": row["key"], "trashKey": dest})
            except Exception:
                traceback.print_exc()
                raise GalleryError(500, f"Trash interrupted: {len(done)} file(s) already moved", {"trashed": done})
        return {"ok": True, "trashed": done}

    def _prune(self, trash_key: str) -> None:
        """Remove the folders a restore left empty, never above .trash/<id>."""
        top = os.path.join(self.root, *trash_key.split("/")[:2])
        folder = os.path.dirname(os.path.join(self.root, trash_key))
        while True:
            try:
                os.rmdir(folder)
            except OSError:
                return
            if folder == top:
                return
            folder = os.path.dirname(folder)

    def restore(self, keys) -> dict:
        keys = self.keys(keys, trash=True)
        done = []
        with self.lock:
            rows = self._rows(keys, trash=True, on_disk=True)
            for row in rows:
                if self.path(row["orig_key"] or "") is None:
                    raise bad(f"Invalid original key: {row['key']}")
            try:
                for row in rows:
                    stem, ext = os.path.splitext(row["orig_key"])
                    for n in range(1000):  # never over a file that took the name meanwhile
                        dest = row["orig_key"] if n == 0 else f"{stem}_restored{n if n > 1 else ''}{ext}"
                        if self.path(dest) is None:
                            raise ValueError(f"no free name for {row['orig_key']}")
                        try:
                            self._move(row, dest, ", orig_key = NULL, trashed_at = NULL")
                            break
                        except (FileExistsError, sqlite3.IntegrityError):
                            continue
                    else:
                        raise ValueError(f"no free name for {row['orig_key']}")
                    self._prune(row["key"])
                    done.append({"trashKey": row["key"], "key": dest})
            except Exception:
                traceback.print_exc()
                raise GalleryError(500, f"Restore interrupted: {len(done)} file(s) already restored",
                                   {"restored": done})
        return {"ok": True, "restored": done}


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


# ── HTTP routes (/api/gallery/…) ─────────────────────────────────────────────

def router(gallery: Gallery):
    from fastapi import APIRouter, Depends, Request
    from fastapi.responses import JSONResponse, Response
    from typing import Any

    from pydantic import BaseModel

    from .guard import same_origin

    # Fields are typed Any: the Gallery methods check them and answer in their own words.
    class Keys(BaseModel):
        keys: Any = None

    class Fav(Keys):
        fav: Any = None

    class Tagging(Keys):
        add: Any = []
        remove: Any = []

    class TagName(BaseModel):
        name: Any = None

    class Rename(BaseModel):
        key: Any = None
        name: Any = None

    api = APIRouter(prefix="/api/gallery")
    write = [Depends(same_origin)]
    no_store = {"Cache-Control": "no-store"}

    def answer(fn, *args):
        try:
            return JSONResponse(fn(*args), headers=no_store)
        except GalleryError as exc:
            return JSONResponse({"detail": exc.detail, **exc.extra}, status_code=exc.status, headers=no_store)

    def filters(request: Request) -> dict:
        f = dict(request.query_params)
        f["fav"] = f.get("fav") == "1"
        return f

    @api.get("/health")
    def health():
        return answer(lambda: {**gallery.health(), "ffmpeg": ffmpeg_available()})

    @api.get("/assets")
    def assets(request: Request):
        return answer(gallery.page, filters(request))

    @api.get("/asset")
    def asset(key: str = ""):
        return answer(gallery.detail, key)

    @api.get("/dates")
    def dates(request: Request):
        return answer(gallery.dates, filters(request))

    @api.get("/facets")
    def facets(scope: str = "app"):
        return answer(gallery.facets, scope)

    @api.get("/thumb")
    def thumb(key: str = ""):
        try:
            return Response(gallery.thumb(key), media_type="image/webp",
                            headers={"Cache-Control": "public, max-age=31536000, immutable"})
        except GalleryError as exc:
            return JSONResponse({"detail": exc.detail}, status_code=exc.status, headers=no_store)

    @api.post("/fav", dependencies=write)
    def fav(body: Fav):
        return answer(gallery.set_fav, body.keys, body.fav)

    @api.post("/tags", dependencies=write)
    def create_tag(body: TagName):
        return answer(gallery.create_tag, body.name)

    @api.post("/tag", dependencies=write)
    def tag(body: Tagging):
        return answer(gallery.tag, body.keys, body.add, body.remove)

    @api.post("/rename", dependencies=write)
    def rename(body: Rename):
        return answer(gallery.rename, body.key, body.name)

    @api.post("/trash", dependencies=write)
    def trash(body: Keys):
        return answer(gallery.trash, body.keys)

    @api.post("/restore", dependencies=write)
    def restore(body: Keys):
        return answer(gallery.restore, body.keys)

    return api
