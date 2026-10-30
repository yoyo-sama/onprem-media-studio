import hashlib
import json
import struct
from types import SimpleNamespace

from studio import import14
from studio.models import ModelStore


def safetensors(tensors: dict[str, bytes], order=None) -> bytes:
    """A safetensors file of uint8 vectors, data laid out in `order`."""
    header, data = {"__metadata__": {"format": "pt"}}, b""
    for name in order or tensors:
        header[name] = {"dtype": "U8", "shape": [len(tensors[name])],
                        "data_offsets": [len(data), len(data) + len(tensors[name])]}
        data += tensors[name]
    raw = json.dumps(header).encode()
    return struct.pack("<Q", len(raw)) + raw + data


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Api:
    def __init__(self, files: dict[str, bytes]):
        self.files = files

    def model_info(self, repo, files_metadata, token):
        return SimpleNamespace(sha="rev", siblings=[
            SimpleNamespace(rfilename=f, size=len(d), lfs=SimpleNamespace(sha256=sha(d)))
            for f, d in self.files.items()])


def only(store, model_id):
    store.catalog = {model_id: store.catalog[model_id]}
    return store


def test_an_identical_file_is_reused_and_a_lookalike_is_not(settings, tmp_path):
    upscaler = "minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"
    good = b"weights" * 10
    store = only(ModelStore(settings, api=Api({upscaler: good})), "h3-latent-upscaler")
    root = tmp_path / "comfy"
    (root / "latent_upscale_models").mkdir(parents=True)
    (root / "latent_upscale_models" / "same_size_other_bytes.safetensors").write_bytes(b"x" * len(good))
    lines = []
    import14.import_models(root, store, lines.append)
    assert not (store.path("h3-latent-upscaler") / upscaler).exists()
    assert lines == ["download MiniMax H3 latent upscaler (3D conv v1, LBH-123-AI): 0.0 GB still to download"]

    (root / "latent_upscale_models" / "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors").write_bytes(good)
    lines.clear()
    import14.import_models(root, store, lines.append)
    assert (store.path("h3-latent-upscaler") / upscaler).read_bytes() == good
    assert lines[0].startswith("reused ")
    assert not store.installed("h3-latent-upscaler")  # the next download checks and marks it


def test_a_shard_is_rebuilt_from_a_single_local_file_only_when_it_comes_out_identical(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(import14, "MIN_REBUILD", 0)
    weights = {"a": b"\x01" * 16, "b": b"\x02" * 8, "c": b"\x03" * 4}
    shard = safetensors({"b": weights["b"], "a": weights["a"]})
    other = safetensors({"c": weights["c"]})
    rel1, rel2 = "text_encoder/model-00001-of-00002.safetensors", "text_encoder/model-00002-of-00002.safetensors"
    remote = {rel1: shard, rel2: other}
    monkeypatch.setattr(import14, "remote_header",
                        lambda repo, f, rev, token: remote[f][:8 + struct.unpack("<Q", remote[f][:8])[0]])
    store = only(ModelStore(settings, api=Api(remote)), "qwen-image-2.1")
    root = tmp_path / "comfy"
    (root / "text_encoders").mkdir(parents=True)
    # One ComfyUI file, its own header and order, holding every tensor of both shards.
    (root / "text_encoders" / "qwen3vl_8b_bf16.safetensors").write_bytes(
        safetensors({**weights, "c": b"\x09" * 4}, order=["c", "a", "b"]))
    lines = []
    import14.import_models(root, store, lines.append)
    folder = store.path("qwen-image-2.1")
    assert (folder / rel1).read_bytes() == shard
    # Same names and shapes, other bytes: the SHA-256 differs, nothing is left behind.
    assert not (folder / rel2).exists()
    assert sorted(p.name for p in (folder / "text_encoder").iterdir()) == [rel1.split("/")[1]]
    assert lines[0].startswith("rebuilt  Qwen Image 2.1: " + rel1)
    assert lines[-1].startswith("download Qwen Image 2.1")


def test_installed_models_are_left_alone(settings, tmp_path):
    store = only(ModelStore(settings, api=None), "h3-latent-upscaler")
    folder = store.path("h3-latent-upscaler")
    folder.mkdir(parents=True)
    (folder / ".complete").write_text("{}")
    lines = []
    import14.import_models(tmp_path, store, lines.append)  # api=None: never asked
    assert lines == []


def test_h3_loras_are_copied_except_speedup_and_rejected_ones(settings, tmp_path, monkeypatch):
    src = tmp_path / "comfy" / "loras" / "H3"
    src.mkdir(parents=True)
    for name in ["MyStyle.safetensors", "minimax_h3_turbo_v4.safetensors", "Acc-8Step.safetensors",
                 "pdd_acc_8step.safetensors", "lightx2v_rank64.safetensors", "NotH3.safetensors",
                 "Present.safetensors"]:
        (src / name).write_bytes(b"lora")
    (tmp_path / "comfy" / "loras" / "Krea2").mkdir()
    (tmp_path / "comfy" / "loras" / "Krea2" / "KreaStyle.safetensors").write_bytes(b"lora")
    dest = settings.loras_dir / "h3"
    dest.mkdir(parents=True)
    (dest / "Present.safetensors").write_bytes(b"mine")

    def convert(path):
        if path.name == "NotH3.safetensors":
            raise ValueError("LoRA NotH3.safetensors has keys that match no MiniMax H3 layer")
        return {}
    monkeypatch.setattr(import14.h3_lora, "_convert", convert)
    lines = []
    import14.import_loras(tmp_path / "comfy", dest, lines.append)
    assert sorted(p.name for p in dest.iterdir()) == ["MyStyle.safetensors", "Present.safetensors"]
    assert (dest / "Present.safetensors").read_bytes() == b"mine"
    assert sum("speed-up" in line for line in lines) == 4
    assert any("NotH3" in line and "match no MiniMax H3 layer" in line for line in lines)
