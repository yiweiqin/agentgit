"""Regression tests for the Gate A annotation pipeline validators.

These tests prove the validator actually fires. A validator that never rejects
anything would let an invalid annotation sheet be reported as "ready", which is
exactly the failure mode Gate A is supposed to prevent.

Run:

    python 03_基准与标注/benchmark/real-history/flask/git-history/tests/test_annotation_pipeline.py
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ANNOTATION = ROOT / "annotation"
BLANK = ANNOTATION / "labels_v1.blank.jsonl"
VALIDATOR = ROOT / "validate_annotations.py"
INTER_RATER = ROOT / "inter_rater.py"
LABELS = ("TC", "BC", "AC", "RT", "RI", "CC", "LF", "UA", "ID")


def load_records() -> list[dict]:
    return [json.loads(line) for line in BLANK.read_text(encoding="utf-8").splitlines() if line.strip()]


EXPECTED_LABEL_PAIRS = len(load_records()) * len(LABELS)


def run_validator(records: list[dict], extra: list[str] | None = None) -> tuple[int, dict]:
    with tempfile.TemporaryDirectory() as tmp:
        sheet = Path(tmp) / "sheet.jsonl"
        sheet.write_bytes(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records).encode("utf-8")
        )
        report = Path(tmp) / "report.json"
        proc = subprocess.run(
            [sys.executable, str(VALIDATOR), "--labels", str(sheet), "--report", str(report), *(extra or [])],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        payload = json.loads(report.read_text(encoding="utf-8")) if report.exists() else {}
        return proc.returncode, payload


def codes(payload: dict) -> set[str]:
    return {item["code"] for item in payload.get("errors", [])}


def blank_label() -> dict:
    return {"value": None, "confidence": None, "evidence": [], "notes": ""}


def set_label(record: dict, phase: str, annotator: str, label: str, **fields) -> None:
    entry = record[phase][annotator][label]
    entry.update(fields)


def fill_all_no(record: dict, locked: str = "2026-09-14T00:00:00Z") -> None:
    record["phase_1"]["locked_at"] = locked
    for annotator in ("annotator_A", "annotator_B"):
        for label in LABELS:
            record["phase_2"][annotator][label] = {
                "value": "no",
                "confidence": "medium",
                "evidence": [],
                "notes": "negative control under available evidence",
            }
            if label == "RT":
                record["phase_2"][annotator][label]["overlap_ratio"] = 0.0


class ValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = load_records()

    def mutate(self, fn, index: int = 0) -> list[dict]:
        records = copy.deepcopy(self.base)
        fn(records[index])
        return records

    def test_blank_sheet_is_valid_but_pending(self) -> None:
        code, payload = run_validator(copy.deepcopy(self.base))
        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["stats"]["label_pairs_pending"], EXPECTED_LABEL_PAIRS)
        self.assertEqual(payload["errors"], [])

    def test_fully_annotated_negative_controls_pass(self) -> None:
        records = self.mutate(fill_all_no)
        code, payload = run_validator(records)
        self.assertEqual(code, 0, payload["errors"])
        self.assertEqual(payload["stats"]["disagreements"], 0)

    def test_high_confidence_without_evidence_is_rejected(self) -> None:
        records = self.mutate(lambda r: set_label(r, "phase_2", "annotator_A", "TC", value="no", confidence="high"))
        code, payload = run_validator(records)
        self.assertEqual(code, 1)
        self.assertIn("E_H1_HIGH_NO_EVIDENCE", codes(payload))

    def test_yes_without_evidence_is_rejected(self) -> None:
        records = self.mutate(lambda r: set_label(r, "phase_2", "annotator_A", "RT", value="yes", confidence="low"))
        code, payload = run_validator(records)
        self.assertIn("E_H2_MISSING_EVIDENCE", codes(payload))

    def test_unresolved_evidence_path_is_rejected(self) -> None:
        records = self.mutate(
            lambda r: set_label(
                r, "phase_2", "annotator_A", "TC", value="no", confidence="low", evidence=["prediction_view.nope"]
            )
        )
        code, payload = run_validator(records)
        self.assertIn("E_EVIDENCE_UNRESOLVED", codes(payload))

    def test_indexed_evidence_path_with_trailing_segment_is_resolved(self) -> None:
        """Manual §2 uses `path[0].field`; indexes must work mid-path, not only at the end."""
        records = self.mutate(
            lambda r: set_label(
                r,
                "phase_2",
                "annotator_A",
                "TC",
                value="no",
                confidence="low",
                evidence=["result_view.repair_or_revert_history.entries[0].subject"],
            )
        )
        code, payload = run_validator(records)
        self.assertNotIn("E_EVIDENCE_SYNTAX", codes(payload))
        self.assertNotIn("E_EVIDENCE_UNRESOLVED", codes(payload))

    def test_unjustified_packet_missing_is_rejected(self) -> None:
        records = self.mutate(
            lambda r: set_label(
                r,
                "phase_2",
                "annotator_A",
                "CC",
                value="uncertain",
                confidence="low",
                evidence=["packet_missing:prediction_view.tasks.A.title"],
            )
        )
        code, payload = run_validator(records)
        self.assertIn("E_EVIDENCE_MISSING_UNJUSTIFIED", codes(payload))

    def test_justified_packet_missing_is_accepted(self) -> None:
        def mutate(r):
            # H5: phase_2 is only valid once the prediction view is locked, so this
            # test must lock phase_1 before exercising the evidence rule.
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(
                r,
                "phase_2",
                "annotator_A",
                "UA",
                value="uncertain",
                confidence="low",
                evidence=["packet_missing:prediction_view.agent_context_summary"],
            )

        records = self.mutate(mutate)
        code, payload = run_validator(records)
        self.assertNotIn("E_EVIDENCE_MISSING_UNJUSTIFIED", codes(payload))
        self.assertEqual(code, 0, payload["errors"])

    def test_id_yes_without_cost_is_rejected(self) -> None:
        def mutate(r):
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(
                r,
                "phase_2",
                "annotator_A",
                "ID",
                value="yes",
                confidence="low",
                evidence=["result_view.repair_or_revert_history.entries[0].subject"],
            )

        code, payload = run_validator(self.mutate(mutate))
        self.assertIn("E_H3_ID_NO_COST", codes(payload))

    def test_id_yes_with_cost_is_accepted(self) -> None:
        def mutate(r):
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(
                r,
                "phase_2",
                "annotator_A",
                "ID",
                value="yes",
                confidence="low",
                evidence=["result_view.repair_or_revert_history.entries[0].subject"],
            )
            r["phase_2"]["cost_evidence"]["annotator_A"]["extra_modified_lines"] = 12

        code, payload = run_validator(self.mutate(mutate))
        self.assertNotIn("E_H3_ID_NO_COST", codes(payload))
        self.assertEqual(code, 0, payload["errors"])

    def test_bc_yes_with_wrong_evidence_type_is_rejected(self) -> None:
        def mutate(r):
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(
                r,
                "phase_2",
                "annotator_A",
                "BC",
                value="yes",
                confidence="high",
                evidence=["prediction_view.change_sets.A.stats.additions"],
            )

        code, payload = run_validator(self.mutate(mutate))
        self.assertIn("E_H4_BC_EVIDENCE_TYPE", codes(payload))

    def test_bc_yes_anchored_on_unexecuted_tests_is_rejected(self) -> None:
        def mutate(r):
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(
                r,
                "phase_2",
                "annotator_A",
                "BC",
                value="yes",
                confidence="high",
                evidence=["result_view.post_integration_tests"],
            )

        code, payload = run_validator(self.mutate(mutate))
        self.assertIn("E_H4_BC_TESTS_NOT_EXECUTED", codes(payload))

    def test_bc_yes_with_repair_evidence_is_accepted(self) -> None:
        def mutate(r):
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(
                r,
                "phase_2",
                "annotator_A",
                "BC",
                value="yes",
                confidence="high",
                evidence=["result_view.repair_or_revert_history.entries[0].subject"],
            )

        code, payload = run_validator(self.mutate(mutate))
        self.assertNotIn("E_H4_BC_EVIDENCE_TYPE", codes(payload))
        self.assertNotIn("E_H4_BC_TESTS_NOT_EXECUTED", codes(payload))

    def test_lf_yes_on_screening_signal_only_is_rejected(self) -> None:
        """H9: path/symbol overlap is a screening signal and can never carry an LF=yes label."""
        index = next(
            i
            for i, record in enumerate(self.base)
            if record["scenario_id"] == "flask-pr-5812-pr-5808"
        )

        def mutate(r):
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(
                r,
                "phase_2",
                "annotator_A",
                "LF",
                value="yes",
                confidence="high",
                evidence=["prediction_view.shared_entities.production_files[0]"],
            )

        code, payload = run_validator(self.mutate(mutate, index))
        self.assertIn("E_H9_LF_SCREENING_ONLY", codes(payload))

    def test_lf_is_not_judgeable_in_this_candidate_set(self) -> None:
        """D3 known limit: the frozen candidates cannot supply symbol-level repeated-touch evidence.

        This pins the packet-level precondition so that a future candidate expansion which
        *does* make LF judgeable has to update this test deliberately, rather than silently.
        """
        all_verdicts = {}
        for scenario_id in (record["scenario_id"] for record in self.base):
            packet = json.loads((ANNOTATION / "packets" / f"{scenario_id}.json").read_text(encoding="utf-8"))
            evidence = packet["prediction_view"]["repeated_touch_evidence"]
            all_verdicts[scenario_id] = evidence["lf_judgeable_from_this_packet"]
        self.assertFalse(
            any(all_verdicts.values()),
            f"LF unexpectedly judgeable in some packet; D3 must be updated: {all_verdicts}",
        )
        self.assertTrue(
            all(
                record["phase_1"]["annotator_A"]["LF"]["value"] is None for record in self.base
            )
        )

    def test_lf_yes_with_repeated_touch_evidence_is_accepted(self) -> None:
        index = next(
            i
            for i, record in enumerate(self.base)
            if record["scenario_id"] == "flask-pr-5812-pr-5808"
        )

        def mutate(r):
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(
                r,
                "phase_2",
                "annotator_A",
                "LF",
                value="yes",
                confidence="high",
                evidence=[
                    "prediction_view.repeated_touch_evidence.symbols[0].followup_merge_count",
                    "prediction_view.repeated_touch_evidence.lf_judgeability_verdict",
                ],
            )

        code, payload = run_validator(self.mutate(mutate, index))
        self.assertNotIn("E_H9_LF_SCREENING_ONLY", codes(payload))
        self.assertEqual(code, 0, payload["errors"])

    def test_lf_no_is_allowed_without_evidence(self) -> None:
        """LF must not be treated as a conflict label: a bare `no` is mechanically valid."""
        def mutate(r):
            r["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
            set_label(r, "phase_2", "annotator_A", "LF", value="no", confidence="medium")

        code, payload = run_validator(self.mutate(mutate))
        self.assertNotIn("E_H9_LF_SCREENING_ONLY", codes(payload))
        self.assertEqual(code, 0, payload["errors"])

    def test_phase2_before_lock_is_rejected(self) -> None:
        records = self.mutate(lambda r: set_label(r, "phase_2", "annotator_A", "TC", value="no", confidence="low"))
        code, payload = run_validator(records)
        self.assertIn("E_H5_VIEW_ORDER", codes(payload))

    def test_value_domain_is_enforced(self) -> None:
        records = self.mutate(
            lambda r: set_label(r, "phase_2", "annotator_A", "TC", value="maybe", confidence="low", evidence=["prediction_view.tasks.A.title"])
        )
        code, payload = run_validator(records)
        self.assertIn("E_VALUE_DOMAIN", codes(payload))

    def test_overlap_ratio_range_is_enforced(self) -> None:
        records = self.mutate(
            lambda r: set_label(r, "phase_2", "annotator_A", "RT", value="no", confidence="low", overlap_ratio=1.5)
        )
        code, payload = run_validator(records)
        self.assertIn("E_RT_OVERLAP_RANGE", codes(payload))

    def test_sheet_packet_mismatch_is_detected(self) -> None:
        records = copy.deepcopy(self.base)
        records[0]["packet_sha256"] = "0" * 64
        code, payload = run_validator(records)
        self.assertIn("E_SHEET_PACKET_MISMATCH", codes(payload))

    def test_require_complete_flags_pending_labels(self) -> None:
        code, payload = run_validator(copy.deepcopy(self.base), ["--require-complete"])
        self.assertIn("E_INCOMPLETE", codes(payload))

    def test_require_adjudication_flags_unadjudicated_disagreement(self) -> None:
        def mutate(r):
            fill_all_no(r)
            set_label(r, "phase_2", "annotator_B", "TC", value="uncertain", confidence="low")

        code, payload = run_validator(self.mutate(mutate), ["--require-adjudication"])
        self.assertIn("E_ADJUDICATION_MISSING", codes(payload))
        self.assertEqual(payload["stats"]["disagreements"], 1)


class InterRaterTests(unittest.TestCase):
    def test_inter_rater_runs_on_blank_sheet_without_claiming_a_result(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(INTER_RATER)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["status"], "not_yet_computable")
        self.assertEqual(payload["scenarios"], 7)
        self.assertFalse(payload["claim_allowed"])

    def run_inter_rater(self, records: list[dict]) -> tuple[int, dict, dict, list[dict]]:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            sheet = tmpdir / "sheet.jsonl"
            sheet.write_bytes(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records).encode("utf-8")
            )
            report = tmpdir / "report.json"
            markdown = tmpdir / "report.md"
            queue = tmpdir / "queue.jsonl"
            proc = subprocess.run(
                [
                    sys.executable,
                    str(INTER_RATER),
                    "--labels",
                    str(sheet),
                    "--report-json",
                    str(report),
                    "--report-md",
                    str(markdown),
                    "--adjudication-queue",
                    str(queue),
                    "--bootstrap",
                    "200",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            payload = json.loads(report.read_text(encoding="utf-8")) if report.exists() else {}
            summary = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else {}
            queued = (
                [json.loads(line) for line in queue.read_text(encoding="utf-8").splitlines() if line.strip()]
                if queue.exists()
                else []
            )
            return proc.returncode, summary, payload, queued

    def fill_uniform(self, record: dict, value: str) -> None:
        """Fills both phases for both annotators with one value (agreement by construction)."""
        record["phase_1"]["locked_at"] = "2026-09-14T00:00:00Z"
        for phase in ("phase_1", "phase_2"):
            for annotator in ("annotator_A", "annotator_B"):
                for label in LABELS:
                    entry = {"value": value, "confidence": "medium", "evidence": [], "notes": ""}
                    if label == "RT":
                        entry["overlap_ratio"] = 0.0
                    record[phase][annotator][label] = entry

    def test_all_negative_sheet_agrees_but_cannot_claim_a_gate(self) -> None:
        records = copy.deepcopy(self.blank)
        for record in records:
            self.fill_uniform(record, "no")
        code, summary, payload, queued = self.run_inter_rater(records)
        self.assertEqual(code, 0, summary)
        self.assertFalse(payload["claim_allowed"])
        self.assertEqual(summary["label_pairs_pending"], 0)
        self.assertEqual(queued, [])
        # Every pair agrees, but the marginal distribution is degenerate: the
        # agreement statistics are undefined and the gate is NOT met.
        tc = payload["metrics"]["phase_2"]["TC"]
        self.assertEqual(tc["raw_agreement"], 1.0)
        self.assertIsNone(tc["krippendorff_alpha_nominal"])
        self.assertIn("no_expected_disagreement", tc["krippendorff_undefined_reason"])
        self.assertTrue(any("not evaluable" in gate["status"] or "failed" in gate["status"] for gate in payload["gates"]))

    def test_disagreement_is_queued_for_adjudication(self) -> None:
        records = copy.deepcopy(self.blank)
        for record in records:
            self.fill_uniform(record, "no")
        records[0]["phase_2"]["annotator_B"]["TC"]["value"] = "uncertain"
        code, summary, payload, queued = self.run_inter_rater(records)
        self.assertEqual(code, 0, summary)
        self.assertEqual(payload["counts"]["label_pairs_disagreement"], 1)
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0]["label"], "TC")
        self.assertEqual(queued[0]["scenario_id"], records[0]["scenario_id"])
        self.assertFalse(payload["claim_allowed"])

    def test_partial_sheet_cannot_claim_a_gate(self) -> None:
        records = copy.deepcopy(self.blank)
        self.fill_uniform(records[0], "no")
        code, summary, payload, _queued = self.run_inter_rater(records)
        self.assertEqual(code, 0, summary)
        self.assertEqual(payload["status"], "partial_no_claim")
        self.assertFalse(payload["claim_allowed"])
        self.assertEqual(summary["label_pairs_complete"], len(LABELS))
        self.assertEqual(summary["label_pairs_pending"], (len(records) - 1) * len(LABELS))

    @property
    def blank(self) -> list[dict]:
        return load_records()


if __name__ == "__main__":
    unittest.main(verbosity=2)
