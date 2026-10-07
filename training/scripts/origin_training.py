"""Validated local-model and assistant-target utilities. Imports ML lazily."""
from __future__ import annotations
import hashlib
import math
from pathlib import Path
from typing import Any
from origin_dataset import Partitions, holdout_path, parse_json, require, MAX_LINE_BYTES


def file_hash(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def base_manifest(path: Path, verify: bool = True) -> dict:
    manifest = parse_json((path / "origin-base.json").read_text(encoding="utf-8"))
    require(isinstance(manifest, dict), "Invalid base model manifest")
    require(manifest.get("version") == 1 and isinstance(manifest.get("revision"), str) and len(manifest["revision"]) == 40, "Invalid pinned base model manifest")
    require(manifest.get("license") == "apache-2.0" and isinstance(manifest.get("files"), dict), "Missing base model license/files")
    require("config.json" in manifest["files"] and any(n.endswith(".safetensors") for n in manifest["files"]), "Base model is incomplete")
    for name, expected in manifest["files"].items():
        require(isinstance(name, str) and Path(name).name == name and name not in (".", ".."), "Unsafe manifest filename")
        require((path / name).is_file(), "Base model file missing")
        if verify:
            require(file_hash(path / name) == expected, "Base model file changed after download")
    return manifest


def sft_input(path: Path, split: str) -> list[dict]:
    require(not holdout_path(path), "Held-out dataset refused")
    records = []
    with path.open("rb") as handle:
        while line := handle.readline(MAX_LINE_BYTES + 1):
            require(len(line) <= MAX_LINE_BYTES, "Oversized SFT record")
            if not line.strip():
                continue
            record = parse_json(line.decode("utf-8-sig"))
            require(isinstance(record, dict) and record.get("version") == 1 and record.get("kind") == "sft", "Unsupported SFT format")
            require(record.get("split") == split and record.get("holdout", False) is False, "Unexpected training partition")
            require(isinstance(record.get("task_id"), str) and "holdout" not in record["task_id"].lower(), "Invalid task identity")
            meta = record.get("metadata", {})
            require(isinstance(meta, dict) and isinstance(meta.get("source"), dict), "Missing SFT provenance")
            require(meta["source"].get("holdout", False) is False and meta["source"].get("split", split) == split, "Conflicting source partition")
            require(meta.get("outcome") == "success" and meta.get("source", {}).get("report_completion") == "completed", "Only verified successful examples may train")
            require(meta.get("representation") == "provider_messages" and meta.get("cleaned") is True, "Provide cleaned exact Provider messages, including the actual system prompt")
            messages = record.get("messages")
            require(isinstance(messages, list) and len(messages) >= 3, "Missing training dialogue")
            for message in messages:
                require(isinstance(message, dict) and message.get("role") in ("system", "user", "assistant") and isinstance(message.get("content"), str) and bool(message["content"].strip()), "Invalid Provider message")
            require(messages[0]["role"] == "system" and messages[-1]["role"] == "assistant", "SFT needs a system prompt and a final assistant target")
            records.append(record)
    require(bool(records), "Empty SFT dataset")
    return records


def load_partitions(train: Path, validation: Path) -> tuple[list[dict], list[dict]]:
    training = sft_input(train, "train")
    checks = sft_input(validation, "validation")
    partitions = Partitions()
    for record in [*training, *checks]:
        partitions.check(record, record["messages"])
    return training, checks


def adapter_manifest(path: Path, base: dict) -> dict:
    meta = parse_json((path / "origin-training.json").read_text(encoding="utf-8"))
    from origin_dataset import digest
    require(isinstance(meta, dict) and meta.get("completed") is True and meta.get("base_sha256") == digest(base), "Adapter belongs to another or incomplete base model run")
    require(meta.get("adapter_sha256") == file_hash(path / "adapter_model.safetensors"), "Adapter weights changed after training")
    return meta


def training_order(records: list[dict], steps: int, rng: Any, teacher_replay: bool = False, teacher_examples_per_replay: int = 3) -> list[int]:
    if not teacher_replay:
        order = []
        while len(order) < steps:
            cycle = list(range(len(records))); rng.shuffle(cycle); order.extend(cycle)
        return order[:steps]
    teacher = [i for i, record in enumerate(records) if record["metadata"]["source"].get("target_origin") == "teacher_patch"]
    replay = [i for i in range(len(records)) if i not in teacher]
    require(bool(teacher) and bool(replay), "Teacher replay sampling needs verified teacher targets and replay examples")
    require(type(teacher_examples_per_replay) is int and 1 <= teacher_examples_per_replay <= 16, "Teacher examples per replay must be 1..16")
    pools = {"teacher": [], "replay": []}; result = []
    for step in range(steps):
        kind = "teacher" if step % (teacher_examples_per_replay + 1) < teacher_examples_per_replay else "replay"
        if not pools[kind]:
            pools[kind] = (teacher if kind == "teacher" else replay).copy(); rng.shuffle(pools[kind])
        result.append(pools[kind].pop())
    return result


def validate_tune_tasks(identity: dict, task_ids: set[str]) -> None:
    reserved = set()
    for key in ("training_task_ids", "validation_task_ids"):
        values = identity.get(key)
        require(isinstance(values, list) and all(isinstance(value, str) for value in values), "Server must identify both training and validation tasks")
        reserved.update(values)
    require(not (task_ids & reserved), "Tune task overlaps training or validation data")


def encode_target(tokenizer: Any, record: dict, max_length: int) -> dict:
    messages = record["messages"]
    prefix = tokenizer.apply_chat_template(messages[:-1], tokenize=True, add_generation_prompt=True)
    full = tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=False)
    require(isinstance(prefix, list) and isinstance(full, list), "Tokenizer must return token IDs")
    require(full[:len(prefix)] == prefix and len(full) > len(prefix), "Chat template does not preserve the assistant prefix")
    require(len(full) <= max_length, "Example exceeds max_sequence_length; increase it or curate a shorter task, never truncate a tool sequence")
    return {"input_ids": full, "target_ids": full[len(prefix):], "task_id": record["task_id"]}


def load_model(path: Path, threads: int, device: str = "cpu"):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    require(1 <= threads <= 32, "CPU threads must be 1..32")
    require(device in ("cpu", "cuda"), "Device must be cpu or cuda")
    require(device != "cuda" or torch.cuda.is_available(), "CUDA is unavailable")
    torch.set_num_threads(threads)
    tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True, trust_remote_code=False)
    require(bool(tokenizer.chat_template), "Base model needs an explicit chat template")
    model = AutoModelForCausalLM.from_pretrained(str(path), local_files_only=True, trust_remote_code=False, use_safetensors=True, torch_dtype=torch.float32, attn_implementation="sdpa").to(device)
    require(model.config.model_type == "qwen2", "Only the Qwen2 causal model family is validated by this CPU training pipeline")
    return torch, tokenizer, model


def target_loss(torch: Any, model: Any, example: dict):
    ids = torch.tensor([example["input_ids"]], device=model.device)
    targets = torch.tensor(example["target_ids"], device=model.device)
    # Avoid allocating vocabulary logits for the unsupervised prompt tokens.
    logits = model(input_ids=ids, attention_mask=torch.ones_like(ids), use_cache=False, logits_to_keep=len(example["target_ids"]) + 1).logits[:, :-1, :]
    return torch.nn.functional.cross_entropy(logits.reshape(-1, logits.shape[-1]), targets)


def mean_loss(torch: Any, model: Any, examples: list[dict]) -> float:
    model.eval()
    with torch.no_grad():
        values = [float(target_loss(torch, model, example).item()) for example in examples]
    require(all(math.isfinite(value) for value in values), "Non-finite validation loss")
    return sum(values) / len(values)
