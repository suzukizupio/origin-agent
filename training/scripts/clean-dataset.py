"""Redact likely secrets, detect split leakage, and remove exact duplicates."""
from origin_dataset import main

if __name__ == "__main__":
    raise SystemExit(main("clean"))
