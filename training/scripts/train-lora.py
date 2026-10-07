"""Local LoRA SFT with assistant-only loss and immutable data provenance."""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import platform
import random
import sys
import time
from origin_dataset import DatasetError, canonical, digest, require
from origin_training import adapter_manifest, base_manifest, encode_target, file_hash, load_model, load_partitions, mean_loss, target_loss, training_order


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("training/configs/sft.yaml"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-steps", type=int)
    parser.add_argument("--check", action="store_true", help="Validate data/config without loading model weights")
    args = parser.parse_args()
    import yaml
    config_hash = file_hash(args.config)
    config = yaml.safe_load(args.config.read_text(encoding="utf-8"))
    require(isinstance(config, dict) and config.get("schema_version") == 2, "Unsupported training config")
    training = config["training"]; lora = config["lora"]
    steps = args.max_steps if args.max_steps is not None else training["max_steps"]
    require(isinstance(steps, int) and 1 <= steps <= 100_000, "max_steps must be 1..100000")
    require(0 < training["learning_rate"] <= 0.1 and 1 <= lora["rank"] <= 256, "Invalid optimizer/LoRA configuration")
    require(config["dataset"]["holdout_allowed"] is False, "Holdout is never an SFT input")
    output = args.output or Path(config["output_dir"])
    require(not output.exists(), "Output already exists; use a new experiment directory")
    train_path = Path(config["dataset"]["train"]); validation_path = Path(config["dataset"]["validation"])
    data_hashes = {"train_sha256": file_hash(train_path), "validation_sha256": file_hash(validation_path)}
    train, validation = load_partitions(train_path, validation_path)
    order = training_order(train, steps, random.Random(training["seed"]), training.get("teacher_replay", False), training.get("teacher_examples_per_replay", 3))
    base_path = Path(config["base_model_path"])
    manifest = base_manifest(base_path, verify=not args.check)
    parent_path = Path(config["initial_adapter_path"]) if config.get("initial_adapter_path") else None
    parent = adapter_manifest(parent_path, manifest) if parent_path else None
    if args.check:
        print(canonical({"validated": True, "train": len(train), "validation": len(validation), "base_revision": manifest["revision"], "steps": steps,
                         "teacher_updates": sum(train[index]["metadata"]["source"].get("target_origin") == "teacher_patch" for index in order)}))
        return
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1"); os.environ.setdefault("HF_HUB_OFFLINE", "1")
    torch, tokenizer, model = load_model(base_path, training["cpu_threads"], training["device"])
    from peft import LoraConfig, TaskType, get_peft_model, PeftModel
    import peft
    import transformers
    seed = training["seed"]; random.seed(seed); torch.manual_seed(seed)
    if parent_path:
        require(parent["config"]["lora"] == lora, "Warm start must retain the parent LoRA configuration")
        model = PeftModel.from_pretrained(model, str(parent_path), is_trainable=True, local_files_only=True)
    else:
        model = get_peft_model(model, LoraConfig(r=lora["rank"], lora_alpha=lora["alpha"], lora_dropout=lora["dropout"], target_modules=lora["target_modules"], bias="none", task_type=TaskType.CAUSAL_LM))
    examples = [encode_target(tokenizer, record, training["max_sequence_length"]) for record in train]
    checks = [encode_target(tokenizer, record, training["max_sequence_length"]) for record in validation[:training["validation_examples"]]]
    require(bool(checks), "No validation targets")
    initial = mean_loss(torch, model, checks)
    if training["gradient_checkpointing"]:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    require(bool(parameters) and sum(p.numel() for p in parameters) < sum(p.numel() for p in model.parameters()), "Only LoRA parameters should be trainable")
    optimizer = torch.optim.AdamW(parameters, lr=training["learning_rate"])
    model.train()
    started = time.monotonic(); history = []
    print(canonical({"training_started": True, "steps": steps, "trainable_parameters": sum(p.numel() for p in parameters), "validation_loss_before": initial}), flush=True)
    for step in range(steps):
        example = examples[order[step]]
        optimizer.zero_grad(set_to_none=True)
        loss = target_loss(torch, model, example)
        require(bool(torch.isfinite(loss)), "Training loss is not finite")
        loss.backward(); torch.nn.utils.clip_grad_norm_(parameters, 1.0); optimizer.step()
        item = {"step": step + 1, "loss": float(loss.item()), "elapsed_sec": round(time.monotonic() - started, 2)}
        history.append(item); print(canonical(item), flush=True)
    final = mean_loss(torch, model, checks)
    require(file_hash(args.config) == config_hash and file_hash(train_path) == data_hashes["train_sha256"] and file_hash(validation_path) == data_hashes["validation_sha256"], "Training inputs changed during the run")
    output.mkdir(parents=True, exist_ok=False)
    model.save_pretrained(str(output), safe_serialization=True); tokenizer.save_pretrained(str(output))
    experiment = {"version": 1, "completed": True, "model_name": config["model_name"], "method": "lora", "created_at": datetime.now(timezone.utc).isoformat(),
        "base": manifest, "base_sha256": digest(manifest),
        "datasets": {**data_hashes, "train_examples": len(train), "validation_examples": len(validation), "train_task_ids": sorted({r["task_id"] for r in train}), "validation_task_ids": sorted({r["task_id"] for r in validation})},
        "config": config, "actual_steps": steps, "config_sha256": config_hash, "parent_adapter_sha256": parent["adapter_sha256"] if parent else None,
        "target_counts": {"teacher": sum(train[index]["metadata"]["source"].get("target_origin") == "teacher_patch" for index in order), "replay": sum(train[index]["metadata"]["source"].get("target_origin") != "teacher_patch" for index in order)},
        "sampled_target_ids": [train[index]["id"] for index in order], "objective": "response_distillation" if training.get("teacher_replay", False) else "curated_sft",
        "runtime": {"python": platform.python_version(), "torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__, "machine": platform.machine(), "device": training["device"], "cpu_threads": training["cpu_threads"]},
        "validation_loss_before": initial, "validation_loss_after": final, "elapsed_sec": round(time.monotonic() - started, 2), "history": history,
        "task_success_improved": None, "status": "trained_requires_agent_evaluation", "adapter_sha256": file_hash(output / "adapter_model.safetensors")}
    (output / "origin-training.json").write_text(canonical(experiment) + "\n", encoding="utf-8")
    print(canonical({"trained": True, "output": str(output), "validation_loss_before": initial, "validation_loss_after": final, "status": experiment["status"]}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (DatasetError, OSError, ImportError, KeyError) as error:
        print(f"Training error: {error}", file=sys.stderr)
        raise SystemExit(1)
