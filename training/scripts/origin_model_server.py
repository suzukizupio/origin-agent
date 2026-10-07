"""Loopback-only local inference. Baseline and candidate share one base model."""
from __future__ import annotations
import argparse
from contextlib import nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time
from origin_dataset import DatasetError, canonical, digest, parse_json, require
from origin_training import adapter_manifest, base_manifest, file_hash, load_model


def validate_request(value: object, limit: int) -> dict:
    require(isinstance(value, dict), "Expected a JSON object")
    require(value.get("variant") in ("baseline", "candidate"), "Invalid model variant")
    messages = value.get("messages")
    require(isinstance(messages, list) and 2 <= len(messages) <= 200, "Invalid message count")
    for message in messages:
        require(isinstance(message, dict) and message.get("role") in ("system", "user", "assistant") and isinstance(message.get("content"), str), "Invalid message")
    require(messages[0]["role"] == "system" and messages[-1]["role"] == "user", "Expected system prompt followed by a user input")
    tokens = value.get("max_new_tokens", limit)
    require(type(tokens) is int and 1 <= tokens <= limit, "Invalid generation token budget")
    return {"variant": value["variant"], "messages": messages, "max_new_tokens": tokens}


class Runtime:
    def __init__(self, args: argparse.Namespace):
        self.base = base_manifest(args.model)
        self.torch, self.tokenizer, self.model = load_model(args.model, args.threads, args.device)
        self.adapter_sha = None
        self.training_task_ids = []
        self.validation_task_ids = []
        self.baseline_adapter_sha = None
        if args.adapter:
            meta = parse_json((args.adapter / "origin-training.json").read_text(encoding="utf-8"))
            require(meta.get("completed") is True and meta.get("base_sha256") == digest(self.base), "Adapter belongs to a different or incomplete training run")
            self.adapter_sha = file_hash(args.adapter / "adapter_model.safetensors")
            require(meta.get("adapter_sha256") == self.adapter_sha, "Adapter weights changed after training")
            self.training_task_ids = meta["datasets"].get("train_task_ids", [])
            self.validation_task_ids = meta["datasets"].get("validation_task_ids", [])
            from peft import PeftModel
            self.model = PeftModel.from_pretrained(self.model, str(args.adapter), is_trainable=False, local_files_only=True)
            if getattr(args, "baseline_adapter", None):
                reference = adapter_manifest(args.baseline_adapter, self.base)
                require(meta.get("parent_adapter_sha256") == reference["adapter_sha256"], "Distilled candidate must start from the selected baseline adapter")
                self.baseline_adapter_sha = reference["adapter_sha256"]
                self.model.load_adapter(str(args.baseline_adapter), adapter_name="reference", is_trainable=False, local_files_only=True)
                self.training_task_ids = sorted(set(self.training_task_ids) | set(reference["datasets"]["train_task_ids"]))
                self.validation_task_ids = sorted(set(self.validation_task_ids) | set(reference["datasets"]["validation_task_ids"]))
        else:
            require(not getattr(args, "baseline_adapter", None), "A baseline adapter needs a candidate adapter")
        self.model.eval()
        self.lock = threading.Lock()
        self.max_output = args.max_output_tokens
        self.max_input = min(args.max_input_tokens, self.model.config.max_position_embeddings - self.max_output)
        self.timeout = args.generation_timeout
        self.guidance = None
        guidance_identity = None
        if getattr(args, "guided_tools", False):
            from origin_guided import GUIDANCE, GuidedTools
            self.guidance = GuidedTools(self.tokenizer)
            guidance_identity = GUIDANCE
        self.identity = {"ready": True, "base_repository": self.base["repository"], "base_revision": self.base["revision"], "base_sha256": digest(self.base), "adapter_sha256": self.adapter_sha, "baseline_adapter_sha256": self.baseline_adapter_sha,
            "variants": ["baseline", "candidate"] if args.adapter else ["baseline"], "device": args.device, "threads": args.threads,
            "max_input_tokens": self.max_input, "max_output_tokens": self.max_output, "generation_timeout_sec": self.timeout, "training_task_ids": self.training_task_ids, "validation_task_ids": self.validation_task_ids,
            "generation": {"do_sample": False, "repetition_penalty": 1.0, "guidance": guidance_identity}}

    def complete(self, request: dict) -> dict:
        require(request["variant"] != "candidate" or self.adapter_sha is not None, "Candidate adapter is not loaded")
        require(self.lock.acquire(blocking=False), "Model is busy; retry after the current request finishes")
        try:
            ids = self.tokenizer.apply_chat_template(request["messages"], tokenize=True, add_generation_prompt=True, return_tensors="pt").to(self.model.device)
            require(ids.shape[-1] <= self.max_input, "Input exceeds context limit; no silent truncation is performed")
            started = time.monotonic()
            if self.baseline_adapter_sha:
                self.model.set_adapter("reference" if request["variant"] == "baseline" else "default")
            context = self.model.disable_adapter() if self.adapter_sha and not self.baseline_adapter_sha and request["variant"] == "baseline" else nullcontext()
            constraints = {"prefix_allowed_tokens_fn": self.guidance.prefix()} if self.guidance else {}
            with context, self.torch.inference_mode():
                output = self.model.generate(input_ids=ids, attention_mask=self.torch.ones_like(ids), do_sample=False,
                    max_new_tokens=request["max_new_tokens"], max_time=self.timeout, repetition_penalty=1.0, pad_token_id=self.tokenizer.eos_token_id, **constraints)
            elapsed = time.monotonic() - started
            generated = output[0, ids.shape[-1]:]
            eos = self.model.generation_config.eos_token_id
            eos_ids = eos if isinstance(eos, list) else [eos]
            reason = "timeout" if elapsed >= self.timeout else "eos" if len(generated) and int(generated[-1]) in eos_ids else "length"
            return {"variant": request["variant"], "text": self.tokenizer.decode(generated, skip_special_tokens=True), "finish_reason": reason,
                    "elapsed_ms": round(elapsed * 1000), "prompt_tokens": ids.shape[-1], "output_tokens": len(generated)}
        finally:
            self.lock.release()


def handler_for(runtime: Runtime):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status: int, value: dict) -> None:
            data = canonical(value).encode("utf-8")
            self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

        def do_GET(self) -> None:
            self.reply(200, runtime.identity) if self.path == "/health" else self.reply(404, {"error": "Unknown route"})

        def do_POST(self) -> None:
            if self.path != "/v1/completions":
                self.reply(404, {"error": "Unknown route"}); return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                require(0 < size <= 2_000_000, "Request body must be 1..2000000 bytes")
                request = validate_request(parse_json(self.rfile.read(size).decode("utf-8")), runtime.max_output)
                self.reply(200, runtime.complete(request))
            except (DatasetError, ValueError, UnicodeError) as error:
                self.reply(400, {"error": str(error)})
            except Exception:
                self.reply(500, {"error": "Local model generation failed; inspect the server log"})

        def log_message(self, format: str, *args) -> None:
            # Do not log prompts or generated source code.
            print(canonical({"http": args[0] if args else "request"}), file=sys.stderr, flush=True)
    return Handler


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8"); sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=Path("training/models/base-qwen-coder-0.5b"))
    parser.add_argument("--adapter", type=Path)
    parser.add_argument("--baseline-adapter", type=Path, help="Compare a distilled candidate against its parent LoRA instead of the bare base model")
    parser.add_argument("--guided-tools", action="store_true", help="Optional single-tool JSON and bounded return-expression grammar for the pilot; identical for both variants")
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--max-input-tokens", type=int, default=4096)
    parser.add_argument("--max-output-tokens", type=int, default=256)
    parser.add_argument("--generation-timeout", type=float, default=120)
    args = parser.parse_args()
    require(1 <= args.port <= 65535 and 1 <= args.max_output_tokens <= 4096 and args.max_input_tokens > 0 and args.generation_timeout > 0, "Invalid server limits")
    os.environ.setdefault("HF_HUB_OFFLINE", "1"); os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    runtime = Runtime(args)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(runtime))
    print(canonical({"listening": f"http://127.0.0.1:{args.port}", **runtime.identity}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
