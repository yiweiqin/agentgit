"""Validate Gate A annotation sheets against the frozen manual and preregistration.

The validator enforces the mechanical parts of `preregistration.md` §4 (hard
constraints) and checks that every evidence reference resolves inside the frozen
annotation packet. It cannot and does not judge whether a label is *correct*.

Exit codes:

    0  no errors (warnings are allowed; a fully blank sheet validates with warnings)
    1  at least one error
    2  the sheet file or a referenced packet is missing / integrity check failed

Usage:

    python 03_基准与标注/benchmark/real-history/flask/git-history/validate_annotations.py
    python 03_基准与标注/benchmark/real-history/flask/git-history/validate_annotations.py \
        --labels annotation/labels_v1.jsonl --require-adjudication
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ANNOTATION_DIR = ROOT / "annotation"
PACKETS_DIR = ANNOTATION_DIR / "packets"

LABELS = ("TC", "BC", "AC", "RT", "RI", "CC", "LF", "UA", "ID")
DEFAULT_VALUES = {"yes", "no", "uncertain"}
ID_VALUES = {"yes", "no", "possible_ID", "uncertain"}
CONFIDENCES = {"high", "medium", "low"}
UNAVAILABLE_STATUS = {"unavailable", "not_executed", "not_collected", "skipped", "not_declared"}
LF_SCREENING_PREFIX = "prediction_view.shared_entities"

# A path is one or more dotted segments, each optionally carrying list indexes.
# Indexes may appear mid-path (manual §2 uses `...repair_or_revert_history[0].sha`),
# so the pattern cannot be restricted to trailing indexes.
RE_REF = re.compile(
    r"^(?P<path>[A-Za-z_]\w*(?:\[\d+\])*(?:\.[A-Za-z_]\w*(?:\[\d+\])*)*)\s*(?:::\s*(?P<note>.*))?$"
)
RE_SEGMENT = re.compile(r"^(?P<name>[A-Za-z_]\w*)(?P<indexes>(?:\[\d+\])*)$")
RE_INDEX = re.compile(r"\[(\d+)\]")

COST_FIELDS = ("extra_modified_lines", "extra_human_minutes", "extra_test_rounds", "reverts", "delay_days")

BC_EVIDENCE_PREFIXES = (
    "result_view.post_integration_tests",
    "result_view.repair_or_revert_history",
    "prediction_view.tasks.A.acceptance_criteria",
    "prediction_view.tasks.B.acceptance_criteria",
)


class Report:
    def __init__(self) -> None:
        self.errors: list[dict] = []
        self.warnings: list[dict] = []
        self.stats: dict = {}

    def error(self, scenario: str, code: str, message: str, where: str = "") -> None:
        self.errors.append({"scenario_id": scenario, "code": code, "message": message, "where": where})

    def warn(self, scenario: str, code: str, message: str, where: str = "") -> None:
        self.warnings.append({"scenario_id": scenario, "code": code, "message": message, "where": where})


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def resolve(packet: dict, ref: str) -> tuple[bool, object, str]:
    """Resolve a dotted path with optional [i] indexes against the packet."""
    node: object = packet
    for segment in ref.split("."):
        match = RE_SEGMENT.match(segment)
        if not match:
            return False, None, f"malformed segment {segment!r}"
        name = match.group("name")
        if not isinstance(node, dict) or name not in node:
            return False, None, f"missing key {name!r}"
        node = node[name]
        for index in RE_INDEX.findall(match.group("indexes")):
            if not isinstance(node, list):
                return False, None, f"{name} is not a list"
            position = int(index)
            if position >= len(node):
                return False, None, f"{name}[{position}] out of range ({len(node)} items)"
            node = node[position]
    return True, node, ""


def check_missing_ref(packet: dict, ref: str) -> tuple[bool, str]:
    """A `packet_missing:` ref is only legal when the target is explicitly unavailable."""
    ok, node, why = resolve(packet, ref)
    if ok and isinstance(node, dict) and node.get("status") in UNAVAILABLE_STATUS:
        return True, ""

    parts = ref.split(".")
    if len(parts) >= 2:
        parent_ok, parent, _ = resolve(packet, ".".join(parts[:-1]))
        key = parts[-1].split("[")[0]
        if parent_ok and isinstance(parent, dict):
            if parent.get("status") in UNAVAILABLE_STATUS:
                return True, ""
            status_value = parent.get(f"{key}_status")
            if status_value in UNAVAILABLE_STATUS:
                return True, ""
            if ok and node in (None, [], "") and status_value is None and f"{key}_status" not in parent:
                return False, (
                    f"{ref} resolves to an empty value but the packet does not mark it as unavailable; "
                    "`packet_missing:` is not justified here"
                )
    if ok:
        return False, (
            f"{ref} resolves to a present value; `packet_missing:` must only reference fields the packet "
            "explicitly marks unavailable"
        )
    return False, f"{ref} does not exist in the packet at all ({why})"


def is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_label(
    report: Report,
    scenario: str,
    packet: dict,
    phase: str,
    annotator: str,
    label: str,
    entry: object,
    cost: dict | None,
) -> str | None:
    where = f"{phase}.{annotator}.{label}"

    if not isinstance(entry, dict):
        report.error(scenario, "E_STRUCTURE", f"{label} entry must be an object", where)
        return None

    value = entry.get("value")
    confidence = entry.get("confidence")
    evidence = entry.get("evidence")

    allowed = ID_VALUES if label == "ID" else DEFAULT_VALUES
    if value is not None and value not in allowed:
        report.error(scenario, "E_VALUE_DOMAIN", f"value {value!r} not in {sorted(allowed)}", where)
        value = None

    if confidence is not None and confidence not in CONFIDENCES:
        report.error(scenario, "E_CONFIDENCE_DOMAIN", f"confidence {confidence!r} not in {sorted(CONFIDENCES)}", where)
        confidence = None

    if not isinstance(evidence, list):
        report.error(scenario, "E_EVIDENCE_TYPE", "evidence must be a list", where)
        evidence = []

    # H1 / H2 / H7 evidence discipline
    if value is None and confidence is not None:
        report.error(scenario, "E_H1_ORPHAN_CONFIDENCE", "confidence set while value is null", where)
    if confidence is not None and value is None:
        confidence = None
    if value in ("yes", "possible_ID") and not evidence:
        report.error(scenario, "E_H2_MISSING_EVIDENCE", f"value={value} requires non-empty evidence", where)
    if confidence == "high" and not evidence:
        report.error(scenario, "E_H1_HIGH_NO_EVIDENCE", "confidence=high requires non-empty evidence", where)

    # evidence references must resolve inside the frozen packet
    for ref in evidence:
        if not isinstance(ref, str):
            report.error(scenario, "E_EVIDENCE_TYPE", f"evidence element must be a string, got {type(ref).__name__}", where)
            continue
        text = ref.strip()
        if not text:
            report.error(scenario, "E_EVIDENCE_EMPTY", "blank evidence reference", where)
            continue
        if text.startswith("packet_missing:"):
            target = text[len("packet_missing:") :].strip()
            ok, why = check_missing_ref(packet, target)
            if not ok:
                report.error(scenario, "E_EVIDENCE_MISSING_UNJUSTIFIED", why, where)
            continue
        match = RE_REF.match(text)
        if not match:
            report.error(
                scenario,
                "E_EVIDENCE_SYNTAX",
                f"{text!r} is not a resolvable packet path; use `path :: note` form (see manual §2)",
                where,
            )
            continue
        ok, node, why = resolve(packet, match.group("path"))
        if not ok:
            report.error(scenario, "E_EVIDENCE_UNRESOLVED", f"{match.group('path')}: {why}", where)
        elif node is None:
            report.warn(scenario, "W_EVIDENCE_NULL", f"{match.group('path')} resolves to null", where)

    # RT auxiliary ratio
    if label == "RT":
        ratio = entry.get("overlap_ratio")
        if ratio is not None and not (is_number(ratio) and 0.0 <= float(ratio) <= 1.0):
            report.error(scenario, "E_RT_OVERLAP_RANGE", f"overlap_ratio {ratio!r} must be within [0, 1] or null", where)

    # H4: BC evidence type discipline
    if label == "BC" and value == "yes":
        usable = [ref for ref in evidence if isinstance(ref, str)]
        typed = [ref for ref in usable if ref.strip().startswith(BC_EVIDENCE_PREFIXES)]
        if not typed:
            report.error(
                scenario,
                "E_H4_BC_EVIDENCE_TYPE",
                "BC=yes requires evidence of a type allowed by manual §3.2 "
                "(post-integration test failure / acceptance-test failure / contract break / later repair-or-revert)",
                where,
            )
        else:
            only_tests = all(ref.strip().startswith("result_view.post_integration_tests") for ref in typed)
            tests_status = (
                ((packet.get("result_view") or {}).get("post_integration_tests") or {}).get("status")
            )
            if only_tests and tests_status != "available":
                report.error(
                    scenario,
                    "E_H4_BC_TESTS_NOT_EXECUTED",
                    f"BC=yes is anchored only on post_integration_tests whose status is {tests_status!r}; "
                    "unmeasured tests cannot support BC=yes",
                    where,
                )

    # H9: LF=yes must not rest on the path/symbol overlap screening signal alone
    if label == "LF" and value == "yes":
        usable = [ref for ref in evidence if isinstance(ref, str) and not ref.strip().startswith("packet_missing:")]
        non_screening = [ref for ref in usable if not ref.strip().startswith(LF_SCREENING_PREFIX)]
        if not non_screening:
            report.error(
                scenario,
                "E_H9_LF_SCREENING_ONLY",
                "LF=yes requires at least one evidence reference that is not "
                f"`{LF_SCREENING_PREFIX}.*`; path/symbol overlap is a screening signal and never a "
                "legibility-failure label (manual §3.9 / preregistration H9)",
                where,
            )

    # H3: ID=yes needs numeric cost evidence
    if label == "ID" and value == "yes":
        if not isinstance(cost, dict):
            report.error(scenario, "E_H3_ID_NO_COST_BLOCK", "ID=yes requires a cost_evidence block", where)
        else:
            numeric = [f for f in COST_FIELDS if is_number(cost.get(f)) and float(cost[f]) > 0]
            if not numeric:
                report.error(
                    scenario,
                    "E_H3_ID_NO_COST",
                    "ID=yes requires at least one positive numeric cost field "
                    f"({', '.join(COST_FIELDS)}); otherwise record `possible_ID`",
                    where,
                )

    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", default="annotation/labels_v1.blank.jsonl", help="annotation sheet to validate")
    parser.add_argument(
        "--report",
        default="annotation/validation_report.json",
        help="where to write the machine-readable validation report",
    )
    parser.add_argument("--require-adjudication", action="store_true", help="fail when disagreements are not adjudicated")
    parser.add_argument(
        "--require-complete",
        action="store_true",
        help="fail when any label is still null (use once annotators have finished)",
    )
    args = parser.parse_args()

    labels_path = Path(args.labels)
    if not labels_path.is_absolute():
        labels_path = ROOT / labels_path
    if not labels_path.exists():
        print(json.dumps({"error": f"annotation sheet not found: {labels_path}"}, ensure_ascii=False))
        return 2

    report = Report()
    rows = [json.loads(line) for line in labels_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    index_path = PACKETS_DIR / "index.json"
    if not index_path.exists():
        print(json.dumps({"error": f"packet index not found: {index_path}; run build_annotation_packets.py"}, ensure_ascii=False))
        return 2
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index_by_id = {row["scenario_id"]: row for row in index.get("packets", [])}

    pending = 0
    completed = 0
    disagreements = 0
    adjudicated = 0

    for row in rows:
        scenario = row.get("scenario_id", "<unknown>")
        packet_rel = row.get("packet_path")
        record = index_by_id.get(scenario)

        if not packet_rel or not record:
            report.error(scenario, "E_PACKET_UNKNOWN", "scenario is not present in annotation/packets/index.json")
            continue

        packet_path = ROOT / packet_rel
        if not packet_path.exists():
            report.error(scenario, "E_PACKET_MISSING", f"packet file not found: {packet_path}")
            continue

        raw = packet_path.read_bytes()
        digest = sha256_bytes(raw)
        if digest != record.get("packet_sha256"):
            report.error(scenario, "E_PACKET_DRIFT", "packet content does not match the frozen index hash")
        if row.get("packet_sha256") and row["packet_sha256"] != digest:
            report.error(
                scenario,
                "E_SHEET_PACKET_MISMATCH",
                "annotation sheet was created against a different packet revision",
            )

        packet = json.loads(raw.decode("utf-8"))

        locked = (row.get("phase_1") or {}).get("locked_at")
        phase_2_filled = False

        for phase in ("phase_1", "phase_2"):
            block = row.get(phase) or {}
            if phase == "phase_2":
                cost_block = block.get("cost_evidence") or {}
            else:
                cost_block = {}

            for annotator in ("annotator_A", "annotator_B"):
                labels = block.get(annotator)
                if not isinstance(labels, dict):
                    report.error(scenario, "E_STRUCTURE", f"{phase}.{annotator} missing", f"{phase}.{annotator}")
                    continue
                missing_keys = [label for label in LABELS if label not in labels]
                if missing_keys:
                    report.error(
                        scenario,
                        "E_STRUCTURE_MISSING_LABELS",
                        f"missing labels: {', '.join(missing_keys)}",
                        f"{phase}.{annotator}",
                    )

                for label in LABELS:
                    entry = labels.get(label)
                    cost = cost_block.get(annotator)
                    value = validate_label(report, scenario, packet, phase, annotator, label, entry, cost)
                    if label == "ID" and cost is not None and not isinstance(cost, dict):
                        report.error(scenario, "E_STRUCTURE", "cost_evidence entry must be an object", f"{phase}.{annotator}")
                    if phase == "phase_2" and value is not None:
                        phase_2_filled = True

        if phase_2_filled and not locked:
            report.error(
                scenario,
                "E_H5_VIEW_ORDER",
                "phase_2 contains labels but phase_1.locked_at is unset; the prediction view must be locked first",
                "phase_1.locked_at",
            )

        # compare phase_2 as the final label set
        final_a = (row.get("phase_2") or {}).get("annotator_A") or {}
        final_b = (row.get("phase_2") or {}).get("annotator_B") or {}
        decisions = ((row.get("adjudication") or {}).get("decisions")) or []
        decided_labels = {d.get("label") for d in decisions if isinstance(d, dict)}

        for label in LABELS:
            a = (final_a.get(label) or {}).get("value")
            b = (final_b.get(label) or {}).get("value")
            if a is None or b is None:
                pending += 1
                continue
            if a != b:
                disagreements += 1
                if label in decided_labels:
                    adjudicated += 1
                elif args.require_adjudication:
                    report.error(
                        scenario,
                        "E_ADJUDICATION_MISSING",
                        f"annotators disagree on {label} but no adjudication decision is recorded",
                        label,
                    )
                else:
                    report.warn(
                        scenario,
                        "W_ADJUDICATION_PENDING",
                        f"annotators disagree on {label}; route to the third annotator",
                        label,
                    )
            else:
                completed += 1

    report.stats = {
        "sheet": str(labels_path),
        "records": len(rows),
        "label_pairs_complete": completed,
        "label_pairs_pending": pending,
        "disagreements": disagreements,
        "adjudicated": adjudicated,
        "errors": len(report.errors),
        "warnings": len(report.warnings),
    }

    if args.require_complete and pending:
        report.error("<global>", "E_INCOMPLETE", f"{pending} label pairs are still unset")

    result = {
        "status": "failed" if report.errors else ("blank_or_partial" if pending else "ok"),
        "stats": report.stats,
        "errors": report.errors,
        "warnings": report.warnings,
    }

    out_path = Path(args.report)
    if not out_path.is_absolute():
        out_path = ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes((json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    print(json.dumps({k: v for k, v in result.items() if k not in ("errors", "warnings")}, ensure_ascii=False))
    for item in report.errors[:40]:
        print(f"ERROR  [{item['scenario_id']}] {item['code']} @ {item['where']}: {item['message']}", file=sys.stderr)
    for item in report.warnings[:20]:
        print(f"WARN   [{item['scenario_id']}] {item['code']} @ {item['where']}: {item['message']}", file=sys.stderr)
    if len(report.errors) > 40:
        print(f"... {len(report.errors) - 40} more errors (see {out_path})", file=sys.stderr)

    return 1 if report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
