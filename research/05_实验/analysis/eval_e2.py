"""E2: score the detection pack and apply the frozen thresholds.

Reads the pack's construction truth through the TypeScript detector (the detector lives
in the plugin, so the evaluator calls into it rather than reimplementing it), then
applies the thresholds frozen in `preregistration.md` §4.

Exit codes are a three-way verdict, deliberately:

    0  measured, every threshold met
    1  measured, at least one threshold missed -> an iteration trigger is recorded
    2  could not measure -> the measurement itself is broken

The distinction matters. A missed threshold is a *result*, and a script that conflated
it with a crash would train us to ignore its failures. A crash is not a result.

Usage
-----
    python analysis/eval_e2.py --pack task-packs/detection-v1/pack.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

_ROOT_DIR = Path(__file__).resolve().parents[2]
_TS_DIR = _ROOT_DIR / "04_协调插件" / "dsh-coord-governor"

# Frozen in preregistration.md §4. Do not edit to make a run pass: the prereg fixes
# these before data exists, and "adjust the bar until it passes" is the failure mode
# pre-registration exists to prevent.
RECALL_FLOOR = 0.60
PRECISION_FLOOR = 0.80
FALSE_REJECTION_CEILING = 0.05

# A3/A4 exist to be compared; A1 is the arm E2 must be measurable on at all, since it
# records detection while taking no action.
ARMS = ("A1-instrument", "A3-advisory", "A4-gated")


def run_arm(arm: str, pack_path: Path) -> dict:
    completed = subprocess.run(
        ["node", "src/cli.ts", "eval-detection", "--pack", str(pack_path.resolve()), "--arm", arm],
        cwd=_TS_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        raise RuntimeError(f"detector failed for {arm} ({completed.returncode}): {completed.stderr.strip()[:400]}")
    return json.loads(completed.stdout)


def verdict(metrics: dict) -> dict:
    """Apply the frozen thresholds to one arm's metrics."""
    checks = {
        "recall": {
            "value": metrics["recall"],
            "threshold": f">= {RECALL_FLOOR}",
            "met": metrics["recall"] >= RECALL_FLOOR,
            "trigger": "I3 (signal insufficient for the detector to fire)",
        },
        "precision": {
            "value": metrics["precision"],
            "threshold": f">= {PRECISION_FLOOR}",
            "met": metrics["precision"] >= PRECISION_FLOOR,
            "trigger": "I4 (too many false alarms; raise the evidence required)",
        },
        "falseRejectionRate": {
            "value": metrics["falseRejectionRate"],
            "threshold": f"<= {FALSE_REJECTION_CEILING}",
            "met": metrics["falseRejectionRate"] <= FALSE_REJECTION_CEILING,
            "trigger": "I4 (legitimate work refused; H9 violation)",
        },
    }
    return {
        "met": all(check["met"] for check in checks.values()),
        "checks": checks,
        "triggers": sorted({check["trigger"] for check in checks.values() if not check["met"]}),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pack", required=True)
    parser.add_argument("--out-dir", default=None, help="where to write eval.json; omit to print only")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    pack_path = Path(args.pack)
    if not pack_path.exists():
        print(json.dumps({"status": "error", "error": f"no task pack at {pack_path}"}))
        return 2

    try:
        per_arm = {arm: run_arm(arm, pack_path) for arm in ARMS}
    except (RuntimeError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        return 2

    report = {"pack": str(pack_path), "status": "measured", "arms": {}}
    any_missed = False
    for arm, metrics in per_arm.items():
        result = verdict(metrics)
        any_missed = any_missed or not result["met"]
        report["arms"][arm] = {
            "n": metrics["n"],
            "tp": metrics["tp"],
            "fp": metrics["fp"],
            "fn": metrics["fn"],
            "tn": metrics["tn"],
            "precision": metrics["precision"],
            "recall": metrics["recall"],
            "f1": metrics["f1"],
            "controlFlagRate": metrics["controlFlagRate"],
            "falseRejectionRate": metrics["falseRejectionRate"],
            "entityVisibleCeiling": metrics["entityVisibleCeiling"],
            "recallWithinCeiling": metrics["recallWithinCeiling"],
            "byTruthKind": metrics["byTruthKind"],
            "outcomes": [
                {
                    "id": o["id"],
                    "truthKind": o["truthKind"],
                    "truth": o["truth"],
                    "overlapsPriorWork": o["overlapsPriorWork"],
                    "detected": o["detected"],
                    "detection": o["detection"],
                    "similarity": o["similarity"],
                }
                for o in metrics["outcomes"]
            ],
            "verdict": result,
        }
    report["thresholds_met"] = not any_missed

    if args.out_dir:
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "eval.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"pack: {pack_path}")
        reference = per_arm[ARMS[0]]
        print(
            f"ceiling: {reference['entityVisibleCeiling']:.3f} of collisions overlap in-flight work, "
            f"so no entity-key detector can exceed that recall"
        )
        print()
        print(f"{'case':<44}{'truth kind':<22}{'overlap':<9}{'flagged':<9}{'detection':<26}sim")
        for outcome in reference["outcomes"]:
            similarity = "" if outcome["similarity"] is None else f"{outcome['similarity']:.3f}"
            marker = "yes" if outcome["detected"] else "no"
            overlap = "yes" if outcome["overlapsPriorWork"] else "no"
            print(
                f"{outcome['id']:<44}{outcome['truthKind']:<22}{overlap:<9}{marker:<9}"
                f"{outcome['detection']:<26}{similarity}"
            )
        print()
        for arm, metrics in per_arm.items():
            result = report["arms"][arm]["verdict"]
            status = "MET" if result["met"] else "MISSED"
            print(
                f"{arm:<16} {status:<7} precision={metrics['precision']:.3f} recall={metrics['recall']:.3f} "
                f"flagRate={metrics['controlFlagRate']:.3f} falseRejection={metrics['falseRejectionRate']:.3f}"
            )
            for trigger in result["triggers"]:
                print(f"                 -> {trigger}")

    return 1 if any_missed else 0


if __name__ == "__main__":
    raise SystemExit(main())
