import argparse
import json
import os
import shutil
import sys
import time
from typing import Dict, Any, Optional

REGISTRY_DEFAULT_PATH = "data/models/registry.json"
ACTIVE_MODEL_CONFIG_PATH = "data/models/active_model.json"
VERSIONS_DIR = "data/models/versions"

def load_registry(registry_path: str = REGISTRY_DEFAULT_PATH) -> Dict[str, Any]:
    if os.path.exists(registry_path):
        try:
            with open(registry_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Warning] Failed to load existing registry: {e}. Reinitializing.")
    return {
        "active_version": None,
        "active_model_path": None,
        "previous_version": None,
        "versions": [],
        "rollback_history": []
    }

def save_registry(registry: Dict[str, Any], registry_path: str = REGISTRY_DEFAULT_PATH):
    os.makedirs(os.path.dirname(os.path.abspath(registry_path)), exist_ok=True)
    with open(registry_path, 'w', encoding='utf-8') as f:
        json.dump(registry, f, indent=2)

def update_active_config(active_version: Optional[str], model_path: Optional[str], status: str = "operational"):
    os.makedirs(os.path.dirname(os.path.abspath(ACTIVE_MODEL_CONFIG_PATH)), exist_ok=True)
    cfg = {
        "active_version": active_version,
        "model_path": model_path,
        "status": status,
        "fallback_to_baseline": True,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }
    with open(ACTIVE_MODEL_CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)

def get_next_version(versions: list) -> str:
    if not versions:
        return "v1.0.0"
    latest = versions[-1].get("version", "v1.0.0")
    try:
        parts = latest.lstrip("v").split(".")
        major, minor, patch = int(parts[0]), int(parts[1]), int(parts[2])
        return f"v{major}.{minor + 1}.0"
    except Exception:
        return f"v1.{len(versions)}.0"

def deploy_model(checkpoint_path: str, eval_report_path: Optional[str] = None, registry_path: str = REGISTRY_DEFAULT_PATH) -> Dict[str, Any]:
    print(f"=== MIKA MODEL DEPLOYMENT ===")
    if not os.path.exists(checkpoint_path):
        raise FileNotFoundError(f"Checkpoint to deploy not found: {checkpoint_path}")

    # Enforce acceptance criteria from evaluation report if provided
    eval_metrics = {}
    if eval_report_path and os.path.exists(eval_report_path):
        with open(eval_report_path, 'r', encoding='utf-8') as f:
            eval_data = json.load(f)
        eval_metrics = eval_data.get("metrics", {})
        is_accepted = eval_data.get("acceptance", {}).get("accepted", True)
        if not is_accepted:
            reasons = eval_data.get("acceptance", {}).get("rejection_reasons", ["Unknown reason"])
            error_msg = f"Deployment rejected: Candidate failed acceptance criteria! Reasons: {'; '.join(reasons)}"
            print(f"[Deployment Rejected] {error_msg}")
            print("[Resilience] Keeping current active model running without changes.")
            return {
                "deployed": False,
                "reason": error_msg,
                "active_version": load_registry(registry_path).get("active_version")
            }

    registry = load_registry(registry_path)
    new_version = get_next_version(registry["versions"])
    dest_dir = os.path.join(VERSIONS_DIR, new_version)
    os.makedirs(dest_dir, exist_ok=True)
    dest_checkpoint = os.path.join(dest_dir, "model.pt")

    shutil.copy2(checkpoint_path, dest_checkpoint)

    # Archive previous active version
    prev_active = registry.get("active_version")
    for v in registry["versions"]:
        if v["version"] == prev_active:
            v["status"] = "archived"

    version_record = {
        "version": new_version,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "checkpoint_path": dest_checkpoint,
        "source_checkpoint": checkpoint_path,
        "eval_metrics": eval_metrics,
        "status": "active"
    }

    registry["versions"].append(version_record)
    registry["previous_version"] = prev_active
    registry["active_version"] = new_version
    registry["active_model_path"] = dest_checkpoint

    save_registry(registry, registry_path)
    update_active_config(new_version, dest_checkpoint, status="operational")

    print(f"[Deployment Success] Version {new_version} successfully deployed!")
    print(f"  Checkpoint Path  : {dest_checkpoint}")
    print(f"  Previous Version : {prev_active or 'None (initial)'}")
    return {
        "deployed": True,
        "version": new_version,
        "path": dest_checkpoint,
        "previous_version": prev_active
    }

def rollback_model(target_version: Optional[str] = None, registry_path: str = REGISTRY_DEFAULT_PATH) -> Dict[str, Any]:
    print(f"=== MIKA MODEL ROLLBACK ===")
    registry = load_registry(registry_path)

    current_active = registry.get("active_version")
    if not current_active:
        print("[Rollback Error] No active model currently deployed to rollback from.")
        return {"rolled_back": False, "error": "No active model deployed"}

    # Determine target version
    target = target_version or registry.get("previous_version")
    if not target:
        print("[Rollback Error] No previous version recorded in registry to rollback to.")
        return {"rolled_back": False, "error": "No previous version available"}

    target_entry = next((v for v in registry["versions"] if v["version"] == target), None)
    if not target_entry or not os.path.exists(target_entry["checkpoint_path"]):
        print(f"[Rollback Error] Target version {target} checkpoint does not exist on disk!")
        return {"rolled_back": False, "error": f"Target version {target} checkpoint missing"}

    # Update statuses
    for v in registry["versions"]:
        if v["version"] == current_active:
            v["status"] = "rolled_back"
        elif v["version"] == target:
            v["status"] = "active"

    rollback_event = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "from_version": current_active,
        "to_version": target,
        "reason": "Manual or automated rollback request"
    }
    registry["rollback_history"].append(rollback_event)
    registry["previous_version"] = current_active
    registry["active_version"] = target
    registry["active_model_path"] = target_entry["checkpoint_path"]

    save_registry(registry, registry_path)
    update_active_config(target, target_entry["checkpoint_path"], status="operational_rollback")

    print(f"[Rollback Success] Active model restored to {target} from {current_active}")
    return {
        "rolled_back": True,
        "active_version": target,
        "previous_version": current_active,
        "path": target_entry["checkpoint_path"]
    }

def print_status(registry_path: str = REGISTRY_DEFAULT_PATH):
    registry = load_registry(registry_path)
    print("=== MIKA MODEL REGISTRY STATUS ===")
    print(f"Active Version   : {registry.get('active_version') or 'None'}")
    print(f"Active Path      : {registry.get('active_model_path') or 'None'}")
    print(f"Previous Version : {registry.get('previous_version') or 'None'}")
    print(f"Total Versions   : {len(registry.get('versions', []))}")
    for v in registry.get('versions', []):
        marker = "==> [ACTIVE]" if v["version"] == registry.get("active_version") else f"    [{v.get('status', 'archived')}]"
        print(f"  {marker} {v['version']} ({v['created_at']}) - {v['checkpoint_path']}")

def main():
    parser = argparse.ArgumentParser(description="MIKA Model Deployment & Rollback Controller")
    parser.add_argument("--deploy", type=str, help="Path to checkpoint to deploy")
    parser.add_argument("--eval-report", type=str, default="data/reports/evaluation_report.json", help="Path to evaluation report")
    parser.add_argument("--rollback", action="store_true", help="Rollback to previous version")
    parser.add_argument("--target-version", type=str, default=None, help="Specific target version for rollback")
    parser.add_argument("--status", action="store_true", help="Display registry status")
    parser.add_argument("--registry-file", type=str, default=REGISTRY_DEFAULT_PATH, help="Path to registry JSON")
    args = parser.parse_args()

    if args.deploy:
        deploy_model(args.deploy, args.eval_report, args.registry_file)
    elif args.rollback:
        rollback_model(args.target_version, args.registry_file)
    elif args.status or len(sys.argv) == 1:
        print_status(args.registry_file)

if __name__ == "__main__":
    main()
