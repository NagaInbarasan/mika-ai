import argparse
import json
import os
import sys
import time
from typing import Dict, Any
import torch
from torch.utils.data import DataLoader

from dataset import CharacterTokenizer, MinecraftChatMLDataset, collate_fn, validate_dataset_quality
from model import MikaPolicyTransformer
from lora import apply_lora, save_lora_checkpoint, get_lora_state_dict

def get_peak_vram_mb() -> float:
    if torch.cuda.is_available():
        return round(torch.cuda.max_memory_allocated() / (1024 * 1024), 2)
    return 0.0

def run_training(args) -> Dict[str, Any]:
    start_time = time.time()
    os.makedirs(args.output_dir, exist_ok=True)
    report_dir = os.path.dirname(os.path.abspath(args.report_file))
    os.makedirs(report_dir, exist_ok=True)

    print(f"=== MIKA AUTONOMOUS LEARNING: PYTHON LORA FINE-TUNING ===")
    print(f"Train File      : {args.train_file}")
    print(f"Eval File       : {args.eval_file}")
    print(f"Output Dir      : {args.output_dir}")
    print(f"LoRA Rank (r)   : {args.lora_r} (Alpha: {args.lora_alpha})")
    print(f"Epochs          : {args.epochs} | Batch Size: {args.batch_size} | LR: {args.lr}")

    # 1. Pre-flight Dataset Quality Checks
    print("\n[Quality Check] Validating training dataset quality...")
    if not os.path.exists(args.train_file):
        raise FileNotFoundError(f"Training dataset does not exist: {args.train_file}")
    if not os.path.exists(args.eval_file):
        raise FileNotFoundError(f"Evaluation dataset does not exist: {args.eval_file}")

    train_records = []
    with open(args.train_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                train_records.append(json.loads(line))

    eval_records = []
    with open(args.eval_file, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                eval_records.append(json.loads(line))

    train_qual = validate_dataset_quality(train_records, "train", min_samples=args.min_samples)
    eval_qual = validate_dataset_quality(eval_records, "eval", min_samples=max(1, args.min_samples // 4))

    if not train_qual["passed"]:
        error_msg = f"Training data failed quality check! Issues: {train_qual['issues']}"
        print(f"[Quality Error] {error_msg}")
        failure_report = {
            "status": "failed_quality_check",
            "train_quality": train_qual,
            "eval_quality": eval_qual,
            "error": error_msg
        }
        with open(args.report_file, 'w', encoding='utf-8') as rf:
            json.dump(failure_report, rf, indent=2)
        sys.exit(1)

    print(f"[Quality Check] PASSED: {train_qual['valid_records']} train records, {eval_qual['valid_records']} eval records. Zero failed actions in SFT demonstrations.")

    # 2. Device & Resource Limits
    device = torch.device(args.device if (args.device == 'cuda' and torch.cuda.is_available()) else 'cpu')
    print(f"[Resource] Training device: {device}")
    if device.type == 'cuda':
        gpu_name = torch.cuda.get_device_name(0)
        total_vram = torch.cuda.get_device_properties(0).total_memory / (1024 * 1024)
        print(f"[Resource] GPU: {gpu_name} (Total VRAM: {total_vram:.0f} MB, Limit: {args.max_vram_mb} MB)")
        torch.cuda.reset_peak_memory_stats()

    torch.manual_seed(42)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(42)

    # 3. Tokenizer & Dataset
    tokenizer = CharacterTokenizer()
    train_dataset = MinecraftChatMLDataset(args.train_file, tokenizer, max_seq_len=args.max_seq_len, strict_clean=True)
    eval_dataset = MinecraftChatMLDataset(args.eval_file, tokenizer, max_seq_len=args.max_seq_len, strict_clean=True)

    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=lambda b: collate_fn(b, tokenizer.pad_token_id)
    )
    eval_loader = DataLoader(
        eval_dataset,
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=lambda b: collate_fn(b, tokenizer.pad_token_id)
    )

    # 4. Model & LoRA Initialization
    model = MikaPolicyTransformer(
        vocab_size=tokenizer.vocab_size,
        d_model=args.d_model,
        nhead=args.nhead,
        num_layers=args.num_layers,
        dim_feedforward=args.dim_feedforward,
        max_seq_len=args.max_seq_len,
        pad_token_id=tokenizer.pad_token_id
    )

    lora_stats = apply_lora(
        model,
        r=args.lora_r,
        alpha=args.lora_alpha,
        dropout=args.lora_dropout
    )
    model.to(device)

    print(f"[LoRA Adapter] Injected into {lora_stats['replaced_layers']} layers.")
    print(f"[Parameters] Trainable: {lora_stats['trainable_params']:,} / Total: {lora_stats['total_params']:,} ({lora_stats['trainable_percent']}%)")

    # 5. Optimizer
    trainable_params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(trainable_params, lr=args.lr, weight_decay=0.01)

    # 6. Training Loop with Checkpoints & Early Stopping
    best_eval_loss = float('inf')
    best_checkpoint_path = os.path.join(args.output_dir, "best_model.pt")
    history = []
    patience_counter = 0

    for epoch in range(1, args.epochs + 1):
        epoch_start = time.time()
        model.train()
        total_train_loss = 0.0
        train_steps = 0

        for batch_inputs, batch_labels, batch_mask in train_loader:
            batch_inputs = batch_inputs.to(device)
            batch_labels = batch_labels.to(device)
            batch_mask = batch_mask.to(device)

            optimizer.zero_grad()
            outputs = model(batch_inputs, labels=batch_labels, attention_mask=batch_mask)
            loss = outputs["loss"]
            loss.backward()
            torch.nn.utils.clip_grad_norm_(trainable_params, max_norm=1.0)
            optimizer.step()

            total_train_loss += loss.item()
            train_steps += 1

        avg_train_loss = total_train_loss / max(1, train_steps)

        # Evaluation phase
        model.eval()
        total_eval_loss = 0.0
        eval_steps = 0
        with torch.no_grad():
            for batch_inputs, batch_labels, batch_mask in eval_loader:
                batch_inputs = batch_inputs.to(device)
                batch_labels = batch_labels.to(device)
                batch_mask = batch_mask.to(device)

                outputs = model(batch_inputs, labels=batch_labels, attention_mask=batch_mask)
                total_eval_loss += outputs["loss"].item()
                eval_steps += 1

        avg_eval_loss = total_eval_loss / max(1, eval_steps)
        epoch_duration = time.time() - epoch_start
        peak_vram = get_peak_vram_mb()

        epoch_record = {
            "epoch": epoch,
            "train_loss": round(avg_train_loss, 4),
            "eval_loss": round(avg_eval_loss, 4),
            "duration_seconds": round(epoch_duration, 2),
            "peak_vram_mb": peak_vram
        }
        history.append(epoch_record)
        print(f"Epoch {epoch:02d}/{args.epochs:02d} | Train Loss: {avg_train_loss:.4f} | Eval Loss: {avg_eval_loss:.4f} | Time: {epoch_duration:.1f}s | Peak VRAM: {peak_vram}MB")

        # Save epoch checkpoint
        epoch_ckpt = os.path.join(args.output_dir, f"checkpoint-epoch-{epoch}.pt")
        save_lora_checkpoint(model, epoch_ckpt, metadata=epoch_record)

        # Track best model
        if avg_eval_loss < best_eval_loss:
            best_eval_loss = avg_eval_loss
            patience_counter = 0
            save_lora_checkpoint(model, best_checkpoint_path, metadata={
                "best_epoch": epoch,
                "best_eval_loss": best_eval_loss,
                "lora_stats": lora_stats
            })
            print(f"  --> Saved new best checkpoint to {best_checkpoint_path} (Eval Loss: {best_eval_loss:.4f})")
        else:
            patience_counter += 1
            if patience_counter >= args.patience:
                print(f"[Early Stopping] Validation loss did not improve for {args.patience} epochs.")
                break

    total_duration = time.time() - start_time

    # 7. Write Final Training Report
    report = {
        "status": "success",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_duration_seconds": round(total_duration, 2),
        "device": str(device),
        "peak_vram_mb": get_peak_vram_mb(),
        "hyperparameters": {
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.lr,
            "lora_r": args.lora_r,
            "lora_alpha": args.lora_alpha,
            "lora_dropout": args.lora_dropout,
            "max_seq_len": args.max_seq_len,
            "d_model": args.d_model,
            "num_layers": args.num_layers
        },
        "lora_parameters": lora_stats,
        "dataset_metrics": {
            "train_samples": len(train_dataset),
            "eval_samples": len(eval_dataset)
        },
        "training_history": history,
        "best_checkpoint": {
            "path": best_checkpoint_path,
            "best_eval_loss": round(best_eval_loss, 4)
        }
    }

    with open(args.report_file, 'w', encoding='utf-8') as rf:
        json.dump(report, rf, indent=2)

    print(f"\n[Training Complete] Report written to: {args.report_file}")
    print(f"[Best Checkpoint] Path: {best_checkpoint_path} (Eval Loss: {best_eval_loss:.4f})")
    return report

def parse_args():
    parser = argparse.ArgumentParser(description="MIKA Python LoRA Training Script")
    parser.add_argument("--train-file", type=str, default="data/processed/sft_chatml_train.jsonl")
    parser.add_argument("--eval-file", type=str, default="data/processed/sft_chatml_eval.jsonl")
    parser.add_argument("--output-dir", type=str, default="data/models/checkpoints")
    parser.add_argument("--report-file", type=str, default="data/reports/training_report.json")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--lora-r", type=int, default=8)
    parser.add_argument("--lora-alpha", type=float, default=16.0)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    parser.add_argument("--d-model", type=int, default=128)
    parser.add_argument("--nhead", type=int, default=4)
    parser.add_argument("--num-layers", type=int, default=4)
    parser.add_argument("--dim-feedforward", type=int, default=256)
    parser.add_argument("--max-seq-len", type=int, default=512)
    parser.add_argument("--device", type=str, default="cuda")
    parser.add_argument("--max-vram-mb", type=int, default=6000)
    parser.add_argument("--patience", type=int, default=2)
    parser.add_argument("--min-samples", type=int, default=10)
    return parser.parse_args()

if __name__ == "__main__":
    args = parse_args()
    run_training(args)
