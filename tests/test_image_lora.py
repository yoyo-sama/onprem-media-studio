"""Style LoRAs on the image engines (Krea 2, Qwen Image 2.1, MOSS-Image): each engine takes a
stack from its own folder, refuses files from another, and hands the stack to its runtime;
image_lora.apply loads adapters only when the files change and unloads them for a render
without LoRA. The real loaders are checked in test_image_lora_models.py (torch needed)."""

import os
import pytest

from studio.pipelines import common, image_lora, krea2, moss, qwen

from .test_image_pipelines import client, fake, rejected, run  # noqa: F401  (fixtures)


class FakeMoss:
    """The resident MOSS engine: records the stack it is given and renders gray."""

    def use_loras(self, stack, folder):
        self.loras = (stack, folder)

    def render(self, prompt, width, height, steps, guidance, turbo, count, seed, callback):
        from PIL import Image
        self.turbo = turbo
        return [Image.new("RGB", (width, height), "gray")] * count

FOLDERS = {"krea2-t2i": "krea2", "qwen-image-2.1": "qwen21", "moss-image": "moss"}


@pytest.fixture
def lora_files(settings):
    for folder in ("krea2", "qwen21", "moss", "h3"):
        (settings.loras_dir / folder).mkdir(parents=True)
        (settings.loras_dir / folder / f"{folder}-style.safetensors").write_bytes(b"x")
    return settings.loras_dir


@pytest.fixture
def applied(monkeypatch):
    calls = []
    monkeypatch.setattr(image_lora, "apply", lambda pipe, stack, folder: calls.append((stack, folder)))
    return calls


@pytest.mark.parametrize("pipeline", ["krea2-t2i", "qwen-image-2.1"])
def test_diffusers_engines_apply_the_stack_of_their_folder(client, fake, lora_files, applied, pipeline):
    folder = FOLDERS[pipeline]
    stack = [{"name": f"{folder}-style.safetensors", "strength": 0.7}]
    job = run(client, pipeline, {"prompt": "p", "loras": stack})
    assert job["params"]["loras"] == stack
    assert applied[-1] == (stack, lora_files / folder)
    run(client, pipeline, {"prompt": "p"})
    assert applied[-1] == ([], lora_files / folder)  # no stack: whatever is loaded is unloaded


def test_moss_hands_the_stack_to_its_runtime(client, monkeypatch, lora_files):
    engine = FakeMoss()
    monkeypatch.setattr(common, "load", lambda key, build, size=0: engine)
    stack = [{"name": "moss-style.safetensors", "strength": -0.5}]
    run(client, "moss-image", {"prompt": "p", "mode": "preview", "loras": stack})
    assert engine.loras == (stack, lora_files / "moss")
    assert engine.turbo  # the turbo LoRA still runs under the style LoRAs


@pytest.mark.parametrize("pipeline", list(FOLDERS))
def test_a_file_of_another_engine_is_refused(client, lora_files, pipeline):
    for other in ("h3", *(f for f in FOLDERS.values() if f != FOLDERS[pipeline])):
        detail = rejected(client, pipeline, {"prompt": "p", "loras": [{"name": f"{other}-style.safetensors"}]})
        assert f"No such LoRA: loras/{FOLDERS[pipeline]}/" in detail


@pytest.mark.parametrize("pipeline", list(FOLDERS))
def test_stack_limits_are_those_of_every_engine(client, lora_files, pipeline):
    name = f"{FOLDERS[pipeline]}-style.safetensors"
    assert "between -2 and 2" in rejected(client, pipeline, {"prompt": "p", "loras": [{"name": name, "strength": 3}]})
    assert "at most 4" in rejected(client, pipeline, {"prompt": "p", "loras": [{"name": name}] * 5})


def test_engines_name_their_folders():
    assert (krea2.LORA_FOLDER, qwen.LORA_FOLDER, moss.LORA_FOLDER) == ("krea2", "qwen21", "moss")


def test_unmatched_keys():
    linears = {"transformer_blocks.0.attn.to_q", "proj_out"}
    keys = ["transformer.transformer_blocks.0.attn.to_q.lora_A.weight",
            "transformer.transformer_blocks.0.attn.to_q.lora_B.weight",
            "transformer.proj_out.lora_A.weight",                       # B half missing
            "transformer.transformer_blocks.9.attn.to_q.lora_A.weight",  # no such layer
            "transformer_blocks.0.attn.to_q.lora_B.weight",              # no transformer. prefix
            "text_encoder.layers.0.q_proj.lora_A.weight"]
    assert image_lora.unmatched(keys, linears) == keys[3:] + ["proj_out (one half missing)"]


# ── apply(), on a pipeline that records what is done to it ───────────────────

class RecordingPipe:
    def __init__(self):
        self.transformer = type("T", (), {"peft_config": None})()
        self.log = []

    def load_lora_weights(self, path, weight_name, adapter_name, local_files_only):
        self.transformer.peft_config = {**(self.transformer.peft_config or {}), adapter_name: path}
        self.log.append(("load", weight_name, adapter_name))

    def unload_lora_weights(self):
        self.transformer.peft_config = None
        self.log.append(("unload",))

    def set_adapters(self, names, weights):
        self.log.append(("set", names, weights))


def test_apply_loads_only_on_a_change_and_unloads_for_no_lora(tmp_path, monkeypatch):
    monkeypatch.setattr(image_lora, "_check", lambda pipe, path: None)
    for name in ("a", "b"):
        (tmp_path / f"{name}.safetensors").write_bytes(b"x")
    pipe = RecordingPipe()
    image_lora.apply(pipe, [], tmp_path)
    assert pipe.log == []  # never touched by a render without LoRA
    stack = [{"name": "a.safetensors", "strength": 0.8}, {"name": "b.safetensors", "strength": -1.0}]
    image_lora.apply(pipe, stack, tmp_path)
    assert pipe.log == [("load", "a.safetensors", "lora0"), ("load", "b.safetensors", "lora1"),
                        ("set", ["lora0", "lora1"], [0.8, -1.0])]
    pipe.log.clear()
    image_lora.apply(pipe, [dict(stack[0], strength=0.3), stack[1]], tmp_path)
    assert pipe.log == [("set", ["lora0", "lora1"], [0.3, -1.0])]  # same files: strengths only
    pipe.log.clear()
    os.utime(tmp_path / "b.safetensors", ns=(1, 1))  # the file was replaced
    image_lora.apply(pipe, stack, tmp_path)
    assert pipe.log[0] == ("unload",) and len(pipe.log) == 4
    pipe.log.clear()
    image_lora.apply(pipe, [], tmp_path)
    assert pipe.log == [("unload",)]


def test_a_refused_file_leaves_no_half_stack(tmp_path, monkeypatch):
    for name in ("a", "b"):
        (tmp_path / f"{name}.safetensors").write_bytes(b"x")

    def check(pipe, path):
        if path.name == "b.safetensors":
            raise ValueError("LoRA b.safetensors: 3 key(s) match no layer")
    monkeypatch.setattr(image_lora, "_check", check)
    pipe = RecordingPipe()
    with pytest.raises(ValueError, match="match no layer"):
        image_lora.apply(pipe, [{"name": "a.safetensors", "strength": 1}, {"name": "b.safetensors", "strength": 1}], tmp_path)
    pipe.log.clear()
    image_lora.apply(pipe, [{"name": "a.safetensors", "strength": 1}], tmp_path)
    assert pipe.log[0] == ("unload",)  # the a loaded before the refusal is not reused half-set
