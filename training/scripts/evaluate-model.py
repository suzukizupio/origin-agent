"""Compare baseline/candidate with the same Agent, tools, machine and tune tasks."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import urllib.request
from origin_dataset import DatasetError, canonical, digest, parse_json, require
from origin_training import validate_tune_tasks


def health(host: str) -> dict:
    with urllib.request.urlopen(host.rstrip("/") + "/health", timeout=10) as response:
        data = json.load(response)
    require(data.get("ready") is True and data.get("variants") == ["baseline", "candidate"], "Server must load a completed candidate adapter and its matching baseline")
    return data


def source_hash(root: Path) -> str:
    files = [*sorted((root / "src").rglob("*.ts")), root / "scripts/model-curriculum.ts", root / "scripts/recovery-curriculum.ts"]
    return digest({str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files})


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8"); sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("ORIGIN_MODEL_HOST", "http://127.0.0.1:18080"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tasks", type=int, default=2)
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--curriculum", choices=("affine", "recovery"), default="affine")
    args = parser.parse_args()
    require(1 <= args.tasks <= 20 and 1 <= args.repeat <= 10 and args.timeout > 0, "Invalid evaluation limits")
    require(not args.output.exists(), "Evaluation output already exists")
    from urllib.parse import urlparse
    parsed = urlparse(args.host)
    require(parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost") and not parsed.username and not parsed.password and parsed.path in ("", "/"), "Use a local model server")
    root = Path(__file__).resolve().parents[2]
    identity = health(args.host)
    task_prefix = "origin-recovery" if args.curriculum == "recovery" else "origin-practice"
    validate_tune_tasks(identity, {f"{task_prefix}-{200 + i}" for i in range(args.tasks)})
    script = root / "scripts" / ("recovery-curriculum.ts" if args.curriculum == "recovery" else "model-curriculum.ts")
    agent_hash = source_hash(root)
    node = shutil.which("node")
    require(node is not None, "Node.js is required for Agent evaluation")
    args.output.mkdir(parents=True, exist_ok=False)
    environment = {**os.environ, "ORIGIN_MODEL_HOST": args.host, "ORIGIN_MODEL_TIMEOUT_MS": str(round(args.timeout * 1000)), "ORIGIN_PRACTICE_PARENT": str(args.output.resolve() / "workspaces")}
    reports = {"baseline": [], "candidate": []}
    for round_index in range(args.repeat):
        for variant in ("baseline", "candidate"):
            require(health(args.host) == identity and source_hash(root) == agent_hash, "Model or Agent changed during comparison")
            path = args.output.resolve() / f"{variant}-{round_index + 1}.json"
            with (args.output / f"{variant}-{round_index + 1}.log").open("w", encoding="utf-8") as log:
                result = subprocess.run([node, str(script), "evaluate", str(path), variant, str(args.tasks)], cwd=root, env=environment,
                    stdout=log, stderr=subprocess.STDOUT, timeout=args.tasks * 7 * args.timeout + 90)
            require(result.returncode == 0, "Agent evaluation command failed; inspect the saved log")
            report = parse_json(path.read_text(encoding="utf-8"))
            require(report.get("completed") is True and report.get("split") == "tune" and report.get("variant") == variant and report.get("total") == args.tasks, "Incomplete or mismatched task report")
            require(all(report[key] == reports["baseline"][0][key] for key in ("tools", "max_steps", "recipe_sha256")) if reports["baseline"] else True, "Evaluation task/tool conditions changed")
            reports[variant].append(report)
            print(canonical({"variant": variant, "round": round_index + 1, "passed": report["passed"], "total": report["total"]}), flush=True)
    require(health(args.host) == identity and source_hash(root) == agent_hash, "Model or Agent changed during comparison")
    metrics = {variant: {"passed": sum(r["passed"] for r in runs), "total": sum(r["total"] for r in runs)} for variant, runs in reports.items()}
    for value in metrics.values():
        value["task_success_rate"] = value["passed"] / value["total"]
    delta = metrics["candidate"]["task_success_rate"] - metrics["baseline"]["task_success_rate"]
    summary = {"version": 1, "completed": True, "created_at": datetime.now(timezone.utc).isoformat(), "split": "tune", "scope": "controlled_edit_failure_continuation" if args.curriculum == "recovery" else "generated_affine_function_pilot",
        "model": identity, "agent_source_sha256": agent_hash, "machine": {"system": platform.system(), "machine": platform.machine(), "processor": platform.processor(), "cpu_count": os.cpu_count()},
        "repeat": args.repeat, "request_timeout_sec": args.timeout, "metrics": metrics, "delta_task_success_rate": delta, "improved": delta > 0,
        "status": "pilot_gain_measured" if delta > 0 else "no_gain_measured", "holdout_used": False,
        "fixture_steps": 2 if args.curriculum == "recovery" else 0,
        "limitation": "Small same-family tune tasks; broader coding improvement and held-out generalization are not established" + (". Recovery fixes the initial failed-operation prefix, including the intended replacement expression, for both models" if args.curriculum == "recovery" else "")}
    (args.output / "comparison.json").write_text(canonical(summary) + "\n", encoding="utf-8")
    print(canonical({"metrics": metrics, "delta": delta, "status": summary["status"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (DatasetError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Evaluation error: {error}", file=sys.stderr)
        raise SystemExit(1)
