"""Estimate the pre-AI baseline for change arrival (lambda) and reconciliation latency (R proxy).

Motivation
----------
The velocity-reconciliation framing (see `01_问题定义与定位/痛点_速度与上下文失配.md`)
claims that agent-driven development breaks Git's implicit design premise lambda ~= R.
Before that claim can be tested, two things must be established:

1.  what lambda and the R proxy look like in a **healthy, pre-agent** project, and
2.  whether those quantities are even *measurable from Git history*.

This script answers both on the locally cloned Flask repository. It is deliberately
read-only and does not write results into any frozen asset.

Definitions used here (and their weaknesses)
--------------------------------------------
* `lambda_merged` = merges per unit time **that reached the mainline**. This is NOT the
  arrival rate of produced changes. Git history contains only changes that were already
  reconciled, so `lambda_merged` is a *lower bound* on the arrival rate, and the gap
  between the two is exactly the backlog the framing is about. This structural blind
  spot is a finding, not a limitation to hide.
* `tip_age` = merge_time - committer_time(last commit on the merged branch). This is a
  *lower bound* on W (total time in system): it captures review/integration queue delay
  but excludes the time the branch spent being written. It is used because it is cheap
  to compute across the full merge set; a true W would require per-merge `merge-base`,
  which this script does not do.

Little's Law gives WIP ~= lambda * W. With both terms under-estimated, the reported WIP
is a floor, and a floor near zero is the meaningful statement: there is no backlog.

Usage (from `03_基准与标注/benchmark/real-history/flask`):

    python git-history/estimate_lambda_R.py
    python git-history/estimate_lambda_R.py --repo repo --json-out git-history/lambda_R_baseline.json

Exit codes: 0 = report produced, 2 = repository unavailable.
"""

from __future__ import annotations

import argparse
import collections
import json
import statistics as st
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
FLASK_ROOT = HERE.parent
DEFAULT_REPO = FLASK_ROOT / "repo"

WIDE_TIP_AGE_HOURS = 1.0


def git(repo: Path, *args: str) -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0 and not proc.stdout:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def parse_iso(value: str) -> datetime:
    # `%cI` may emit a trailing `Z`, which datetime.fromisoformat rejects before
    # Python 3.11. Normalise it so the script runs on older interpreters too.
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def percentile(sorted_values: list[float], q: float) -> float:
    """Nearest-rank percentile on an already-sorted list. q in [0, 1]."""
    if not sorted_values:
        raise ValueError("empty")
    idx = min(len(sorted_values) - 1, max(0, int(round(q * (len(sorted_values) - 1)))))
    return sorted_values[idx]


def collect_commit_dates(repo: Path) -> list[str]:
    return git(repo, "log", "--format=%cI")


def collect_merges(repo: Path) -> list[tuple[str, str, str]]:
    """Return (merge_sha, merge_date, second_parent) for first-parent merges."""
    out: list[tuple[str, str, str]] = []
    for line in git(repo, "log", "--first-parent", "--merges", "--format=%H|%cI|%P"):
        parts = line.split("|")
        if len(parts) < 3:
            continue
        parents = parts[2].split()
        if len(parents) < 2:
            continue
        out.append((parts[0], parts[1], parents[1]))
    return out


def resolve_tip_times(repo: Path, shas: list[str], batch: int = 200) -> dict[str, str]:
    tips: dict[str, str] = {}
    for start in range(0, len(shas), batch):
        chunk = shas[start : start + batch]
        for line in git(repo, "log", "--no-walk", "--format=%H|%cI", *chunk):
            if "|" in line:
                sha, date = line.split("|", 1)
                tips[sha] = date
    return tips


def summarise(values: list[float]) -> dict:
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "min": ordered[0],
        "p25": percentile(ordered, 0.25),
        "median": st.median(ordered),
        "p75": percentile(ordered, 0.75),
        "p90": percentile(ordered, 0.90),
        "p99": percentile(ordered, 0.99),
        "max": ordered[-1],
        "share_below_1h": sum(1 for v in ordered if v < WIDE_TIP_AGE_HOURS) / len(ordered),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=str(DEFAULT_REPO))
    parser.add_argument("--json-out", default=None)
    args = parser.parse_args()

    repo = Path(args.repo)
    if not (repo / ".git").exists():
        print(json.dumps({"error": f"not a git repository: {repo}"}, ensure_ascii=False))
        return 2

    commits = collect_commit_dates(repo)
    merges = collect_merges(repo)
    tips = resolve_tip_times(repo, [m[2] for m in merges])

    per_year_commits: collections.Counter[str] = collections.Counter(c[:4] for c in commits)
    per_year_merges: collections.Counter[str] = collections.Counter(m[1][:4] for m in merges)

    tip_age: list[tuple[float, str]] = []
    for _sha, merge_date, second_parent in merges:
        tip_date = tips.get(second_parent)
        if tip_date is None:
            continue
        try:
            delta = (parse_iso(merge_date) - parse_iso(tip_date)).total_seconds() / 3600.0
        except ValueError:
            continue
        if delta >= 0:
            tip_age.append((delta, merge_date[:4]))

    if not tip_age:
        print(json.dumps({"error": "no merge latency could be computed"}, ensure_ascii=False))
        return 2

    per_year_tip_age: dict[str, list[float]] = collections.defaultdict(list)
    for delta, year in tip_age:
        per_year_tip_age[year].append(delta)

    merge_times = sorted(parse_iso(m[1]) for m in merges)
    span_hours = (merge_times[-1] - merge_times[0]).total_seconds() / 3600.0

    lambda_merged = len(merges) / span_hours
    w_floor = st.median([d for d, _ in tip_age])
    wip_floor = lambda_merged * w_floor

    report = {
        "repo": str(repo),
        "status": "baseline_estimate_only_not_the_agent_driven_failure_state",
        "commits_total": len(commits),
        "merges_total": len(merges),
        "history_span": {
            "first_commit": min(commits)[:10] if commits else None,
            "last_commit": max(commits)[:10] if commits else None,
        },
        "lambda_merged_per_hour": lambda_merged,
        "lambda_merged_per_day": lambda_merged * 24,
        "tip_age_hours": summarise([d for d, _ in tip_age]),
        "w_floor_hours_median": w_floor,
        "wip_floor_changes": wip_floor,
        "per_year": {
            year: {
                "commits": per_year_commits.get(year, 0),
                "merges": per_year_merges.get(year, 0),
                "n_tip_age": len(per_year_tip_age.get(year, [])),
                "median_tip_age_hours": (
                    st.median(per_year_tip_age[year]) if per_year_tip_age.get(year) else None
                ),
            }
            for year in sorted(set(per_year_commits) | set(per_year_merges))
        },
        "interpretation_guards": [
            "lambda_merged counts only changes that REACHED the mainline. The produced-change "
            "arrival rate is strictly larger, and the difference is the backlog this framework "
            "is about. Git history cannot observe the backlog by construction: unreconciled work "
            "is, by definition, not in the commit graph.",
            "Therefore this script CANNOT produce evidence for the lambda > R failure state. It "
            "can only calibrate the healthy baseline and demonstrate the measurement obstacle.",
            "tip_age is a lower bound on W (time in system): it excludes the writing time of the "
            "branch. A small tip_age must not be read as 'changes are cheap to reconcile', only "
            "as 'they do not queue before merge'.",
            "This repository is a mature project whose throughput is DECLINING. A declining "
            "lambda with a collapsing tip_age is the expected signature of a converging project, "
            "not of the multi-session agent failure mode.",
        ],
    }

    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
