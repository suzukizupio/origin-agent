"""Validate tested teacher targets and mix them with Phase 2 replay data."""
import argparse
from pathlib import Path
import re
import sys
from origin_dataset import DatasetError, Partitions, canonical, digest, parse_json, redact, require, write_records
from origin_training import load_partitions


def prepare(teacher: Path, replay_train: Path, replay_validation: Path, output: Path) -> dict:
    targets, checks = load_partitions(teacher / "train.jsonl", teacher / "validation.jsonl")
    replay, old_checks = load_partitions(replay_train, replay_validation)
    for record in [*targets, *checks]:
        source = record["metadata"]["source"]
        identity = source.get("teacher", {})
        require(source.get("target_origin") == "teacher_patch" and isinstance(identity.get("name"), str) and re.fullmatch(r"[a-f0-9]{64}", identity.get("digest", "")) is not None, "Missing pinned teacher provenance")
        require(all(re.fullmatch(r"[a-f0-9]{64}", identity.get(key, "")) for key in ("prompt_sha256", "response_sha256")), "Missing teacher response provenance")
        raw = identity.get("raw_response")
        require(isinstance(raw, str) and digest(raw) == identity["response_sha256"], "Teacher response changed after generation")
        call = re.fullmatch(r'<tool name="edit_file">\s*([\s\S]+?)\s*</tool>', record["messages"][-1]["content"])
        require(call is not None and parse_json(call[1]) == parse_json(raw), "SFT target differs from the actual teacher patch")
        require(redact(record) == record, "Masking would change a verified task; curate it before training")
    partitions = Partitions()
    for record in [*targets, *checks, *replay, *old_checks]:
        partitions.check(record, record["messages"])
    require(not output.exists(), "Prepared output already exists")
    output.mkdir(parents=True, exist_ok=False)
    # Teacher validation first, so a limited validation budget cannot hide its loss.
    write_records(output / "train.jsonl", [*targets, *replay])
    write_records(output / "validation.jsonl", [*checks, *old_checks])
    return {"teacher_train": len(targets), "replay_train": len(replay), "validation": len(checks) + len(old_checks)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--teacher", type=Path, required=True)
    parser.add_argument("--replay-train", type=Path, default=Path("training/data/sft/practice-train.jsonl"))
    parser.add_argument("--replay-validation", type=Path, default=Path("training/data/validation/practice-validation.jsonl"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(canonical(prepare(args.teacher, args.replay_train, args.replay_validation, args.output)))
    except (DatasetError, OSError) as error:
        print(f"Distillation data error: {error}", file=sys.stderr); raise SystemExit(1)
