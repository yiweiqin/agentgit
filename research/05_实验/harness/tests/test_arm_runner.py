"""Regression tests for the E1/E3 arm runner.

These cover the parts that decide what an experiment *means*: plan expansion, the two
rendering functions, outcome parsing, reconciliation, and the metric/verdict arithmetic.
Nothing here needs a machine.

The tests exist because every failure mode in this file is silent.  A plan whose intent
groups are never co-scheduled produces a primary indicator of zero that looks like a
finding.  A `.jsonl` ledger path makes the Python analyser read a different file from the
one the plugin wrote and report "no contention".  A round script that waits on `$!` wrongly
reports a round of failures as a clean round.  None of those turn anything red on their own.

    python -m unittest discover -s harness/tests -v
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_HARNESS_DIR = Path(__file__).resolve().parents[1]
_EXPERIMENT_DIR = _HARNESS_DIR.parent
_ROOT_DIR = _EXPERIMENT_DIR.parent
_TS_DIR = _ROOT_DIR / "04_协调插件" / "dsh-coord-governor"

sys.path.insert(0, str(_HARNESS_DIR))

import arm_runner  # noqa: E402


def base_plan(**overrides):
    """A minimal plan that passes validation, so each test changes exactly one thing."""
    plan = {
        "status": "skeleton",
        "schemaVersion": arm_runner.PLAN_SCHEMA,
        "experiment": "E3",
        "topology": "multi-process",
        "arms": ["A0-baseline", "A1-instrument"],
        "rounds": 8,
        "concurrency": 2,
        "timeoutSeconds": 420,
        "repo": {"path": "/exp/repo", "commit": "a" * 40, "url": "https://example.invalid/r.git"},
        "plugin": {"entry": "/exp/plugin/src/index.ts"},
        "dsh": {"binary": "/exp/dsh-host/node_modules/.bin/dsh", "profile": "headless"},
        "tasks": [
            {"taskId": "T-1", "intentGroup": "G-1", "developer": "d1", "prompt": "p1"},
            {"taskId": "T-2", "intentGroup": "G-1", "developer": "d2", "prompt": "p2"},
        ],
    }
    plan.update(overrides)
    return plan


class ArmListDriftTest(unittest.TestCase):
    """The runner's arm list must not drift from the host's, or a typo becomes a 404 arm."""

    def test_arm_names_match_config_ts(self):
        source = (_TS_DIR / "src" / "config.ts").read_text(encoding="utf-8")
        block = re.search(r"export type ArmName =([\s\S]*?)\n\n", source)
        self.assertIsNotNone(block, "could not find the ArmName union in src/config.ts")
        declared = set(re.findall(r"'([^']+)'", block.group(1)))
        self.assertEqual(
            declared,
            set(arm_runner.ARM_NAMES),
            "arm_runner.ARM_NAMES and src/config.ts disagree: a run would name an arm the host does not define",
        )

    def test_prereg_arms_are_a_subset_of_known_arms(self):
        self.assertTrue(set(arm_runner.PREREG_ARMS) <= set(arm_runner.ARM_NAMES))
        self.assertTrue(set(arm_runner.ABLATION_ARMS) <= set(arm_runner.ARM_NAMES))


class PlanValidationTest(unittest.TestCase):
    def test_base_plan_is_valid(self):
        self.assertEqual(arm_runner.validate_plan(base_plan()), [])

    def test_state_not_skeleton_or_frozen_is_rejected(self):
        errors = arm_runner.validate_plan(base_plan(status="draft"))
        self.assertTrue(any("status must be" in e for e in errors), errors)

    def test_a3_without_a1_is_rejected(self):
        # Governance is compared against the placebo (recording on, governance off), not the
        # bare baseline; without A1 present the comparison §5.1 defines cannot be made.
        plan = base_plan(arms=["A0-baseline", "A3-advisory"])
        errors = arm_runner.validate_plan(plan)
        self.assertTrue(any("A1-instrument" in e for e in errors), errors)

    def test_a3_under_multi_process_is_rejected(self):
        plan = base_plan(arms=["A1-instrument", "A3-advisory"])
        errors = arm_runner.validate_plan(plan)
        self.assertTrue(any("in-process-multi-session" in e for e in errors), errors)

    def test_in_process_topology_requires_a_driver_entry(self):
        # Without the driver there is nothing to create the round's sessions, so the shared view
        # A3/A4 depend on does not exist and the round would measure nothing.
        plan = base_plan(topology="in-process-multi-session", arms=["A1-instrument"])
        errors = arm_runner.validate_plan(plan)
        self.assertTrue(any("driverEntry" in e for e in errors), errors)

    def test_in_process_topology_accepts_a3_when_the_driver_is_present(self):
        # This is the whole point of the in-process backend: A3/A4 stop being refused because the
        # governor and the sessions that create the contention share one process.
        plan = base_plan(topology="in-process-multi-session", arms=["A1-instrument", "A3-advisory"])
        plan["plugin"]["driverEntry"] = "/exp/plugin/src/round-driver.ts"
        self.assertEqual(arm_runner.validate_plan(plan), [])

    def test_a3_is_still_refused_under_multi_process(self):
        plan = base_plan(topology="multi-process", arms=["A1-instrument", "A3-advisory"])
        plan["plugin"]["driverEntry"] = "/exp/plugin/src/round-driver.ts"
        errors = arm_runner.validate_plan(plan)
        self.assertTrue(any("multi-process" in e for e in errors), errors)

    def test_rounds_outside_the_frozen_bound_are_rejected(self):
        self.assertTrue(any("§5.4 bound" in e for e in arm_runner.validate_plan(base_plan(rounds=3))))
        self.assertTrue(any("§5.4 bound" in e for e in arm_runner.validate_plan(base_plan(rounds=41))))

    def test_concurrency_below_two_is_rejected(self):
        errors = arm_runner.validate_plan(base_plan(concurrency=1))
        self.assertTrue(any("concurrency" in e for e in errors), errors)

    def test_duplicate_task_id_is_rejected(self):
        plan = base_plan(
            tasks=[
                {"taskId": "T-1", "intentGroup": "G-1", "developer": "d1", "prompt": "p1"},
                {"taskId": "T-1", "intentGroup": "G-2", "developer": "d2", "prompt": "p2"},
            ]
        )
        errors = arm_runner.validate_plan(plan)
        self.assertTrue(any("duplicated" in e for e in errors), errors)

    def test_no_shared_intent_group_is_rejected(self):
        plan = base_plan(
            tasks=[
                {"taskId": "T-1", "intentGroup": "G-1", "developer": "d1", "prompt": "p1"},
                {"taskId": "T-2", "intentGroup": "G-2", "developer": "d2", "prompt": "p2"},
            ]
        )
        errors = arm_runner.validate_plan(plan)
        self.assertTrue(any("2+ tasks" in e for e in errors), errors)

    def test_never_co_scheduled_intent_group_is_rejected(self):
        # With concurrency 2 the scheduler produces adjacent pairs {r, r+1} of a 4-cycle, so
        # members at indices 0 and 2 are never in flight together. Without this check the plan
        # would run, cost a machine, and produce a structural zero.
        plan = base_plan(
            concurrency=2,
            tasks=[
                {"taskId": "T-0", "intentGroup": "G-apart", "developer": "d1", "prompt": "p0"},
                {"taskId": "T-1", "intentGroup": "G-other", "developer": "d1", "prompt": "p1"},
                {"taskId": "T-2", "intentGroup": "G-apart", "developer": "d2", "prompt": "p2"},
                {"taskId": "T-3", "intentGroup": "G-other", "developer": "d2", "prompt": "p3"},
            ]
        )
        errors = arm_runner.validate_plan(plan)
        self.assertTrue(any("never co-scheduled" in e for e in errors), errors)


class ExpansionTest(unittest.TestCase):
    def test_expansion_is_complete_and_deterministic(self):
        plan = base_plan(arms=["A0-baseline", "A1-instrument", "A2-inert"], rounds=8, concurrency=3)
        first = [r.as_dict() for r in arm_runner.expand_runs(plan)]
        second = [r.as_dict() for r in arm_runner.expand_runs(plan)]
        self.assertEqual(first, second)
        self.assertEqual(len(first), 3 * 8 * 3)

    def test_labels_sort_in_round_order(self):
        # Round order is B(t) order; unpadded labels would sort r10 before r2 and invite a
        # human to diff the wrong two rounds.
        runs = arm_runner.expand_runs(base_plan(rounds=12, concurrency=2))
        labels = [r.label for r in runs if r.session_index == 0]
        self.assertEqual(labels, sorted(labels))

    def test_every_run_carries_its_intent_group(self):
        runs = arm_runner.expand_runs(base_plan())
        self.assertTrue(all(r.intent_group.startswith("G-") for r in runs))

    def test_plan_is_json_round_trippable(self):
        plan = base_plan()
        self.assertEqual(json.loads(json.dumps(plan)), plan)


class OverlayTest(unittest.TestCase):
    def test_overlay_matches_the_verified_host_shape(self):
        text = arm_runner.render_overlay("A1-instrument", "/exp/ledgers/E3/A1-instrument-r000", "/exp/plugin/src/index.ts")
        self.assertEqual(
            text,
            "- insert:\n"
            "    - id: coord-governor\n"
            "      name: /exp/plugin/src/index.ts\n"
            "      config:\n"
            "        arm: A1-instrument\n"
            "        ledgerPath: /exp/ledgers/E3/A1-instrument-r000\n",
        )

    def test_ledger_path_is_a_directory_not_a_jsonl_file(self):
        # The two analysers disagree about a `.jsonl` path: the TS side writes that file, the
        # Python side looks for `<path>/events.jsonl` and reads nothing. An empty report is
        # indistinguishable from "no contention", which is why this is asserted rather than
        # documented. A1 is the arm that records, so it is the one that has a ledgerPath.
        text = arm_runner.render_overlay("A1-instrument", "/exp/ledgers/E3/A1-instrument-r000", "/exp/plugin/src/index.ts")
        ledger = [line for line in text.splitlines() if "ledgerPath" in line][0]
        self.assertFalse(ledger.strip().endswith(".jsonl"), ledger)

    def test_a0_baseline_does_not_mount_the_governor(self):
        # A0 is "the plugin not mounted at all"; that is what separates it from A2-inert ("loaded
        # but touching nothing"), and mounting it for both would collapse the two arms so that
        # `A1 - A2` stopped isolating recording cost. `remote_verify_fix.sh` runs A0 with no overlay.
        text = arm_runner.render_overlay("A0-baseline", "/exp/ledgers/E3/A0-baseline-r000", "/exp/plugin/src/index.ts")
        self.assertNotIn("coord-governor", text)

    def test_a0_still_gets_the_driver_in_process(self):
        # The driver is the launcher, not an instrument: without it an in-process round has no
        # sessions at all. It records nothing by itself.
        text = arm_runner.render_overlay(
            "A0-baseline",
            "/exp/ledgers/E3/A0-baseline-r000",
            "/exp/plugin/src/index.ts",
            ("/exp/plugin/src/round-driver.ts", "/exp/spec.json", "/exp/done"),
        )
        self.assertNotIn("coord-governor", text)
        self.assertIn("coord-round-driver", text)

    def test_unknown_arm_is_refused(self):
        with self.assertRaises(ValueError):
            arm_runner.render_overlay("A9-nope", "/exp/ledgers", "/exp/plugin/src/index.ts")

    def test_ledger_dir_is_per_round_and_per_arm(self):
        a = arm_runner.round_ledger_dir("/exp", "E3", "A1-instrument", 0)
        b = arm_runner.round_ledger_dir("/exp", "E3", "A1-instrument", 1)
        c = arm_runner.round_ledger_dir("/exp", "E3", "A0-baseline", 0)
        self.assertEqual(len({a, b, c}), 3)


class RoundScriptTest(unittest.TestCase):
    def setUp(self):
        self.plan = base_plan(rounds=8, concurrency=2)
        self.script = arm_runner.render_round_script(
            self.plan, "A1-instrument", 0, "/exp", "~/.coord-dsh.env"
        )

    def test_one_run_one_invocation_per_session(self):
        self.assertEqual(self.script.count("run_one "), 2)

    def test_each_session_is_backgrounded(self):
        # Sequential execution would make simultaneity an artefact of session duration, which is
        # exactly the variable the experiment manipulates.
        self.assertEqual(self.script.count("& pids+=($!)"), 2)

    def test_each_pid_is_waited_individually(self):
        # Bare `wait` returns 0 even when every session failed, reporting a broken round as clean.
        self.assertIn('for pid in "${pids[@]}"; do wait "$pid" || status=1; done', self.script)

    def test_session_id_is_read_from_the_host_session_directory(self):
        # The ledger does not carry the working directory, so this is the only sound join
        # between a run label and the host's session id.
        self.assertIn('-name "session-*"', self.script)
        self.assertIn("session_id=$(basename", self.script)

    def test_prompt_is_read_from_a_file(self):
        # Interpolating a prompt through PowerShell and SSH is how a session loses half its
        # words and still exits 0.
        self.assertIn('"$(cat "$prompt_file")"', self.script)

    def test_worktree_is_per_session_and_pinned(self):
        self.assertIn('worktree add --detach --force "$worktree" "$COMMIT"', self.script)

    def test_reconciliation_is_not_written_on_the_machine(self):
        self.assertNotIn("lifecycle_integrated", self.script)
        self.assertIn("derived locally", self.script)

    def test_ledger_goes_to_a_directory(self):
        self.assertNotIn(".jsonl", self.script.split("LEDGER_DIR=")[1].split("\n")[0])

    def test_env_file_tilde_is_expanded_rather_than_quoted(self):
        # `shlex.quote('~/x')` yields `'~/x'`, a literal tilde: the file is then never found,
        # the key is never sourced, and every session fails with MISSING_CREDENTIAL -- which
        # reads like a broken key, not a quoting bug.
        self.assertIn('DSH_ENV_FILE="$HOME/.coord-dsh.env"', self.script)
        self.assertNotIn("'~/.coord-dsh.env'", self.script)

    def test_node_prefix_is_prepended_to_path(self):
        # The machine ships Node 12 on PATH and Node 24 off it (machine-assessment.md §5).
        plan = base_plan()
        plan["dsh"]["pathPrepend"] = ["/opt/node24/bin"]
        script = arm_runner.render_round_script(plan, "A1-instrument", 0, "/exp", "~/.coord-dsh.env")
        self.assertIn('export PATH=/opt/node24/bin:"$PATH"', script)


class OutcomeParseTest(unittest.TestCase):
    def test_parses_the_round_script_format(self):
        values = arm_runner.parse_outcome("LABEL=x\nSESSION=session-1\nEXIT=0\nSECONDS=12\nLANDED=yes\nCHANGED=3\nREASON=ok\n")
        self.assertEqual(values["LABEL"], "x")
        self.assertEqual(values["EXIT"], "0")

    def test_outcome_from_file_carries_the_plan_identity(self):
        run = arm_runner.expand_runs(base_plan())[0]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "outcome.env"
            path.write_text("LABEL=x\nSESSION=session-1\nEXIT=0\nSECONDS=3\nLANDED=yes\nCHANGED=1\nREASON=ok\n", encoding="utf-8")
            outcome = arm_runner.outcome_from_file(path, run)
        self.assertTrue(outcome.landed)
        self.assertEqual(outcome.session_id, "session-1")
        self.assertEqual(outcome.task_id, run.task_id)
        self.assertEqual(outcome.intent_group, run.intent_group)

    def test_non_numeric_field_is_loud(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "outcome.env"
            path.write_text("LABEL=x\nEXIT=soon\nLANDED=no\nCHANGED=0\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                arm_runner.outcome_from_file(path)

    def test_missing_landing_key_is_loud(self):
        # The in-process driver writes EXIT but not LANDED/CHANGED, because it owns no git
        # worktree; the round script appends them. If that append never ran, defaulting to
        # "did not land" would quietly move real work out of the numerator of the primary
        # indicator -- so a missing key is an error, not a default.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "outcome.env"
            path.write_text("LABEL=x\nSESSION=s\nEXIT=0\nSECONDS=3\nREASON=ok\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                arm_runner.outcome_from_file(path)

    def test_appended_keys_win_over_the_driver_written_ones(self):
        # The round script appends CHANGED/LANDED to the driver's file; the parser is last-wins,
        # which is what makes the append authoritative without rewriting the file.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "outcome.env"
            path.write_text(
                "LABEL=x\nSESSION=s\nEXIT=0\nSECONDS=3\nREASON=ok\nCHANGED=0\nLANDED=no\n",
                encoding="utf-8",
            )
            outcome = arm_runner.outcome_from_file(path)
            self.assertFalse(outcome.landed)
            path.write_text(
                "LABEL=x\nSESSION=s\nEXIT=0\nSECONDS=3\nREASON=ok\nCHANGED=0\nLANDED=no\nLANDED=yes\nCHANGED=2\n",
                encoding="utf-8",
            )
            outcome = arm_runner.outcome_from_file(path)
            self.assertTrue(outcome.landed)
            self.assertEqual(outcome.changed, 2)


def _event(kind, session, task, timestamp, **extra):
    body = {
        "schema_version": "coord-ledger-0.1",
        "event_id": f"evt-{absolute_hash(kind + session + timestamp)}",
        "kind": kind,
        "timestamp_utc": timestamp,
        "session_id": session,
        "developer": None,
        "task_id": task,
        "entities": extra.pop("entities", []),
        "intent_text": None,
        "host_event": None,
        "reason": extra.pop("reason", None),
        "detail": extra.pop("detail", None),
    }
    body.update(extra)
    return body


def absolute_hash(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


class ReconcileTest(unittest.TestCase):
    def test_landed_session_is_closed_as_integrated_at_its_last_event(self):
        events = [
            _event("file_write", "session-1", "session-1", "2026-04-01T00:00:00Z"),
            _event("file_write", "session-1", "session-1", "2026-04-01T00:05:00Z"),
        ]
        outcomes = [
            arm_runner.Outcome(
                label="r", session_id="session-1", exit_code=0, seconds=300, landed=True, changed=2,
                reason="ok", intent_group="G-1",
            )
        ]
        derived = arm_runner.reconcile(events, outcomes)
        self.assertEqual(len(derived), 3)
        closing = derived[-1]
        self.assertEqual(closing["kind"], "lifecycle_integrated")
        self.assertEqual(closing["timestamp_utc"], "2026-04-01T00:05:00Z")
        self.assertEqual(closing["task_id"], "session-1")

    def test_failed_session_is_closed_as_abandoned(self):
        events = [_event("file_write", "session-1", "session-1", "2026-04-01T00:00:00Z")]
        outcomes = [
            arm_runner.Outcome(
                label="r", session_id="session-1", exit_code=1, seconds=10, landed=False, changed=0,
                reason="ok", intent_group="G-1",
            )
        ]
        closing = arm_runner.reconcile(events, outcomes)[-1]
        self.assertEqual(closing["kind"], "lifecycle_abandoned")

    def test_session_that_wrote_nothing_gets_no_capsule(self):
        # Writing a closing event here would make B(t) depend on how many sessions were launched
        # rather than on how many worked.
        events = [_event("file_write", "session-other", "session-other", "2026-04-01T00:00:00Z")]
        outcomes = [
            arm_runner.Outcome(
                label="quiet", session_id="session-quiet", exit_code=0, seconds=1, landed=False,
                changed=0, reason="ok", intent_group="G-1",
            )
        ]
        derived = arm_runner.reconcile(events, outcomes)
        self.assertEqual(len(derived), 1)

    def test_landed_session_without_a_captured_id_is_an_error(self):
        # Its capsule could never be closed, so B(t) would be permanently inflated in whichever
        # arm hit the capture bug -- and the bug would look like a finding.
        events = [_event("file_write", "session-1", "session-1", "2026-04-01T00:00:00Z")]
        outcomes = [
            arm_runner.Outcome(
                label="lost", session_id="", exit_code=0, seconds=1, landed=True, changed=1,
                reason="session-id-not-found", intent_group="G-1",
            )
        ]
        with self.assertRaises(ValueError):
            arm_runner.reconcile(events, outcomes)

    def test_derived_events_are_accepted_by_the_frozen_python_analyser(self):
        # The runner must not invent a wire shape: if `coord_ledger` cannot read what it writes,
        # the whole evidence chain is broken at the last step.
        import coord_ledger

        events = [_event("file_write", "session-1", "session-1", "2026-04-01T00:00:00Z")]
        outcomes = [
            arm_runner.Outcome(
                label="r", session_id="session-1", exit_code=0, seconds=1, landed=True, changed=1,
                reason="ok", intent_group="G-1",
            )
        ]
        derived = arm_runner.reconcile(events, outcomes)
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / coord_ledger.LEDGER_FILENAME).write_text(
                "\n".join(json.dumps(e, ensure_ascii=False) for e in derived) + "\n", encoding="utf-8"
            )
            report = coord_ledger.compute_report(directory)
        self.assertEqual(report["counts"]["capsules"], 1)
        self.assertEqual(report["counts"]["integrated_capsules"], 1)
        self.assertEqual(report["counts"]["open_capsules"], 0)


class MetricsTest(unittest.TestCase):
    def _landing(self, label, group, landed):
        return arm_runner.Outcome(
            label=label, session_id=label, exit_code=0 if landed else 1, seconds=1, landed=landed,
            changed=1 if landed else 0, reason="ok", intent_group=group,
        )

    def test_redundant_landing_counts_every_landing_past_the_first_per_group(self):
        outcomes = [
            self._landing("a", "G-1", True),
            self._landing("b", "G-1", True),
            self._landing("c", "G-1", True),
            self._landing("d", "G-2", True),
            self._landing("e", "G-3", False),
        ]
        report = {"counts": {"events": 5, "open_capsules": 1, "integrated_capsules": 4}, "backlog_series": [], "rates": {}}
        metrics = arm_runner.round_metrics("A1-instrument", 0, [], outcomes, report)
        self.assertEqual(metrics.landed_functions, 4)
        self.assertEqual(metrics.redundant_landings, 2)
        self.assertAlmostEqual(metrics.redundant_landing_rate, 0.5)

    def test_rate_is_none_when_nothing_landed(self):
        # Not zero: an absent measurement must not be reported as a perfect rate.
        outcomes = [self._landing("a", "G-1", False)]
        report = {"counts": {}, "backlog_series": [], "rates": {}}
        metrics = arm_runner.round_metrics("A1-instrument", 0, [], outcomes, report)
        self.assertIsNone(metrics.redundant_landing_rate)

    def test_verdict_refuses_to_call_an_all_empty_arm_measured(self):
        summaries = {"A1-instrument": arm_runner.summarise_arm("A1-instrument", [])}
        outcome = arm_runner.verdict(summaries, {"checks": [], "triggered": False})
        self.assertEqual(outcome["exit_code"], 2)
        self.assertEqual(outcome["status"], "could-not-measure")

    def test_verdict_reports_a_kill_trigger_as_a_result_not_a_failure(self):
        metrics = arm_runner.RoundMetrics(
            arm="A3-advisory", round_index=0, events=1, sessions_launched=1, landed=1,
            redundant_landings=0, landed_functions=1, redundant_landing_rate=0.0,
            parallelism_mean=1.0, parallel_fraction=1.0, backlog_end=0, integrated_capsules=1,
            decayed_capsules=0, contested_entities=0, writes_after_context_loss=0, gate_denied=0,
            advisory_injected=0, sessions_without_session_id=0, rate_is_meaningful=True,
            lambda_produced_per_hour=1.0,
        )
        summaries = {m.arm: arm_runner.summarise_arm(m.arm, [m]) for m in [metrics]}
        outcome = arm_runner.verdict(summaries, {"checks": [{"triggered": True}], "triggered": True})
        self.assertEqual(outcome["exit_code"], 1)

    def test_describe_reports_variance(self):
        described = arm_runner._describe([1.0, 2.0, 3.0])
        self.assertEqual(described["n"], 3)
        self.assertEqual(described["mean"], 2.0)
        self.assertIsNotNone(described["variance"])
        self.assertIsNone(arm_runner._describe([1.0])["variance"])


class EK4Test(unittest.TestCase):
    def _summary(self, arm, mean, fraction):
        return arm_runner.ArmSummary(
            arm=arm, rounds=8, rounds_with_defined_rate=8,
            redundant_landing_rate_pooled=0.2, redundant_landing_rate_per_round={},
            landed_functions_per_round={},
            parallelism_mean={"mean": mean}, parallel_fraction={"mean": fraction},
            backlog_end={}, integrated_capsules={}, decayed_capsules={},
            gate_denied_per_round={}, advisory_injected_per_round={},
        )

    def test_mean_drop_above_threshold_triggers(self):
        summaries = {
            "A1-instrument": self._summary("A1-instrument", 4.0, 0.9),
            "A4-gated": self._summary("A4-gated", 3.0, 0.9),  # 25% drop > 15%
        }
        self.assertTrue(arm_runner.e_k4_checks(summaries)["triggered"])

    def test_parallel_fraction_drop_above_threshold_triggers(self):
        summaries = {
            "A1-instrument": self._summary("A1-instrument", 4.0, 0.9),
            "A3-advisory": self._summary("A3-advisory", 4.0, 0.6),  # 33% drop > 25%
        }
        self.assertTrue(arm_runner.e_k4_checks(summaries)["triggered"])

    def test_a_small_drop_does_not_trigger(self):
        summaries = {
            "A1-instrument": self._summary("A1-instrument", 4.0, 0.9),
            "A3-advisory": self._summary("A3-advisory", 3.9, 0.88),
        }
        self.assertFalse(arm_runner.e_k4_checks(summaries)["triggered"])

    def test_zero_reference_is_none_not_zero(self):
        # "No parallel work to begin with" is not "no drop"; treating it as zero would silently
        # pass the guard exactly where it matters.
        self.assertIsNone(arm_runner.relative_drop(0.0, 0.0))
        self.assertIsNone(arm_runner.relative_drop(None, 1.0))


class ParallelismMirrorTest(unittest.TestCase):
    """The Python mirror of `computeParallelism` must agree with the TypeScript original."""

    def test_mirror_matches_typescript_when_node_is_available(self):
        series = [
            {"timestamp_utc": "2026-04-01T00:00:00Z", "open_capsules": 1},
            {"timestamp_utc": "2026-04-01T00:10:00Z", "open_capsules": 2},
            {"timestamp_utc": "2026-04-01T00:20:00Z", "open_capsules": 3},
            {"timestamp_utc": "2026-04-01T00:30:00Z", "open_capsules": 1},
            {"timestamp_utc": "2026-04-01T00:40:00Z", "open_capsules": 0},
        ]
        import coord_ledger

        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            lines = []
            for index, point in enumerate(series):
                lines.append(
                    json.dumps(
                        _event(
                            "file_write" if index % 2 == 0 else "turn_ended",
                            f"session-{index}",
                            f"session-{index}",
                            point["timestamp_utc"],
                        )
                    )
                )
            (directory / coord_ledger.LEDGER_FILENAME).write_text("\n".join(lines) + "\n", encoding="utf-8")

            python_view = arm_runner.parallelism_from_series(series)
            self.assertGreater(python_view["mean"], 0.0)

            completed = subprocess.run(
                ["node", "src/cli.ts", "report", "--ledger", str(directory), "--json"],
                cwd=_TS_DIR,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            if completed.returncode != 0:
                self.skipTest(
                    "node could not run the TypeScript report (needs Node with type stripping, "
                    f">=22.19 or >=24): {(completed.stderr or '').strip()[:200]}"
                )
            ts_report = json.loads(completed.stdout)
            ts_parallelism = ts_report["ts_only"]["parallelism"]
            # Compare on the same series the TypeScript side derived, so the mirror is tested
            # against the reference rather than against a second hand-built input.
            mirror = arm_runner.parallelism_from_series(ts_report["backlog_series"])
            self.assertAlmostEqual(mirror["mean"], ts_parallelism["mean"], places=9)
            self.assertAlmostEqual(mirror["parallelFraction"], ts_parallelism["parallelFraction"], places=9)
            self.assertEqual(mirror["peak"], ts_parallelism["peak"])


class DryRunIntegrationTest(unittest.TestCase):
    """`stage` is what touches a paid machine, so it must be renderable offline."""

    def test_stage_renders_every_artifact(self):
        plan = base_plan(arms=["A0-baseline", "A1-instrument"], rounds=8, concurrency=2)
        with tempfile.TemporaryDirectory() as tmp:
            counts = arm_runner.stage(plan, Path(tmp), "/exp", "~/.coord-dsh.env")
            self.assertEqual(counts["runs"], 2 * 8 * 2)
            self.assertEqual(counts["overlays"], 2 * 8)
            self.assertEqual(counts["round_scripts"], 2 * 8)
            self.assertEqual(counts["prompts"], 2 * 8 * 2)
            # The multi-process backend has no driver, so no specs are rendered.
            self.assertEqual(counts["round_specs"], 0)

    def test_stage_renders_specs_for_the_in_process_backend(self):
        plan = base_plan(topology="in-process-multi-session", arms=["A1-instrument"], rounds=8, concurrency=2)
        plan["plugin"]["driverEntry"] = "/exp/plugin/src/round-driver.ts"
        with tempfile.TemporaryDirectory() as tmp:
            counts = arm_runner.stage(plan, Path(tmp), "/exp", "~/.coord-dsh.env")
            self.assertEqual(counts["round_specs"], 8)


class InProcessTest(unittest.TestCase):
    """The in-process backend exists to make A3/A4 measurable; these pin the mechanism."""

    def setUp(self):
        self.plan = base_plan(topology="in-process-multi-session", arms=["A1-instrument"], rounds=8, concurrency=2)
        self.plan["plugin"]["driverEntry"] = "/exp/plugin/src/round-driver.ts"

    def test_overlay_mounts_the_driver_in_the_same_plugin_tree_as_the_governor(self):
        text = arm_runner.render_overlay(
            "A3-advisory",
            "/exp/ledgers/E3/A3-advisory-r000",
            "/exp/plugin/src/index.ts",
            ("/exp/plugin/src/round-driver.ts", "/exp/round-specs/E3/A3-advisory-r000.json", "/exp/done/E3/A3-advisory-r000"),
        )
        self.assertIn("id: coord-governor", text)
        self.assertIn("id: coord-round-driver", text)
        self.assertIn("specPath: /exp/round-specs/E3/A3-advisory-r000.json", text)
        self.assertIn("doneMarker: /exp/done/E3/A3-advisory-r000", text)

    def test_overlay_without_a_driver_mounts_only_the_governor(self):
        text = arm_runner.render_overlay("A1-instrument", "/exp/ledgers", "/exp/plugin/src/index.ts")
        self.assertIn("id: coord-governor", text)
        self.assertNotIn("coord-round-driver", text)

    def test_spec_carries_an_explicit_session_id_per_run(self):
        # The driver cannot recover the label->session-id join any other way (it never records the
        # working directory), so the id is minted by the harness and passed in. An inferred join
        # would attribute one session's writes to another and swap the arms.
        spec = json.loads(arm_runner.render_round_spec(self.plan, "A1-instrument", 0, "/exp"))
        self.assertEqual(len(spec["sessions"]), 2)
        ids = {s["sessionId"] for s in spec["sessions"]}
        self.assertEqual(len(ids), 2)
        for session in spec["sessions"]:
            self.assertTrue(session["sessionId"].startswith("session-"))
            self.assertIn(session["label"], session["sessionId"])
            self.assertIn("/exp/worktrees/", session["cwd"])
            self.assertTrue(session["prompt"])

    def test_spec_done_marker_is_per_round(self):
        a = json.loads(arm_runner.render_round_spec(self.plan, "A1-instrument", 0, "/exp"))["doneMarker"]
        b = json.loads(arm_runner.render_round_spec(self.plan, "A1-instrument", 1, "/exp"))["doneMarker"]
        self.assertNotEqual(a, b)

    def test_round_script_starts_the_host_once(self):
        script = arm_runner.render_round_script(self.plan, "A1-instrument", 0, "/exp", "~/.coord-dsh.env")
        # One host process for the whole round is the mechanism; N processes would make the
        # cross-session scope inert, which is the R4.3 failure.
        self.assertEqual(script.count('"$DSH" --profile "$PROFILE" --patch "$OVERLAY"'), 1)
        self.assertIn("HOST_PID=$!", script)

    def test_round_script_polls_for_the_done_marker_then_sigterms(self):
        script = arm_runner.render_round_script(self.plan, "A1-instrument", 0, "/exp", "~/.coord-dsh.env")
        self.assertIn('while [ ! -f "$DONE" ]; do', script)
        # SIGTERM, not SIGKILL: the launcher drains on SIGTERM by disposing the root, and that is
        # what flushes the compressed session logs.
        self.assertIn('kill -TERM "$HOST_PID"', script)
        self.assertNotIn("kill -9", script)
        self.assertIn("deadline=$(( $(date +%s) + TIMEOUT ))", script)

    def test_round_script_appends_landing_from_the_worktrees(self):
        script = arm_runner.render_round_script(self.plan, "A1-instrument", 0, "/exp", "~/.coord-dsh.env")
        # The driver has no git view, so landing is computed here and appended; `parse_outcome`
        # is last-wins, which is what makes the append authoritative.
        self.assertIn("LANDED=%s", script)
        self.assertIn(">> \"$outcome\"", script)
        self.assertIn('printf \'REASON=timeout', script)

    def test_round_script_covers_every_run_of_the_round(self):
        script = arm_runner.render_round_script(self.plan, "A1-instrument", 0, "/exp", "~/.coord-dsh.env")
        for run in arm_runner.expand_runs(self.plan):
            if run.arm == "A1-instrument" and run.round_index == 0:
                self.assertIn(run.label, script)

    def test_round_scripts_never_contain_the_prompt_text(self):
        plan = base_plan(
            tasks=[
                {"taskId": "T-1", "intentGroup": "G-1", "developer": "d1", "prompt": "`rm -rf /` and $HOME"},
                {"taskId": "T-2", "intentGroup": "G-1", "developer": "d2", "prompt": "p2"},
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            arm_runner.stage(plan, Path(tmp), "/exp", "~/.coord-dsh.env")
            scripts = list((Path(tmp) / "round-scripts").glob("*.sh"))
            self.assertTrue(scripts)
            for script in scripts:
                self.assertNotIn("rm -rf /", script.read_text(encoding="utf-8"))


class RunGuardTest(unittest.TestCase):
    """`run`'s guards fire before any SSH, so they are testable offline."""

    def _args(self, tmp, status, resume):
        import argparse

        plan = base_plan(status=status)
        plan_path = Path(tmp) / "plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        results = Path(tmp) / "results"
        results.mkdir(exist_ok=True)
        return argparse.Namespace(
            plan=str(plan_path), results=str(results), only_arm=None, only_round=None,
            json=False, allow_skeleton=False, resume=resume,
        )

    def test_full_run_refuses_to_double_count_an_existing_rounds_file(self):
        # The run appends, so re-running into the same directory would count every round twice
        # and the arm summary would show twice as many rounds of plausible-looking evidence.
        with tempfile.TemporaryDirectory() as tmp:
            args = self._args(tmp, "frozen", resume=False)
            (Path(args.results) / "rounds.jsonl").write_text("{}\n", encoding="utf-8")
            self.assertEqual(arm_runner._cmd_run(args), 2)

    def test_skeleton_plan_is_refused_before_anything_else(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self._args(tmp, "skeleton", resume=False)
            self.assertEqual(arm_runner._cmd_run(args), 2)

    def test_frozen_plan_without_ssh_credentials_fails_loudly_not_silently(self):
        # No rounds.jsonl, a frozen plan, and no DSH_SSH_HOST. The failure must be a refusal to
        # connect, never a traceback that could be mistaken for a harness bug -- and never a 0.
        with tempfile.TemporaryDirectory() as tmp:
            args = self._args(tmp, "frozen", resume=False)
            import os

            saved = {k: os.environ.pop(k, None) for k in ("DSH_SSH_HOST", "DSH_SSH_PASSWORD")}
            try:
                try:
                    code = arm_runner._cmd_run(args)
                except ImportError as exc:  # paramiko is only needed for a live run
                    self.skipTest(f"paramiko is not installed: {exc}")
                except SystemExit as exc:  # remote.connect() refuses without credentials
                    code = exc.code if isinstance(exc.code, int) else 2
            finally:
                for key, value in saved.items():
                    if value is not None:
                        os.environ[key] = value
            self.assertNotEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
