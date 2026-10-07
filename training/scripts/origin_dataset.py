"""Offline, versioned datasets from origin-agent evaluation events (Python 3.10+)."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
from collections import Counter
from itertools import chain
from typing import Any, Iterable

VERSION = 1
SPLITS = ("train", "validation", "tune")
MAX_REPORT_BYTES = 32 * 1024 * 1024
MAX_LINE_BYTES = 8 * 1024 * 1024
TOOL_NAME = re.compile(r"[a-zA-Z0-9_]+\Z")
SECRET_KEY = re.compile(r"(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization|credential)", re.I)


class DatasetError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DatasetError(message)


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def parse_json(text: str) -> Any:
    def invalid_constant(_: str) -> None:
        raise DatasetError("Non-finite JSON numbers are not supported")
    try:
        return json.loads(text, parse_constant=invalid_constant)
    except (ValueError, RecursionError) as error:
        raise DatasetError("Invalid JSON (contents are not printed)") from error


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def holdout_path(path: Path) -> bool:
    return any("holdout" in part.lower() for part in path.resolve().parts)


def safe_split(value: Any) -> str:
    require(value in SPLITS, "Split must be train, validation, or tune; holdout is never a training input")
    return value


def validate_turns(turns: Any) -> None:
    require(isinstance(turns, list), "Trace turns must be an array")
    for turn in turns:
        require(isinstance(turn, dict) and isinstance(turn.get("input"), str), "Invalid trace input")
        require(type(turn.get("restart", False)) is bool and isinstance(turn.get("events"), list), "Invalid trace turn")
        for event in turn["events"]:
            require(isinstance(event, dict), "Invalid trace event")
            kind = event.get("type")
            if kind in ("assistant", "assistant_delta"):
                require(isinstance(event.get("text"), str), "Invalid assistant event")
            elif kind in ("tool_start", "tool_end"):
                require(isinstance(event.get("name"), str) and TOOL_NAME.fullmatch(event["name"]) is not None, "Invalid tool name")
                if kind == "tool_start":
                    require(isinstance(event.get("args"), dict), "Invalid tool arguments")
                else:
                    require(isinstance(event.get("result"), str) and type(event.get("ok")) is bool, "Invalid tool result")
            elif kind == "done":
                require(event.get("reason") in ("answered", "max_steps", "stuck"), "Invalid completion reason")
            elif kind == "notice":
                require(isinstance(event.get("message"), str), "Invalid notice")
            elif kind == "model_stats":
                require(isinstance(event.get("stats"), dict) and all(is_number(v) for v in event["stats"].values()), "Invalid model statistics")
            else:
                raise DatasetError("Unsupported event type; update the converter before using this trace")


def collect_reports(paths: list[Path], split: str, stats: Counter, allow_legacy: bool = False) -> Iterable[dict]:
    safe_split(split)
    for path in paths:
        # Do not even open filenames/directories identifying held-out data.
        if holdout_path(path):
            stats["holdout_reports_excluded"] += 1
            continue
        require(path.stat().st_size <= MAX_REPORT_BYTES, "Report exceeds the 32 MiB limit")
        raw = path.read_bytes()
        require(len(raw) <= MAX_REPORT_BYTES, "Report exceeds the 32 MiB limit")
        try:
            report = parse_json(raw.decode("utf-8-sig"))
        except UnicodeError as error:
            raise DatasetError("Report must be UTF-8") from error
        require(isinstance(report, dict) and isinstance(report.get("tasks"), list), "Expected an origin-agent evaluation report")
        require(all(isinstance(t, dict) and isinstance(t.get("id"), str) for t in report["tasks"]), "Invalid report tasks")
        for owner in [report, *report["tasks"]]:
            require("holdout" not in owner or type(owner["holdout"]) is bool, "Invalid holdout marker")
            require("split" not in owner or owner["split"] in (*SPLITS, "holdout"), "Invalid report split")
        if any(owner.get("holdout") is True or owner.get("split") == "holdout" for owner in [report, *report["tasks"]]) or any("holdout" in t["id"].lower() for t in report["tasks"]):
            stats["holdout_reports_excluded"] += 1
            continue
        # Partial reports can change outcome and must not produce training labels.
        legacy = "completed" not in report
        if report.get("completed") is not True and not (legacy and allow_legacy):
            stats["uncompleted_reports_excluded"] += 1
            continue
        require(isinstance(report.get("provider"), str) and isinstance(report.get("startedAt"), str), "Invalid report provenance")
        source = {
            "report": path.name, "sha256": hashlib.sha256(raw).hexdigest(),
            "provider": report["provider"], "started_at": report["startedAt"],
            "report_completion": "legacy_unverified" if legacy else "completed",
        }
        for old, new in (("sourceCommit", "commit"), ("sourceDirty", "dirty"), ("nodeVersion", "node_version"), ("timeoutSec", "timeout_sec"), ("suite", "suite")):
            if old in report:
                source[new] = report[old]
        for task_index, task in enumerate(report["tasks"]):
            # Explicit split labels cannot be overridden by a CLI option.
            require(all(owner.get("split", split) == split for owner in (report, task)), "Report split conflicts with requested split")
            attempts = task.get("attempts", [])
            require(isinstance(attempts, list), "Invalid attempts")
            tools = task.get("tools", [])
            require(isinstance(tools, list) and all(isinstance(tool, str) for tool in tools), "Invalid tool inventory")
            require(isinstance(task.get("title", task["id"]), str), "Invalid task title")
            for attempt_index, attempt in enumerate(attempts):
                require(isinstance(attempt, dict) and type(attempt.get("ok")) is bool and is_number(attempt.get("ms")), "Invalid attempt result")
                if "trace" not in attempt or not attempt["trace"]:
                    stats["attempts_without_trace"] += 1
                    continue
                validate_turns(attempt["trace"])
                for key in ("reason", "failureKind"):
                    require(key not in attempt or isinstance(attempt[key], str), "Invalid failure metadata")
                record = {
                    "version": VERSION, "kind": "trace", "split": split,
                    "id": digest([source["sha256"], task_index, attempt_index]),
                    "source": {**source, "task_index": task_index, "attempt_index": attempt_index},
                    "task_id": task["id"], "task": task.get("title", task["id"]),
                    "outcome": "success" if attempt["ok"] else "failure",
                    "failure": None if attempt["ok"] else {"kind": attempt.get("failureKind", "unknown"), "reason": attempt.get("reason", "")},
                    "duration_ms": attempt["ms"], "tools": tools, "turns": attempt["trace"],
                }
                validate_record(record, "trace")
                stats[record["outcome"]] += 1
                yield record
        stats["reports_collected"] += 1


def validate_messages(messages: Any) -> None:
    require(isinstance(messages, list) and bool(messages), "Messages must be a non-empty array")
    for message in messages:
        require(isinstance(message, dict) and message.get("role") in ("user", "assistant", "tool") and isinstance(message.get("content"), str), "Invalid dialogue message")
        if message["role"] == "tool":
            require(isinstance(message.get("name"), str) and TOOL_NAME.fullmatch(message["name"]) is not None, "Invalid dialogue tool name")


def validate_record(record: Any, kind: str) -> None:
    require(isinstance(record, dict) and type(record.get("version")) is int and record["version"] == VERSION and record.get("kind") == kind, "Unsupported dataset schema")
    safe_split(record.get("split"))
    require(record.get("holdout", False) is False, "Held-out record refused")
    require(all(isinstance(record.get(key), str) and record[key].strip() for key in ("id", "task_id")), "Invalid record identity")
    require("holdout" not in record["task_id"].lower(), "Held-out task refused")
    require(record.get("outcome") in ("success", "failure"), "Invalid outcome")
    require(isinstance(record.get("source"), dict), "Missing provenance")
    source = record["source"]
    require(source.get("holdout", False) is False and source.get("split", record["split"]) == record["split"], "Conflicting source partition")
    if isinstance(source.get("report"), str):
        require("holdout" not in source["report"].lower(), "Held-out source refused")
    if kind == "trace":
        validate_turns(record.get("turns"))
        require(isinstance(record.get("tools"), list), "Missing tools")
        if record["outcome"] == "failure":
            require(isinstance(record.get("failure"), dict) and all(isinstance(record["failure"].get(k), str) for k in ("kind", "reason")), "Missing failure label")
    elif kind == "trajectory":
        validate_messages(record.get("messages"))
        require(type(record.get("complete")) is bool and isinstance(record.get("done_reasons"), list), "Invalid trajectory completion")
        require(all(reason in ("answered", "max_steps", "stuck", None) for reason in record["done_reasons"]), "Invalid trajectory completion reason")


def read_records(path: Path, kind: str) -> Iterable[dict]:
    require(not holdout_path(path), "Held-out input path refused")
    with path.open("rb") as handle:
        line_number = 0
        while True:
            line = handle.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            line_number += 1
            require(len(line) <= MAX_LINE_BYTES, f"Dataset line {line_number} exceeds 8 MiB")
            if not line.strip():
                continue
            try:
                record = parse_json(line.decode("utf-8-sig" if line_number == 1 else "utf-8"))
                validate_record(record, kind)
            except (DatasetError, UnicodeError) as error:
                raise DatasetError(f"Invalid {kind} record on line {line_number}: {error}") from error
            yield record


def write_records(path: Path, records: Iterable[dict]) -> int:
    """Validate into a temporary file; publish exclusively, never replace an output."""
    require(not holdout_path(path), "Held-out output path refused")
    require(not path.exists(), "Output already exists; choose a new path")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".dataset-", suffix=".tmp", dir=path.parent)
    count = 0
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            for record in records:
                line = canonical(record)
                require(len((line + "\n").encode("utf-8")) <= MAX_LINE_BYTES, "Output record exceeds 8 MiB")
                handle.write(line + "\n")
                count += 1
            handle.flush()
            os.fsync(handle.fileno())
        # Windows rename refuses existing destinations. On POSIX, link provides
        # the same atomic no-replace behavior (rename would overwrite a race).
        if os.name == "nt":
            os.rename(temporary, path)
        else:
            os.link(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return count


def redacted_text(text: str) -> str:
    text = re.sub(r"-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----", "[REDACTED PRIVATE KEY]", text)
    text = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b", "[REDACTED]", text)
    text = re.sub(r"(?i)(\bbearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)(https?://)[^\s/:@]+:[^\s/@]+@", r"\1[REDACTED]@", text)
    text = re.sub(r'''(?im)(\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)''', r'\1"[REDACTED]"', text)
    return text


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return redacted_text(value)
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: "[REDACTED]" if SECRET_KEY.search(key) else redact(item) for key, item in value.items()}
    return value


def trace_content(record: dict) -> list:
    # Timing, streaming chunks, and notices must not defeat duplicate detection.
    return [{"input": t["input"], "restart": t.get("restart", False), "events": [e for e in t["events"] if e["type"] not in ("assistant_delta", "model_stats", "notice")]} for t in record["turns"]]


class Partitions:
    def __init__(self) -> None:
        self.tasks: dict[str, str] = {}
        self.contents: dict[str, str] = {}
        self.prompts: dict[str, str] = {}

    def check(self, record: dict, content: Any) -> str:
        fingerprint = digest(content)
        split = safe_split(record["split"])
        prompts = [item["input"] for item in content if isinstance(item, dict) and "input" in item]
        if not prompts:
            prompts = [item["content"] for item in content if isinstance(item, dict) and item.get("role") == "user"]
        for mapping, key in ((self.tasks, record["task_id"]), (self.contents, fingerprint), (self.prompts, digest(prompts))):
            require(key not in mapping or mapping[key] == split, "Partition leakage: the same task, user inputs, or dialogue appears in multiple splits")
            mapping[key] = split
        return fingerprint


def clean_records(records: Iterable[dict], stats: Counter) -> Iterable[dict]:
    partitions = Partitions()
    seen: set[str] = set()
    for record in records:
        cleaned = redact(record)
        # Check partition identity before redaction as well as afterwards.
        partitions.check(record, trace_content(record))
        content_hash = partitions.check(cleaned, trace_content(cleaned))
        key = digest([content_hash, cleaned["outcome"], cleaned.get("failure")])
        if key in seen:
            stats["duplicates_removed"] += 1
            continue
        seen.add(key)
        cleaned["content_sha256"] = content_hash
        cleaned["cleaning"] = {"redacted": True, "version": VERSION}
        validate_record(cleaned, "trace")
        stats[cleaned["outcome"]] += 1
        yield cleaned


def tool_text(name: str, args: dict) -> str:
    # Match src/protocol.ts's text interface. No native function-calling required.
    return f'<tool name="{name}">\n{json.dumps(args, ensure_ascii=False, separators=(",", ":"), allow_nan=False)}\n</tool>'


def append_message(messages: list[dict], role: str, content: str, name: str | None = None) -> None:
    if role == "assistant" and messages and messages[-1]["role"] == "assistant":
        messages[-1]["content"] += "\n" + content
    else:
        messages.append({"role": role, "content": content, **({"name": name} if name else {})})


def convert_record(record: dict) -> list[dict]:
    sessions: list[list[dict]] = []
    for turn in record["turns"]:
        if not sessions or turn.get("restart", False):
            sessions.append([])
        sessions[-1].append(turn)
    result = []
    for session_index, turns in enumerate(sessions):
        messages: list[dict] = []
        operations: list[dict] = []
        reasons: list[str | None] = []
        complete = True
        for turn in turns:
            append_message(messages, "user", turn["input"])
            pending: dict | None = None
            done: str | None = None
            for event in turn["events"]:
                kind = event["type"]
                if kind in ("assistant", "tool_start", "tool_end") and done is not None:
                    complete = False
                if kind == "assistant" and event["text"].strip():
                    append_message(messages, "assistant", event["text"])
                elif kind == "tool_start":
                    if pending is not None:
                        complete = False
                    pending = {"name": event["name"], "args": event["args"], "state": [dict(message) for message in messages]}
                    append_message(messages, "assistant", tool_text(event["name"], event["args"]))
                elif kind == "tool_end":
                    if pending is None or pending["name"] != event["name"]:
                        complete = False
                    else:
                        operations.append({**pending, "result": event["result"], "ok": event["ok"]})
                    append_message(messages, "tool", event["result"], event["name"])
                    pending = None
                elif kind == "done":
                    if done is not None:
                        complete = False
                    done = event["reason"]
            complete = complete and pending is None and done == "answered" and messages[-1]["role"] == "assistant" and "<tool" not in messages[-1]["content"]
            reasons.append(done)
        recoveries = []
        for index, operation in enumerate(operations):
            if operation["ok"]:
                continue
            candidate = next((op for op in operations[index + 1:] if op["name"] == operation["name"] and op["ok"]), None)
            recoveries.append({
                "state": operation["state"],
                "bad_action": {"name": operation["name"], "args": operation["args"]},
                "error": operation["result"],
                "candidate_action": {"name": candidate["name"], "args": candidate["args"]} if candidate else None,
                "candidate_result": candidate["result"] if candidate else None,
                "reviewed": False,
            })
        trajectory = {
            "version": VERSION, "kind": "trajectory", "id": digest([record["id"], session_index]),
            "trace_id": record["id"], "session_index": session_index,
            "split": record["split"], "task_id": record["task_id"], "task": record.get("task", record["task_id"]),
            "source": record["source"], "outcome": record["outcome"], "failure": record.get("failure"),
            "messages": messages, "tools": record["tools"], "complete": complete,
            "done_reasons": reasons, "recoveries": recoveries,
            "representation": "agent_events", "cleaning": record.get("cleaning"),
        }
        validate_record(trajectory, "trajectory")
        result.append(trajectory)
    return result


def convert_records(records: Iterable[dict], stats: Counter) -> Iterable[dict]:
    partitions = Partitions()
    for record in records:
        partitions.check(record, trace_content(record))
        for trajectory in convert_record(record):
            stats[trajectory["outcome"]] += 1
            stats["recovery_candidates"] += len(trajectory["recoveries"])
            yield trajectory


def sft_records(records: Iterable[dict], split: str, stats: Counter) -> Iterable[dict]:
    require(split in ("train", "validation"), "SFT can only use train or validation")
    partitions = Partitions()
    seen: set[str] = set()
    for record in records:
        content_hash = partitions.check(record, record["messages"])
        if record["split"] != split:
            stats["other_splits_excluded"] += 1
            continue
        if record["outcome"] != "success":
            stats["failed_attempts_excluded"] += 1
            continue
        if record["source"].get("report_completion") != "completed":
            stats["unverified_reports_excluded"] += 1
            continue
        require(isinstance(record.get("cleaning"), dict) and record["cleaning"].get("redacted") is True, "Run clean-dataset.py before generating SFT")
        messages = record["messages"]
        if not record["complete"] or not record["done_reasons"] or any(reason != "answered" for reason in record["done_reasons"]) or messages[-1]["role"] != "assistant" or not messages[-1]["content"].strip() or "<tool" in messages[-1]["content"]:
            stats["incomplete_trajectories_excluded"] += 1
            continue
        if content_hash in seen:
            stats["duplicates_removed"] += 1
            continue
        seen.add(content_hash)
        stats["sft_examples"] += 1
        yield {
            "version": VERSION, "kind": "sft", "id": record["id"], "split": split,
            "task_id": record["task_id"], "messages": messages,
            "metadata": {"source": record["source"], "trace_id": record["trace_id"], "representation": record["representation"], "outcome": "success", "tools": record["tools"], "content_sha256": content_hash},
        }


def main(stage: str, argv: list[str] | None = None) -> int:
    # JSON summaries and errors must remain UTF-8 when Windows stdout is piped.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=f"origin-agent dataset stage: {stage} (offline; outputs never overwritten)")
    if stage == "collect":
        parser.add_argument("--input", type=Path, nargs="+", required=True, help="Explicit evaluation JSON reports; no directory crawl")
        parser.add_argument("--split", choices=SPLITS, default="tune", help="Default tune; choose train explicitly for training sources")
        parser.add_argument("--allow-legacy", action="store_true", help="Import old reports without completed marker for inspection; never eligible for SFT")
    else:
        parser.add_argument("--input", type=Path, nargs="+", required=True, help="Check all partitions together")
        if stage == "sft":
            parser.add_argument("--split", choices=("train", "validation"), default="train")
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args(argv)
    stats: Counter = Counter()
    try:
        if stage == "collect":
            records = collect_reports(options.input, options.split, stats, options.allow_legacy)
        elif stage == "clean":
            records = clean_records(chain.from_iterable(read_records(path, "trace") for path in options.input), stats)
        elif stage == "convert":
            records = convert_records(chain.from_iterable(read_records(path, "trace") for path in options.input), stats)
        elif stage == "sft":
            records = sft_records(chain.from_iterable(read_records(path, "trajectory") for path in options.input), options.split, stats)
        else:
            raise DatasetError("Unknown dataset stage")
        stats["written"] = write_records(options.output, records)
        print(canonical({"stage": stage, "counts": dict(stats)}))
        return 0
    except (DatasetError, OSError, RecursionError) as error:
        print(f"Dataset error: {error}", file=sys.stderr)
        return 1
