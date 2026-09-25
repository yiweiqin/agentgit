"""Summarize Git-history candidates without assigning semantic labels."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
rows = [json.loads(line) for line in (ROOT / "merge_rows.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
candidates = [json.loads(line) for line in (ROOT / "candidates.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]

temporal = [row for row in candidates if row["temporal_overlap"]]
temporal_and_prod = [row for row in temporal if any(path.startswith(("src/", "lib/", "app/")) for path in row["shared_files"])]

report = {
    "merge_rows": len(rows),
    "all_path_or_temporal_candidates": len(candidates),
    "temporal_overlap_candidates": len(temporal),
    "temporal_and_shared_production_path_candidates": len(temporal_and_prod),
    "candidate_ids_temporal": [row["scenario_id"] for row in temporal],
    "candidate_ids_temporal_and_shared_production_path": [row["scenario_id"] for row in temporal_and_prod],
    "interpretation": "Screening counts only. No semantic conflict, duplicate-task, or integration-debt label is inferred.",
}
(ROOT / "screening_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(ROOT / "temporal_candidates.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in temporal), encoding="utf-8")
(ROOT / "temporal_production_overlap_candidates.jsonl").write_text(
    "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in temporal_and_prod), encoding="utf-8"
)
print(json.dumps(report, ensure_ascii=False))
