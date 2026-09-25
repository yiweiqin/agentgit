"""Create blank Gate A annotation records from strict Git-history candidates."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
INPUT = ROOT / "temporal_candidates.jsonl"
OUTPUT = ROOT / "annotation_queue.jsonl"
LABELS = ("TC", "BC", "AC", "RT", "RI", "CC", "UA", "ID")


def blank_label() -> dict:
    return {"value": None, "evidence": [], "confidence": None, "notes": ""}


def main() -> int:
    rows = [json.loads(line) for line in INPUT.read_text(encoding="utf-8").splitlines() if line.strip()]
    queue = []
    for row in rows:
        queue.append(
            {
                "scenario_id": row["scenario_id"],
                "data_status": "real_public_git_metadata_candidate",
                "annotation_status": "awaiting_two_independent_annotators",
                "evidence": {
                    "left_pr": row["left_pr"],
                    "right_pr": row["right_pr"],
                    "left_merge_sha": row["left_merge_sha"],
                    "right_merge_sha": row["right_merge_sha"],
                    "left_subject": row["left_subject"],
                    "right_subject": row["right_subject"],
                    "shared_files": row["shared_files"],
                    "temporal_overlap": row["temporal_overlap"],
                    "patch_paths": [
                        f"candidate_patches/pr-{row['left_pr']}.patch",
                        f"candidate_patches/pr-{row['right_pr']}.patch",
                    ],
                },
                "annotator_A": {label: blank_label() for label in LABELS},
                "annotator_B": {label: blank_label() for label in LABELS},
                "adjudication": {
                    "status": "not_started",
                    "third_annotator": None,
                    "decision_log": [],
                },
            }
        )
    OUTPUT.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in queue), encoding="utf-8")
    print(json.dumps({"records": len(queue), "output": str(OUTPUT), "status": "blank_queue_only"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
