"""Build Gate A two-view annotation packets for the Flask real-history pilot.

The output of this script is the *executable annotation task*: for each screened
candidate pair it produces one self-contained packet with a `prediction_view`
(what annotators may see before any integration result) and a `result_view`
(integration outcome, subsequent history, test status).

Design rules enforced here:

* **No ACCD ground truth.** The builder never writes a `TC`/`BC`/... value. The
  single-researcher screening opinions in `adjudication.md` and
  `strict_candidate_adjudication.md` are deliberately *not* read.
* **Missing evidence is explicit.** Anything that cannot be recovered (agent
  context, executed test results) is written as `status: "unavailable"` /
  `"not_executed"` with a reason, never omitted.
* **Deterministic output.** Packets contain no build timestamp, so `SHA-256`
  of a packet is stable across rebuilds and can be frozen into the annotation
  sheets. The build timestamp lives in `packets/index.json` only.
* **Counterfactual replay is labelled as such.** The two PRs were merged into
  mainline sequentially, so a pair-level merge is a constructed counterfactual,
  not recorded history. Evidence is tagged `evidence_kind` accordingly.

Usage (from the research folder root):

    python 03_基准与标注/benchmark/real-history/flask/git-history/build_annotation_packets.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FLASK = ROOT.parent
REPO = FLASK / "repo"
OUT_DIR = ROOT / "annotation"
PACKETS_DIR = OUT_DIR / "packets"
CONTEXT_CACHE = OUT_DIR / "context_cache"

CANDIDATES = ROOT / "temporal_candidates.jsonl"
PATCH_MANIFEST = ROOT / "candidate_patch_manifest.json"
MERGE_ROWS = ROOT / "merge_rows.jsonl"
MERGE_REPLAY = ROOT / "merge_replay.jsonl"

PACKET_VERSION = "1.1"
BUILDER_VERSION = "1.1"
LABELS = ("TC", "BC", "AC", "RT", "RI", "CC", "LF", "UA", "ID")
DEFAULT_WINDOW_DAYS = 180
GIT_TIMEOUT = 120
PRODUCTION_PREFIXES = ("src/", "lib/", "app/")

BODY_CHAR_CAP = 20000

RE_DEF = re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)")
RE_CLASS = re.compile(r"^\s*class\s+([A-Za-z_]\w*)")
RE_JSTS = re.compile(r"^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)")
RE_CHECKBOX = re.compile(r"^\s*[-*+]\s+\[[ xX]\]\s+(.*\S)\s*$")
RE_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")
RE_SECTION = re.compile(r"^\s*#{1,6}\s*(.*\S)\s*$")
RE_REVERT = re.compile(r"\b(revert|rollback|roll back|back out|undo)\b", re.IGNORECASE)
RE_FIX = re.compile(r"\b(fix|fixes|fixed|regression|broken|hotfix|patch up)\b", re.IGNORECASE)
AC_SECTION_WORDS = ("acceptance criteria", "acceptance", "acceptance test", "test plan", "testing", "tests", "验证", "验收")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str | None:
    if not path.exists():
        return None
    return sha256_bytes(path.read_bytes())


def git(*args: str) -> tuple[int, str, str]:
    try:
        result = subprocess.run(
            ["git", "-C", str(REPO), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=GIT_TIMEOUT,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {GIT_TIMEOUT}s"
    except FileNotFoundError:
        return 127, "", "git executable not found"


def parse_utc(value: str) -> datetime | None:
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# patch parsing
# --------------------------------------------------------------------------- #
def parse_patch(text: str) -> dict:
    files: list[dict] = []
    current: dict | None = None
    hunk: dict | None = None
    total_added = 0
    total_removed = 0

    for line in text.splitlines():
        if line.startswith("diff --git "):
            current = {"old_path": None, "new_path": None, "hunks": []}
            files.append(current)
            hunk = None
            continue
        if current is None:
            continue
        if line.startswith("--- "):
            current["old_path"] = line[4:].strip()
            continue
        if line.startswith("+++ "):
            current["new_path"] = line[4:].strip()
            continue
        if line.startswith("@@"):
            hunk = {"header": line.strip(), "file": current["new_path"], "added": [], "removed": []}
            current["hunks"].append(hunk)
            continue
        if hunk is None:
            continue
        if line.startswith("+") and not line.startswith("+++"):
            hunk["added"].append(line[1:])
            total_added += 1
        elif line.startswith("-") and not line.startswith("---"):
            hunk["removed"].append(line[1:])
            total_removed += 1

    for entry in files:
        for candidate in (entry.get("new_path"), entry.get("old_path")):
            if candidate and candidate != "/dev/null":
                entry["path"] = candidate[2:] if candidate.startswith(("a/", "b/")) else candidate
                break
        else:
            entry["path"] = None
        entry["additions"] = sum(len(h["added"]) for h in entry["hunks"])
        entry["deletions"] = sum(len(h["removed"]) for h in entry["hunks"])
        entry["hunk_count"] = len(entry["hunks"])

    return {
        "files": files,
        "stats": {
            "files_changed": len(files),
            "additions": total_added,
            "deletions": total_removed,
            "hunks": sum(entry["hunk_count"] for entry in files),
        },
    }


def touched_symbols(files: list[dict]) -> list[dict]:
    """Symbol-level change candidates, extracted from added/removed diff lines.

    This is a *lexical* extraction, not a semantic program analysis. It exists so
    annotators can see entity-level overlap without a language server, and is
    tagged as a screening signal.
    """
    seen: dict[tuple[str, str, str], dict] = {}
    for entry in files:
        path = entry.get("path") or "<unknown>"
        for hunk in entry["hunks"]:
            for kind, lines in (("added", hunk["added"]), ("removed", hunk["removed"])):
                for line in lines:
                    name = None
                    for pattern in (RE_DEF, RE_CLASS, RE_JSTS):
                        match = pattern.match(line)
                        if match:
                            name = match.group(1)
                            break
                    if not name:
                        continue
                    key = (path, name, kind)
                    if key not in seen:
                        seen[key] = {
                            "file": path,
                            "symbol": name,
                            "change": kind,
                            "hunk_header": hunk["header"],
                            "evidence_kind": "lexical_extraction_screening_signal",
                        }
    return sorted(seen.values(), key=lambda row: (row["file"], row["symbol"], row["change"]))


# --------------------------------------------------------------------------- #
# PR context (cached; offline-safe)
# --------------------------------------------------------------------------- #
def load_context(pr: int) -> dict:
    path = CONTEXT_CACHE / f"pr-{pr}.json"
    if not path.exists():
        return {
            "status": "unavailable",
            "reason": (
                f"no cached GitHub context at context_cache/pr-{pr}.json; "
                "run fetch_pr_context.py in a networked environment"
            ),
            "context_cache_ref": None,
            "context_sha256": None,
        }
    raw = json.loads(path.read_text(encoding="utf-8"))
    pull = (raw.get("data") or {}).get("pull") or {}
    review_comments = (raw.get("data") or {}).get("review_comments") or []
    issue_comments = (raw.get("data") or {}).get("issue_comments") or []
    degraded = bool(raw.get("degraded"))
    return {
        "status": "partially_available" if degraded else "available",
        "reason": raw.get("availability_note"),
        "context_cache_ref": f"context_cache/pr-{pr}.json",
        "context_sha256": sha256_file(path),
        "retrieved_at_utc": raw.get("retrieved_at_utc"),
        "response_sha256": raw.get("response_sha256") or {},
        "fetched": raw.get("fetched") or {},
        "pull": pull,
        "review_comments": review_comments,
        "issue_comments": issue_comments,
        "provenance_note": (
            "Task text, labels and discussion are upstream-authored public GitHub content, "
            "cached verbatim and hash-pinned; they are not researcher-authored descriptions."
        ),
    }


def extract_acceptance_criteria(body: str | None) -> tuple[list[dict], str]:
    if not body:
        return [], "not_declared"

    items: list[dict] = []
    in_section = False
    section_name: str | None = None

    for line in body.splitlines():
        section = RE_SECTION.match(line)
        if section:
            title = section.group(1).lower()
            in_section = any(word in title for word in AC_SECTION_WORDS)
            section_name = section.group(1) if in_section else None
            continue

        checkbox = RE_CHECKBOX.match(line)
        if checkbox:
            items.append(
                {
                    "text": checkbox.group(1),
                    "kind": "declared_checkbox",
                    "section": section_name,
                }
            )
            continue

        if in_section:
            bullet = RE_BULLET.match(line)
            if bullet:
                items.append(
                    {
                        "text": bullet.group(1),
                        "kind": "declared_section_bullet",
                        "section": section_name,
                    }
                )

    if items:
        return items, "declared"
    return [], "not_declared"


def build_task(pr: int, context: dict, patch_info: dict, merge_row: dict | None) -> dict:
    pull = context.get("pull") or {}
    body = pull.get("body")
    if body and len(body) > BODY_CHAR_CAP:
        body_text = body[:BODY_CHAR_CAP]
        body_truncated = True
    else:
        body_text = body
        body_truncated = False

    criteria, criteria_status = extract_acceptance_criteria(pull.get("body"))

    return {
        "source_pr": pr,
        "source_url": f"https://github.com/pallets/flask/pull/{pr}",
        "title": pull.get("title") or (merge_row or {}).get("subject"),
        "description_text": body_text,
        "description_status": "available" if body_text else ("not_provided_upstream" if context["status"] != "unavailable" else "unavailable"),
        "description_truncated_in_packet": body_truncated,
        "description_full_char_count": len(body) if body else 0,
        "acceptance_criteria": criteria,
        "acceptance_criteria_status": criteria_status,
        "acceptance_criteria_note": (
            "Flask PRs frequently declare no acceptance criteria. `not_declared` means the upstream "
            "text contains none; it must not be read as `no overlap`."
        ),
        "declared_labels": pull.get("labels") or [],
        "author": pull.get("author"),
        "created_at": pull.get("created_at"),
        "merged_at": pull.get("merged_at"),
        "changed_files_upstream": pull.get("changed_files"),
        "additions_upstream": pull.get("additions"),
        "deletions_upstream": pull.get("deletions"),
        "discussion": {
            "review_comments": context.get("review_comments") or [],
            "issue_comments": context.get("issue_comments") or [],
            "discussion_status": (
                "available"
                if (context.get("review_comments") or context.get("issue_comments"))
                else ("none_upstream" if context["status"] != "unavailable" else "unavailable")
            ),
        },
        "change_set_stats_from_patch": patch_info["stats"],
    }


# --------------------------------------------------------------------------- #
# views
# --------------------------------------------------------------------------- #
def build_change_set(label: str, pr: int, patch_info: dict, patch_path: Path) -> dict:
    files = patch_info["files"]
    paths = sorted({entry["path"] for entry in files if entry.get("path")})

    return {
        "change_set": label,
        "source_pr": pr,
        "patch_relative_path": str(patch_path.relative_to(ROOT)).replace("\\", "/"),
        "patch_sha256": sha256_file(patch_path),
        "files": [
            {
                "path": entry.get("path"),
                "additions": entry["additions"],
                "deletions": entry["deletions"],
                "hunk_count": entry["hunk_count"],
                "is_production_path": bool(entry.get("path") and entry["path"].startswith(PRODUCTION_PREFIXES)),
            }
            for entry in files
        ],
        "diff_hunks": [
            {
                "file": hunk["file"],
                "header": hunk["header"],
                "added": hunk["added"],
                "removed": hunk["removed"],
            }
            for entry in files
            for hunk in entry["hunks"]
        ],
        "touched_symbols": touched_symbols(files),
        "stats": patch_info["stats"],
        "changed_paths": paths,
        "diff_integrity": {
            "full_diff_in_packet": True,
            "note": (
                "All added/removed lines present in the public patch are reproduced inline. "
                "Hunk context lines (unchanged surrounding code) are not included; read the "
                "frozen patch file hash-pinned by patch_sha256 for full context."
            ),
        },
    }


def build_repair_history(window_days: int, files_a: list[str], files_b: list[str], after: datetime | None) -> dict:
    rows = read_jsonl(MERGE_ROWS)
    if after is None:
        return {
            "status": "unavailable",
            "reason": "candidate merge timestamps unavailable; cannot bound the follow-up window",
            "evidence_kind": "subsequent_mainline_history",
        }

    until = after + timedelta(days=window_days)
    union = set(files_a) | set(files_b)
    entries = []

    for row in rows:
        stamp = parse_utc(row.get("merge_time_utc", ""))
        if stamp is None or not (after < stamp <= until):
            continue
        paths = set(row.get("file_paths") or [])
        overlap = sorted(paths & union)
        if not overlap:
            continue
        subject = row.get("subject") or ""
        entries.append(
            {
                "pr_number": row.get("pr_number"),
                "merge_sha": row.get("merge_sha"),
                "merge_time_utc": row.get("merge_time_utc"),
                "subject": subject,
                "days_after_candidate": round((stamp - after).total_seconds() / 86400.0, 2),
                "shared_paths": overlap,
                "shared_with_change_set_a": sorted(paths & set(files_a)),
                "shared_with_change_set_b": sorted(paths & set(files_b)),
                "lexical_revert_signal": bool(RE_REVERT.search(subject)),
                "lexical_fix_signal": bool(RE_FIX.search(subject)),
            }
        )

    entries.sort(key=lambda row: row["merge_time_utc"])

    stamps = [stamp for stamp in (parse_utc(row.get("merge_time_utc", "")) for row in rows) if stamp]
    coverage_end = max(stamps) if stamps else None
    truncated = bool(coverage_end and until > coverage_end)

    return {
        "status": "computed",
        "evidence_kind": "subsequent_mainline_history",
        "window_days": window_days,
        "window_start_utc": after.isoformat().replace("+00:00", "Z"),
        "window_end_utc": until.isoformat().replace("+00:00", "Z"),
        "data_coverage_start_utc": min(stamps).isoformat().replace("+00:00", "Z") if stamps else None,
        "data_coverage_end_utc": coverage_end.isoformat().replace("+00:00", "Z") if coverage_end else None,
        "window_truncated_by_data": truncated,
        "effective_observed_window_end_utc": (
            min(until, coverage_end).isoformat().replace("+00:00", "Z") if coverage_end else None
        ),
        "coverage_guard": (
            "The screened commit range ends at data_coverage_end_utc. If window_truncated_by_data is true, "
            "the absence of a follow-up fix after effective_observed_window_end_utc is an artifact of data "
            "coverage, not evidence that no repair was needed."
        ),
        "source": "merge_rows.jsonl (local commit graph, 80 PR-like merge rows in the screened window)",
        "entry_count": len(entries),
        "entries": entries,
        "interpretation_guard": (
            "`lexical_revert_signal` and `lexical_fix_signal` are keyword matches on merge subjects. "
            "They are candidate evidence for the annotator to inspect, not an ID/BC label. "
            "An empty entry list means no mainline merge in the window touched these paths in the "
            "screened commit range; it is not proof that no repair happened."
        ),
    }


def build_repeated_touch_evidence(left_set: dict, right_set: dict, repair_history: dict) -> dict:
    """Symbol-level repeated-touch evidence for the `LF` label (manual §3.9).

    `LF` asks whether one entity was touched by three or more distinct changes and
    lost its task attribution. The packet can establish the A/B touches exactly
    (from the two patches), but follow-up history is only available at *path*
    level, so every follow-up count here is an explicitly labelled proxy. The
    block never asserts `LF`; it only gives the annotator resolvable, bounded
    evidence plus the reason the bound is loose.
    """
    symbols: dict[str, dict] = {}
    for label, change_set in (("A", left_set), ("B", right_set)):
        for row in change_set.get("touched_symbols") or []:
            entry = symbols.setdefault(
                row["symbol"],
                {"symbol": row["symbol"], "files": set(), "in_packet_changes": set(), "declarations": []},
            )
            entry["files"].add(row["file"])
            entry["in_packet_changes"].add(label)
            entry["declarations"].append(
                {
                    "change_set": label,
                    "file": row["file"],
                    "change": row["change"],
                    "hunk_header": row["hunk_header"],
                }
            )

    entries = repair_history.get("entries") or []
    window_truncated = bool(repair_history.get("window_truncated_by_data"))

    out = []
    for symbol in sorted(symbols):
        entry = symbols[symbol]
        files = sorted(entry["files"])
        followups = [
            {
                "pr_number": item.get("pr_number"),
                "merge_sha": item.get("merge_sha"),
                "merge_time_utc": item.get("merge_time_utc"),
                "days_after_candidate": item.get("days_after_candidate"),
                "shared_paths": sorted(set(item.get("shared_paths") or []) & set(files)),
                "lexical_revert_signal": item.get("lexical_revert_signal"),
                "lexical_fix_signal": item.get("lexical_fix_signal"),
            }
            for item in entries
            if set(item.get("shared_paths") or []) & set(files)
        ]
        in_packet = sorted(entry["in_packet_changes"])
        lower_bound = len(in_packet)
        proxy_count = lower_bound + len(followups)
        out.append(
            {
                "symbol": symbol,
                "files": files,
                "in_packet_changes": in_packet,
                "in_packet_change_count": lower_bound,
                "touched_by_both_packet_changes": lower_bound >= 2,
                "followup_merge_count": len(followups),
                "followup_merges": followups,
                "distinct_touch_count_lower_bound_exact": lower_bound,
                "distinct_touch_count_upper_bound_path_proxy": proxy_count,
                "meets_three_touch_threshold_on_path_proxy": proxy_count >= 3,
                "meets_three_touch_threshold_on_exact_evidence": lower_bound >= 3,
            }
        )

    shared_symbols_exact = [row["symbol"] for row in out if row["touched_by_both_packet_changes"]]
    path_proxy_only = [
        row["symbol"]
        for row in out
        if row["meets_three_touch_threshold_on_path_proxy"]
        and not row["meets_three_touch_threshold_on_exact_evidence"]
    ]

    if not out:
        verdict = "no_symbol_level_evidence_available"
        judgeable = False
        reason = (
            "Neither patch in this pair declares any touched symbol that this builder can extract, so "
            "repeated touch cannot even be enumerated. LF is not judgeable from this packet."
        )
    elif len(out) == 1 and not out[0]["meets_three_touch_threshold_on_path_proxy"]:
        verdict = "insufficient_touch_evidence"
        judgeable = False
        reason = (
            "Repeated touch requires three or more distinct touching changes. This packet supplies at most "
            f"{out[0]['distinct_touch_count_upper_bound_path_proxy']} touch(es) even on the loose path proxy, "
            "so the threshold cannot be reached. LF is not judgeable from this packet."
        )
    elif not shared_symbols_exact:
        verdict = "path_proxy_reaches_threshold_but_symbol_level_unestablished"
        judgeable = False
        reason = (
            "Some symbols reach the three-touch threshold only through the path-level proxy, and no symbol "
            "is touched by both members of the pair. A path-level count cannot establish symbol-level "
            "repeated touch, so LF must be recorded as `uncertain`, never `yes` and never `no` (H9)."
        )
    else:
        verdict = "symbol_level_evidence_available"
        judgeable = True
        reason = (
            "At least one symbol is touched by both packet changes, so the annotator can attempt to "
            "establish task attribution for that symbol from in-packet evidence."
        )

    return {
        "status": "computed",
        "evidence_kind": "path_level_proxy_for_repeated_touch",
        "purpose": "Evidence support for the LF label only (manual §3.9). Not an LF label.",
        "lf_judgeable_from_this_packet": judgeable,
        "lf_judgeability_verdict": verdict,
        "lf_judgeability_reason": reason,
        "symbols_touched_by_both_packet_changes": shared_symbols_exact,
        "symbols_reaching_threshold_on_path_proxy_only": path_proxy_only,
        "symbols": out,
        "exact_evidence_available_for": "the two in-packet change sets (A and B) only",
        "proxy_limitation": (
            "Follow-up history is recorded at path level, not symbol level, so followup_merge_count "
            "counts merges that touched a FILE containing this symbol. A merge touching the same file "
            "may have changed an unrelated symbol. Therefore "
            "`distinct_touch_count_upper_bound_path_proxy` is an upper bound, not a count of touches to "
            "this symbol, and `meets_three_touch_threshold_on_path_proxy = true` is a screening signal "
            "only. If symbol-level repeated touch cannot be established from the in-packet evidence, "
            "annotators must record `uncertain`, never `no` and never `yes` on the proxy alone (H9)."
        ),
        "window_truncated_by_data": window_truncated,
        "window_note": (
            "If window_truncated_by_data is true, missing follow-up merges are an artifact of commit-graph "
            "coverage, not evidence that the symbol was touched only twice."
        ),
    }


def counterfactual_pair_merge(left_head: str, right_head: str) -> dict:
    if not left_head or not right_head:
        return {"status": "unavailable", "reason": "missing PR head commit for one or both sides"}
    if not REPO.exists():
        return {"status": "unavailable", "reason": f"local git repository not found at {REPO}"}

    code, out, err = git("merge-tree", "--write-tree", left_head, right_head)
    lines = out.splitlines()
    tree = lines[0].strip() if lines and len(lines[0].strip()) == 40 else None
    conflicts = [line.strip() for line in (lines + err.splitlines()) if "CONFLICT" in line.upper()]
    conflicted_files = sorted(
        {
            match.group(1)
            for line in (lines + err.splitlines())
            if (match := re.search(r"(?:CONFLICT.*?in\s+|conflict in\s+)(\S+)", line, re.IGNORECASE))
        }
    )

    if code == 124:
        return {"status": "unavailable", "reason": err.strip(), "command": f"git merge-tree --write-tree {left_head} {right_head}"}

    return {
        "status": "computed",
        "evidence_kind": "counterfactual_replay",
        "command": f"git merge-tree --write-tree {left_head} {right_head}",
        "exit_code": code,
        "auto_tree": tree,
        "textual_conflict_observed": bool(conflicts),
        "conflict_lines": conflicts,
        "conflicted_files": conflicted_files,
        "note": (
            "Counterfactual construction: the two PRs were merged into mainline sequentially, so this "
            "merge is not recorded history. It answers 'what would a direct three-way merge of the two "
            "branch heads produce', which is the scenario the study targets."
        ),
    }


def per_pr_replay(prs: tuple[int, int]) -> dict:
    rows = {row.get("pr_number"): row for row in read_jsonl(MERGE_REPLAY)}
    out = {}
    for pr in prs:
        row = rows.get(pr)
        if not row:
            out[str(pr)] = {"status": "unavailable", "reason": "no replay row for this PR"}
            continue
        out[str(pr)] = {
            "status": "computed",
            "evidence_kind": "recorded_history_replay",
            "merge_sha": row.get("merge_sha"),
            "auto_tree": row.get("auto_tree"),
            "actual_tree": row.get("actual_tree"),
            "tree_equal": row.get("tree_equal"),
            "conflict_lines": row.get("conflict_lines"),
            "replay_status": row.get("replay_status"),
        }
    return out


# --------------------------------------------------------------------------- #
# packet assembly
# --------------------------------------------------------------------------- #
def build_packet(candidate: dict, manifest: dict, window_days: int, merge_rows_by_pr: dict) -> dict:
    left_pr = candidate["left_pr"]
    right_pr = candidate["right_pr"]
    scenario_id = candidate["scenario_id"]

    left_row = merge_rows_by_pr.get(left_pr) or {}
    right_row = merge_rows_by_pr.get(right_pr) or {}

    left_patch = PACKETS_DIR.parent.parent / "candidate_patches" / f"pr-{left_pr}.patch"
    right_patch = PACKETS_DIR.parent.parent / "candidate_patches" / f"pr-{right_pr}.patch"

    manifest_status = {row["pr_number"]: row for row in manifest.get("records", [])}

    def load_patch(pr: int, path: Path) -> dict:
        record = manifest_status.get(pr, {})
        if record.get("status") != "downloaded":
            return {"files": [], "stats": {"files_changed": 0, "additions": 0, "deletions": 0, "hunks": 0}}
        if not path.exists():
            return {"files": [], "stats": {"files_changed": 0, "additions": 0, "deletions": 0, "hunks": 0}}
        text = path.read_text(encoding="utf-8", errors="replace")
        parsed = parse_patch(text)
        parsed["sha256_matches_manifest"] = (
            sha256_file(path) == record.get("sha256") if record.get("sha256") else None
        )
        return parsed

    left_info = load_patch(left_pr, left_patch)
    right_info = load_patch(right_pr, right_patch)

    left_set = build_change_set("A", left_pr, left_info, left_patch)
    right_set = build_change_set("B", right_pr, right_info, right_patch)

    files_a = left_set["changed_paths"]
    files_b = right_set["changed_paths"]
    shared_files = sorted(set(files_a) & set(files_b))
    shared_production = [p for p in shared_files if p.startswith(PRODUCTION_PREFIXES)]

    symbols_a = {row["symbol"] for row in left_set["touched_symbols"]}
    symbols_b = {row["symbol"] for row in right_set["touched_symbols"]}
    shared_symbols = sorted(symbols_a & symbols_b)

    if shared_files and shared_symbols:
        overlap_scope = "file_and_symbol"
    elif shared_files:
        overlap_scope = "file_only"
    else:
        overlap_scope = "none"

    left_context = load_context(left_pr)
    right_context = load_context(right_pr)

    merge_base_code, merge_base_out, merge_base_err = git(
        "merge-base", left_row.get("second_parent", ""), right_row.get("second_parent", "")
    )
    merge_base = merge_base_out.strip() if merge_base_code == 0 and merge_base_out.strip() else None
    base_desc = None
    if merge_base:
        _, subject_out, _ = git("show", "-s", "--format=%s", merge_base)
        base_desc = subject_out.strip() or None

    left_time = parse_utc(left_row.get("merge_time_utc", ""))
    right_time = parse_utc(right_row.get("merge_time_utc", ""))
    if left_time and right_time:
        later_time = max(left_time, right_time)
        later_pr = left_pr if left_time >= right_time else right_pr
    else:
        later_time = None
        later_pr = None

    pair_merge = counterfactual_pair_merge(
        left_row.get("second_parent", ""), right_row.get("second_parent", "")
    )

    data_status = "real_public_git_metadata_plus_public_patch"
    if left_context["status"] == "available" and right_context["status"] == "available":
        data_status += "_plus_public_pr_context"

    repair_history = build_repair_history(window_days, files_a, files_b, later_time)
    repeated_touch = build_repeated_touch_evidence(left_set, right_set, repair_history)

    return {
        "packet_version": PACKET_VERSION,
        "scenario_id": scenario_id,
        "provenance": {            "repository": manifest.get("repository", "pallets/flask"),
            "data_status": data_status,
            "license_note": (
                "Flask reports BSD-3-Clause. PR bodies, comments and patches are upstream-authored "
                "public content; verify LICENSE before redistribution."
            ),
            "generator": {"script": "build_annotation_packets.py", "version": BUILDER_VERSION},
            "sources": [
                "temporal_candidates.jsonl (commit-graph screening)",
                "candidate_patch_manifest.json (patch SHA-256 pins)",
                "merge_rows.jsonl (local commit graph)",
                "merge_replay.jsonl (recorded-history replay)",
                f"context_cache/pr-{left_pr}.json",
                f"context_cache/pr-{right_pr}.json",
            ],
            "screening_lineage": candidate.get("selection_note"),
            "ground_truth_absent": (
                "This packet contains no ACCD label values. Screening opinions and single-researcher "
                "adjudications were not read by the builder."
            ),
        },
        "prediction_view": {
            "view_instructions": (
                "Fill phase_1 using ONLY this object. Do not open result_view before phase_1 is locked."
            ),
            "baseline": {
                "merge_base_commit": merge_base,
                "merge_base_subject": base_desc,
                "source": "git merge-base of the two PR head commits",
                "command": f"git merge-base {left_row.get('second_parent')} {right_row.get('second_parent')}",
                "left_head_commit": left_row.get("second_parent"),
                "right_head_commit": right_row.get("second_parent"),
            },
            "tasks": {
                "A": build_task(left_pr, left_context, left_info, left_row),
                "B": build_task(right_pr, right_context, right_info, right_row),
            },
            "change_sets": {"A": left_set, "B": right_set},
            "shared_entities": {
                "files": shared_files,
                "production_files": shared_production,
                "symbols": shared_symbols,
                "overlap_scope": overlap_scope,
                "evidence_kind": "path_and_lexical_symbol_overlap_screening_signal",
                "guard": (
                    "File or symbol overlap is a screening signal only. It never implies RT/RI/CC/BC, "
                    "and it never implies LF (H9)."
                ),
            },
            "repeated_touch_evidence": repeated_touch,
            "temporal_context": {
                "left_pr_merge_time_utc": left_row.get("merge_time_utc"),
                "right_pr_merge_time_utc": right_row.get("merge_time_utc"),
                "left_pr_branch_start_utc": left_row.get("branch_start_utc"),
                "right_pr_branch_start_utc": right_row.get("branch_start_utc"),
                "temporal_overlap": candidate.get("temporal_overlap"),
                "later_merged_pr": later_pr,
                "screening_definition_of_overlap": (
                    "Temporal overlap means the two PR branch lifecycles overlapped in the commit "
                    "graph; it does not mean the two tasks were concurrent agent tasks."
                ),
            },
            "agent_context_summary": {
                "status": "unavailable",
                "reason": (
                    "These are human-authored PRs. There is no agent, prompt, retry, tool log or "
                    "failure trace. Treat agent attribution as undecidable in this pilot."
                ),
                "evidence_kind": "not_collected",
            },
            "pre_change_test_state": {
                "status": "not_executed",
                "reason": (
                    "The local clone is a partial clone and the pilot environment does not install "
                    "Flask test dependencies; pre-change test results were not executed offline."
                ),
                "available_proxy": "Upstream CI status is not captured in the cached context payloads.",
            },
        },
        "result_view": {
            "view_instructions": (
                "Only open after phase_1.locked_at is set. Record revisions in phase_2; never edit phase_1."
            ),
            "integration_outcome": {
                "status": "computed",
                "evidence_kind": "recorded_history",
                "both_merges_landed_on_mainline": bool(left_row) and bool(right_row),
                "left_merge_sha": left_row.get("merge_sha"),
                "right_merge_sha": right_row.get("merge_sha"),
                "merges_were_sequential_on_mainline": True,
                "note": (
                    "Both PRs were merged to mainline as separate events, so the recorded integration "
                    "outcome is 'both landed', not a single joint merge."
                ),
            },
            "counterfactual_pair_merge": pair_merge,
            "per_pr_merge_replay": per_pr_replay((left_pr, right_pr)),
            "post_integration_tests": {
                "status": "not_executed",
                "reason": (
                    "No offline run of the merged tree was performed. Absence of test results is "
                    "'unmeasured', not 'passed'."
                ),
                "consequence_for_labels": (
                    "AC guide: BC may only be `uncertain` without test or subsequent-repair evidence."
                ),
            },
            "repair_or_revert_history": repair_history,
        },
        "label_ontology": {
            "labels": list(LABELS),
            "allowed_values": {
                "default": ["yes", "no", "uncertain", None],
                "ID": ["yes", "no", "possible_ID", "uncertain", None],
            },
            "manual": "annotation/annotation_manual.md",
            "preregistration": "annotation/preregistration.md",
        },
        "packet_integrity": {
            "deterministic": True,
            "contains_no_labels": True,
            "patch_sha256_matches_manifest": {
                "A": left_info.get("sha256_matches_manifest"),
                "B": right_info.get("sha256_matches_manifest"),
            },
        },
    }


# --------------------------------------------------------------------------- #
# blank annotation sheets
# --------------------------------------------------------------------------- #
def blank_label(label: str) -> dict:
    row = {"value": None, "confidence": None, "evidence": [], "notes": ""}
    if label == "RT":
        row["overlap_ratio"] = None
    return row


def blank_cost() -> dict:
    return {
        "extra_modified_lines": None,
        "extra_human_minutes": None,
        "extra_test_rounds": None,
        "reverts": None,
        "delay_days": None,
        "notes": "",
    }


def blank_annotator() -> dict:
    return {label: blank_label(label) for label in LABELS}


def build_blank_record(scenario_id: str, packet_rel: str, packet_sha: str) -> dict:
    return {
        "record_version": "1.0",
        "scenario_id": scenario_id,
        "packet_path": packet_rel,
        "packet_sha256": packet_sha,
        "annotation_status": "awaiting_two_independent_annotators",
        "manual_version": "annotation_manual.md v1.1",
        "preregistration": "annotation/preregistration.md",
        "phase_1": {
            "view": "prediction_view",
            "locked_at": None,
            "annotator_A": blank_annotator(),
            "annotator_B": blank_annotator(),
        },
        "phase_2": {
            "view": "result_view",
            "annotator_A": blank_annotator(),
            "annotator_B": blank_annotator(),
            "cost_evidence": {"annotator_A": blank_cost(), "annotator_B": blank_cost()},
        },
        "adjudication": {"status": "not_started", "third_annotator": None, "decisions": []},
    }


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--window-days", type=int, default=DEFAULT_WINDOW_DAYS, help="follow-up history window")
    parser.add_argument("--skip-git", action="store_true", help="skip git-derived evidence (offline smoke test)")
    args = parser.parse_args()

    if not CANDIDATES.exists():
        print(json.dumps({"error": f"missing {CANDIDATES}"}, ensure_ascii=False))
        return 1

    PACKETS_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    candidates = read_jsonl(CANDIDATES)
    manifest = json.loads(PATCH_MANIFEST.read_text(encoding="utf-8")) if PATCH_MANIFEST.exists() else {}
    merge_rows_by_pr = {row.get("pr_number"): row for row in read_jsonl(MERGE_ROWS)}

    index_entries = []
    records = []

    for candidate in candidates:
        packet = build_packet(candidate, manifest, args.window_days, merge_rows_by_pr)
        if args.skip_git:
            packet["result_view"]["counterfactual_pair_merge"] = {"status": "skipped", "reason": "--skip-git"}
            packet["prediction_view"]["baseline"]["merge_base_commit"] = None
        payload = json.dumps(packet, ensure_ascii=False, indent=2) + "\n"
        packet_path = PACKETS_DIR / f"{candidate['scenario_id']}.json"
        # Write bytes, not text: text mode would translate \n to \r\n on Windows and
        # break the SHA-256 pin that annotation sheets freeze against.
        packet_path.write_bytes(payload.encode("utf-8"))
        digest = sha256_bytes(payload.encode("utf-8"))
        rel = f"annotation/packets/{packet_path.name}"

        index_entries.append(
            {
                "scenario_id": candidate["scenario_id"],
                "packet_path": rel,
                "packet_sha256": digest,
                "left_pr": candidate["left_pr"],
                "right_pr": candidate["right_pr"],
                "shared_files": candidate.get("shared_files") or [],
                "counterfactual_merge_status": packet["result_view"]["counterfactual_pair_merge"].get("status"),
                "textual_conflict_observed": packet["result_view"]["counterfactual_pair_merge"].get(
                    "textual_conflict_observed"
                ),
                "repair_history_entries": packet["result_view"]["repair_or_revert_history"].get("entry_count"),
            }
        )
        records.append(build_blank_record(candidate["scenario_id"], rel, digest))

    index = {
        "packet_version": PACKET_VERSION,
        "builder_version": BUILDER_VERSION,
        "built_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "follow_up_window_days": args.window_days,
        "scenarios": len(index_entries),
        "contains_labels": False,
        "packets": index_entries,
    }
    (PACKETS_DIR / "index.json").write_bytes(
        (json.dumps(index, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    )

    labels_path = OUT_DIR / "labels_v1.blank.jsonl"
    labels_path.write_bytes(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records).encode("utf-8")
    )

    print(
        json.dumps(
            {
                "scenarios": len(index_entries),
                "packets_dir": str(PACKETS_DIR),
                "blank_labels": str(labels_path),
                "textual_conflicts_found": sum(1 for row in index_entries if row["textual_conflict_observed"]),
                "counterfactual_status": sorted({row["counterfactual_merge_status"] for row in index_entries}),
                "status": "packets_built_no_labels",
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
