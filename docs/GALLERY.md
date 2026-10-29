# Gallery, in-app update and LoRA upload

French version: [fr/GALLERY.md](fr/GALLERY.md).

In 1.4 these were two separate services behind nginx (`gallery` on :8094, `updater` on :8093).
In 2.0 they are modules of the same server (`studio/gallery.py`, `studio/update.py`,
`studio/loras.py`), under `/api/gallery/`, `/api/update/` and `/api/loras`.

## Gallery

An SQLite/FTS5 index (`STUDIO_DATA_DIR/gallery.db`) of the output folder, with WebP thumbnails
cached in `STUDIO_DATA_DIR/cache/thumbs/`.

### Rules kept from 1.4

- **Files are never rewritten.** Tags and favourites live in SQLite only.
- **Nothing is deleted for good.** "Delete" moves the file to `output/.trash/<ms>-<hex>/<key>`;
  restore puts it back (as `<name>_restored.<ext>` if the name was taken meanwhile). Purging the
  trash is manual: `rm -r <data>/output/.trash`. Every move links the new name, then unlinks the
  old one, so an existing file is never overwritten.
- **A scan never wipes the index.** If the output folder is missing, or empty while the index has
  rows, nothing is removed and `health.warning` says so.
- **The gallery never submits a job.** "Reuse prompt" in the front end writes the brief only on an
  explicit click, with Undo, and launches nothing.
- **Write routes need the same origin** (`Origin` or `Referer` matching `Host`, and
  `Sec-Fetch-Site` absent or `same-origin`), like every route that moves or writes files.

### What is indexed

Every `.png .jpg .jpeg .webp .mp4 .webm .mov` under the output folder, skipping symbolic links,
names starting with a dot (hence `.trash` and temporary files) and files younger than 5 s (the next
scan takes them). A scan runs at start-up, then every `STUDIO_GALLERY_SCAN` seconds (default 60);
a job's outputs are indexed as soon as it ends, before its `done` event reaches the clients.

Metadata is what the engines write with each output, `{"pipeline", "origin", "params", "role"}`:

- in a PNG, the `studio` text chunk (read before the image data);
- in an MP4, the `studio` tag, written by remuxing without re-encoding right after FastVideo wrote
  the file (needs `ffmpeg`; without it the clip keeps no metadata and a line is logged).

`pipeline` is the engine (`krea2-t2i`, `h3-r2v`…), `origin` the front-end feature that submitted
the job (`storyboard`, `relay`, `canvas`…, sent as the job's `origin` field), `params` the
validated job parameters (prompt, seed, LoRAs…). A clip's last frame (`role: "last-frame"`, named
`<clip>-1.png`) is kept for Relay chaining but hidden from the default `app` scope. A file without
metadata is listed with its folder as pipeline.

Search (`q`) matches prompt, file key, pipeline and origin, word prefixes, all words required.

### API

Reading:

| Route | Parameters | Answer |
|---|---|---|
| `GET /api/gallery/health` | — | `{ok, indexed, app, trashed, scanning, lastScanMs, scanSeconds, warning, ffmpeg}` |
| `GET /api/gallery/assets` | `type=image\|video`, `q`, `pipeline` (or `none`), `origin`, `tag`, `fav=1`, `from`/`to` (ms), `scope=app\|all\|trash`, `sort=new\|old`, `limit` (1–200, default 60), `cursor` | `{items: [Asset], next, counts: {image, video}}`; `counts` apply every filter but the type |
| `GET /api/gallery/asset?key=` | key (also a trash key) | Asset with the full prompt; a present file not indexed yet is indexed now |
| `GET /api/gallery/thumb?key=&v=` | key, version | WebP, longest side 320 px, cached for a year (the URL changes with the file) |
| `GET /api/gallery/dates` | filters + `unit=day\|week\|month`, `tz` (= `Date.getTimezoneOffset()`) | `{unit, periods: [{start, end, count}]}`, newest first; weeks run Monday to Monday |
| `GET /api/gallery/facets?scope=` | scope | `{pipelines: [{id, count}], origins: [{id, count}], tags: [{name, count}]}` |

Writing (POST, JSON body, same origin, at most 100 keys):

| Route | Body | Answer |
|---|---|---|
| `/api/gallery/fav` | `{keys, fav}` | `{ok, changed}` |
| `/api/gallery/tags` | `{name}` (1–40 characters, case-insensitive) | `{ok, tag: {name, count}}` |
| `/api/gallery/tag` | `{keys, add: [names], remove: [names]}` | `{ok, assets: [{key, tags}]}` |
| `/api/gallery/rename` | `{key, name}` (same folder and extension, 150 characters at most) | `{ok, asset}`; 409 if the name is taken or the file belongs to a storyboard or Relay session |
| `/api/gallery/trash` | `{keys}` | `{ok, trashed: [{key, trashKey}]}` |
| `/api/gallery/restore` | `{keys: [trash keys]}` | `{ok, restored: [{trashKey, key}]}` |

Errors are `{"detail": "..."}`; a trash or restore interrupted half-way answers 500 with the list
of what was already moved.

An **Asset**: `key` (POSIX path under the output folder, no leading slash), `filename`, `folder`,
`type`, `url` (`/outputs/<key>?v=<mtime>`), `ref` (`outputs/<key>`, what a job takes as an image
reference), `thumb`, `ts` (ms), `prompt` (400 characters in lists), `pipeline`, `origin`,
`loras`, `seed`, `w`, `h`, `duration`, `size`, `fav`, `tags`, `trash` (`{origKey, at}` or null).

Changes from 1.4: no ComfyUI graph to walk (metadata is explicit), no `model` facet (the engine
says it), an `origin` facet instead of the file-name patterns that guessed the pipeline, URLs
under `/outputs/` instead of `/comfy/view`.

## In-app update

Only for an installation that is a **git checkout** (bare metal, `scripts/install.sh`). A Docker
image is updated by rebuilding it; its status says so.

- `GET /api/update/status` → `{mode: "git"|"none", branch, local, remote, available, message}`.
  It compares `HEAD` with the remote branch (`STUDIO_UPDATE_BRANCH`, default `main`) by
  `git ls-remote`, without fetching, cached one minute.
- `POST /api/update/apply` (same origin) refuses a branch other than the update branch, local
  changes to tracked files, and queued or running jobs (409). It then runs
  `git pull --ff-only` and answers `{updated, from, to, reinstall, restarting}`:
  - if only code changed, the server **restarts itself in place** one second later (same process
    id: systemd and a terminal both keep it); the front end waits for `/api/health` and reloads;
  - if `pyproject.toml`, `docker/` or `scripts/install.sh` changed, it does not restart and asks
    for `scripts/install.sh` to be run again, which reinstalls and restarts the service.

## LoRA upload

- `GET /api/loras` → `{"h3": [{name, size}]}`.
- `POST /api/loras/h3?name=<file>.safetensors` (same origin), raw file in the body, 8 GB at most.
  The file is written under a hidden temporary name, then linked to its final name: an existing
  LoRA is never replaced (409).

Only MiniMax H3 takes LoRAs in 2.0 (`docs/H3.md` § LoRA stack). 1.4 also had Krea 2 style LoRAs;
the Krea 2 engine does not take them yet.
