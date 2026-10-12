import math
import os
import torch
import torch.nn as nn

class LoRALinear(nn.Module):
    """
    Low-Rank Adaptation (LoRA) linear wrapper.
    Augments frozen weights W0 with trainable low-rank decomposition B * A:
        h = W0 * x + (alpha / r) * (B * A) * x
    """
    def __init__(self, original_linear: nn.Linear, r: int = 8, alpha: float = 16.0, dropout: float = 0.05):
        super().__init__()
        self.in_features = original_linear.in_features
        self.out_features = original_linear.out_features
        self.r = r
        self.alpha = alpha
        self.scaling = alpha / r if r > 0 else 1.0

        # Preserve original linear layer and freeze its parameters
        self.original_linear = original_linear
        for p in self.original_linear.parameters():
            p.requires_grad = False

        if r > 0:
            self.lora_A = nn.Parameter(torch.empty(r, self.in_features))
            self.lora_B = nn.Parameter(torch.zeros(self.out_features, r))
            nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))
            nn.init.zeros_(self.lora_B)
            self.lora_dropout = nn.Dropout(p=dropout) if dropout > 0.0 else nn.Identity()
        else:
            self.lora_A = None
            self.lora_B = None
            self.lora_dropout = nn.Identity()

        self.merged = False

    @property
    def weight(self):
        return self.original_linear.weight

    @property
    def bias(self):
        return self.original_linear.bias

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        base_out = self.original_linear(x)
        if self.r <= 0 or self.merged:
            return base_out
        lora_out = (self.lora_dropout(x) @ self.lora_A.t()) @ self.lora_B.t()
        return base_out + lora_out * self.scaling

    def merge_weights(self):
        if self.r > 0 and not self.merged:
            delta = (self.lora_B @ self.lora_A) * self.scaling
            self.original_linear.weight.data += delta
            self.merged = True

    def unmerge_weights(self):
        if self.r > 0 and self.merged:
            delta = (self.lora_B @ self.lora_A) * self.scaling
            self.original_linear.weight.data -= delta
            self.merged = False


def apply_lora(model: nn.Module, r: int = 8, alpha: float = 16.0, dropout: float = 0.05, target_keywords=None, trainable_modules=None):
    """
    Applies LoRA to matching linear layers in the given PyTorch model.
    Freezes all base parameters and leaves only LoRA adapter parameters trainable.
    """
    if target_keywords is None:
        target_keywords = ['q_proj', 'v_proj', 'out_proj', 'mlp']

    # Freeze base model parameters
    for p in model.parameters():
        p.requires_grad = False

    replaced_count = 0

    def _replace_layers(module, prefix=""):
        nonlocal replaced_count
        for name, child in module.named_children():
            full_name = f"{prefix}.{name}" if prefix else name
            if isinstance(child, nn.Linear):
                matches = any(kw in name.lower() or kw in full_name.lower() for kw in target_keywords)
                if matches:
                    lora_layer = LoRALinear(child, r=r, alpha=alpha, dropout=dropout)
                    setattr(module, name, lora_layer)
                    replaced_count += 1
            else:
                _replace_layers(child, full_name)

    _replace_layers(model)

    # Unfreeze trainable head and embedding modules if specified
    if trainable_modules is None:
        trainable_modules = ['tok_embed', 'lm_head', 'pos_embed']

    for name, param in model.named_parameters():
        if any(mod in name for mod in trainable_modules):
            param.requires_grad = True

    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total_params = sum(p.numel() for p in model.parameters())
    trainable_percent = (trainable_params / total_params * 100.0) if total_params > 0 else 0.0

    return {
        "replaced_layers": replaced_count,
        "trainable_params": trainable_params,
        "total_params": total_params,
        "trainable_percent": round(trainable_percent, 3)
    }


def get_lora_state_dict(model: nn.Module) -> dict:
    """Returns all trainable parameters (LoRA adapters and unfreezed heads)."""
    return {k: v for k, v in model.state_dict().items() if v.requires_grad}


def save_lora_checkpoint(model: nn.Module, save_path: str, metadata: dict = None):
    """Saves LoRA weights along with full model state and hyperparameter metadata."""
    os.makedirs(os.path.dirname(os.path.abspath(save_path)), exist_ok=True)
    payload = {
        'state_dict': model.state_dict(),
        'lora_state_dict': get_lora_state_dict(model),
        'metadata': metadata or {}
    }
    torch.save(payload, save_path)


def load_lora_checkpoint(model: nn.Module, checkpoint_path: str):
    """Loads saved weights into the model."""
    checkpoint = torch.load(checkpoint_path, map_location='cpu')
    if 'state_dict' in checkpoint:
        model.load_state_dict(checkpoint['state_dict'], strict=True)
    else:
        lora_sd = checkpoint.get('lora_state_dict', checkpoint)
        model.load_state_dict(lora_sd, strict=False)
    return checkpoint.get('metadata', {})
