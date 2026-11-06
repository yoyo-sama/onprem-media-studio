"""Upscale ×2: an image or a video already rendered, enlarged twice in width and
height by SPAN, a small super-resolution network (2xNomosUni_span_multijpg, 4.3 MB,
loaded through spandrel). It runs only when the user clicks "Upscale ×2" in the
gallery, never after a render on its own.

NVIDIA's own upscalers do not run on the GB10 (DLSS 5 is a Windows game feature, the
RTX Video SDK is Windows only and nvidia-vfx ships no ARM64 build): see
docs/IMAGE-ENGINES.md § Upscale ×2. A video is upscaled frame by frame, streamed
from one ffmpeg process to another, its sound copied as is.
"""

import json
import subprocess
import tempfile
import time

from ..files import media_kind
from . import Pipeline, common, register
from .montage import ffmpeg, output_stem

MODEL = "span-2x-nomosuni"
MODEL_FILE = "2xNomosUni_span_multijpg.safetensors"
SCALE = 2
MAX_IMAGE_EDGE = 4096  # 8192 px out
MAX_VIDEO_EDGE = 1920  # 3840 px out (4K)


def video_info(path) -> dict:
    """Width, height, frame rate (as ffmpeg writes it), frame count and sound of a clip."""
    out = json.loads(ffmpeg("ffprobe", "-v", "error", "-show_entries",
                            "stream=codec_type,width,height,r_frame_rate,nb_frames:format=duration",
                            "-of", "json", str(path)))
    streams = out.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise ValueError(f"{path.name} has no video stream")
    rate = video.get("r_frame_rate") or "24/1"
    num, _, den = rate.partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 24.0
    frames = int(video.get("nb_frames") or 0) or round(float(out.get("format", {}).get("duration") or 0) * fps)
    return {"width": int(video["width"]), "height": int(video["height"]), "rate": rate,
            "frames": frames, "audio": any(s.get("codec_type") == "audio" for s in streams)}


def source_size(path, kind: str) -> tuple[int, int]:
    if kind == "image":
        from PIL import Image
        with Image.open(path) as img:
            return img.size
    info = video_info(path)
    return info["width"], info["height"]


class Upscale2x(Pipeline):
    id = "upscale-2x"
    models = [MODEL]

    def validate(self, params, files):
        common.check_keys(params, {"source"}, "upscaling has no prompt.")
        ref = params.get("source")
        if not isinstance(ref, str) or not ref:
            raise ValueError("source must be an image or video reference")
        path = files.resolve(ref)
        kind = media_kind(ref)
        if kind not in ("image", "video"):
            raise ValueError(f"source: {ref} is neither an image nor a video")
        width, height = source_size(path, kind)
        limit = MAX_IMAGE_EDGE if kind == "image" else MAX_VIDEO_EDGE
        if max(width, height) > limit:
            raise ValueError(f"source is {width}×{height}: a {kind} to upscale ×2 is at most {limit} px "
                             f"on its long side ({limit * SCALE} px out)")
        return {"source": ref}

    def run(self, params, models, ctx):
        ctx.progress(0, "Loading the upscaler")
        model = common.load(self.id, lambda: _build(models[MODEL]), common.disk_size(models[MODEL]))
        path = ctx.files.resolve(params["source"])
        if media_kind(params["source"]) == "image":
            return self._image(model, path, params, ctx)
        return self._video(model, path, params, ctx)

    def _image(self, model, path, params, ctx):
        from PIL import Image
        import numpy as np
        began = time.time()
        img = common.open_image(path)
        ctx.progress(0.1, f"Upscaling {img.width}×{img.height} ×{SCALE}")
        out = Image.fromarray(upscale_frame(model, np.asarray(img)))
        print(f"render: {self.id} image {img.width}×{img.height} → {out.width}×{out.height} "
              f"in {time.time() - began:.2f} s", flush=True)
        return common.save_images([out], ctx, params)

    def _video(self, model, path, params, ctx):
        info = video_info(path)
        folder = ctx.output_dir / self.id
        folder.mkdir(parents=True, exist_ok=True)
        out = folder / f"{output_stem(ctx)}.mp4"
        began = time.time()
        done, spent = stream_video(lambda f: upscale_frame(model, f), path, out, info, ctx)
        total = time.time() - began
        print(f"render: {self.id} video {info['width']}×{info['height']} → {info['width'] * SCALE}×"
              f"{info['height'] * SCALE}, {done} frames in {total:.1f} s ({done / max(total, 1e-6):.1f} frames/s): "
              f"network {spent:.1f} s, decoding and encoding the rest", flush=True)
        common.tag_video(out, ctx, params)
        return [out]


def stream_video(upscale, src, out, info: dict, ctx) -> tuple[int, float]:
    """Decode `src` to RGB frames, pass each through `upscale` (H×W×3 uint8 in,
    2H×2W×3 out) and encode them to `out` at the source frame rate, the source's
    sound copied unchanged. Returns the frame count and the seconds spent in `upscale`."""
    import numpy as np
    width, height = info["width"], info["height"]
    size = width * height * 3
    with tempfile.TemporaryFile() as dec_err, tempfile.TemporaryFile() as enc_err:
        dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(src), "-map", "0:v:0",
                                "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                               stdout=subprocess.PIPE, stderr=dec_err)
        enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                                "-s", f"{width * SCALE}x{height * SCALE}", "-r", info["rate"], "-i", "-",
                                "-i", str(src), "-map", "0:v", "-map", "1:a?", "-c:a", "copy",
                                "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                                "-movflags", "+faststart", str(out)],
                               stdin=subprocess.PIPE, stderr=enc_err)
        done, spent = 0, 0.0
        try:
            while len(raw := dec.stdout.read(size)) == size:
                frame = np.frombuffer(raw, np.uint8).reshape(height, width, 3)
                t0 = time.time()
                big = upscale(frame)
                spent += time.time() - t0
                enc.stdin.write(np.ascontiguousarray(big, np.uint8).tobytes())
                done += 1
                ctx.progress(min(done / max(info["frames"], 1), 0.99), f"Upscaling ×{SCALE}: frame {done}/{info['frames']}")
            enc.stdin.close()
            if dec.wait() or enc.wait():
                dec_err.seek(0)
                enc_err.seek(0)
                raise RuntimeError("ffmpeg failed: " + (dec_err.read() + enc_err.read()).decode(errors="replace")[-400:])
            if not done:
                raise RuntimeError(f"{src.name}: no frame to upscale")
        except BaseException:
            for p in (dec, enc):
                p.kill()
                p.wait()
            out.unlink(missing_ok=True)
            raise
    return done, spent


def upscale_frame(model, frame):
    """H×W×3 uint8 RGB → 2H×2W×3 uint8 through the network on the GPU."""
    import torch
    x = torch.from_numpy(frame.copy()).to(common.device()).permute(2, 0, 1)[None]
    x = x.to(model.dtype).div_(255)
    with torch.inference_mode():
        y = model(x)
    return y.clamp_(0, 1).mul_(255).round_().to(torch.uint8)[0].permute(1, 2, 0).cpu().numpy()


def _build(path):
    import torch
    from spandrel import ModelLoader
    model = ModelLoader().load_from_file(str(path / MODEL_FILE))
    if model.scale != SCALE:
        raise RuntimeError(f"{MODEL_FILE} upscales ×{model.scale}, not ×{SCALE}")
    # float16 rather than bfloat16: the output is quantised to 8 bits, and bfloat16 keeps
    # 8 bits of mantissa, one 255th near white.
    dtype = torch.float16 if model.supports_half else torch.float32
    model.to(common.device()).eval()
    model.to(dtype)
    return model


register(Upscale2x())
