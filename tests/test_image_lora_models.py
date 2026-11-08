"""The LoRA loaders of the image engines on tiny models, with torch, diffusers and peft (the
versions of docker/constraints.txt): a Krea 2 / Qwen adapter is an exact side branch next to
weights it never changes, a stack is the weighted sum, unloading gives the original layers
back, a file whose keys miss the model is refused; MOSS reads diffusers files and their
metadata alpha, and its hooks add up with their strengths."""

import json
from pathlib import Path

import pytest

torch = pytest.importorskip("torch")
pytest.importorskip("peft")
pytest.importorskip("diffusers")

from studio.pipelines import image_lora, moss  # noqa: E402



def save(path: Path, tensors: dict, metadata: dict | None = None) -> Path:
    from safetensors.torch import save_file
    save_file({k: v.contiguous() for k, v in tensors.items()}, str(path), metadata=metadata)
    return path


def tiny_qwen():
    """A one-block Qwen Image 2.1 transformer inside an object that loads LoRAs like the pipeline."""
    from diffusers import DiffusionPipeline, QwenImage21Transformer2DModel
    from diffusers.loaders import QwenImageLoraLoaderMixin

    class TinyQwenPipeline(DiffusionPipeline, QwenImageLoraLoaderMixin):
        """QwenImage21Pipeline's base classes, with the transformer as its only component."""

        def __init__(self, transformer):
            super().__init__()
            self.register_modules(transformer=transformer)

    torch.manual_seed(0)
    return TinyQwenPipeline(QwenImage21Transformer2DModel(**_small_config(QwenImage21Transformer2DModel)))


def _small_config(cls):
    """The smallest config the model's __init__ accepts: every size argument shrunk."""
    import inspect
    small = {"num_layers": 1, "attention_head_dim": 8, "num_attention_heads": 2, "in_channels": 4,
             "out_channels": 4, "joint_attention_dim": 16, "context_in_dim": 16, "axes_dims_rope": (2, 2, 4),
             "patch_size": 1, "mlp_ratio": 2}
    params = inspect.signature(cls.__init__).parameters
    return {k: v for k, v in small.items() if k in params}


def test_peft_adapter_is_an_exact_side_branch_and_unloads_clean(tmp_path):
    pipe = tiny_qwen()
    layer = pipe.transformer.transformer_blocks[0].attn.to_q
    x = torch.randn(3, layer.in_features)
    plain = layer(x).detach().clone()
    rank = 2
    d1, u1 = torch.randn(rank, layer.in_features), torch.randn(layer.out_features, rank)
    d2, u2 = torch.randn(rank, layer.in_features), torch.randn(layer.out_features, rank)
    # A ComfyUI file (diffusion_model., kohya halves, alpha) and a diffusers one.
    save(tmp_path / "comfy.safetensors", {
        "diffusion_model.transformer_blocks.0.attn.to_q.lora_down.weight": d1,
        "diffusion_model.transformer_blocks.0.attn.to_q.lora_up.weight": u1,
        "diffusion_model.transformer_blocks.0.attn.to_q.alpha": torch.tensor(1.0)})
    save(tmp_path / "peft.safetensors", {
        "transformer.transformer_blocks.0.attn.to_q.lora_A.weight": d2,
        "transformer.transformer_blocks.0.attn.to_q.lora_B.weight": u2})
    stack = [{"name": "comfy.safetensors", "strength": 0.5}, {"name": "peft.safetensors", "strength": -1.0}]
    image_lora.apply(pipe, stack, tmp_path)
    expected = plain + 0.5 * (1.0 / rank) * (x @ d1.T @ u1.T) - (x @ d2.T @ u2.T)
    wrapped = pipe.transformer.transformer_blocks[0].attn.to_q  # PEFT wraps the layer
    assert torch.allclose(wrapped(x), expected, atol=1e-4)
    assert torch.equal(wrapped.base_layer.weight, layer.weight)  # never merged into the weights
    image_lora.apply(pipe, [], tmp_path)
    restored = pipe.transformer.transformer_blocks[0].attn.to_q
    assert isinstance(restored, torch.nn.Linear) and not hasattr(restored, "base_layer")
    assert torch.equal(restored(x), plain)


def test_a_qwen_lora_for_another_model_is_refused(tmp_path):
    pipe = tiny_qwen()
    save(tmp_path / "flux.safetensors", {
        "transformer.single_transformer_blocks.0.attn.to_q.lora_A.weight": torch.ones(2, 8),
        "transformer.single_transformer_blocks.0.attn.to_q.lora_B.weight": torch.ones(8, 2)})
    with pytest.raises(ValueError, match="match no layer of this engine"):
        image_lora.apply(pipe, [{"name": "flux.safetensors", "strength": 1.0}], tmp_path)
    assert not getattr(pipe.transformer, "peft_config", None)


# MOSS: diffusers-format files and metadata alpha, read by its own hook loader.

class TinyMoss(torch.nn.Module):
    def __init__(self):
        super().__init__()
        block = torch.nn.Module()
        block.proj = torch.nn.ModuleDict({"q": torch.nn.Linear(4, 4, bias=False)})
        self.layers = torch.nn.ModuleList([block])

    def forward(self, x):
        return self.layers[0].proj["q"](x)


def test_moss_reads_diffusers_files_with_their_metadata_alpha(tmp_path):
    keys = {"transformer.layers.0.proj.q.lora_A.weight": torch.ones(2, 4),
            "transformer.layers.0.proj.q.lora_B.weight": torch.ones(4, 2)}
    plain = moss.read_lora(save(tmp_path / "plain.safetensors", keys), TinyMoss())
    assert plain["layers.0.proj.q"][2] == 1.0  # no alpha anywhere: alpha = rank
    meta = {"lora_adapter_metadata": json.dumps({"transformer.r": 2, "transformer.lora_alpha": 8})}
    scaled = moss.read_lora(save(tmp_path / "meta.safetensors", keys, meta), TinyMoss())
    assert scaled["layers.0.proj.q"][2] == 4.0
    meta = {"lora_adapter_metadata": json.dumps({"r": 2, "lora_alpha": 2, "rank_pattern": {"q": 4}})}
    with pytest.raises(ValueError, match="patterns"):
        moss.read_lora(save(tmp_path / "pattern.safetensors", keys, meta), TinyMoss())


def test_moss_stack_hooks_add_up_with_their_strengths():
    model = TinyMoss()
    x = torch.ones(1, 4)
    plain = model(x)
    one = {"layers.0.proj.q": (torch.ones(1, 4), torch.ones(4, 1), 1.0)}       # adds 4 per output
    two = {"layers.0.proj.q": (torch.ones(1, 4), torch.full((4, 1), 2.0), 1.0)}  # adds 8 per output
    with moss.lora_hooks(model, one, 0.5), moss.lora_hooks(model, two, -1.0):
        assert torch.allclose(model(x) - plain, torch.full((1, 4), 0.5 * 4 - 8.0))
    assert torch.equal(model(x), plain)
