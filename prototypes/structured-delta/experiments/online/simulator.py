"""Recompute base-to-active deltas after every incremental patch event.

Patch-event indices are the time unit. Runtime ms is separately recorded.
A merge failure and a semantic test failure are separate clocks.
"""

import argparse
import json
import statistics
import time
from pathlib import Path
from ..delta.extractor import extract
from ..delta.interaction import detect
from ..evaluation.runtime import snapshot, merged_pair, strict_order, digest
from ..evaluation.freeze import verify
from .sequences import functional_complete


def simulate(root, benchmark, out):
    verify(root)
    if out.exists():
        raise FileExistsError(out)
    out.mkdir(parents=True)
    records = []
    for path in sorted(benchmark.glob("case[0-9]*")):
        if not (path / "online" / "schedule.json").exists():
            continue
        base = snapshot(path / "base")
        final = {k: snapshot(path / k) for k in ("a", "b")}
        active = {"a": dict(base), "b": dict(base)}
        checks = {k: (path / "checks" / f"{k}.py").read_text() for k in ("a", "b")}
        events = []
        for tick, event in enumerate(
            json.loads((path / "online" / "schedule.json").read_text()), 1
        ):
            branch = event["branch"]
            target = snapshot(path / "online" / event["state"])
            inc = (path / "online" / event["patch"]).read_text()
            application = strict_order(active[branch], [inc], {})
            if not application["applied"] or application["state_hash"] != digest(
                target
            ):
                raise RuntimeError(f"Broken incremental sequence {path.name}:{event}")
            active[branch] = target
            start = time.perf_counter()
            pred = detect(extract(base, active["a"]), extract(base, active["b"]))
            elapsed = (time.perf_counter() - start) * 1000
            # Run branch requirements as soon as that branch's functional change is
            # fully present, not after arbitrary cleanup (avoids artificial lead).
            active_checks = {
                k: v
                for k, v in checks.items()
                if functional_complete(active[k], final[k])
            }
            merge = merged_pair(base, active["a"], active["b"], active_checks)
            events.append(
                {
                    "tick": tick,
                    "event": event,
                    "prediction": pred.to_dict(),
                    "detection_ms": elapsed,
                    "requirements_active": list(active_checks),
                    "merge_clean": merge["both_clean"],
                    "test_failure": any(
                        merge[k]["clean"] and not merge[k]["tests"]["passed"]
                        for k in ("ab", "ba")
                    ),
                    "merge": merge,
                }
            )
        # Gold is used only to score intervention correctness, not for detection.
        gold = json.loads((path / "gold.json").read_text())

        def first(predicate):
            return next((e["tick"] for e in events if predicate(e)), None)

        detected = first(lambda e: e["prediction"]["label"] == "conflicting")
        merge_failed = first(lambda e: not e["merge_clean"])
        test_failed = first(lambda e: e["test_failure"])
        failures = [v for v in (merge_failed, test_failed) if v is not None]
        failed = min(failures) if failures else None
        rec = {
            "id": path.name,
            "label": gold["label"],
            "events": events,
            "first_detection_tick": detected,
            "first_merge_failure_tick": merge_failed,
            "first_test_failure_tick": test_failed,
            "first_failure_tick": failed,
            "lead_ticks": failed - detected
            if failed is not None and detected is not None
            else None,
            "semantic_lead_ticks": test_failed - detected
            if test_failed is not None and detected is not None
            else None,
            "false_intervention": detected is not None
            and gold["label"] != "conflicting",
            "false_before_failure": detected is not None
            and gold["label"] != "conflicting"
            and (failed is None or detected < failed),
        }
        (out / f"{path.name}.json").write_text(
            json.dumps(rec, ensure_ascii=False, indent=2) + "\n"
        )
        records.append(rec)
        print(path.name, flush=True)
    conflict = [r for r in records if r["label"] == "conflicting"]
    nonconf = [r for r in records if r["label"] != "conflicting"]
    leads = [r["lead_ticks"] for r in conflict if r["lead_ticks"] is not None]
    summary = {
        "cases": len(records),
        "events": sum(len(r["events"]) for r in records),
        "conflicting_cases": len(conflict),
        "conflicts_detected": sum(
            r["first_detection_tick"] is not None for r in conflict
        ),
        "nonconflicting_cases": len(nonconf),
        "false_interventions": sum(r["false_intervention"] for r in nonconf),
        "false_early_interventions": sum(r["false_before_failure"] for r in nonconf),
        "lead_ticks_conflicts": leads,
        "mean_lead_ticks_conflicts": statistics.mean(leads) if leads else None,
        "median_detection_ms": statistics.median(
            e["detection_ms"] for r in records for e in r["events"]
        ),
        "rows": [{k: v for k, v in r.items() if k != "events"} for r in records],
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, default=Path("."))
    p.add_argument(
        "--benchmark", type=Path, default=Path("experiments/benchmark/cases")
    )
    p.add_argument("--out", type=Path, default=Path("experiments/results/online-001"))
    a = p.parse_args()
    simulate(a.root, a.benchmark, a.out)
