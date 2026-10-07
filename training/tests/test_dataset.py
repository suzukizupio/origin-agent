"""Behavioral checks for the offline trace pipeline, including CLI integration."""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import origin_dataset as dataset


def turn(text: str = "テストの原因を直してください", restart: bool = False) -> dict:
    return {"input": text, "restart": restart, "events": [
        {"type": "assistant_delta", "text": "原因を"},
        {"type": "assistant", "text": "原因を調べます"},
        {"type": "tool_start", "name": "read_file", "args": {"path": "missing.py"}},
        {"type": "tool_end", "name": "read_file", "result": "File not found", "ok": False},
        {"type": "notice", "message": "再試行"},
        {"type": "tool_start", "name": "read_file", "args": {"path": "src/math.py"}},
        {"type": "tool_end", "name": "read_file", "result": "def add(a, b): return a + b", "ok": True},
        {"type": "model_stats", "stats": {"elapsedMs": 12}},
        {"type": "assistant", "text": "確認しました"},
        {"type": "done", "reason": "answered"},
    ]}


def report() -> dict:
    return {"completed": True, "holdout": False, "provider": "fixture", "startedAt": "2026-10-05T00:00:00Z", "tasks": [
        {"id": "fixture-repair", "title": "架空の修正課題", "tools": ["read_file"], "attempts": [
            {"ok": True, "ms": 15, "trace": [turn()]},
            {"ok": False, "ms": 10, "failureKind": "check_failed", "reason": "A test still fails", "trace": [turn()]},
        ]}
    ]}


class PipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="origin-training-test-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def source(self, value: dict | None = None, name: str = "report.json") -> Path:
        path = self.root / name
        path.write_text(json.dumps(value if value is not None else report(), ensure_ascii=False), encoding="utf-8")
        return path

    def collected(self, split: str = "train") -> list[dict]:
        return list(dataset.collect_reports([self.source()], split, Counter()))

    def cli(self, script: str, *arguments: str, ok: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, arguments)], capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stderr)
        return result

    def test_end_to_end_cli_keeps_failures_and_only_exports_verified_success(self) -> None:
        raw, cleaned, converted, sft = [self.root / f"{name}.jsonl" for name in ("raw", "cleaned", "converted", "sft")]
        self.cli("collect-traces.py", "--input", self.source(), "--split", "train", "--output", raw)
        self.cli("clean-dataset.py", "--input", raw, "--output", cleaned)
        self.cli("convert-traces.py", "--input", cleaned, "--output", converted)
        result = self.cli("generate-sft.py", "--input", converted, "--output", sft)
        self.assertEqual(json.loads(result.stdout)["counts"]["sft_examples"], 1)
        self.assertEqual(len(list(dataset.read_records(converted, "trajectory"))), 2)
        example = json.loads(sft.read_text(encoding="utf-8"))
        self.assertEqual(example["messages"][0]["content"], "テストの原因を直してください")
        self.assertIn('<tool name="read_file">', example["messages"][1]["content"])
        self.assertEqual([m["content"] for m in example["messages"] if m["role"] == "tool"], ["File not found", "def add(a, b): return a + b"])
        self.assertNotIn("原因を\n", json.dumps(example, ensure_ascii=False))
        self.assertEqual(example["messages"][-1]["content"], "確認しました")
        self.assertEqual(example["metadata"]["outcome"], "success")

    def test_holdout_filename_not_opened_and_mixed_report_excluded(self) -> None:
        stats = Counter()
        self.assertEqual(list(dataset.collect_reports([self.root / "holdout-missing.json"], "train", stats)), [])
        mixed = report()
        mixed["tasks"].append({"id": "holdout-fixture", "attempts": [{"trace": "INVALID, must never inspect"}]})
        self.assertEqual(list(dataset.collect_reports([self.source(mixed)], "train", stats)), [])
        self.assertEqual(stats["holdout_reports_excluded"], 2)
        for label in ({"holdout": True}, {"split": "holdout"}):
            self.assertEqual(list(dataset.collect_reports([self.source({**report(), **label})], "train", Counter())), [])

    def test_partial_legacy_and_traceless_reports_are_not_labeled_success(self) -> None:
        partial = report()
        partial["completed"] = False
        self.assertEqual(list(dataset.collect_reports([self.source(partial)], "train", Counter())), [])
        del partial["completed"]
        self.assertEqual(list(dataset.collect_reports([self.source(partial)], "train", Counter())), [])
        legacy = report()
        del legacy["tasks"][0]["attempts"][0]["trace"]
        stats = Counter()
        self.assertEqual(len(list(dataset.collect_reports([self.source(legacy)], "train", stats))), 1)
        self.assertEqual(stats["attempts_without_trace"], 1)

    def test_legacy_opt_in_preserves_history_but_never_enters_sft(self) -> None:
        legacy = report()
        del legacy["completed"]
        records = list(dataset.collect_reports([self.source(legacy)], "train", Counter(), allow_legacy=True))
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["source"]["report_completion"], "legacy_unverified")
        trajectories = list(dataset.convert_records(dataset.clean_records(records, Counter()), Counter()))
        stats = Counter()
        self.assertEqual(list(dataset.sft_records(trajectories, "train", stats)), [])
        self.assertEqual(stats["unverified_reports_excluded"], 1)
        legacy["completed"] = False
        self.assertEqual(list(dataset.collect_reports([self.source(legacy)], "train", Counter(), allow_legacy=True)), [])

    def test_dedup_ignores_timing_but_keeps_failures(self) -> None:
        records = self.collected()
        duplicate = deepcopy(records[0])
        duplicate["id"] = "duplicate"
        duplicate["turns"][0]["events"].append({"type": "model_stats", "stats": {"elapsedMs": 999}})
        stats = Counter()
        cleaned = list(dataset.clean_records([*records, duplicate], stats))
        self.assertEqual(len(cleaned), 2)
        self.assertEqual(stats["duplicates_removed"], 1)
        self.assertEqual({r["outcome"] for r in cleaned}, {"success", "failure"})

    def test_split_leakage_rejected_by_task_and_dialogue(self) -> None:
        record = self.collected()[0]
        for by_task in (True, False):
            other = deepcopy(record)
            other["split"] = "validation"
            if by_task:
                other["turns"][0]["input"] = "Another input, same task"
            else:
                other["task_id"] = "a-different-task-id"
            with self.subTest(by_task=by_task), self.assertRaisesRegex(dataset.DatasetError, "leakage"):
                list(dataset.clean_records([record, other], Counter()))

    def test_same_inputs_with_renamed_task_and_different_answer_cannot_cross_splits(self) -> None:
        record = self.collected()[0]
        other = deepcopy(record)
        other["split"] = "validation"
        other["task_id"] = "renamed-task"
        other["turns"][0]["events"][-2]["text"] = "A completely different answer"
        with self.assertRaisesRegex(dataset.DatasetError, "leakage"):
            list(dataset.clean_records([record, other], Counter()))

    def test_redaction_applies_to_nested_args_tool_results_and_final_answer(self) -> None:
        record = self.collected()[0]
        events = record["turns"][0]["events"]
        secret = "sk-" + "a" * 32
        events[2]["args"]["api_key"] = "plaintext-password"
        events[3]["result"] = f"TOKEN={secret}\npassword=abc\nAuthorization: Bearer xyz123\nhttps://user:pwd@example.com"
        events[-2]["text"] = f"{secret}\n-----BEGIN PRIVATE KEY-----\nsecret bytes\n-----END PRIVATE KEY-----"
        cleaned = list(dataset.clean_records([record], Counter()))[0]
        encoded = dataset.canonical(cleaned)
        for value in (secret, "plaintext-password", "secret bytes", "Bearer xyz123", "user:pwd", "password=abc"):
            self.assertNotIn(value, encoded)
        self.assertIn("[REDACTED]", encoded)

    def test_restart_cuts_history_and_normal_turns_retain_context(self) -> None:
        record = self.collected()[0]
        record["turns"] = [turn("FIRST"), turn("SECOND"), turn("AFTER RESTART", True)]
        converted = dataset.convert_record(record)
        self.assertEqual(len(converted), 2)
        self.assertEqual([m["content"] for m in converted[0]["messages"] if m["role"] == "user"], ["FIRST", "SECOND"])
        self.assertEqual(converted[1]["messages"][0]["content"], "AFTER RESTART")
        self.assertNotIn("FIRST", dataset.canonical(converted[1]))

    def test_recovery_is_unreviewed_candidate_with_state_before_bad_action(self) -> None:
        converted = dataset.convert_record(self.collected()[0])[0]
        candidate = converted["recoveries"][0]
        self.assertEqual(candidate["bad_action"]["args"]["path"], "missing.py")
        self.assertEqual(candidate["candidate_action"]["args"]["path"], "src/math.py")
        self.assertFalse(candidate["reviewed"])
        self.assertNotIn("<tool", dataset.canonical(candidate["state"]))
        self.assertNotIn("better_action", candidate)

    def test_incomplete_mismatched_and_failed_sessions_excluded_from_sft(self) -> None:
        original = self.collected()[0]
        for mutation in ("max_steps", "missing_done", "orphan_end", "missing_end", "after_done", "empty_answer"):
            record = deepcopy(original)
            events = record["turns"][0]["events"]
            if mutation == "max_steps":
                events[-1]["reason"] = "max_steps"
            elif mutation == "missing_done":
                events.pop()
            elif mutation == "orphan_end":
                del events[2]
            elif mutation == "missing_end":
                del events[3]
            elif mutation == "after_done":
                events.append({"type": "assistant", "text": "Late output"})
            else:
                del events[-2]
            cleaned = list(dataset.clean_records([record], Counter()))
            converted = list(dataset.convert_records(cleaned, Counter()))
            with self.subTest(mutation=mutation):
                self.assertEqual(list(dataset.sft_records(converted, "train", Counter())), [])

    def test_invalid_input_does_not_publish_or_overwrite_outputs(self) -> None:
        output = self.root / "output.jsonl"
        output.write_text("existing", encoding="utf-8")
        result = self.cli("collect-traces.py", "--input", self.source(), "--output", output, ok=False)
        self.assertIn("already exists", result.stderr)
        self.assertEqual(output.read_text(encoding="utf-8"), "existing")
        invalid = report()
        invalid["tasks"][0]["attempts"][1]["trace"][0]["events"].append({"type": "unknown", "text": "DO NOT PRINT SECRET"})
        target = self.root / "invalid.jsonl"
        result = self.cli("collect-traces.py", "--input", self.source(invalid), "--output", target, ok=False)
        self.assertFalse(target.exists())
        self.assertNotIn("DO NOT PRINT SECRET", result.stderr)
        self.assertEqual(list(self.root.glob(".dataset-*.tmp")), [])

    def test_all_partition_inputs_checked_together_and_output_is_transactional(self) -> None:
        train = self.collected()[0]
        validation = deepcopy(train)
        validation["split"] = "validation"
        files = [self.root / "train.jsonl", self.root / "validation.jsonl"]
        for path, record in zip(files, (train, validation)):
            dataset.write_records(path, [record])
        output = self.root / "mixed.jsonl"
        result = self.cli("clean-dataset.py", "--input", *files, "--output", output, ok=False)
        self.assertIn("leakage", result.stderr)
        self.assertFalse(output.exists())

    def test_tune_default_and_validation_export_are_explicit(self) -> None:
        tune = self.root / "tune.jsonl"
        self.cli("collect-traces.py", "--input", self.source(), "--output", tune)
        self.assertEqual(list(dataset.read_records(tune, "trace"))[0]["split"], "tune")
        records = self.collected("validation")
        trajectories = list(dataset.convert_records(dataset.clean_records(records, Counter()), Counter()))
        self.assertEqual(list(dataset.sft_records(trajectories, "train", Counter())), [])
        self.assertEqual(len(list(dataset.sft_records(trajectories, "validation", Counter()))), 1)

    def test_uncleaned_data_and_invalid_labels_refused(self) -> None:
        record = self.collected()[0]
        with self.assertRaisesRegex(dataset.DatasetError, "clean-dataset"):
            list(dataset.sft_records(dataset.convert_record(record), "train", Counter()))
        for key, value in (("split", "holdout"), ("version", 2), ("task_id", "holdout-fixture"), ("holdout", True)):
            invalid = {**record, key: value}
            with self.subTest(key=key), self.assertRaises(dataset.DatasetError):
                dataset.validate_record(invalid, "trace")
        with self.assertRaises(dataset.DatasetError):
            dataset.parse_json('{"value":NaN}')


if __name__ == "__main__":
    unittest.main()
