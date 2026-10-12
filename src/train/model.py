import math
from typing import Optional, Dict, Any
import torch
import torch.nn as nn
import torch.nn.functional as F

class CausalSelfAttention(nn.Module):
    """
    Standard multi-head causal self-attention with explicit projection matrices.
    Directly compatible with LoRA linear replacement on q_proj and v_proj.
    """
    def __init__(self, d_model: int, nhead: int, dropout: float = 0.1):
        super().__init__()
        assert d_model % nhead == 0, f"d_model ({d_model}) must be divisible by nhead ({nhead})"
        self.d_model = d_model
        self.nhead = nhead
        self.head_dim = d_model // nhead

        self.q_proj = nn.Linear(d_model, d_model)
        self.k_proj = nn.Linear(d_model, d_model)
        self.v_proj = nn.Linear(d_model, d_model)
        self.out_proj = nn.Linear(d_model, d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        b, s, d = x.size()
        q = self.q_proj(x).view(b, s, self.nhead, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(b, s, self.nhead, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(b, s, self.nhead, self.head_dim).transpose(1, 2)

        scores = (q @ k.transpose(-2, -1)) / math.sqrt(self.head_dim)
        if mask is not None:
            scores = scores.masked_fill(~mask, -1e4)

        probs = F.softmax(scores, dim=-1)
        probs = torch.nan_to_num(probs, nan=0.0)
        probs = self.dropout(probs)
        h = (probs @ v).transpose(1, 2).contiguous().view(b, s, d)
        return self.out_proj(h)

class TransformerBlock(nn.Module):
    def __init__(self, d_model: int, nhead: int, dim_feedforward: int, dropout: float = 0.1):
        super().__init__()
        self.ln_1 = nn.LayerNorm(d_model)
        self.attn = CausalSelfAttention(d_model, nhead, dropout)
        self.ln_2 = nn.LayerNorm(d_model)
        self.mlp = nn.Sequential(
            nn.Linear(d_model, dim_feedforward),
            nn.GELU(),
            nn.Linear(dim_feedforward, d_model),
            nn.Dropout(dropout)
        )

    def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        x = x + self.attn(self.ln_1(x), mask=mask)
        x = x + self.mlp(self.ln_2(x))
        return x

class MikaPolicyTransformer(nn.Module):
    """
    Lightweight Causal Transformer Language Model for MIKA Minecraft ALife decisions.
    Configurable for fast local training and fine-tuning with LoRA adapters.
    """
    def __init__(
        self,
        vocab_size: int = 256,
        d_model: int = 128,
        nhead: int = 4,
        num_layers: int = 4,
        dim_feedforward: int = 256,
        max_seq_len: int = 512,
        dropout: float = 0.1,
        pad_token_id: int = 0
    ):
        super().__init__()
        self.vocab_size = vocab_size
        self.d_model = d_model
        self.max_seq_len = max_seq_len
        self.pad_token_id = pad_token_id

        # Token & Positional embeddings
        self.tok_embed = nn.Embedding(vocab_size, d_model, padding_idx=pad_token_id)
        self.pos_embed = nn.Embedding(max_seq_len, d_model)
        self.dropout = nn.Dropout(dropout)

        # Transformer blocks
        self.blocks = nn.ModuleList([
            TransformerBlock(d_model, nhead, dim_feedforward, dropout)
            for _ in range(num_layers)
        ])
        self.ln_f = nn.LayerNorm(d_model)

        # Output LM head (weight tied with token embeddings)
        self.lm_head = nn.Linear(d_model, vocab_size, bias=False)
        self.lm_head.weight = self.tok_embed.weight

        self._init_weights()

    def _init_weights(self):
        for p in self.parameters():
            if p.dim() > 1:
                nn.init.normal_(p, mean=0.0, std=0.02)

    def forward(
        self,
        input_ids: torch.Tensor,
        labels: Optional[torch.Tensor] = None,
        attention_mask: Optional[torch.Tensor] = None
    ) -> Dict[str, Any]:
        b, s = input_ids.size()
        positions = torch.arange(0, s, device=input_ids.device).unsqueeze(0).expand(b, s)

        # Embeddings
        x = self.tok_embed(input_ids) + self.pos_embed(positions)
        x = self.dropout(x)

        # Causal mask: True where attention is allowed (lower triangular)
        causal_mask = torch.tril(torch.ones(s, s, device=input_ids.device, dtype=torch.bool)).view(1, 1, s, s)
        if attention_mask is not None:
            # Combine with key padding mask (shape: b, 1, 1, s)
            key_pad = attention_mask.view(b, 1, 1, s).bool()
            diag_mask = torch.eye(s, device=input_ids.device, dtype=torch.bool).view(1, 1, s, s)
            causal_mask = (causal_mask & key_pad) | diag_mask

        for block in self.blocks:
            x = block(x, mask=causal_mask)

        x = self.ln_f(x)
        logits = self.lm_head(x)

        loss = None
        if labels is not None:
            shift_logits = logits[..., :-1, :].contiguous()
            shift_labels = labels[..., 1:].contiguous()
            loss_fct = nn.CrossEntropyLoss(ignore_index=-100)
            loss = loss_fct(shift_logits.view(-1, self.vocab_size), shift_labels.view(-1))

        return {
            "logits": logits,
            "loss": loss
        }

    @torch.no_grad()
    def generate(
        self,
        input_ids: torch.Tensor,
        max_new_tokens: int = 128,
        temperature: float = 0.2,
        top_k: int = 40,
        eos_token_id: Optional[int] = None
    ) -> torch.Tensor:
        self.eval()
        curr_ids = input_ids.clone()

        for _ in range(max_new_tokens):
            if curr_ids.size(1) >= self.max_seq_len:
                break

            out = self.forward(curr_ids)
            next_token_logits = out["logits"][:, -1, :]

            if temperature <= 0.05:
                next_token = torch.argmax(next_token_logits, dim=-1, keepdim=True)
            else:
                scaled_logits = next_token_logits / temperature
                if top_k > 0:
                    v, _ = torch.topk(scaled_logits, min(top_k, scaled_logits.size(-1)))
                    scaled_logits[scaled_logits < v[:, [-1]]] = -float('Inf')
                probs = F.softmax(scaled_logits, dim=-1)
                next_token = torch.multinomial(probs, num_samples=1)

            curr_ids = torch.cat([curr_ids, next_token], dim=1)

            if eos_token_id is not None and (next_token == eos_token_id).all():
                break

        return curr_ids
