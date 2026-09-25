"""Replay three-way merges for PR-like commits in the local Flask graph."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent / "repo"
ROWS = ROOT / "merge_rows.jsonl"
OUT = ROOT / "merge_replay.jsonl"


def run(*args: str) -> tuple[int, str, str]:
    result = subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.returncode, result.stdout, result.stderr


def main() -> int:
    rows = [json.loads(line) for line in ROWS.read_text(encoding="utf-8").splitlines() if line.strip()]
    results = []
    for row in rows:
        code, auto_out, auto_err = run("merge-tree", "--write-tree", row["first_parent"], row["second_parent"])
        auto_lines = auto_out.splitlines()
        auto_tree = auto_lines[0].strip() if auto_lines and len(auto_lines[0].strip()) == 40 else None
        conflicts = [line.strip() for line in auto_lines + auto_err.splitlines() if "CONFLICT" in line.upper()]
        _, actual_out, _ = run("show", "-s", "--format=%T", row["merge_sha"])
        actual_tree = actual_out.strip()
        results.append(
            {
                "pr_number": row["pr_number"],
                "merge_sha": row["merge_sha"],
                "subject": row["subject"],
                "auto_exit_code": code,
                "auto_tree": auto_tree,
                "actual_tree": actual_tree,
                "tree_equal": auto_tree == actual_tree if auto_tree else False,
                "conflict_lines": conflicts,
                "replay_status": "auto_clean_same_tree"
                if auto_tree == actual_tree
                else "auto_conflict_or_manual_difference",
            }
        )
    OUT.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in results), encoding="utf-8")
    summary = {
        "rows": len(results),
        "auto_clean_same_tree": sum(row["replay_status"] == "auto_clean_same_tree" for row in results),
        "auto_conflict_or_manual_difference": sum(row["replay_status"] == "auto_conflict_or_manual_difference" for row in results),
        "auto_conflict_lines": sum(bool(row["conflict_lines"]) for row in results),
        "interpretation": "Replay evidence only; tree difference does not by itself prove semantic conflict.",
    }
    (ROOT / "merge_replay_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
