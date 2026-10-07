"""Freeze a distilled model comparison; expose only held-out aggregate metrics."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import urllib.request
from urllib.parse import urlparse
from origin_dataset import DatasetError, canonical, digest, parse_json, require
from origin_training import validate_tune_tasks


def identity(host: str) -> dict:
    with urllib.request.urlopen(host + "/health", timeout=10) as response:
        value = json.load(response)
    require(value.get("ready") is True and value.get("variants") == ["baseline", "candidate"] and value.get("baseline_adapter_sha256") and value.get("adapter_sha256") != value.get("baseline_adapter_sha256"), "Load a distilled candidate and its parent adapter in the same server")
    return value


def source_hash(root: Path) -> str:
    paths = [*sorted((root / "src").rglob("*.ts")), root / "scripts/distill-curriculum.ts", root / "scripts/model-curriculum.ts",
             *sorted((root / "training/scripts").glob("*.py")), *sorted((root / "training/configs").glob("*.yaml"))]
    return digest({str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths})


def report_metrics(report: dict, split: str, variant: str, expected_ids: set[str]) -> dict:
    require(report.get("completed") is True and report.get("split") == split and report.get("variant") == variant, "Incomplete evaluation report")
    attempts = report.get("attempts")
    require(isinstance(attempts, list) and len(attempts) == len(expected_ids) and {a.get("task_id") for a in attempts} == expected_ids and all(type(a.get("ok")) is bool for a in attempts), "Evaluation task set changed")
    passed = sum(attempt["ok"] for attempt in attempts)
    require(report.get("total") == len(attempts) and report.get("passed") == passed, "Inconsistent success counts")
    return {"passed": passed, "total": len(attempts), "task_success_rate": passed / len(attempts)}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8"); sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="http://127.0.0.1:18080")
    parser.add_argument("--split", choices=("tune", "holdout"), default="tune")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    url = urlparse(args.host)
    require(url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost") and url.path in ("", "/") and not url.username and not url.password and not url.query and not url.fragment, "Use a local model server")
    host = args.host.rstrip("/"); root = Path(__file__).resolve().parents[2]
    node = shutil.which("node"); require(node is not None, "Node.js required")
    model = identity(host); code_hash = source_hash(root)
    frozen_path = args.output / "frozen.json"
    if args.resume:
        frozen = parse_json(frozen_path.read_text(encoding="utf-8"))
        require(frozen["model"] == model and frozen["source_sha256"] == code_hash and frozen["split"] == args.split, "Resume requires the exact frozen model, source and partition")
        require(not (args.output / "comparison.json").exists(), "Completed comparisons cannot be rerun")
    else:
        require(not args.output.exists(), "Use a new output directory")
        args.output.mkdir(parents=True, exist_ok=False)
        frozen = {"version": 1, "created_at": datetime.now(timezone.utc).isoformat(), "model": model, "source_sha256": code_hash, "split": args.split, "nonce": secrets.randbelow(1_000_000_000) + 1,
                  "max_steps": 5, "tools": ["read_file", "edit_file", "run_shell"], "request_timeout_sec": 120}
        if args.split == "holdout":
            marker = root / "training/experiments" / f'holdout-lock-{model["adapter_sha256"]}.json'
            with marker.open("x", encoding="utf-8") as handle:
                handle.write(canonical({"output": str(args.output.resolve()), **frozen}) + "\n")
        with frozen_path.open("x", encoding="utf-8") as handle: handle.write(canonical(frozen) + "\n")
    private = args.output / "private-holdout"
    spec = private / "tasks.json"
    if args.split == "holdout":
        private.mkdir(exist_ok=True)
        if not spec.exists():
            subprocess.run([node, "scripts/distill-curriculum.ts", "freeze-holdout", str(spec.resolve()), str(frozen["nonce"])], cwd=root, check=True, timeout=30)
        tasks = parse_json(spec.read_text(encoding="utf-8")); expected_ids = {task["id"] for task in tasks}
        require(len(tasks) == 4 and len(expected_ids) == 4 and all(task["split"] == "holdout" for task in tasks), "Invalid held-out manifest")
        task_hash = hashlib.sha256(spec.read_bytes()).hexdigest()
        spec_identity = private / "task-identity.json"
        if spec_identity.exists():
            require(parse_json(spec_identity.read_text(encoding="utf-8"))["sha256"] == task_hash, "Held-out manifest changed since its creation")
        else:
            with spec_identity.open("x", encoding="utf-8") as handle: handle.write(canonical({"sha256": task_hash}) + "\n")
    else:
        expected_ids = {"origin-distill-tune-clamp-500", "origin-distill-tune-threshold-501"}
        task_hash = None
    validate_tune_tasks(model, expected_ids)
    environment = {**os.environ, "ORIGIN_MODEL_HOST": host, "ORIGIN_MODEL_TIMEOUT_MS": "120000", "ORIGIN_DISTILL_PARENT": str((args.output / "workspaces").resolve())}
    metrics = {}; reports = []
    for variant in ("baseline", "candidate"):
        require(identity(host) == model and source_hash(root) == code_hash, "Model or source changed after freezing")
        require(task_hash is None or hashlib.sha256(spec.read_bytes()).hexdigest() == task_hash, "Held-out tasks changed")
        path = (private if args.split == "holdout" else args.output) / f"{variant}.json"
        if not path.exists():
            command = [node, "scripts/distill-curriculum.ts", "evaluate", str(path.resolve()), variant, args.split]
            if args.split == "holdout": command.append(str(spec.resolve()))
            with path.with_suffix(".log").open("w", encoding="utf-8") as log:
                result = subprocess.run(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=len(expected_ids) * 5 * 120 + 90)
            require(result.returncode == 0, "Evaluation failed; held-out details remain private")
        report = parse_json(path.read_text(encoding="utf-8")); metrics[variant] = report_metrics(report, args.split, variant, expected_ids); reports.append(report)
        print(canonical({"split": args.split, "variant": variant, **metrics[variant]}), flush=True)
    require(all(reports[0][key] == reports[1][key] for key in ("tools", "max_steps", "recipe_sha256")), "Paired evaluation conditions differ")
    require(identity(host) == model and source_hash(root) == code_hash, "Model or source changed during comparison")
    delta = metrics["candidate"]["task_success_rate"] - metrics["baseline"]["task_success_rate"]
    summary = {"version": 1, "completed": True, "split": args.split, "frozen": frozen, "metrics": metrics, "delta_task_success_rate": delta, "improved": delta > 0,
               "holdout_used": args.split == "holdout", "status": "holdout_gain_measured" if args.split == "holdout" and delta > 0 else "tune_gain_measured" if delta > 0 else "no_gain_measured",
               "limitation": "Small generated clamp/threshold tasks with unseen parameters; broad coding generalization is not established"}
    with (args.output / "comparison.json").open("x", encoding="utf-8") as handle: handle.write(canonical(summary) + "\n")
    print(canonical({"split": args.split, "delta": delta, "status": summary["status"]}), flush=True)


if __name__ == "__main__":
    try: main()
    except (DatasetError, OSError, subprocess.SubprocessError) as error:
        print(f"Comparison error: {error}", file=sys.stderr); raise SystemExit(1)
