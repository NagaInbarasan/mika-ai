import argparse
import json
import os
import subprocess
import sys
import time

def main():
    parser = argparse.ArgumentParser(description="MIKA Python Autonomous Learning Pipeline CLI")
    parser.add_argument("--epochs", type=int, default=3, help="Training epochs")
    parser.add_argument("--batch-size", type=int, default=8, help="Batch size")
    parser.add_argument("--eval-ratio", type=float, default=0.2, help="Eval split ratio")
    parser.add_argument("--rollback", action="store_true", help="Perform model rollback")
    parser.add_argument("--force-train", action="store_true", help="Bypass sample size checks")
    parser.add_argument("--data-dir", type=str, default="./data", help="Data directory")
    args = parser.parse_args()

    # Delegate to node orchestrator which executes full multi-phase pipeline with Python ML sub-processes
    node_cmd = ["node", "src/pipeline/index.js"]
    if args.rollback:
        node_cmd.append("--rollback")
    if args.force_train:
        node_cmd.append("--force-train")
    if args.epochs:
        node_cmd.extend(["--epochs", str(args.epochs)])
    if args.batch_size:
        node_cmd.extend(["--batch-size", str(args.batch_size)])

    res = subprocess.run(node_cmd)
    sys.exit(res.returncode)

if __name__ == "__main__":
    main()
