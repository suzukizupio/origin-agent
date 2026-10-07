"""Download a pinned public base model into the ignored local model directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request
from origin_dataset import DatasetError, canonical, require


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="Qwen/Qwen2.5-Coder-0.5B-Instruct")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--output", type=Path, default=Path("training/models/base-qwen-coder-0.5b"))
    args = parser.parse_args()
    require(not (args.output / "origin-base.json").exists(), "Base model already prepared; choose another output")
    os.environ.setdefault("HF_HOME", str(args.output.resolve() / ".hf-cache"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{args.model}/revision/{args.revision}", timeout=30) as response:
        info = json.load(response)
    revision = info.get("sha")
    license_name = info.get("cardData", {}).get("license")
    require(isinstance(revision, str) and len(revision) == 40, "Missing immutable model revision")
    require(license_name == "apache-2.0", "This downloader requires an Apache-2.0 model; review other licenses separately")
    from huggingface_hub import snapshot_download
    snapshot_download(args.model, revision=revision, local_dir=str(args.output), allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "LICENSE*", "README.md"])
    files = {}
    for path in sorted(args.output.glob("*")):
        if path.is_file():
            with path.open("rb") as handle:
                files[path.name] = hashlib.file_digest(handle, "sha256").hexdigest()
    require(any(name.endswith(".safetensors") for name in files), "No safetensors weights downloaded")
    manifest = {"version": 1, "repository": args.model, "revision": revision, "license": license_name, "files": files}
    with (args.output / "origin-base.json").open("x", encoding="utf-8") as handle:
        handle.write(canonical(manifest) + "\n")
    print(canonical({"prepared": True, "model": args.model, "revision": revision, "license": license_name}))


if __name__ == "__main__":
    try:
        main()
    except (DatasetError, OSError) as error:
        print(f"Model preparation error: {error}", file=sys.stderr)
        raise SystemExit(1)
