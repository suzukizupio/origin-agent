import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from copy import deepcopy

scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts))
from origin_dataset import DatasetError, canonical, digest
from test_training import example

def module(name):
    spec = importlib.util.spec_from_file_location(name, scripts / f"{name}.py")
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result); return result

prepare = module("prepare-distillation").prepare
metrics = module("evaluate-distillation").report_metrics

class DistillationTests(unittest.TestCase):
    def test_comparison_counts_must_match_the_exact_completed_task_set(self):
        report = {"completed": True, "split": "holdout", "variant": "candidate", "passed": 1, "total": 2, "attempts": [{"task_id": "unseen-1", "ok": True}, {"task_id": "unseen-2", "ok": False}]}
        self.assertEqual(metrics(report, "holdout", "candidate", {"unseen-1", "unseen-2"})["task_success_rate"], 0.5)
        for change in ({"passed": 2}, {"completed": False}, {"split": "train"}, {"attempts": [{"task_id": "unseen-1", "ok": True}] * 2}):
            with self.subTest(change=change), self.assertRaises(DatasetError): metrics({**report, **change}, "holdout", "candidate", {"unseen-1", "unseen-2"})

    def test_preparation_preserves_the_teacher_target_and_rejects_changed_response(self):
        with tempfile.TemporaryDirectory(prefix="origin-distillation-test-") as directory:
            root = Path(directory); teacher = root / "teacher"; teacher.mkdir()
            def write(path, records): path.write_text("".join(canonical(record) + "\n" for record in records), encoding="utf-8")
            train = example(task="teacher-train", prompt="Repair one train task")
            val = example("validation", "teacher-val", "Repair a separate validation task")
            patch = {"path": "file.js", "old_string": "return value;", "new_string": "return value >= 5;"}; raw = json.dumps(patch)
            for record in (train, val):
                record["messages"][-1]["content"] = f'<tool name="edit_file">\n{json.dumps(patch)}\n</tool>'
                record["metadata"]["source"].update({"target_origin": "teacher_patch", "teacher": {"name": "fixture", "digest": "a" * 64, "prompt_sha256": "b" * 64, "response_sha256": digest(raw), "raw_response": raw}})
            write(teacher / "train.jsonl", [train]); write(teacher / "validation.jsonl", [val])
            replay = root / "replay.jsonl"; checks = root / "checks.jsonl"
            write(replay, [example(task="replay", prompt="Replay another task")]); write(checks, [example("validation", "old-val", "Older validation task")])
            self.assertEqual(prepare(teacher, replay, checks, root / "prepared")["teacher_train"], 1)
            changed = deepcopy(train); changed["metadata"]["source"]["teacher"]["raw_response"] = "{}"
            write(teacher / "train.jsonl", [changed])
            with self.assertRaisesRegex(DatasetError, "changed"): prepare(teacher, replay, checks, root / "refused")
            self.assertFalse((root / "refused").exists())

if __name__ == "__main__": unittest.main()
