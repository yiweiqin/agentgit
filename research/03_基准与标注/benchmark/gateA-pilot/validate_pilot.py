"""Validate the synthetic Gate A pilot without interpreting its oracle labels.

This validator checks the benchmark contract only. It deliberately does not
compute detector accuracy, because the pilot labels are synthetic_oracle data.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCENARIOS = ROOT / "scenarios.jsonl"
REQUIRED_TOP = {"scenario_id", "data_status", "project", "baseline_commit", "pre_view", "result_view", "oracle"}
REQUIRED_LABELS = {"TC", "BC", "AC", "RT", "RI", "CC", "UA", "ID"}


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def main() -> int:
    if not SCENARIOS.exists():
        fail(f"missing {SCENARIOS}")

    rows = []
    for line_no, raw in enumerate(SCENARIOS.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError as exc:
            fail(f"line {line_no} is not valid JSON: {exc}")
        missing = REQUIRED_TOP - row.keys()
        if missing:
            fail(f"line {line_no} missing top-level fields: {sorted(missing)}")
        if row["data_status"] != "synthetic_oracle":
            fail(f"{row['scenario_id']}: pilot data_status must be synthetic_oracle")
        if set(row["oracle"]) != REQUIRED_LABELS | {"evidence_type"}:
            fail(f"{row['scenario_id']}: oracle labels do not match the Gate A vocabulary")
        if not isinstance(row["pre_view"].get("tasks"), list) or len(row["pre_view"]["tasks"]) < 2:
            fail(f"{row['scenario_id']}: requires at least two tasks")
        if not isinstance(row["pre_view"].get("changes"), list) or len(row["pre_view"]["changes"]) < 2:
            fail(f"{row['scenario_id']}: requires at least two changes")
        if not row["result_view"].get("repair_cost"):
            fail(f"{row['scenario_id']}: missing result_view.repair_cost")
        rows.append(row)

    ids = [row["scenario_id"] for row in rows]
    if len(ids) != len(set(ids)):
        fail("scenario_id values are not unique")
    if len(rows) < 8:
        fail("pilot must contain at least eight calibration scenarios")

    coverage = {label: sum(bool(row["oracle"][label]) for row in rows) for label in REQUIRED_LABELS}
    missing_positive = sorted(label for label, count in coverage.items() if count == 0)
    if missing_positive:
        fail(f"labels with no positive calibration example: {missing_positive}")

    print(f"validated {len(rows)} scenarios")
    print("positive oracle coverage:")
    for label in sorted(coverage):
        print(f"  {label}: {coverage[label]}")
    print("status: synthetic calibration only; no empirical claim is made")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
