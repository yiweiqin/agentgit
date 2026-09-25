"""Extract a small, metadata-only candidate set from Flask pull requests.

The output is a candidate pool, not ground truth. Human annotation must decide
whether temporal/file overlap represents a real parallel task or a semantic
conflict. No repository source files are downloaded by this script.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
OWNER = "pallets"
REPO = "flask"
API = f"https://api.github.com/repos/{OWNER}/{REPO}"
HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "ai-change-coordination-research/0.1",
}


def get_json(url: str):
    request = Request(url, headers=HEADERS)
    with urlopen(request, timeout=30) as response:  # noqa: S310 - fixed GitHub API host
        return json.load(response)


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main() -> int:
    ROOT.mkdir(parents=True, exist_ok=True)
    # GitHub sorts by update time, not merge time. A single page can therefore
    # contain very few merged PRs; paginate and record the screening denominator.
    pages = []
    for page in range(1, 4):
        pages.extend(get_json(f"{API}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={page}"))
        time.sleep(0.15)
    merged = [p for p in pages if p.get("merged_at")]

    records = []
    for summary in merged[:20]:
        number = summary["number"]
        detail = get_json(f"{API}/pulls/{number}")
        files = get_json(f"{API}/pulls/{number}/files?per_page=100")
        records.append(
            {
                "pr_number": number,
                "title": detail["title"],
                "html_url": detail["html_url"],
                "author": detail["user"]["login"],
                "created_at": detail["created_at"],
                "updated_at": detail["updated_at"],
                "merged_at": detail["merged_at"],
                "base_sha": detail["base"]["sha"],
                "head_sha": detail["head"]["sha"],
                "merge_commit_sha": detail.get("merge_commit_sha"),
                "changed_files": detail["changed_files"],
                "additions": detail["additions"],
                "deletions": detail["deletions"],
                "file_paths": sorted({item["filename"] for item in files}),
                "data_status": "real_public_metadata_candidate",
                "license_note": "Repository metadata reports BSD-3-Clause; verify repository LICENSE before redistribution.",
            }
        )
        time.sleep(0.15)

    records.sort(key=lambda r: r["merged_at"])
    candidates = []
    for index, left in enumerate(records):
        left_paths = set(left["file_paths"])
        left_created = parse_time(left["created_at"])
        left_merged = parse_time(left["merged_at"])
        for right in records[index + 1 :]:
            right_paths = set(right["file_paths"])
            right_created = parse_time(right["created_at"])
            right_merged = parse_time(right["merged_at"])
            overlap = sorted(left_paths & right_paths)
            temporal_overlap = max(left_created, right_created) < min(left_merged, right_merged)
            if overlap or temporal_overlap:
                candidates.append(
                    {
                        "scenario_id": f"flask-pr-{left['pr_number']}-pr-{right['pr_number']}",
                        "left_pr": left["pr_number"],
                        "right_pr": right["pr_number"],
                        "shared_files": overlap,
                        "temporal_overlap": temporal_overlap,
                        "left_url": left["html_url"],
                        "right_url": right["html_url"],
                        "annotation_status": "unannotated_candidate",
                        "selection_note": "Temporal or file overlap is only a screening signal; it is not evidence of semantic conflict or duplicate work.",
                    }
                )

    (ROOT / "pull_requests.jsonl").write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )
    (ROOT / "overlap_candidates.jsonl").write_text(
        "".join(json.dumps(candidate, ensure_ascii=False) + "\n" for candidate in candidates),
        encoding="utf-8",
    )
    manifest = {
        "repository": f"{OWNER}/{REPO}",
        "api_endpoint": API,
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "records": len(records),
        "candidates": len(candidates),
        "screened_closed_prs": len(pages),
        "screened_merged_prs": len(merged),
        "selection": "first 20 merged PRs among three pages sorted by updated time",
        "data_status": "real_public_metadata_candidate",
        "ground_truth": "not_available; requires Gate A human annotation",
        "source_policy": "metadata only; no source files or private data",
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
