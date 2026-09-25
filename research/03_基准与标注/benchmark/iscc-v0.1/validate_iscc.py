"""Validate ISCC JSON with jsonschema when available."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCHEMA = ROOT / "iscc.schema.json"
EXAMPLE = ROOT / "example_capsule.json"


def main() -> int:
    try:
        import jsonschema
    except ImportError:
        print("ERROR: jsonschema is required (install with: python -m pip install jsonschema)")
        return 2

    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    instance = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    errors = sorted(jsonschema.Draft202012Validator(schema).iter_errors(instance), key=lambda e: list(e.path))
    if errors:
        for error in errors:
            print(f"ERROR: {'/'.join(map(str, error.path))}: {error.message}")
        return 1
    print(f"valid ISCC capsule: {instance['capsule_id']}")
    print("status: schema validation only; no semantic conflict claim is made")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
