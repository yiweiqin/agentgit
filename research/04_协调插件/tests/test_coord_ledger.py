"""Regression tests for the coordinator ledger instrument.

These tests protect the properties the framework's measurements depend on:

* the ledger must reject events it cannot attribute (a change with no session is not
  usable as evidence and must not be silently recorded);
* B(t) must be reconstructed exactly, because it is the quantity Git history cannot
  supply and therefore carries the paper's central empirical claim;
* symbol-level and path-level contention must stay distinguishable, so that repeated
  touching of one target is not conflated with unrelated edits in one file;
* the recorder must not lose the distinction between a change made before and after a
  session lost its context, since that distinction is the H3 (quality vs quantity) probe.

Run:  python -m unittest discover -s tests -v   (from `04_协调插件`)
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import coord_ledger as cl  # noqa: E402

T0 = datetime(2026, 9, 15, 10, 0, 0, tzinfo=timezone.utc)


def ev(kind: str, session: str, task: str | None, minutes: float, entities=None, developer="dev-a"):
    return cl.build_event(
        kind=kind,
        session_id=session,
        developer=developer,
        task_id=task,
        entities=[cl.normalise_entity(e) for e in (entities or []) if cl.normalise_entity(e)],
        reason=None,
        hook_input={"hook_event_name": kind},
        now=T0 + timedelta(minutes=minutes),
    )


class EventValidationTests(unittest.TestCase):
    def test_unknown_event_kind_is_rejected(self):
        with self.assertRaises(cl.LedgerError):
            ev("teleported", "s1", "t1", 0)

    def test_isec_and_coord_kinds_are_both_accepted(self):
        for kind in sorted(cl.ISCC_EVENT_KINDS | cl.COORD_EVENT_KINDS):
            with self.subTest(kind=kind):
                event = ev(kind, "s1", "t1", 0)
                self.assertEqual(event["kind"], kind)

    def test_missing_session_is_rejected(self):
        # Without a session id, provenance cannot be reconstructed, so the record is
        # worthless as evidence. Better to fail loudly than to write it.
        with self.assertRaises(cl.LedgerError):
            ev("file_write", "", "t1", 0)

    def test_event_id_is_stable_for_identical_payloads(self):
        a, b = ev("file_write", "s1", "t1", 0, ["app.py"]), ev("file_write", "s1", "t1", 0, ["app.py"])
        self.assertEqual(a["event_id"], b["event_id"])

    def test_event_id_changes_when_payload_changes(self):
        a = ev("file_write", "s1", "t1", 0, ["app.py"])
        b = ev("file_write", "s1", "t1", 0, ["other.py"])
        self.assertNotEqual(a["event_id"], b["event_id"])

    def test_context_compacted_is_not_in_iscc_v01(self):
        # Guards the documented gap: if this ever passes, iscc-0.2 landed and the
        # README note about the missing event kind must be updated.
        self.assertNotIn("context_compacted", cl.ISCC_EVENT_KINDS)


class EntityNormalisationTests(unittest.TestCase):
    def test_windows_separators_are_normalised(self):
        self.assertEqual(cl.normalise_entity("src\\app\\views.py")["path"], "src/app/views.py")

    def test_leading_dot_slash_is_stripped(self):
        self.assertEqual(cl.normalise_entity("./app.py")["path"], "app.py")

    def test_case_is_preserved_to_avoid_merging_distinct_files(self):
        a = cl.normalise_entity("App.py")["path"]
        b = cl.normalise_entity("app.py")["path"]
        self.assertNotEqual(a, b)

    def test_iscc_style_entity_object_is_accepted(self):
        entity = cl.normalise_entity({"kind": "function", "identifier": "index", "path": "flask/app.py"})
        self.assertEqual(cl.entity_key(entity), "function::index")

    def test_path_level_key_is_used_for_plain_files(self):
        entity = cl.normalise_entity("flask/app.py")
        self.assertEqual(cl.entity_key(entity), "file::flask/app.py")

    def test_symbol_and_path_keys_do_not_collide(self):
        sym = cl.entity_key(cl.normalise_entity({"kind": "function", "identifier": "app.py", "path": "app.py"}))
        path = cl.entity_key(cl.normalise_entity("app.py"))
        self.assertNotEqual(sym, path)


class CapsuleDerivationTests(unittest.TestCase):
    def test_capsule_opens_and_closes_on_lifecycle_events(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("lifecycle_integrated", "s1", "t1", 10),
        ]
        capsule = cl.build_capsules(events)["t1"]
        self.assertEqual(capsule["state"], "integrated")
        self.assertFalse(capsule["is_open"])
        self.assertIsNotNone(capsule["closed_at_utc"])

    def test_events_without_task_id_do_not_create_capsules(self):
        events = [ev("session_started", "s1", None, 0), ev("context_compacted", "s1", None, 1)]
        self.assertEqual(cl.build_capsules(events), {})

    def test_multiple_sessions_accumulate_on_one_capsule(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("file_write", "s2", "t1", 5, ["app.py"]),
        ]
        capsule = cl.build_capsules(events)["t1"]
        self.assertEqual(sorted(capsule["sessions"]), ["s1", "s2"])
        self.assertEqual(capsule["n_sessions"], 2)

    def test_first_close_wins_for_closed_at(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("lifecycle_abandoned", "s1", "t1", 5),
            ev("lifecycle_integrated", "s1", "t1", 50),
        ]
        capsule = cl.build_capsules(events)["t1"]
        self.assertEqual(capsule["state"], "integrated")
        # closed_at reflects the FIRST terminal transition, so capsule lifetime is not
        # silently extended by a later inconsistent event.
        self.assertEqual(capsule["closed_at_utc"], cl.iso(T0 + timedelta(minutes=5)))

    def test_writes_after_context_loss_are_counted_separately(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("file_write", "s1", "t1", 2, ["a.py"]),
            ev("context_compacted", "s1", "t1", 5),
            ev("file_write", "s1", "t1", 6, ["b.py"]),
            ev("file_write", "s1", "t1", 7, ["c.py"]),
        ]
        capsule = cl.build_capsules(events)["t1"]
        self.assertEqual(capsule["n_compact_events"], 1)
        # Only the two writes after compaction count: this is the H3 probe.
        self.assertEqual(capsule["writes_after_compact"], 2)

    def test_repeated_touches_on_one_entity_are_counted(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("file_write", "s1", "t1", 1, ["app.py"]),
            ev("file_write", "s1", "t1", 2, ["app.py"]),
            ev("file_write", "s1", "t1", 3, ["app.py"]),
        ]
        capsule = cl.build_capsules(events)["t1"]
        self.assertEqual(capsule["entities"]["file::app.py"]["touches"], 3)
        self.assertEqual(capsule["n_entities"], 1)


class ContentionTests(unittest.TestCase):
    def test_same_entity_in_two_tasks_is_contested(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("task_registered", "s2", "t2", 1),
            ev("file_write", "s1", "t1", 2, ["app.py"]),
            ev("file_write", "s2", "t2", 3, ["app.py"]),
        ]
        contested = cl.build_contention(cl.build_capsules(events))
        self.assertEqual([c["entity_key"] for c in contested], ["file::app.py"])
        self.assertEqual(len(contested[0]["tasks"]), 2)

    def test_two_sessions_one_task_is_contested(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("file_write", "s1", "t1", 1, ["app.py"]),
            ev("file_write", "s2", "t1", 2, ["app.py"]),
        ]
        contested = cl.build_contention(cl.build_capsules(events))
        self.assertEqual(len(contested), 1)
        self.assertEqual(len(contested[0]["sessions"]), 2)

    def test_single_session_single_task_is_not_contested(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("file_write", "s1", "t1", 1, ["app.py"]),
        ]
        self.assertEqual(cl.build_contention(cl.build_capsules(events)), [])

    def test_distinct_symbols_in_one_file_are_not_contested(self):
        # The whole reason symbol-level keys exist: two edits to one file are not
        # evidence of semantic interference unless they hit the same target.
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("task_registered", "s2", "t2", 1),
            ev("file_write", "s1", "t1", 2, [{"kind": "function", "identifier": "index", "path": "app.py"}]),
            ev("file_write", "s2", "t2", 3, [{"kind": "function", "identifier": "helper", "path": "app.py"}]),
        ]
        self.assertEqual(cl.build_contention(cl.build_capsules(events)), [])


class BacklogTests(unittest.TestCase):
    def test_backlog_rises_then_falls(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("task_registered", "s2", "t2", 1),
            ev("lifecycle_integrated", "s1", "t1", 2),
        ]
        series = cl.backlog_series(cl.build_capsules(events), events)
        self.assertEqual([point["open_capsules"] for point in series], [1, 2, 1])

    def test_backlog_never_goes_negative(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("lifecycle_integrated", "s1", "t1", 1),
            ev("lifecycle_abandoned", "s1", "t1", 2),
        ]
        series = cl.backlog_series(cl.build_capsules(events), events)
        self.assertTrue(all(point["open_capsules"] >= 0 for point in series))

    def test_empty_ledger_yields_empty_series(self):
        self.assertEqual(cl.backlog_series({}, []), [])

    def test_rates_are_per_hour_over_observed_span(self):
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("task_registered", "s2", "t2", 30),
            ev("lifecycle_integrated", "s1", "t1", 60),
        ]
        info = cl.rates(cl.build_capsules(events), events)
        self.assertAlmostEqual(info["observed_hours"], 1.0, places=6)
        self.assertAlmostEqual(info["lambda_produced_per_hour"], 2.0, places=6)
        self.assertAlmostEqual(info["integration_rate_per_hour"], 1.0, places=6)
        self.assertTrue(info["rate_is_meaningful"])

    def test_rates_are_withheld_when_span_is_too_short(self):
        # Regression: a burst of events one second apart once produced a reported
        # lambda of ~5600/h. A withheld rate must never be replaced by a huge one.
        events = [
            ev("task_registered", "s1", "t1", 0),
            ev("task_registered", "s2", "t2", 0.01),
            ev("task_registered", "s3", "t3", 0.02),
        ]
        info = cl.rates(cl.build_capsules(events), events)
        self.assertIsNone(info["lambda_produced_per_hour"])
        self.assertIsNone(info["integration_rate_per_hour"])
        self.assertFalse(info["rate_is_meaningful"])
        self.assertIn("floor", info["withheld_reason"])

    def test_rates_are_withheld_with_no_events(self):
        info = cl.rates({}, [])
        self.assertIsNone(info["lambda_produced_per_hour"])
        self.assertFalse(info["rate_is_meaningful"])


class PersistenceTests(unittest.TestCase):
    def test_round_trip_preserves_events_in_time_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            cl.append_event(tmp, ev("task_registered", "s1", "t1", 10))
            cl.append_event(tmp, ev("task_registered", "s2", "t2", 0))
            loaded = cl.load_events(tmp)
            self.assertEqual([e["task_id"] for e in loaded], ["t2", "t1"])

    def test_missing_ledger_reads_as_empty_not_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(cl.load_events(Path(tmp) / "nope"), [])

    def test_malformed_line_is_reported_with_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = cl.ledger_path(tmp)
            path.write_text('{"ok": 1}\nnot json\n', encoding="utf-8")
            with self.assertRaises(cl.LedgerError) as ctx:
                cl.load_events(tmp)
            self.assertIn(":2:", str(ctx.exception))

    def test_jsonl_uses_lf_newlines(self):
        # The ledger is committed, so CRLF would create spurious diffs across platforms.
        with tempfile.TemporaryDirectory() as tmp:
            cl.append_event(tmp, ev("task_registered", "s1", "t1", 0))
            raw = cl.ledger_path(tmp).read_bytes()
            self.assertNotIn(b"\r\n", raw)


class HookInputTests(unittest.TestCase):
    def test_valid_hook_json_is_parsed(self):
        parsed = cl.read_hook_input(io.StringIO('{"session_id": "abc", "hook_event_name": "Stop"}'))
        self.assertEqual(parsed["session_id"], "abc")

    def test_empty_stream_yields_empty_dict(self):
        self.assertEqual(cl.read_hook_input(io.StringIO("")), {})

    def test_non_json_stream_yields_empty_dict(self):
        self.assertEqual(cl.read_hook_input(io.StringIO("not json at all")), {})

    def test_json_array_is_rejected_rather_than_misread(self):
        self.assertEqual(cl.read_hook_input(io.StringIO("[1,2,3]")), {})

    def test_record_command_ingests_session_from_stdin(self):
        with tempfile.TemporaryDirectory() as tmp:
            stdin, real = sys.stdin, sys.stdin
            sys.stdin = io.StringIO(json.dumps({"session_id": "sess-from-host", "hook_event_name": "file_write"}))
            try:
                rc = cl.main(["record", "--ledger", tmp, "--task", "t1", "--entity", "app.py"])
            finally:
                sys.stdin = real
                del stdin
            self.assertEqual(rc, 0)
            event = cl.load_events(tmp)[0]
            self.assertEqual(event["session_id"], "sess-from-host")
            self.assertEqual(event["kind"], "file_write")
            self.assertEqual(event["entities"][0]["path"], "app.py")

    def test_record_command_fails_when_no_session_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = sys.stdin
            sys.stdin = io.StringIO("{}")
            try:
                rc = cl.main(["record", "--ledger", tmp, "--event", "file_write", "--task", "t1"])
            finally:
                sys.stdin = real
            self.assertEqual(rc, 1)
            self.assertEqual(cl.load_events(tmp), [])


class ReportTests(unittest.TestCase):
    def _scenario(self) -> list[dict]:
        return [
            ev("session_started", "s1", "t1", 0),
            ev("task_registered", "s1", "t1", 0.1, ["app.py"]),
            ev("file_write", "s1", "t1", 1, ["app.py"]),
            ev("session_started", "s2", "t2", 2),
            ev("task_registered", "s2", "t2", 2.1, ["app.py"]),
            ev("context_compacted", "s2", "t2", 3),
            ev("file_write", "s2", "t2", 4, ["app.py"]),
            ev("lifecycle_integrated", "s1", "t1", 5),
        ]

    def test_report_surfaces_the_frameworks_quantities(self):
        with tempfile.TemporaryDirectory() as tmp:
            for event in self._scenario():
                cl.append_event(tmp, event)
            report = cl.compute_report(tmp)
            counts = report["counts"]
            self.assertEqual(counts["capsules"], 2)
            self.assertEqual(counts["integrated_capsules"], 1)
            self.assertEqual(counts["unreconciled_capsules"], 1)
            self.assertEqual(counts["contested_entities"], 1)
            self.assertEqual(counts["sessions_with_context_loss"], 1)
            self.assertEqual(report["writes_after_context_loss"], 1)
            self.assertIsNotNone(report["rates"]["lambda_produced_per_hour"])

    def test_report_declares_that_it_applied_no_governance(self):
        with tempfile.TemporaryDirectory() as tmp:
            cl.append_event(tmp, ev("task_registered", "s1", "t1", 0))
            report = cl.compute_report(tmp)
            self.assertEqual(report["status"], "instrumentation_only_no_governance_applied")

    def test_report_warns_about_the_observation_effect(self):
        # Guard: the guards themselves are part of the contract, because a favourable
        # number from an unguarded run is exactly how this framework could be misused.
        with tempfile.TemporaryDirectory() as tmp:
            cl.append_event(tmp, ev("task_registered", "s1", "t1", 0))
            guards = " ".join(cl.compute_report(tmp)["interpretation_guards"])
            self.assertIn("observation effect", guards)
            self.assertIn("H9", guards)
            self.assertIn("iscc-0.2", guards)

    def test_empty_ledger_report_is_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = cl.compute_report(tmp)
            self.assertEqual(report["counts"]["capsules"], 0)
            self.assertIsNone(report["rates"]["lambda_produced_per_hour"])

    def test_unreconciled_equals_open(self):
        # Regression: these once disagreed, so a report could show open=1 while
        # unreconciled=0, which is incoherent given the framework defines B(t) as the
        # open set.
        with tempfile.TemporaryDirectory() as tmp:
            for event in self._scenario():
                cl.append_event(tmp, event)
            counts = cl.compute_report(tmp)["counts"]
            self.assertEqual(counts["unreconciled_capsules"], counts["open_capsules"])
            self.assertGreater(counts["open_capsules"], 0)

    def test_validated_but_not_integrated_still_counts_as_backlog(self):
        # `validated` means checks passed, not that the change was reconciled into an
        # explainable repository state. Counting it as done would understate the backlog.
        with tempfile.TemporaryDirectory() as tmp:
            cl.append_event(tmp, ev("task_registered", "s1", "t1", 0))
            cl.append_event(tmp, ev("lifecycle_validated", "s1", "t1", 1))
            report = cl.compute_report(tmp)
            self.assertEqual(report["counts"]["open_capsules"], 1)
            self.assertEqual(report["counts"]["integrated_capsules"], 0)

    def test_decay_is_reported_separately_from_backlog(self):
        # A wave of abandonments must not look like a shrinking backlog.
        with tempfile.TemporaryDirectory() as tmp:
            cl.append_event(tmp, ev("task_registered", "s1", "t1", 0))
            cl.append_event(tmp, ev("task_registered", "s2", "t2", 1))
            cl.append_event(tmp, ev("lifecycle_abandoned", "s1", "t1", 2))
            counts = cl.compute_report(tmp)["counts"]
            self.assertEqual(counts["open_capsules"], 1)
            self.assertEqual(counts["decayed_capsules"], 1)
            self.assertEqual(counts["integrated_capsules"], 0)


if __name__ == "__main__":
    unittest.main()
