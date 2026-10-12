import json
import os
from typing import List, Dict, Any, Tuple
import torch
from torch.utils.data import Dataset

class CharacterTokenizer:
    """
    Robust character & keyword-level tokenizer for Minecraft JSON/ChatML actions.
    Ensures zero external tokenizer dependencies while covering all JSON syntax and tokens.
    """
    def __init__(self):
        # Base special tokens
        self.pad_token = "<pad>"
        self.bos_token = "<bos>"
        self.eos_token = "<eos>"
        self.unk_token = "<unk>"
        self.system_token = "<|system|>"
        self.user_token = "<|user|>"
        self.assistant_token = "<|assistant|>"

        self.special_tokens = [
            self.pad_token, self.bos_token, self.eos_token, self.unk_token,
            self.system_token, self.user_token, self.assistant_token
        ]

        # Common Minecraft action keywords and JSON subwords
        self.keywords = [
            '{"goal":', '{"action":', '"arguments":', '"reason_summary":',
            '"expected_outcome":', '"confidence":', '"risk":', '"environment":',
            '"observation":', '"position":', '"health":', '"food":', '"inventory":',
            '"nearby_threats":', '"nearby_resources":', '"available_actions":',
            '"dimension":', '"minecraft_version":', '"world_id":', '"overworld":',
            '"collect_resource"', '"craft_item"', '"navigate_to"', '"look_around"',
            '"inspect_inventory"', '"eat_food"', '"equip_item"', '"attack_target"',
            '"build_shelter"', '"stop"', '"success"', '"failed"', '"true"', '"false"',
            '"wood"', '"sand"', '"dirt"', '"stick"', '"planks"', '"oak_log"',
            'You are MIKA', 'autonomous Minecraft', 'survival agent'
        ]

        # Sort keywords by descending length so longest match takes precedence
        self.keywords.sort(key=len, reverse=True)

        self.vocab: Dict[str, int] = {}
        self.inv_vocab: Dict[int, str] = {}
        self._build_vocab()

    def _build_vocab(self):
        idx = 0
        for tok in self.special_tokens:
            self.vocab[tok] = idx
            self.inv_vocab[idx] = tok
            idx += 1

        for kw in self.keywords:
            self.vocab[kw] = idx
            self.inv_vocab[idx] = kw
            idx += 1

        # ASCII characters (printable)
        for c in range(32, 127):
            ch = chr(c)
            if ch not in self.vocab:
                self.vocab[ch] = idx
                self.inv_vocab[idx] = ch
                idx += 1

        # Add newline and tab
        for ch in ['\n', '\r', '\t']:
            if ch not in self.vocab:
                self.vocab[ch] = idx
                self.inv_vocab[idx] = ch
                idx += 1

    @property
    def vocab_size(self) -> int:
        return len(self.vocab)

    @property
    def pad_token_id(self) -> int:
        return self.vocab[self.pad_token]

    @property
    def bos_token_id(self) -> int:
        return self.vocab[self.bos_token]

    @property
    def eos_token_id(self) -> int:
        return self.vocab[self.eos_token]

    def encode(self, text: str) -> List[int]:
        tokens = []
        i = 0
        n = len(text)
        while i < n:
            # Check for special tokens
            matched_special = False
            for st in self.special_tokens:
                if text.startswith(st, i):
                    tokens.append(self.vocab[st])
                    i += len(st)
                    matched_special = True
                    break
            if matched_special:
                continue

            # Check for keywords
            matched_kw = False
            for kw in self.keywords:
                if text.startswith(kw, i):
                    tokens.append(self.vocab[kw])
                    i += len(kw)
                    matched_kw = True
                    break
            if matched_kw:
                continue

            # Single char fallback
            ch = text[i]
            tokens.append(self.vocab.get(ch, self.vocab[self.unk_token]))
            i += 1
        return tokens

    def decode(self, token_ids: Any) -> str:
        if isinstance(token_ids, torch.Tensor):
            token_ids = token_ids.tolist()
        res = []
        for tid in token_ids:
            if isinstance(tid, torch.Tensor):
                tid = tid.item()
            int_tid = int(tid)
            if int_tid == self.pad_token_id:
                continue
            res.append(self.inv_vocab.get(int_tid, ''))
        return "".join(res)


def validate_dataset_quality(records: List[Dict[str, Any]], dataset_type: str = "train", min_samples: int = 5) -> Dict[str, Any]:
    """
    Enforces strict pre-flight quality checks:
    - Minimum sample count
    - No corrupt or non-object records
    - Invariant: Never silently convert failed actions into successful examples
    """
    issues = []
    failed_action_count = 0
    valid_count = 0

    if len(records) < min_samples:
        issues.append(f"Insufficient samples: found {len(records)}, required at least {min_samples}")

    for i, r in enumerate(records):
        if not isinstance(r, dict):
            issues.append(f"Row {i} is not a valid JSON object")
            continue

        # Invariant check: Failures MUST NOT exist in positive SFT demonstration datasets
        is_failed = False
        if r.get('metadata', {}).get('execution_status') in ['failed', 'timeout']:
            is_failed = True
        if r.get('metadata', {}).get('failure_detected', False):
            is_failed = True
        if r.get('metadata', {}).get('reward', 0) < 0:
            is_failed = True

        if is_failed:
            failed_action_count += 1
            issues.append(f"Row {i} contains failed action metadata in positive training set ({r.get('event_id')})")

        # Must have prompt/input and target/output
        has_content = ('messages' in r) or ('instruction' in r and 'output' in r) or ('target' in r)
        if not has_content:
            issues.append(f"Row {i} is missing input or target content")
        else:
            valid_count += 1

    passed = len(issues) == 0
    return {
        "passed": passed,
        "dataset_type": dataset_type,
        "total_records": len(records),
        "valid_records": valid_count,
        "failed_actions_detected": failed_action_count,
        "issues": issues[:20]
    }


class MinecraftChatMLDataset(Dataset):
    """
    PyTorch Dataset for ChatML / Action Prediction JSONL records.
    Constructs prompt and target tokens, masking loss on prompt tokens.
    """
    def __init__(self, file_path: str, tokenizer: CharacterTokenizer, max_seq_len: int = 512, strict_clean: bool = True):
        self.file_path = file_path
        self.tokenizer = tokenizer
        self.max_seq_len = max_seq_len
        self.samples: List[Tuple[torch.Tensor, torch.Tensor]] = []

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Dataset file not found: {file_path}")

        records = []
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                clean_line = line.strip()
                if not clean_line:
                    continue
                try:
                    records.append(json.loads(clean_line))
                except json.JSONDecodeError as err:
                    raise ValueError(f"Malformed JSONL at line {line_num} in {file_path}: {err}")

        # Quality validation
        quality = validate_dataset_quality(records, dataset_type=os.path.basename(file_path))
        if strict_clean and not quality['passed']:
            raise ValueError(f"Dataset failed pre-flight quality check: {quality['issues']}")

        # Build tokenized samples
        for r in records:
            # Extract prompt and response
            if 'messages' in r:
                prompt_parts = []
                response_text = ""
                for msg in r['messages']:
                    role = msg.get('role', 'user')
                    content = msg.get('content', '')
                    if role == 'assistant':
                        response_text = f"{content}<eos>"
                    else:
                        prompt_parts.append(f"<|{role}|>{content}")
                prompt_parts.append("<|assistant|>")
                prompt_text = "".join(prompt_parts)
            elif 'input' in r and 'output' in r:
                instruction = r.get('instruction', '')
                inp = r['input'] if isinstance(r['input'], str) else json.dumps(r['input'])
                out = r['output'] if isinstance(r['output'], str) else json.dumps(r['output'])
                prompt_text = f"<|system|>{instruction}<|user|>{inp}<|assistant|>"
                response_text = f"{out}<eos>"
            elif 'input' in r and 'target' in r:
                inp = json.dumps(r['input'])
                tgt = json.dumps(r['target'])
                prompt_text = f"<|system|>MIKA ALife Decision<|user|>{inp}<|assistant|>"
                response_text = f"{tgt}<eos>"
            else:
                continue

            prompt_ids = self.tokenizer.encode(prompt_text)
            resp_ids = self.tokenizer.encode(response_text)

            # Always preserve target response tokens so loss can be computed
            if len(resp_ids) >= max_seq_len:
                resp_ids = resp_ids[:max_seq_len - 16]

            max_prompt_len = max_seq_len - len(resp_ids)
            if len(prompt_ids) > max_prompt_len:
                # Keep the tail of the prompt (containing current state)
                prompt_ids = prompt_ids[-max_prompt_len:]

            input_ids = prompt_ids + resp_ids
            # Labels: -100 on prompt tokens so loss is computed strictly on assistant predictions
            labels = [-100] * len(prompt_ids) + resp_ids

            self.samples.append((
                torch.tensor(input_ids, dtype=torch.long),
                torch.tensor(labels, dtype=torch.long)
            ))

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        return self.samples[idx]


def collate_fn(batch: List[Tuple[torch.Tensor, torch.Tensor]], pad_token_id: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """
    Batches and pads variable-length sequences with attention mask.
    """
    input_ids_list = [item[0] for item in batch]
    labels_list = [item[1] for item in batch]

    max_len = max(len(ids) for ids in input_ids_list)

    padded_inputs = []
    padded_labels = []
    attention_masks = []

    for inp, lbl in zip(input_ids_list, labels_list):
        pad_len = max_len - len(inp)
        padded_inputs.append(torch.cat([inp, torch.full((pad_len,), pad_token_id, dtype=torch.long)]))
        padded_labels.append(torch.cat([lbl, torch.full((pad_len,), -100, dtype=torch.long)]))
        attention_masks.append(torch.cat([torch.ones(len(inp), dtype=torch.long), torch.zeros(pad_len, dtype=torch.long)]))

    return (
        torch.stack(padded_inputs),
        torch.stack(padded_labels),
        torch.stack(attention_masks)
    )
