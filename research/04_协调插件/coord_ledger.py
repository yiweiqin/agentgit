"""Coordinator ledger: the observation channel for the velocity-reconciliation framework.

Why this exists
---------------
`01_问题定义与定位/痛点_速度与上下文失配.md` §10 established, by measurement, that the
failure state (lambda > R, i.e. a growing backlog of unreconciled changes) is
**structurally invisible to Git history**: a change that was never reconciled is, by
definition, not in the commit graph. Every existing benchmark asset in this repository
can therefore only observe the healthy baseline.

This module is the missing observation channel. It is the passive half of the
coordination plugin: hooks call `record`, and `report` derives the framework's
quantities from what was recorded. It performs no governance and mutates no repository
state, so that baseline (no treatment) and treatment conditions can be measured with the
same instrument.

Relation to ISCC v0.1
---------------------
Capsules are NOT re-invented here. The capsule contract is
`03_基准与标注/benchmark/iscc-v0.1/iscc.schema.json`, and this module's derived capsule
view uses its `lifecycle.state` vocabulary verbatim:

    proposed -> active -> validated -> integrated
                       \\-> stale / abandoned

Two deliberate deviations, both recorded rather than hidden:

1.  The ledger is an **append-only event stream**, and capsules are *derived* from it.
    ISCC capsules are snapshots; a snapshot cannot express "this was true at time t",
    which is required to reconstruct B(t) as a function of time.
2.  The event kind `context_compacted` does **not** exist in the ISCC v0.1 enum
    (`task_registered | file_read | file_write | command | test | review | decision`).
    It is added here because context compaction is the concrete, timestamped moment at
    which a session's memory is truncated -- the mechanism the current framework is
    built on. ISCC v0.1 therefore cannot record its own framework's root cause; this is
    a required v0.2 change, not a workaround. See `README.md`.

Stdlib only, on purpose: hooks must not depend on an installed package, and the hook
authoring guidance explicitly warns against assuming that helper binaries exist.

Usage
-----
Record from a hook (hook JSON arrives on stdin, CLI flags act as overrides):

    python coord_ledger.py record --ledger .coord-ledger \
        --event context_compacted --session "$CODEX_SESSION_ID"

Derive the framework's quantities:

    python coord_ledger.py report --ledger .coord-ledger
    python coord_ledger.py report --ledger .coord-ledger --json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA_VERSION = "coord-ledger-0.1"
LEDGER_FILENAME = "events.jsonl"

# ISCC v0.1 provenance event kinds, verbatim from iscc.schema.json.
ISCC_EVENT_KINDS = frozenset(
    {"task_registered", "file_read", "file_write", "command", "test", "review", "decision"}
)

# Coordination-specific events. `context_compacted` is NOT in ISCC v0.1 and is the
# reason a v0.2 extension is required; see the module docstring.
COORD_EVENT_KINDS = frozenset(
    {
        "session_started",
        "session_ended",
        "context_compacted",
        "lifecycle_validated",
        "lifecycle_integrated",
        "lifecycle_stale",
        "lifecycle_abandoned",
    }
)

EVENT_KINDS = ISCC_EVENT_KINDS | COORD_EVENT_KINDS

# ISCC v0.1 lifecycle.state vocabulary, verbatim.
OPEN_STATES = frozenset({"proposed", "active", "validated"})
CLOSED_STATES = frozenset({"integrated", "stale", "abandoned"})

# The backlog B(t) is exactly the open set: work that is registered but not yet
# reconciled. `stale` and `abandoned` are deliberately NOT backlog -- they are closed.
# They are still a cost, but a realised one, so they are reported separately as decay;
# mixing the two would let a wave of abandonments masquerade as a shrinking backlog.
UNRECONCILED_STATES = OPEN_STATES
DECAYED_STATES = frozenset({"stale", "abandoned"})

# Below this span, events written back-to-back make a rate meaningless (a handful of
# events a second apart would imply thousands per hour). Rates are withheld instead of
# reported, because a bogus lambda would be indistinguishable from a real spike.
MIN_RATE_WINDOW_HOURS = 1.0 / 60.0

# Events that carry entity scope. Used for contention and unattributed analysis.
ENTITY_EVENTS = frozenset({"file_write", "file_read"})


class LedgerError(Exception):
    """Raised for caller-visible problems (bad event kind, malformed ledger)."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_ts(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise LedgerError(f"invalid timestamp: {value!r}") from exc


def ledger_path(ledger_dir: str | os.PathLike[str]) -> Path:
    return Path(ledger_dir) / LEDGER_FILENAME


def normalise_path(path: str) -> str:
    """Normalise a repo-relative path so contention is not defeated by spelling.

    Deliberately conservative: only separators and a leading `./` are normalised.
    Case folding is NOT applied, because doing so would silently merge distinct files
    on case-sensitive filesystems and inflate contention counts.
    """
    cleaned = path.strip().replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return cleaned


def normalise_entity(raw: object) -> dict | None:
    """Accept either a plain path string or an ISCC-style entity object."""
    if isinstance(raw, str) and raw.strip():
        return {"kind": "file", "identifier": raw.strip(), "path": normalise_path(raw)}
    if isinstance(raw, dict):
        ident = raw.get("identifier") or raw.get("path")
        path = raw.get("path") or ident
        if isinstance(path, str) and path.strip():
            return {
                "kind": raw.get("kind") or "file",
                "identifier": str(ident).strip() if ident else normalise_path(path),
                "path": normalise_path(path),
            }
    return None


def entity_key(entity: dict) -> str:
    """Symbol-level key when available, else path-level.

    Symbol level matters: the framework's central claim is about repeated touching of
    the *same* semantic target, which path-level counting cannot distinguish from two
    unrelated edits in one file.
    """
    if entity.get("kind") and entity["kind"] != "file":
        return f"{entity['kind']}::{entity.get('identifier') or entity['path']}"
    return f"file::{entity['path']}"


def read_hook_input(stream) -> dict:
    """Read hook JSON from stdin, tolerating an empty or non-JSON stream."""
    if stream is None:
        return {}
    try:
        raw = stream.read()
    except (OSError, ValueError):
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def build_event(
    *,
    kind: str,
    session_id: str,
    developer: str | None,
    task_id: str | None,
    entities: list[dict],
    reason: str | None,
    hook_input: dict,
    now: datetime,
) -> dict:
    if kind not in EVENT_KINDS:
        raise LedgerError(
            f"unknown event kind: {kind!r}; expected one of {sorted(EVENT_KINDS)}"
        )
    if not session_id:
        raise LedgerError("session_id is required: without it, provenance cannot be reconstructed")

    event = {
        "schema_version": SCHEMA_VERSION,
        "event_id": "",
        "kind": kind,
        "timestamp_utc": iso(now),
        "session_id": session_id,
        "developer": developer or None,
        "task_id": task_id or None,
        "entities": entities,
        # `hook_event_name` is passed through verbatim when present, so the record can be
        # traced back to the host event that produced it rather than to our own naming.
        "host_event": hook_input.get("hook_event_name"),
    }
    if reason:
        event["reason"] = reason
    digest_src = json.dumps(
        {k: v for k, v in event.items() if k != "event_id"}, sort_keys=True, ensure_ascii=False
    )
    event["event_id"] = "evt-" + hashlib.sha256(digest_src.encode("utf-8")).hexdigest()[:24]
    return event


def append_event(ledger_dir: str | os.PathLike[str], event: dict) -> Path:
    directory = Path(ledger_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = ledger_path(directory)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    return path


def load_events(ledger_dir: str | os.PathLike[str]) -> list[dict]:
    path = ledger_path(ledger_dir)
    if not path.exists():
        return []
    events: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LedgerError(f"{path}:{lineno}: malformed JSON") from exc
        if not isinstance(record, dict):
            raise LedgerError(f"{path}:{lineno}: expected a JSON object")
        events.append(record)
    events.sort(key=lambda e: (e.get("timestamp_utc", ""), e.get("event_id", "")))
    return events


LIFECYCLE_TRANSITIONS = {
    "lifecycle_validated": "validated",
    "lifecycle_integrated": "integrated",
    "lifecycle_stale": "stale",
    "lifecycle_abandoned": "abandoned",
}


def build_capsules(events: list[dict]) -> dict[str, dict]:
    """Fold the event stream into one capsule per task_id.

    `task_registered` opens a capsule; lifecycle events advance its state. Entities and
    sessions accumulate, because the framework needs "who else touched this" and
    "under how many sessions", not just the latest values.
    """
    capsules: dict[str, dict] = {}
    for event in events:
        kind = event.get("kind")
        task_id = event.get("task_id")
        if not task_id:
            continue
        capsule = capsules.setdefault(
            task_id,
            {
                "task_id": task_id,
                "state": "proposed",
                "opened_at_utc": event.get("timestamp_utc"),
                "closed_at_utc": None,
                "sessions": [],
                "developers": [],
                "entities": {},
                "n_events": 0,
                "n_compact_events": 0,
                "writes_after_compact": 0,
            },
        )
        capsule["n_events"] += 1
        session = event.get("session_id")
        if session and session not in capsule["sessions"]:
            capsule["sessions"].append(session)
        developer = event.get("developer")
        if developer and developer not in capsule["developers"]:
            capsule["developers"].append(developer)

        if kind == "context_compacted":
            capsule["n_compact_events"] += 1

        if kind in ENTITY_EVENTS:
            for entity in event.get("entities") or []:
                key = entity_key(entity)
                record = capsule["entities"].setdefault(
                    key,
                    {
                        "kind": entity.get("kind", "file"),
                        "identifier": entity.get("identifier"),
                        "path": entity.get("path"),
                        "touches": 0,
                        "sessions": [],
                    },
                )
                record["touches"] += 1
                if session and session not in record["sessions"]:
                    record["sessions"].append(session)
                # Writes that happen after this session already compacted are precisely
                # the changes produced under degraded context.
                if kind == "file_write" and capsule["n_compact_events"] > 0:
                    capsule["writes_after_compact"] += 1

        new_state = LIFECYCLE_TRANSITIONS.get(kind)
        if new_state:
            capsule["state"] = new_state
            if new_state in CLOSED_STATES and capsule["closed_at_utc"] is None:
                capsule["closed_at_utc"] = event.get("timestamp_utc")

    for capsule in capsules.values():
        capsule["n_entities"] = len(capsule["entities"])
        capsule["n_sessions"] = len(capsule["sessions"])
        capsule["n_developers"] = len(capsule["developers"])
        capsule["is_open"] = capsule["state"] in OPEN_STATES
    return capsules


def build_contention(capsules: dict[str, dict]) -> list[dict]:
    """Entities touched by more than one session or more than one task.

    This is the cross-session blind spot made visible: any single session can only see
    its own touches. Multi-task contention is the ground truth for redundant
    implementation; multi-session contention is the ground truth for loss of
    attributable intent.
    """
    by_entity: dict[str, dict] = {}
    for capsule in capsules.values():
        for key, record in capsule["entities"].items():
            entry = by_entity.setdefault(
                key,
                {
                    "entity_key": key,
                    "kind": record["kind"],
                    "identifier": record["identifier"],
                    "path": record["path"],
                    "tasks": [],
                    "sessions": [],
                    "touches": 0,
                },
            )
            if capsule["task_id"] not in entry["tasks"]:
                entry["tasks"].append(capsule["task_id"])
            for session in record["sessions"]:
                if session not in entry["sessions"]:
                    entry["sessions"].append(session)
            entry["touches"] += record["touches"]

    contested = [e for e in by_entity.values() if len(e["tasks"]) > 1 or len(e["sessions"]) > 1]
    contested.sort(key=lambda e: (-len(e["tasks"]), -len(e["sessions"]), -e["touches"], e["entity_key"]))
    return contested


def backlog_series(capsules: dict[str, dict], events: list[dict], now: datetime | None = None) -> list[dict]:
    """Reconstruct B(t): open capsules as a function of time.

    B(t) is the framework's central quantity and the one Git history cannot supply. It is
    computed by replaying open/close events, so it is exact with respect to the ledger
    rather than sampled.
    """
    timeline: list[tuple[str, str]] = []
    for capsule in capsules.values():
        if capsule["opened_at_utc"]:
            timeline.append((capsule["opened_at_utc"], "open"))
        if capsule["closed_at_utc"]:
            timeline.append((capsule["closed_at_utc"], "close"))
    if not timeline:
        return []
    timeline.sort()

    series: list[dict] = []
    open_count = 0
    for ts, action in timeline:
        open_count += 1 if action == "open" else -1
        open_count = max(0, open_count)
        series.append({"timestamp_utc": ts, "open_capsules": open_count})
    return series


def rates(capsules: dict[str, dict], events: list[dict]) -> dict:
    """lambda_produced and the integration rate, over the observed wall-clock span.

    Both are per hour. `lambda_produced` is the number the framework needs and the one
    absent from every existing asset; `lambda_merged` (see estimate_lambda_R.py) is its
    lower bound, because it counts only what reached the mainline.

    Rates are withheld when the observed span is too short to be meaningful, so that a
    burst of back-to-back events cannot be reported as an enormous arrival rate.
    """
    stamps = [parse_ts(e["timestamp_utc"]) for e in events if e.get("timestamp_utc")]
    result = {
        "observed_hours": 0.0,
        "lambda_produced_per_hour": None,
        "integration_rate_per_hour": None,
        "rate_is_meaningful": False,
    }
    if not stamps:
        return result
    span_hours = max((max(stamps) - min(stamps)).total_seconds() / 3600.0, 0.0)
    result["observed_hours"] = span_hours
    if span_hours < MIN_RATE_WINDOW_HOURS:
        result["withheld_reason"] = (
            f"observed span {span_hours * 3600:.1f}s is below the "
            f"{MIN_RATE_WINDOW_HOURS * 3600:.0f}s floor; rates withheld because a burst of "
            "back-to-back events would imply a meaningless arrival rate"
        )
        return result
    result["rate_is_meaningful"] = True
    integrated = sum(1 for c in capsules.values() if c["state"] == "integrated")
    result["lambda_produced_per_hour"] = len(capsules) / span_hours
    result["integration_rate_per_hour"] = integrated / span_hours
    return result


def compute_report(ledger_dir: str | os.PathLike[str], now: datetime | None = None) -> dict:
    events = load_events(ledger_dir)
    capsules = build_capsules(events)
    contention = build_contention(capsules)
    series = backlog_series(capsules, events, now=now)
    rate_info = rates(capsules, events)

    open_capsules = [c for c in capsules.values() if c["is_open"]]
    unresolved = [c for c in capsules.values() if c["state"] in UNRECONCILED_STATES]
    decayed = [c for c in capsules.values() if c["state"] in DECAYED_STATES]
    compact_sessions = sorted(
        {e["session_id"] for e in events if e.get("kind") == "context_compacted" and e.get("session_id")}
    )

    return {
        "schema_version": SCHEMA_VERSION,
        "ledger": str(ledger_path(ledger_dir)),
        "status": "instrumentation_only_no_governance_applied",
        "counts": {
            "events": len(events),
            "capsules": len(capsules),
            "open_capsules": len(open_capsules),
            # Equal to open_capsules by definition; kept as a named field because
            # "unreconciled" is the term the framework's propositions are stated in.
            "unreconciled_capsules": len(unresolved),
            "integrated_capsules": sum(1 for c in capsules.values() if c["state"] == "integrated"),
            "decayed_capsules": len(decayed),
            "contested_entities": len(contention),
            "sessions_with_context_loss": len(compact_sessions),
        },
        "rates": rate_info,
        # The headline quantity of the framework. It must be reported alongside
        # effective parallelism to satisfy H5; that metric is not yet instrumented.
        "backlog_now": {
            "open_capsules": len(open_capsules),
            "note": (
                "B(t) as reconstructed from the ledger. This is the quantity Git history "
                "cannot supply. Report together with effective parallelism, otherwise an "
                "improvement bought by reducing lambda is indistinguishable from governance."
            ),
        },
        "backlog_series": series,
        "state_histogram": _histogram(c["state"] for c in capsules.values()),
        "top_contested_entities": contention[:20],
        "writes_after_context_loss": sum(c["writes_after_compact"] for c in capsules.values()),
        "interpretation_guards": [
            "This ledger observes the PRODUCED change stream, which is the point: it sees "
            "changes that never reached the mainline and are therefore absent from git log.",
            "Recording is passive. Do not compare a ledger produced with governance enabled "
            "against one produced without; enable governance only after the baseline window.",
            "The mere presence of the recorder can alter behaviour (observation effect). Any "
            "claimed treatment effect must be checked against a run where recording was on "
            "but governance was off.",
            "contested_entities counts session/task overlap, which is a screening signal, not "
            "evidence of semantic interference. Overlap alone must never be labelled as a "
            "coordination failure (consistent with hard constraint H9).",
            "context_compacted is not an ISCC v0.1 event kind. Until iscc-0.2 defines it, "
            "these records are a ledger extension and must be declared as such in any writeup.",
        ],
    }


def _histogram(values) -> dict:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return dict(sorted(counts.items()))


def cmd_record(args: argparse.Namespace) -> int:
    hook_input = read_hook_input(sys.stdin)
    kind = args.event or hook_input.get("hook_event_name") or ""

    entities: list[dict] = []
    for raw in args.entity or []:
        entity = normalise_entity(raw)
        if entity:
            entities.append(entity)
    for raw in hook_input.get("entities") or []:
        entity = normalise_entity(raw)
        if entity and entity not in entities:
            entities.append(entity)

    # Common host field spellings, checked in order so a host rename degrades loudly
    # (missing session_id raises) rather than silently attributing to the wrong session.
    session_id = (
        args.session
        or hook_input.get("session_id")
        or hook_input.get("codex_session_id")
        or ""
    )
    developer = args.developer or hook_input.get("developer") or os.environ.get("USERNAME")

    try:
        event = build_event(
            kind=kind,
            session_id=str(session_id),
            developer=developer,
            task_id=args.task or hook_input.get("task_id"),
            entities=entities,
            reason=args.reason or hook_input.get("reason"),
            hook_input=hook_input,
            now=utc_now(),
        )
    except LedgerError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1

    path = append_event(args.ledger, event)
    print(
        json.dumps(
            {"status": "recorded", "event_id": event["event_id"], "kind": event["kind"], "ledger": str(path)},
            ensure_ascii=False,
        )
    )
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    try:
        report = compute_report(args.ledger)
    except LedgerError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False))
        return 1

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    counts = report["counts"]
    print(f"ledger            : {report['ledger']}")
    print(f"capsules (tasks)  : {counts['capsules']}")
    print(f"open (= backlog)  : {counts['open_capsules']}")
    print(f"integrated        : {counts['integrated_capsules']}")
    print(f"decayed (stale/abandoned): {counts['decayed_capsules']}")
    span = report["rates"]["observed_hours"]
    if report["rates"]["rate_is_meaningful"]:
        print(f"lambda_produced/h : {report['rates']['lambda_produced_per_hour']:.3f}")
        print(f"integration_rate/h: {report['rates']['integration_rate_per_hour']:.3f}")
        print(f"observed_hours    : {span:.3f}")
    else:
        print(f"rates             : withheld ({report['rates'].get('withheld_reason', 'no events')})")
    print(f"contested entities: {counts['contested_entities']}")
    print(f"writes after context loss: {report['writes_after_context_loss']}")
    print(f"state histogram   : {report['state_histogram']}")
    if report["top_contested_entities"]:
        print("top contested entities:")
        for entry in report["top_contested_entities"][:10]:
            print(
                f"  {entry['entity_key']}: tasks={len(entry['tasks'])} "
                f"sessions={len(entry['sessions'])} touches={entry['touches']}"
            )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    record = sub.add_parser("record", help="append one event (called by hooks)")
    record.add_argument("--ledger", required=True, help="ledger directory, e.g. .coord-ledger")
    record.add_argument("--event", default=None, help=f"event kind; one of {sorted(EVENT_KINDS)}")
    record.add_argument("--session", default=None, help="session identifier (required, from host)")
    record.add_argument("--developer", default=None)
    record.add_argument("--task", default=None, help="task identifier; groups events into a capsule")
    record.add_argument("--entity", action="append", default=[], help="entity path, repeatable")
    record.add_argument("--reason", default=None)
    record.set_defaults(func=cmd_record)

    report = sub.add_parser("report", help="derive lambda, R, B(t) and contention")
    report.add_argument("--ledger", required=True)
    report.add_argument("--json", action="store_true")
    report.set_defaults(func=cmd_report)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
