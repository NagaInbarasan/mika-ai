import argparse
import json
import os
import re
import sys
import time
from typing import Dict, Any, List
import torch
from torch.utils.data import DataLoader

from dataset import CharacterTokenizer, MinecraftChatMLDataset, collate_fn
from model import MikaPolicyTransformer
from lora import apply_lora, load_lora_checkpoint

def extract_action_from_output(text: str) -> str:
    """Extracts the planned action string from generated JSON or text."""
    try:
        # Match "action": "xxx" or "action":"xxx"
        match = re.search(r'"action"\s*:\s*"([a-zA-Z0-9_]+)"', text)
        if match:
            return match.group(1)
        # Match any known Minecraft action keyword
        for act in ['navigate_to', 'collect_resource', 'craft_item', 'look_around', 'inspect_inventory', 'eat_food', 'stop']:
            if f'"{act}"' in text or f": {act}" in text:
                return act
        # Or parse full JSON
        data = json.loads(text)
        return data.get('action', 'unknown')
    except Exception:
        return 'unknown'

def run_evaluation(args) -> Dict[str, Any]:
    print("=== MIKA MODEL EVALUATION ON UNSEEN SCENARIOS ===")
    print(f"Candidate Checkpoint : {args.candidate_checkpoint}")
    print(f"Eval File (Unseen)   : {args.eval_file}")
    print(f"Baseline Loss        : {args.baseline_loss}")
    print(f"Baseline Accuracy    : {args.baseline_accuracy:.2%}")

    if not os.path.exists(args.candidate_checkpoint):
        raise FileNotFoundError(f"Candidate checkpoint not found: {args.candidate_checkpoint}")
    if not os.path.exists(args.eval_file):
        raise FileNotFoundError(f"Evaluation file not found: {args.eval_file}")

    device = torch.device(args.device if (args.device == 'cuda' and torch.cuda.is_available()) else 'cpu')
    tokenizer = CharacterTokenizer()

    # Load dataset
    eval_dataset = MinecraftChatMLDataset(args.eval_file, tokenizer, max_seq_len=args.max_seq_len, strict_clean=True)
    eval_loader = DataLoader(
        eval_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=lambda b: collate_fn(b, tokenizer.pad_token_id)
    )

    # Instantiate model & load checkpoint
    model = MikaPolicyTransformer(
        vocab_size=tokenizer.vocab_size,
        d_model=args.d_model,
        nhead=args.nhead,
        num_layers=args.num_layers,
        dim_feedforward=args.dim_feedforward,
        max_seq_len=args.max_seq_len,
        pad_token_id=tokenizer.pad_token_id
    )

    apply_lora(model, r=args.lora_r, alpha=args.lora_alpha)
    meta = load_lora_checkpoint(model, args.candidate_checkpoint)
    model.to(device)
    model.eval()

    print(f"[Model] Checkpoint loaded successfully (Trained Epoch: {meta.get('best_epoch', 'N/A')})")

    # 1. Compute Cross-Entropy Loss on Unseen Scenarios
    total_loss = 0.0
    step_count = 0
    with torch.no_grad():
        for batch_inputs, batch_labels, batch_mask in eval_loader:
            batch_inputs = batch_inputs.to(device)
            batch_labels = batch_labels.to(device)
            batch_mask = batch_mask.to(device)

            out = model(batch_inputs, labels=batch_labels, attention_mask=batch_mask)
            total_loss += out["loss"].item()
            step_count += 1

    candidate_eval_loss = round(total_loss / max(1, step_count), 4)

    # 2. Test Generation & Action Prediction on Held-Out Scenarios
    correct_actions = 0
    valid_schemas = 0
    sample_eval_limit = min(50, len(eval_dataset))

    eval_raw_records = []
    with open(args.eval_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                eval_raw_records.append(json.loads(line))

    print(f"[Inference] Testing decision accuracy on {sample_eval_limit} held-out episodes...")
    for i in range(sample_eval_limit):
        rec = eval_raw_records[i]
        # Expected action
        expected_action = "stop"
        if 'output' in rec:
            expected_action = extract_action_from_output(rec['output'])
        elif 'target' in rec and isinstance(rec['target'], dict):
            expected_action = rec['target'].get('action', 'stop')
        elif 'messages' in rec:
            for m in rec['messages']:
                if m.get('role') == 'assistant':
                    expected_action = extract_action_from_output(m.get('content', ''))

        # Prepare prompt
        input_ids, labels = eval_dataset[i]
        # Find exact prompt length (where labels are -100)
        prompt_len = (labels == -100).sum().item()
        prompt_tensor = input_ids[:prompt_len].unsqueeze(0).to(device)

        with torch.no_grad():
            gen_ids = model.generate(
                prompt_tensor,
                max_new_tokens=160,
                temperature=0.0,
                eos_token_id=tokenizer.eos_token_id
            )

        gen_text = tokenizer.decode(gen_ids[0].tolist()[prompt_len:])
        predicted_action = extract_action_from_output(gen_text)

        # Check validity
        if "{" in gen_text and ("}" in gen_text or '"action"' in gen_text or '"goal"' in gen_text):
            valid_schemas += 1
        if predicted_action == expected_action and predicted_action != 'unknown':
            correct_actions += 1

    candidate_accuracy = round(correct_actions / max(1, sample_eval_limit), 4)
    schema_validity = round(valid_schemas / max(1, sample_eval_limit), 4)

    # 3. Acceptance / Rejection Decision vs Baseline
    rejection_reasons = []

    # Check loss regression
    if candidate_eval_loss > (args.baseline_loss + args.loss_tolerance):
        rejection_reasons.append(
            f"Eval loss regressed: candidate {candidate_eval_loss} > baseline {args.baseline_loss} (+tol {args.loss_tolerance})"
        )

    # Check accuracy regression
    min_required_acc = args.baseline_accuracy * args.min_accuracy_ratio
    if candidate_accuracy < min_required_acc:
        rejection_reasons.append(
            f"Action prediction accuracy dropped: candidate {candidate_accuracy:.2%} < required {min_required_acc:.2%}"
        )

    # Check schema validity
    if schema_validity < args.min_schema_validity:
        rejection_reasons.append(
            f"JSON schema output validity too low: candidate {schema_validity:.2%} < {args.min_schema_validity:.2%}"
        )

    is_accepted = len(rejection_reasons) == 0

    print("\n=== EVALUATION RESULTS ===")
    print(f"Candidate Eval Loss  : {candidate_eval_loss} (Baseline: {args.baseline_loss})")
    print(f"Action Accuracy      : {candidate_accuracy:.2%} (Baseline: {args.baseline_accuracy:.2%})")
    print(f"Schema Validity      : {schema_validity:.2%}")
    print(f"Decision             : {'ACCEPTED' if is_accepted else 'REJECTED'}")
    if not is_accepted:
        print(f"Rejection Reasons    : {'; '.join(rejection_reasons)}")

    report = {
        "status": "evaluated",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "candidate_checkpoint": args.candidate_checkpoint,
        "eval_dataset": args.eval_file,
        "total_eval_samples": len(eval_dataset),
        "tested_samples": sample_eval_limit,
        "metrics": {
            "candidate_eval_loss": candidate_eval_loss,
            "baseline_eval_loss": args.baseline_loss,
            "loss_delta": round(candidate_eval_loss - args.baseline_loss, 4),
            "candidate_action_accuracy": candidate_accuracy,
            "baseline_action_accuracy": args.baseline_accuracy,
            "accuracy_delta": round(candidate_accuracy - args.baseline_accuracy, 4),
            "schema_validity_rate": schema_validity
        },
        "acceptance": {
            "accepted": is_accepted,
            "criteria_met": {
                "loss_within_tolerance": candidate_eval_loss <= (args.baseline_loss + args.loss_tolerance),
                "accuracy_meets_baseline": candidate_accuracy >= min_required_acc,
                "schema_syntax_valid": schema_validity >= args.min_schema_validity
            },
            "rejection_reasons": rejection_reasons
        }
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.report_file)), exist_ok=True)
    with open(args.report_file, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)

    print(f"Report written to: {args.report_file}")
    return report

def parse_args():
    parser = argparse.ArgumentParser(description="MIKA Candidate Model Evaluation")
    parser.add_argument("--candidate-checkpoint", type=str, default="data/models/checkpoints/best_model.pt")
    parser.add_argument("--eval-file", type=str, default="data/processed/sft_chatml_eval.jsonl")
    parser.add_argument("--baseline-loss", type=float, default=4.5)
    parser.add_argument("--baseline-accuracy", type=float, default=0.20)
    parser.add_argument("--loss-tolerance", type=float, default=0.5)
    parser.add_argument("--min-accuracy-ratio", type=float, default=0.9)
    parser.add_argument("--min-schema-validity", type=float, default=0.7)
    parser.add_argument("--report-file", type=str, default="data/reports/evaluation_report.json")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-seq-len", type=int, default=512)
    parser.add_argument("--d-model", type=int, default=128)
    parser.add_argument("--nhead", type=int, default=4)
    parser.add_argument("--num-layers", type=int, default=4)
    parser.add_argument("--dim-feedforward", type=int, default=256)
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-alpha", type=float, default=16.0)
    parser.add_argument("--device", type=str, default="cuda")
    return parser.parse_args()

if __name__ == "__main__":
    args = parse_args()
    report = run_evaluation(args)
    if not report["acceptance"]["accepted"]:
        print("[Evaluation Notice] Model rejected based on performance criteria.")
