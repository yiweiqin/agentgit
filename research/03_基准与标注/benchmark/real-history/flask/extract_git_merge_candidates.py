"""Extract merge-commit candidates using a local Git object graph.

This avoids GitHub REST API quotas and deliberately emits metadata only. A
candidate is not a semantic-conflict label: it requires later human review.
"""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).resolve().parent
REPO = HERE / "repo"
OUT = HERE / "git-history"
PR_SUBJECT = re.compile(r"\(#(\d+)\)|pull request #?(\d+)", re.IGNORECASE)


def git(*args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO), *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout


def commit_row(sha: str, parents: list[str], subject: str, timestamp: int) -> dict:
    first, second = parents[:2]
    changed = git("diff", "--name-only", first, sha).splitlines()
    branch_start = int(git("show", "-s", "--format=%ct", second).strip())
    match = PR_SUBJECT.search(subject)
    return {
        "merge_sha": sha,
        "first_parent": first,
        "second_parent": second,
        "subject": subject,
        "pr_number": int(next(group for group in match.groups() if group)),
        "merge_time_utc": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
        "branch_start_utc": datetime.fromtimestamp(branch_start, timezone.utc).isoformat(),
        "file_paths": sorted(set(changed)),
        "data_status": "real_public_git_metadata_candidate",
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    raw = git("log", "--merges", "--format=%H%x09%P%x09%ct%x09%s", "-n", "120")
    rows = []
    skipped = []
    for line in raw.splitlines():
        sha, parent_text, timestamp_text, subject = line.split("\t", 3)
        parents = parent_text.split()
        if len(parents) < 2:
            skipped.append({"merge_sha": sha, "reason": "fewer_than_two_parents"})
            continue
        if not PR_SUBJECT.search(subject):
            skipped.append({"merge_sha": sha, "subject": subject, "reason": "not_pr_subject"})
            continue
        try:
            rows.append(commit_row(sha, parents, subject, int(timestamp_text)))
        except subprocess.CalledProcessError as exc:
            skipped.append({"merge_sha": sha, "subject": subject, "reason": f"git_diff_failed:{exc.returncode}"})

    rows.sort(key=lambda row: row["merge_time_utc"])
    candidates = []
    for index, left in enumerate(rows):
        left_paths = set(left["file_paths"])
        left_start = datetime.fromisoformat(left["branch_start_utc"])
        left_end = datetime.fromisoformat(left["merge_time_utc"])
        for right in rows[index + 1 :]:
            right_paths = set(right["file_paths"])
            right_start = datetime.fromisoformat(right["branch_start_utc"])
            right_end = datetime.fromisoformat(right["merge_time_utc"])
            shared = sorted(left_paths & right_paths)
            temporal_overlap = max(left_start, right_start) < min(left_end, right_end)
            if not (shared or temporal_overlap):
                continue
            candidates.append(
                {
                    "scenario_id": f"flask-pr-{left['pr_number']}-pr-{right['pr_number']}",
                    "left_merge_sha": left["merge_sha"],
                    "right_merge_sha": right["merge_sha"],
                    "left_pr": left["pr_number"],
                    "right_pr": right["pr_number"],
                    "shared_files": shared,
                    "temporal_overlap": temporal_overlap,
                    "left_subject": left["subject"],
                    "right_subject": right["subject"],
                    "annotation_status": "unannotated_candidate",
                    "selection_note": "Git commit-graph screening only; no semantic or duplicate-work label is inferred.",
                }
            )

    (OUT / "merge_rows.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8"
    )
    (OUT / "candidates.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in candidates), encoding="utf-8"
    )
    (OUT / "skipped.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in skipped), encoding="utf-8"
    )
    manifest = {
        "repository": "pallets/flask",
        "source": "local Git object graph cloned from public repository",
        "commit_limit": 120,
        "pr_like_merge_rows": len(rows),
        "candidate_pairs": len(candidates),
        "skipped_merges": len(skipped),
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "data_status": "real_public_git_metadata_candidate",
        "ground_truth": "not_available; requires Gate A human annotation",
        "source_policy": "commit metadata and path lists only; no source files copied into output",
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
