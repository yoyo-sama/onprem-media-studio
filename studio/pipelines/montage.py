"""Montage: CPU jobs on files that other jobs rendered, run with ffmpeg and Pillow.

- `video-concat` joins clips with hard cuts, sound included: the storyboard
  animatic, the Relay sequence and the multi-image sequence.
- `image-grid` lays shot images out as one contact sheet.
- `video-frames` saves frames counted back from the end of a clip: the
  candidate transition images of a Relay segment.

They need no model and no GPU, but go through the job queue like the engines,
so their files reach the gallery and their progress the page the same way. They
run on the queue's CPU worker (`gpu = False`): a Relay transition or an animatic
does not wait behind a video render.
"""

import json
import math
import shutil
import subprocess
import time
from pathlib import Path

from ..files import VIDEO_EXTENSIONS
from . import Pipeline, register
from . import common

MAX_CLIPS = 32
MAX_GRID = 16
MAX_FRAME_OFFSET = 48  # two seconds at 24 fps
FPS = 24  # every H3 clip


def ffmpeg(*args: str, timeout: float = 900) -> str:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        raise RuntimeError("ffmpeg is not installed: montage jobs need ffmpeg and ffprobe")
    done = subprocess.run(args, capture_output=True, timeout=timeout)
    if done.returncode:
        raise RuntimeError(f"{args[0]} failed: {done.stderr.decode(errors='replace')[-400:]}")
    return done.stdout.decode()


def probe(path: Path) -> dict:
    """Width, height, frame count and whether the file has sound."""
    out = json.loads(ffmpeg("ffprobe", "-v", "error", "-count_packets", "-show_entries",
                            "stream=codec_type,width,height,nb_read_packets", "-of", "json", str(path)))
    video = next((s for s in out.get("streams", []) if s.get("codec_type") == "video"), None)
    if video is None:
        raise RuntimeError(f"{path.name} has no video stream")
    return {"width": int(video["width"]), "height": int(video["height"]),
            "frames": int(video.get("nb_read_packets") or 0),
            "audio": any(s.get("codec_type") == "audio" for s in out.get("streams", []))}


def video_refs(params: dict, key: str, files, low: int, high: int) -> list[str]:
    refs = params.get(key, [])
    if not isinstance(refs, list) or not low <= len(refs) <= high:
        raise ValueError(f"{key} must be a list of {low} to {high} video references")
    for ref in refs:
        files.resolve(ref)
        if not ref.lower().endswith(VIDEO_EXTENSIONS):
            raise ValueError(f"{key}: {ref} is not a video")
    return refs


def output_stem(ctx) -> str:
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{ctx.job.id}"


class VideoConcat(Pipeline):
    """Clips end to end with hard cuts. Every clip is scaled into the first one's
    frame (letterboxed when its aspect differs) at 24 fps; sound is kept when
    every clip has some, else the result is silent and the job says so."""

    id = "video-concat"
    models = []
    gpu = False

    def validate(self, params, files):
        common.check_keys(params, {"clips"}, "a montage has no prompt.")
        return {"clips": video_refs(params, "clips", files, 2, MAX_CLIPS)}

    def run(self, params, models, ctx):
        paths = [ctx.files.resolve(ref) for ref in params["clips"]]
        info = [probe(p) for p in paths]
        width, height = info[0]["width"], info[0]["height"]
        audio = all(i["audio"] for i in info)
        if not audio:
            ctx.progress(0.1, "A clip has no sound: the sequence is silent")
        args, chain = ["ffmpeg", "-v", "error", "-y"], ""
        for n, path in enumerate(paths):
            args += ["-i", str(path)]
            chain += (f"[{n}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
                      f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={FPS}[v{n}];")
            if audio:
                chain += f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo[a{n}];"
        chain += "".join(f"[v{n}]" + (f"[a{n}]" if audio else "") for n in range(len(paths)))
        chain += f"concat=n={len(paths)}:v=1:a={int(audio)}[v]" + ("[a]" if audio else "")
        folder = ctx.output_dir / self.id
        folder.mkdir(parents=True, exist_ok=True)
        out = folder / f"{output_stem(ctx)}.mp4"
        args += ["-filter_complex", chain, "-map", "[v]"] + (["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] if audio else [])
        args += ["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                 "-movflags", "+faststart", str(out)]
        ctx.progress(0.2, f"Joining {len(paths)} clips")
        ffmpeg(*args)
        ctx.check()
        common.tag_video(out, ctx, params)
        return [out]


class ImageGrid(Pipeline):
    """A square-ish contact sheet (4 → 2×2, 9 → 3×3), rows filled from the left,
    every cell at the first image's size (1.4's grid)."""

    id = "image-grid"
    models = []
    gpu = False

    def validate(self, params, files):
        common.check_keys(params, {"images"}, "a contact sheet has no prompt.")
        return {"images": common.image_refs(params, "images", files, 2, MAX_GRID)}

    def run(self, params, models, ctx):
        from PIL import Image
        images = [common.open_image(ctx.files.resolve(ref)) for ref in params["images"]]
        width, height = images[0].size
        cols = math.ceil(math.sqrt(len(images)))
        rows = math.ceil(len(images) / cols)
        sheet = Image.new("RGB", (cols * width, rows * height), "white")
        for n, img in enumerate(images):
            if img.size != (width, height):
                img = img.resize((width, height), Image.LANCZOS)
            sheet.paste(img, ((n % cols) * width, (n // cols) * height))
        return common.save_images([sheet], ctx, params)


class VideoFrames(Pipeline):
    """Frames `offsets` frames before the end of a clip (0 = the last one), as PNG
    files in the order asked. They are working images, hidden from the gallery's
    default view like a clip's last frame."""

    id = "video-frames"
    models = []
    gpu = False

    def validate(self, params, files):
        common.check_keys(params, {"video", "offsets"}, "extracting frames has no prompt.")
        video = video_refs({"video": [params.get("video")]}, "video", files, 1, 1)[0]
        offsets = params.get("offsets")
        if (not isinstance(offsets, list) or not 1 <= len(offsets) <= 8
                or any(isinstance(o, bool) or not isinstance(o, int) or not 0 <= o <= MAX_FRAME_OFFSET
                       for o in offsets)):
            raise ValueError(f"offsets must be a list of 1 to 8 integers between 0 and {MAX_FRAME_OFFSET}")
        return {"video": video, "offsets": offsets}

    def run(self, params, models, ctx):
        path = ctx.files.resolve(params["video"])
        frames = probe(path)["frames"]
        if frames < 1:
            raise RuntimeError(f"{path.name}: no frame to extract")
        # An offset past the start falls back on the first frame, as 1.4 clamped its index.
        wanted = [max(0, frames - 1 - off) for off in params["offsets"]]
        folder = ctx.output_dir / ".frames"
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / f"{ctx.job.id}-%02d.png"
        select = "+".join(f"eq(n\\,{i})" for i in sorted(set(wanted)))
        ffmpeg("ffmpeg", "-v", "error", "-y", "-i", str(path), "-vf", f"select='{select}'",
               "-vsync", "0", str(tmp))
        try:
            got = sorted(folder.glob(f"{ctx.job.id}-*.png"))
            by_index = dict(zip(sorted(set(wanted)), got))
            images = []
            for i in wanted:
                if i not in by_index:
                    raise RuntimeError(f"{path.name}: frame {i} could not be read")
                images.append(common.open_image(by_index[i]))
        finally:
            for f in folder.glob(f"{ctx.job.id}-*.png"):
                f.unlink()
        return common.save_images(images, ctx, params, role="frame")


register(VideoConcat())
register(ImageGrid())
register(VideoFrames())
