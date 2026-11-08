"""FastVideo adapter for the MiniMax H3 engines: one VideoGenerator in memory,
built from the DGX Spark recipes FastVideo publishes, in NVFP4.

Recipes followed (FastVideo `examples/inference/basic/`):
- FastH3 V2 (t2v, i2v, FL2VA): `basic_fasth3_spark_qad_v2_nvfp4.yaml`;
- FastH3 OmniRef (Ref2VA): `basic_fasth3_omniref_spark.yaml` with its
  lossless speed-ups and the 36-layer NVFP4 video decoder.

Two things are deliberately left out of the recipes: the precomputed AdaLN
table (it would bypass the LoRA on the AdaLN layers and only holds the
timesteps of the trained schedule, not those of the refine pass), and any
speed-up LoRA.

One more departure, for Ref2VA only: FastVideo resizes every image reference
to a 2048 px short edge, upscaling small ones, and keeps image references
dense in its sparse attention. The validated ComfyUI workflow
(ref_image_size "max") only ever downscales to that edge, so the same rule is
installed here (reference_size): with two 1920×1088 sheets, r2v went from 680 s
to about 247 s on the GB10 with no visible loss (LESSONS.md #38).

The generator runs in-process (one GPU: FastVideo's uniproc executor), so a
cancelled job interrupts it directly. FastVideo reads its environment when the
generator is built, which is why a LoRA change builds a new one.

fastvideo and torch are imported inside functions: the server and the unit
tests run without them.
"""

import contextlib
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

_SPARK_ENV = {
    "FASTVIDEO_ATTENTION_BACKEND": "VIDEO_SPARSE_ATTN_H3",
    "FASTVIDEO_MINIMAX_H3_FUSIONS": "all",
    "FASTVIDEO_VSA_TRITON": "1",
    "FASTVIDEO_VSA_PTX_BLACKWELL": "0",
    "FASTVIDEO_FA4": "0",
    "FASTVIDEO_H3_VAE_TILE_BATCH": "12",
    "FASTVIDEO_H3_VAE_INT8_OVERLAY": "0",
    # LoRAs always run as an exact side branch (see h3_lora).
    "FASTVIDEO_LORA_SIDE_BRANCH": "1",
}
_NVFP4_ENV = {
    "FASTVIDEO_H3_VSA_FP4": "1",
    "FASTVIDEO_H3_VSA_FP4_PREFIX": "fp8",
    "FASTVIDEO_H3_VSA_FP4_TWO_LEVEL_P": "1",
    "FASTVIDEO_H3_VSA_FP4_K_SMOOTH": "1",
    "FASTVIDEO_NVFP4_MM_BACKEND": "cudnn",
    "FASTVIDEO_NVFP4_MM_ROW_SPLIT": "table",
}
# OmniRef recipe only: bit-identical speed-ups and the reference-encode cache.
_OMNIREF_ENV = {
    "FASTVIDEO_H3_GATE_CHUNK_ROWS": "8192",
    "FASTVIDEO_ULYSSES_A2A": "auto",
    "FASTVIDEO_MINIMAX_H3_EXACT_KERNELS": "all",
    "FASTVIDEO_H3_VSA_HEADS_FIRST_TILE": "1",
    "FASTVIDEO_H3_VAE_TILE_PARALLEL": "1",
    "FASTVIDEO_H3_REF2VA_MEMO_ENTRIES": "16",
}
# Keys this module may set; any of them not in a profile is removed, so that a
# V2 engine does not inherit OmniRef settings from the previous build.
_ALL_KEYS = set(_SPARK_ENV) | set(_NVFP4_ENV) | set(_OMNIREF_ENV) | {
    "FASTVIDEO_H3_VAE_NVFP4_DECODER"}

REFERENCE_SHORT_EDGE = 2048

_FP4_ATTENTION = {"enabled": True, "prefix_precision": "fp8", "two_level_p": True, "smooth_k": True}


@dataclass(frozen=True)
class EngineSpec:
    """Everything a generator is built from; a different spec means a new generator."""
    model_dir: Path
    ref2va: bool
    lora: Path | None = None
    # The stack the merged adapter was built from, for the log line only (the file's
    # hash already sets the generator apart).
    lora_names: str = field(default="", compare=False)

    def __str__(self) -> str:  # the engine: log line
        return self.model_dir.name + (f" + LoRA {self.lora_names or self.lora.name}" if self.lora else "")


def environment(spec: EngineSpec) -> dict[str, str]:
    env = dict(_SPARK_ENV)
    env.update(_NVFP4_ENV)
    if spec.ref2va:
        env.update(_OMNIREF_ENV)
        env["FASTVIDEO_H3_VAE_NVFP4_DECODER"] = str(spec.model_dir / "vae_decoder_nvfp4" / "decoder-nvfp4.safetensors")
    return env


def experimental(spec: EngineSpec) -> dict:
    out = {"attention_backend": "VIDEO_SPARSE_ATTN_H3", "video_decode_backend": "h3-vae",
           "h3_sequential_load": False, "h3_vsa_fp4": dict(_FP4_ATTENTION)}
    if not spec.ref2va:
        # FastH3 V2 keeps its trained 64-token VSA layout and 0.8 sparsity.
        out.update({"VSA_sparsity": 0.8, "VSA_tile_size": 64, "inference_torch_compile": False,
                    "vae_parallel_decode": False})
    return out


def reference_size(width: int, height: int, multiple: int = 32) -> tuple[int, int]:
    """(height, width) of an image reference, by ComfyUI's ref_image_size "max":
    down to a 2048 px short edge, never up, in multiples of the canvas step."""
    if width <= 0 or height <= 0:
        raise ValueError(f"A reference image must have a positive size, got {width}x{height}.")
    if width > 4 * height or height > 4 * width:
        raise ValueError(f"A reference image must be within 1:4 and 4:1, got {width}x{height}.")
    scale = min(1.0, REFERENCE_SHORT_EDGE / min(width, height))
    return (max(multiple, round(height * scale / multiple) * multiple),
            max(multiple, round(width * scale / multiple) * multiple))


def _size_references_like_comfyui() -> None:
    from fastvideo.pipelines.basic.minimax_h3 import reference
    step = reference.MINIMAX_H3_CANVAS_MULTIPLE
    reference.resolve_reference_image_size = lambda width, height: reference_size(width, height, step)


class WholeFile:
    """Stands in for safetensors' safe_open in FastVideo's weight iterator (DiT shards and
    text encoders): the file is read whole instead of memory-mapped. Mapped, the 27 GB of
    FastH3 took 170 s to read on the GB10, as Krea 2's mapped files did (253 s against 82 s
    read whole, LESSONS.md #42). Only what the iterator uses on one GPU: keys, get_tensor."""

    def __init__(self, path, framework: str = "pt", device: str = "cpu"):
        from safetensors.torch import load
        with open(path, "rb") as fh:
            self._tensors = load(fh.read())
        self._device = device

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._tensors = None

    def keys(self):
        return list(self._tensors)

    def get_tensor(self, name):
        return self._tensors[name].to(self._device)


# safetensors dtype names (the file header) and their torch dtypes, looked up by name so that
# the module imports without torch.
_DTYPES = {"BOOL": "bool", "U8": "uint8", "I8": "int8", "I16": "int16", "U16": "uint16",
           "I32": "int32", "U32": "uint32", "I64": "int64", "U64": "uint64", "F16": "float16",
           "BF16": "bfloat16", "F32": "float32", "F64": "float64",
           "F8_E4M3": "float8_e4m3fn", "F8_E5M2": "float8_e5m2"}


class RangeFile:
    """Stands in for safetensors' safe_open while FastVideo loads the packed NVFP4 export of the
    transformer (one 11.9 GB file): each tensor is read with a plain seek and read instead of
    through a memory map. Mapped, that file took 68 s to read on the GB10 (0.17 GB/s) and was
    the longest step of an H3 load. Tensor by tensor rather than whole, so the load does not hold
    a second copy of the file. Only what that loader uses: keys, get_tensor, metadata."""

    def __init__(self, path, framework: str = "pt", device: str = "cpu"):
        import json
        self._file = open(path, "rb")
        size = int.from_bytes(self._file.read(8), "little")
        header = json.loads(self._file.read(size))
        self._metadata = header.pop("__metadata__", None)
        self._header, self._start, self._device = header, 8 + size, device

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._file.close()

    def keys(self):
        return list(self._header)

    def metadata(self):
        return self._metadata

    def get_tensor(self, name):
        import torch
        entry = self._header[name]
        dtype = getattr(torch, _DTYPES[entry["dtype"]])
        begin, end = entry["data_offsets"]
        if end == begin:
            return torch.empty(entry["shape"], dtype=dtype, device=self._device)
        data = bytearray(end - begin)
        self._file.seek(self._start + begin)
        if self._file.readinto(data) != len(data):
            raise OSError(f"{self._file.name}: {name} is cut short")
        return torch.frombuffer(data, dtype=dtype).reshape(entry["shape"]).to(self._device)


def _read_weights_whole() -> None:
    from fastvideo.layers.quantization import nvfp4_config
    from fastvideo.models.loader import weight_utils
    weight_utils.safe_open = WholeFile
    load = nvfp4_config.load_minimax_h3_nvfp4_dit_export
    if getattr(load, "reads_ranges", False):
        return

    def load_export(*args, **kwargs):
        # The loader imports safe_open from safetensors when called: replaced for that call only.
        import safetensors
        mapped, safetensors.safe_open = safetensors.safe_open, RangeFile
        try:
            return load(*args, **kwargs)
        finally:
            safetensors.safe_open = mapped
    load_export.reads_ranges = True
    nvfp4_config.load_minimax_h3_nvfp4_dit_export = load_export


def _apply_env(env: dict[str, str]) -> None:
    for key in _ALL_KEYS - set(env):
        os.environ.pop(key, None)
    os.environ.update(env)


class Engine:
    """A built FastVideo generator for one spec. close() frees it."""

    def __init__(self, spec: EngineSpec):
        from fastvideo import VideoGenerator
        from fastvideo.api import (CompileConfig, ComponentConfig, EngineConfig, GeneratorConfig,
                                   OffloadConfig, PipelineSelection, QuantizationConfig)
        self.spec = spec
        _apply_env(environment(spec))
        _read_weights_whole()
        quant = QuantizationConfig(transformer_quant="NVFP4", layer_profile="h3_dit_vsa")
        components = ComponentConfig(lora_path=str(spec.lora) if spec.lora else None, lora_strength=1.0)
        if spec.ref2va:
            components.override_pipeline_cls_name = "MiniMaxH3Ref2VAModularPipeline"
            _size_references_like_comfyui()
        self.generator = VideoGenerator.from_config(GeneratorConfig(
            model_path=str(spec.model_dir),
            engine=EngineConfig(
                num_gpus=1,
                quantization=quant,
                # A GB10 keeps everything resident: 128 GB of unified memory.
                offload=OffloadConfig(dit=False, dit_layerwise=False, text_encoder=False, image_encoder=False,
                                      vae=False, pin_cpu_memory=False, lazy_module_load=False),
                # No torch.compile, VAE included: the V2 recipe compiles the VAE tiles with
                # CUDA graphs, whose state is per thread, and FastVideo runs each request in
                # a new thread, so a second job failed (LESSONS.md #37).
                compile=CompileConfig(enabled=False, vae_enabled=False),
            ),
            pipeline=PipelineSelection(
                workload_type="i2v" if spec.ref2va else "t2v",
                components=components,
                vae_tiling=True,
                experimental=experimental(spec),
            ),
        ))

    def close(self) -> None:
        self.generator.shutdown()

    @contextlib.contextmanager
    def overrides(self, latent_output: bool = False, pdd_step_indices: tuple[int, ...] | None = None):
        """Temporarily change what FastVideo copies into each request: latent output
        for the first pass, and the PDD blocks of the refine pass."""
        args = self.generator.fastvideo_args
        saved = (args.output_type, getattr(args.pipeline_config, "pdd_step_indices", None))
        try:
            if latent_output:
                args.output_type = "latent"
            if pdd_step_indices is not None:
                args.pipeline_config.pdd_step_indices = tuple(pdd_step_indices)
            yield
        finally:
            args.output_type = saved[0]
            if pdd_step_indices is not None:
                args.pipeline_config.pdd_step_indices = saved[1]

    def generate(self, ctx, *, prompt: str, width: int, height: int, frames: int, steps: int, seed: int,
                 output: Path, save: bool = True, pil_image=None, last_image=None, references=None,
                 latents=None, audio_latents=None):
        """One FastVideo request; a cancelled job interrupts it and raises Cancelled."""
        from fastvideo.api import GenerationRequest, InputConfig, OutputConfig, SamplingConfig
        request = GenerationRequest(
            prompt=prompt,
            negative_prompt="",
            inputs=InputConfig(pil_image=pil_image, last_image=last_image, references=references,
                               latents=latents, audio_latents=audio_latents),
            sampling=SamplingConfig(height=height, width=width, num_frames=frames, fps=24,
                                    num_inference_steps=steps, guidance_scale=1.0, batch_cfg=False, seed=seed),
            output=OutputConfig(output_path=str(output), save_video=save, return_frames=True),
        )
        done = threading.Event()

        def watch():
            while not done.wait(0.5):
                if ctx.cancelled():
                    self.generator.executor.interrupt()
                    return

        watcher = threading.Thread(target=watch, name="h3-cancel", daemon=True)
        watcher.start()
        try:
            return self.generator.generate(request)
        except RuntimeError:
            ctx.check()  # an interrupted run raises RuntimeError: report it as cancelled
            raise
        finally:
            done.set()
