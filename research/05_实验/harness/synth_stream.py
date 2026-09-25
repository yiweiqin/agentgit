"""Generate a synthetic event stream whose framework quantities are known by construction.

Why this exists
---------------
E0 must validate the instrument *against ground truth*, not only against itself. If
`coord_ledger.py` and the TypeScript plugin agree but both are wrong, a cross-check
alone would happily report success. So the scenario is planned first, the expected
`lambda_produced`, `B(t)`, contention set and `writes_after_compact` are recorded from
that plan, and only then is the stream serialised and handed to the analyzers.

The plan is the authority. Nothing here is derived by running an analyzer.

Two deliberate properties:

1.  Events are emitted through `coord_ledger.build_event`, so the bytes are exactly what
    the Python instrument would write for the same facts. A hand-rolled serialiser
    would test the serialiser, not the instrument.
2.  Timestamps are minute-aligned and therefore unique, except in the tie scenario.
    Ground truth for `B(t)` is then unambiguous, and the tie-break rule is exercised
    separately instead of being smuggled into every comparison.

Usage
-----
    python synth_stream.py --out-dir <dir> --scenario clean
    python synth_stream.py --out-dir <dir> --scenario ties
    python synth_stream.py --out-dir <dir> --scenario kinds
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

# The analysis-side instrument lives in the sibling research directory. Imported
# rather than reimplemented so this generator cannot drift from it.
_MODULE_DIR = Path(__file__).resolve().parents[2] / "04_协调插件"
if str(_MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(_MODULE_DIR))

from coord_ledger import (  # noqa: E402
    CLOSED_STATES,
    OPEN_STATES,
    append_event,
    build_event,
    iso,
    ledger_path,
    normalise_path,
)

T0 = datetime(2026, 3, 1, 0, 0, 0, tzinfo=timezone.utc)

# Python's `build_capsules` counts a `file_read` as an entity touch; the TypeScript
# plugin deliberately does not, because a read is not a conflict. The generator can
# produce reads so the divergence is *measured* rather than assumed inert.
ENTITY_KINDS = ("file_write", "file_read")


@dataclass
class PlannedEvent:
    """One event as intended, before it becomes a ledger row."""

    minute: int
    kind: str
    session: str
    task: str | None
    paths: list[str] = field(default_factory=list)
    developer: str | None = "dev-a"
    reason: str | None = None


@dataclass
class Scenario:
    """A planned stream plus the quantities it is constructed to have."""

    name: str
    events: list[PlannedEvent]
    truth: dict


def _entity(path: str) -> dict:
    return {"kind": "file", "identifier": path, "path": normalise_path(path)}


def _plan_clean(
    *,
    n_tasks: int = 8,
    n_sessions: int = 3,
    n_shared: int = 3,
    n_private: int = 4,
    compacted_tasks: int = 3,
    writes_after_compaction: int = 2,
    span_minutes: int = 480,
    include_reads: bool = False,
) -> Scenario:
    """A stream with exact, easily stated ground truth.

    Construction rules, each chosen so the expected value is arithmetic rather than
    an opinion:

    - every task is opened by a `task_registered` and gets one private file
    - every shared file is written by exactly two *distinct* tasks
    - the first ``compacted_tasks`` tasks are compacted once, then written again
      ``writes_after_compaction`` times: that is exactly the `writes_after_compact`
      total
    - task 0 integrated, task 1 validated (stays open), task 2 stale, the rest open
    """
    events: list[PlannedEvent] = []
    shared = [f"pkg/core/s{k}.py" for k in range(n_shared)]

    session_of = {f"T{i + 1}": f"s{(i % n_sessions) + 1}" for i in range(n_tasks)}
    sessions = sorted(set(session_of.values()))

    # Session bookkeeping is emitted with no task id, so it must form no capsule in
    # either analyzer while still counting toward the observed window.
    for index, session in enumerate(sessions):
        events.append(PlannedEvent(minute=index, kind="session_started", session=session, task=None))

    open_minute: dict[str, int] = {}
    for i in range(n_tasks):
        task = f"T{i + 1}"
        session = session_of[task]
        start = 10 + i * 15
        open_minute[task] = start
        events.append(PlannedEvent(minute=start, kind="task_registered", session=session, task=task))
        for j in range(n_private):
            events.append(
                PlannedEvent(
                    minute=start + 1 + j,
                    kind="file_write",
                    session=session,
                    task=task,
                    paths=[f"pkg/mod{i + 1}/f{j + 1}.py"],
                )
            )

    # Contention by construction: each shared file has exactly two distinct task writers.
    for k, path in enumerate(shared):
        writers = [f"T{((2 * k + n) % n_tasks) + 1}" for n in range(2)]
        for task in writers:
            events.append(
                PlannedEvent(
                    minute=open_minute[task] + 6,
                    kind="file_write",
                    session=session_of[task],
                    task=task,
                    paths=[path],
                )
            )

    compacted = [f"T{i + 1}" for i in range(min(compacted_tasks, n_tasks))]
    writes_after = 0
    for task in compacted:
        session = session_of[task]
        compact_minute = open_minute[task] + 8
        events.append(
            PlannedEvent(
                minute=compact_minute,
                kind="context_compacted",
                session=session,
                task=task,
                reason="context pressure crossed the compaction threshold",
            )
        )
        for n in range(writes_after_compaction):
            events.append(
                PlannedEvent(
                    minute=compact_minute + 1 + n,
                    kind="file_write",
                    session=session,
                    task=task,
                    paths=[f"pkg/mod{int(task[1:])}/after_compact_{n + 1}.py"],
                )
            )
            writes_after += 1

    if include_reads:
        # One read of a shared file, after both writers have touched it. Python counts
        # this as a third touch; the plugin does not. Used to measure the divergence.
        events.append(
            PlannedEvent(
                minute=span_minutes - 30,
                kind="file_read",
                session=sessions[-1],
                task=compacted[0] if compacted else "T1",
                paths=[shared[0]],
            )
        )

    events.append(PlannedEvent(minute=span_minutes - 20, kind="lifecycle_validated", session=session_of["T2"], task="T2"))
    events.append(PlannedEvent(minute=span_minutes - 10, kind="lifecycle_integrated", session=session_of["T1"], task="T1"))
    events.append(PlannedEvent(minute=span_minutes - 5, kind="lifecycle_stale", session=session_of["T3"], task="T3"))

    for index, session in enumerate(sessions):
        events.append(PlannedEvent(minute=span_minutes + index, kind="session_ended", session=session, task=None))

    events.sort(key=lambda e: (e.minute, e.kind, e.session, e.task or ""))

    # ------------------------------------------------------------------ truth
    closed_by: dict[str, int] = {"T1": span_minutes - 10, "T3": span_minutes - 5}
    state_of = {f"T{i + 1}": "proposed" for i in range(n_tasks)}
    state_of["T2"] = "validated"
    state_of["T1"] = "integrated"
    state_of["T3"] = "stale"

    timeline: list[tuple[int, int]] = []
    for task in state_of:
        timeline.append((open_minute[task], 1))
        if task in closed_by:
            timeline.append((closed_by[task], -1))
    timeline.sort(key=lambda pair: (pair[0], pair[1]))
    running = 0
    series = []
    for minute, delta in timeline:
        running = max(0, running + delta)
        series.append({"timestamp_utc": iso(T0 + timedelta(minutes=minute)), "open_capsules": running})

    span_hours = (max(e.minute for e in events) - min(e.minute for e in events)) / 60.0
    truth = {
        "scenario": "clean-with-reads" if include_reads else "clean",
        "counts": {
            "events": len(events),
            "capsules": n_tasks,
            "open_capsules": sum(1 for s in state_of.values() if s in OPEN_STATES),
            "unreconciled_capsules": sum(1 for s in state_of.values() if s in OPEN_STATES),
            "integrated_capsules": sum(1 for s in state_of.values() if s == "integrated"),
            "decayed_capsules": sum(1 for s in state_of.values() if s in CLOSED_STATES and s != "integrated"),
            "contested_entities": n_shared,
            "sessions_with_context_loss": len({session_of[t] for t in compacted}),
        },
        "rates": {
            "observed_hours": span_hours,
            "lambda_produced_per_hour": n_tasks / span_hours,
            "integration_rate_per_hour": 1 / span_hours,
            "rate_is_meaningful": span_hours >= (1.0 / 60.0),
        },
        "backlog_series": series,
        "writes_after_context_loss": writes_after,
        "contested_keys": sorted(f"file::{p}" for p in shared),
        "state_histogram": {state: list(state_of.values()).count(state) for state in set(state_of.values())},
        "note": (
            "Ground truth is the plan above, not the output of any analyzer. "
            "contested_entities counts shared files, each written by exactly two distinct tasks."
        ),
    }
    if include_reads:
        # The read of an already-contested file does not change *which* entities are
        # contested, only how many touches one of them shows. Declaring that keeps the
        # divergence from spreading unnoticed into the touch counts the governor uses
        # for ordering its advisories.
        truth["expected_divergences"] = [
            {
                "field": "top_contested_entities",
                "python": "touches=3 on the read file (write + write + read)",
                "typescript": "touches=2 on the read file (write + write)",
                "why": (
                    "coord_ledger.py counts file_read as an entity touch; the plugin does not. "
                    "counts.contested_entities is unaffected because the file was already "
                    "contested by two tasks."
                ),
            }
        ]
    return Scenario(name="clean-with-reads" if include_reads else "clean", events=events, truth=truth)


def _plan_ties() -> Scenario:
    """Same-minute events, to pin the canonical tie-break.

    The expected values here are deliberately *not* asserted against ground truth:
    which of two same-instant events counts as "after" is decided by the `event_id`
    hash, so only agreement between the two analyzers is meaningful. The cross-check
    therefore compares the analyzers to each other for this scenario.
    """
    events = [
        PlannedEvent(minute=0, kind="task_registered", session="s1", task="T1"),
        PlannedEvent(minute=5, kind="file_write", session="s1", task="T1", paths=["a.py"]),
        PlannedEvent(minute=10, kind="context_compacted", session="s1", task="T1"),
        PlannedEvent(minute=10, kind="file_write", session="s1", task="T1", paths=["b.py"]),
        PlannedEvent(minute=10, kind="file_write", session="s1", task="T1", paths=["c.py"]),
        PlannedEvent(minute=10, kind="lifecycle_integrated", session="s1", task="T1"),
        PlannedEvent(minute=10, kind="file_write", session="s2", task="T2", paths=["a.py"]),
        PlannedEvent(minute=10, kind="task_registered", session="s2", task="T2"),
    ]
    return Scenario(
        name="ties",
        events=events,
        truth={"scenario": "ties", "note": "tie-break scenario: analyzer-vs-analyzer only"},
    )


def _plan_kinds() -> Scenario:
    """A stream carrying kinds only one analyzer knows.

    `file_read` is counted as an entity touch by `coord_ledger.py` and ignored by the
    plugin. `write_settled` is the reverse: the plugin records it, Python has no
    constant for it. Both are emitted here so E0 can state the boundary of agreement
    as a measured number instead of a comment.
    """
    events = [
        PlannedEvent(minute=0, kind="task_registered", session="s1", task="T1"),
        PlannedEvent(minute=5, kind="file_write", session="s1", task="T1", paths=["a.py"]),
        PlannedEvent(minute=10, kind="file_read", session="s1", task="T1", paths=["a.py"]),
        PlannedEvent(minute=15, kind="file_read", session="s2", task="T2", paths=["a.py"]),
        PlannedEvent(minute=20, kind="task_registered", session="s2", task="T2"),
    ]
    return Scenario(
        name="kinds",
        events=events,
        truth={
            "scenario": "kinds",
            "expected_divergences": [
                {
                    "field": "counts.contested_entities",
                    "python": 1,
                    "typescript": 0,
                    "why": (
                        "coord_ledger.py counts file_read as an entity touch, so two sessions "
                        "reading one file is contention there. The plugin counts only writes, "
                        "because a read is not a conflict. Measured here so the boundary is a "
                        "number rather than a comment."
                    ),
                },
                {
                    "field": "top_contested_entities",
                    "python": "1 entry, touches=3",
                    "typescript": "0 entries",
                    "why": "Same cause as counts.contested_entities, at the detail level.",
                },
            ],
            "note": (
                "Kind-coverage scenario. Both analyzers know `file_read`; only Python treats it "
                "as a touch. `write_settled` is the mirror case and is not emitted here because "
                "Python's loader tolerates unknown kinds, so the divergence would be invisible."
            ),
        },
    )


def serialize(scenario: Scenario, out_dir: Path) -> Path:
    """Write the planned events as a real ledger, through the instrument's own builder."""
    ledger_dir = out_dir / scenario.name
    for planned in scenario.events:
        event = build_event(
            kind=planned.kind,
            session_id=planned.session,
            developer=planned.developer,
            task_id=planned.task,
            entities=[_entity(p) for p in planned.paths],
            reason=planned.reason,
            hook_input={},
            now=T0 + timedelta(minutes=planned.minute),
        )
        append_event(ledger_dir, event)
    (out_dir / f"truth.{scenario.name}.json").write_text(
        json.dumps(scenario.truth, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8"
    )
    return ledger_path(ledger_dir)


SCENARIOS = {
    "clean": lambda: _plan_clean(),
    "clean-with-reads": lambda: _plan_clean(include_reads=True),
    "ties": _plan_ties,
    "kinds": _plan_kinds,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--scenario", default="clean", choices=sorted(SCENARIOS))
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    scenario = SCENARIOS[args.scenario]()
    path = serialize(scenario, out_dir)
    print(json.dumps({"scenario": scenario.name, "ledger": str(path), "events": len(scenario.events)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
