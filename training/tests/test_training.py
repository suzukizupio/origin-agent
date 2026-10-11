from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
import random

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from origin_dataset import DatasetError, canonical
from origin_training import adapter_manifest, base_manifest, encode_target, file_hash, load_model, load_partitions, sft_input, validate_tune_tasks, training_order
from origin_model_server import validate_request


def example(split="train", task="fixture-1", prompt="Change fixture one"):
    return {"version": 1, "kind": "sft", "id": task, "task_id": task, "split": split,
            "messages": [{"role": "system", "content": "Use the supplied tools"}, {"role": "user", "content": prompt}, {"role": "assistant", "content": '<tool name="read_file">{"path":"file.js"}</tool>'}],
            "metadata": {"representation": "provider_messages", "outcome": "success", "cleaned": True, "source": {"report_completion": "completed"}}}


class Tokenizer:
    def apply_chat_template(self, messages, tokenize, add_generation_prompt):
        text = "".join(f'<{m["role"]}>{m["content"]}</{m["role"]}>' for m in messages)
        if add_generation_prompt:
            text += "<assistant>"
        return list(text.encode("utf-8"))


class TrainingTests(unittest.TestCase):
    def test_invalid_precision_is_refused_before_loading_weights(self):
        for precision in ("float16", "auto", "unknown"):
            with self.subTest(precision=precision), self.assertRaisesRegex(DatasetError, "dtype"):
                load_model(Path("unused"), 2, "cpu", precision)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="origin-sft-test-")
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def write(self, name, records):
        path = self.root / name
        path.write_text("".join(canonical(record) + "\n" for record in records), encoding="utf-8")
        return path

    def test_assistant_target_excludes_system_user_and_role_prefix(self):
        record = example()
        encoded = encode_target(Tokenizer(), record, 4096)
        target = bytes(encoded["target_ids"]).decode("utf-8")
        self.assertEqual(target, record["messages"][-1]["content"] + "</assistant>")
        self.assertNotIn(record["messages"][0]["content"], target)
        self.assertNotIn("<assistant>", target)

    def test_tool_sequence_never_truncated_to_fit_training(self):
        with self.assertRaisesRegex(DatasetError, "never truncate"):
            encode_target(Tokenizer(), example(), 10)

    def test_train_validation_partition_checked_before_model_load(self):
        train = self.write("train.jsonl", [example()])
        validation = self.write("validation.jsonl", [example("validation", "another-id")])
        with self.assertRaisesRegex(DatasetError, "leakage"):
            load_partitions(train, validation)
        validation = self.write("validation.jsonl", [example("validation", "other", "Different task")])
        self.assertEqual(tuple(map(len, load_partitions(train, validation))), (1, 1))

    def test_unverified_failures_holdout_and_reconstructed_prompts_refused(self):
        original = example()
        variants = []
        for key, value in (("outcome", "failure"), ("cleaned", False), ("representation", "agent_events")):
            record = deepcopy(original); record["metadata"][key] = value; variants.append(record)
        record = deepcopy(original); record["split"] = "holdout"; variants.append(record)
        record = deepcopy(original); record["metadata"]["source"]["report_completion"] = "legacy_unverified"; variants.append(record)
        record = deepcopy(original); record["metadata"]["source"]["holdout"] = True; variants.append(record)
        for index, record in enumerate(variants):
            with self.subTest(index=index), self.assertRaises(DatasetError):
                sft_input(self.write("invalid.jsonl", [record]), "train")

    def test_base_weights_are_verified_against_pinned_manifest(self):
        (self.root / "config.json").write_text("{}", encoding="utf-8")
        (self.root / "model.safetensors").write_bytes(b"fixture weights")
        manifest = {"version": 1, "repository": "fixture", "revision": "a" * 40, "license": "apache-2.0", "files": {name: file_hash(self.root / name) for name in ("config.json", "model.safetensors")}}
        (self.root / "origin-base.json").write_text(canonical(manifest), encoding="utf-8")
        self.assertEqual(base_manifest(self.root), manifest)
        (self.root / "model.safetensors").write_bytes(b"changed")
        with self.assertRaisesRegex(DatasetError, "changed"):
            base_manifest(self.root)

    def test_server_contract_rejects_invalid_roles_variants_and_unbounded_generation(self):
        request = {"variant": "baseline", "messages": [{"role": "system", "content": "rules"}, {"role": "user", "content": "task"}]}
        self.assertEqual(validate_request(request, 256)["max_new_tokens"], 256)
        for change in ({"variant": "teacher"}, {"max_new_tokens": True}, {"max_new_tokens": 257}, {"messages": [{"role": "tool", "content": "not converted"}]}):
            with self.subTest(change=change), self.assertRaises(DatasetError):
                validate_request({**request, **change}, 256)

    def test_tune_tasks_must_exclude_both_training_and_validation(self):
        identity = {"training_task_ids": ["trained"], "validation_task_ids": ["validated"]}
        validate_tune_tasks(identity, {"new-tune-task"})
        for task in ("trained", "validated"):
            with self.subTest(task=task), self.assertRaisesRegex(DatasetError, "overlaps"):
                validate_tune_tasks(identity, {task})
        with self.assertRaisesRegex(DatasetError, "both training and validation"):
            validate_tune_tasks({"training_task_ids": ["trained"]}, {"new-tune-task"})

    def test_teacher_replay_balances_targets_and_visits_all_teacher_examples(self):
        records = [example(task=str(i)) for i in range(8)]
        for record in records[:4]: record["metadata"]["source"]["target_origin"] = "teacher_patch"
        order = training_order(records, 16, random.Random(42), True)
        self.assertEqual(sum(index < 4 for index in order), 12)
        self.assertEqual({index for index in order if index < 4}, set(range(4)))
        self.assertEqual(order, training_order(records, 16, random.Random(42), True))
        with self.assertRaises(DatasetError): training_order(records[:4], 4, random.Random(42), True)

    def test_warm_start_refuses_changed_or_different_base_adapters(self):
        from origin_dataset import digest
        base = {"fixture": "base"}
        (self.root / "adapter_model.safetensors").write_bytes(b"adapter")
        meta = {"completed": True, "base_sha256": digest(base), "adapter_sha256": file_hash(self.root / "adapter_model.safetensors")}
        (self.root / "origin-training.json").write_text(canonical(meta), encoding="utf-8")
        self.assertEqual(adapter_manifest(self.root, base), meta)
        with self.assertRaises(DatasetError): adapter_manifest(self.root, {"other": "base"})
        (self.root / "adapter_model.safetensors").write_bytes(b"changed")
        with self.assertRaises(DatasetError): adapter_manifest(self.root, base)

    def test_balanced_distillation_replays_every_prior_target(self):
        records = [example(task=str(i)) for i in range(28)]
        for record in records[:4]: record["metadata"]["source"]["target_origin"] = "teacher_patch"
        order = training_order(records, 48, random.Random(42), True, 1)
        self.assertEqual(sum(index < 4 for index in order), 24)
        self.assertEqual({index for index in order if index >= 4}, set(range(4, 28)))
        self.assertTrue(all((index < 4) == (position % 2 == 0) for position, index in enumerate(order)))
        for ratio in (0, True, 17):
            with self.assertRaises(DatasetError): training_order(records, 4, random.Random(42), True, ratio)


if __name__ == "__main__":
    unittest.main()
