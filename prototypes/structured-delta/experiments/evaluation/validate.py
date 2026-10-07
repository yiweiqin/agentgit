"""Validate fixtures without exposing checks/witnesses to prediction modules."""

import argparse
import json
from pathlib import Path
from .runtime import snapshot, check_state, strict_order, digest


def validate(root, out):
    records = []
    for path in sorted(root.glob("case[0-9]*")):
        base, a, b = (snapshot(path / k) for k in ("base", "a", "b"))
        gold = json.loads((path / "gold.json").read_text())
        checks = {
            k: (path / "checks" / f"{k}.py").read_text() for k in ("base", "a", "b")
        }
        r = {
            "id": path.name,
            "base": check_state(base, {"base": checks["base"]}),
            "a": check_state(a, {"a": checks["a"]}),
            "b": check_state(b, {"b": checks["b"]}),
        }
        for key, target in (("a", a), ("b", b)):
            applied = strict_order(
                base, [(path / f"patch_{key.upper()}.diff").read_text()], {}
            )
            r["patch_" + key] = {
                "applied": applied["applied"],
                "matches_snapshot": applied["state_hash"] == digest(target),
                "details": applied if not applied["applied"] else None,
            }
        if gold["witness_available"]:
            r["witness"] = check_state(
                snapshot(path / "witness"), {"a": checks["a"], "b": checks["b"]}
            )
        records.append(r)
        print(path.name, "valid" if valid(r) else "INVALID", flush=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {"valid": all(valid(r) for r in records), "cases": records}, indent=2
        )
        + "\n"
    )
    if not all(valid(r) for r in records):
        raise SystemExit(1)


def valid(r):
    return (
        all(r[k]["passed"] for k in ("base", "a", "b"))
        and all(r["patch_" + k]["matches_snapshot"] for k in ("a", "b"))
        and r.get("witness", {"passed": True})["passed"]
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument(
        "--benchmark", type=Path, default=Path("experiments/benchmark/cases")
    )
    p.add_argument(
        "--out", type=Path, default=Path("experiments/results/validation.json")
    )
    a = p.parse_args()
    validate(a.benchmark, a.out)
