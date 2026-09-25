"""Compute Gate A inter-rater agreement for the Flask real-history pilot.

This is the step-7 script of `annotation/annotation_manual.md` §5 and the
operationalization of `annotation/preregistration.md` §5 (readiness gates) and
§6 (statistical plan). It reads the frozen annotation sheet, computes per-label
agreement for both phases, evaluates the registered thresholds, and emits the
third-annotator adjudication queue.

What this script deliberately does NOT do:

* It never invents, imputes or back-fills a label. Unset labels are counted as
  `missing`, never as `no`.
* It never writes anything into `annotation/packets/`, so the frozen packet
  hashes (and therefore the sheet/packet binding) cannot drift.
* It never reads `adjudication.md`, `strict_candidate_adjudication.md`,
  `screening_report.json` or any screener opinion (H7). Its only inputs are the
  annotation sheet and `annotation/packets/index.json`.
* It refuses to declare a Gate A result unless every registered gate passes.
  A blank or partial sheet yields `status = "not_yet_computable"` /
  `"partial_no_claim"` and `claim_allowed = false`.

Metrics per label, per phase (all pure-python, no third-party dependencies):

* raw agreement over scenarios where both annotators recorded a value;
* Cohen's kappa on the preregistered binary collapse (`yes` = positive;
  `no` / `uncertain` / `possible_ID` = negative, preregistration §6);
* Krippendorff's alpha (nominal), via the coincidence matrix, which tolerates
  units where only one annotator rated;
* Gwet's AC1 (nominal), reported alongside kappa because the pilot's candidate
  set is negative-control heavy and kappa is prevalence-sensitive.

Bootstrap intervals resample *scenarios*. The preregistration says "标注者对
层面的 bootstrap"; with exactly two annotators that resampling is degenerate
(there is one annotator pair), so unit-level resampling is implemented and the
substitution is reported as a documented deviation that must be logged in
`adjudication_log.md`.

Usage (from the research folder root):

    python 03_基准与标注/benchmark/real-history/flask/git-history/inter_rater.py
    python .../inter_rater.py --labels annotation/labels_v1.jsonl

Exit codes: 0 = report written (including "not yet computable"), 2 = inputs
missing or the sheet/packet binding is broken.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ANNOTATION_DIR = ROOT / "annotation"
PACKETS_DIR = ANNOTATION_DIR / "packets"

LABELS = ("TC", "BC", "AC", "RT", "RI", "CC", "LF", "UA", "ID")
CORE_LABELS = ("BC", "RT", "RI")
OBJECTIVE_LABELS = ("TC",)
EXPLORATORY_LABELS = ("AC", "CC", "UA", "LF")
CONFLICT_LABELS = ("TC", "BC", "AC")
ANNOTATORS = ("annotator_A", "annotator_B")
PHASES = ("phase_1", "phase_2")

DEFAULT_SHEET = "annotation/labels_v1.blank.jsonl"
DEFAULT_REPORT_JSON = "annotation/inter_rater_report.json"
DEFAULT_REPORT_MD = "annotation/inter_rater_report.md"
DEFAULT_QUEUE = "annotation/adjudication_queue.jsonl"

# preregistration §5 readiness gates
G1_ALPHA = 0.667
G1_ALPHA_TARGET = 0.80
G1_RAW = 0.80
G2_RAW = 0.90
G2_ALPHA = 0.80
G3_ALPHA = 0.60
G4_RAW = 0.90
G5_UNCERTAIN_SHARE = 0.30

POSITIVE_VALUE = "yes"

HIGH_CONFIDENCE = "high"


# --------------------------------------------------------------------------- #
# io helpers
# --------------------------------------------------------------------------- #
def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def relative_label(path: Path) -> str:
    """Report paths relative to the pilot root when possible, else absolute."""
    try:
        return str(path.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        return str(path)


# --------------------------------------------------------------------------- #
# agreement statistics (pure python)
# --------------------------------------------------------------------------- #
def raw_agreement(pairs: list[tuple[str, str]]) -> float | None:
    if not pairs:
        return None
    return sum(1 for a, b in pairs if a == b) / len(pairs)


def binary_collapse(value: str) -> int:
    """Preregistration §6: `yes` = positive, everything else = negative."""
    return 1 if value == POSITIVE_VALUE else 0


def cohen_kappa_binary(pairs: list[tuple[str, str]]) -> tuple[float | None, str | None]:
    if not pairs:
        return None, "no_complete_pairs"
    n = len(pairs)
    both_positive = sum(1 for a, b in pairs if binary_collapse(a) == 1 and binary_collapse(b) == 1)
    both_negative = sum(1 for a, b in pairs if binary_collapse(a) == 0 and binary_collapse(b) == 0)
    observed = (both_positive + both_negative) / n
    positive_share = (sum(binary_collapse(a) for a, _ in pairs) + sum(binary_collapse(b) for _, b in pairs)) / (2 * n)
    expected = positive_share**2 + (1 - positive_share) ** 2
    if expected >= 1.0:
        return None, "kappa_undefined_degenerate_marginals_all_negative_or_all_positive"
    return (observed - expected) / (1 - expected), None


def krippendorff_alpha_nominal(units: list[list[str]]) -> tuple[float | None, str | None]:
    """Nominal alpha from the coincidence matrix; units with one rating are dropped."""
    usable = [unit for unit in units if len(unit) >= 2]
    if not usable:
        return None, "no_units_with_two_or_more_ratings"

    coincidence: dict[tuple[str, str], float] = {}
    for unit in usable:
        m = len(unit)
        for i, value_i in enumerate(unit):
            for j, value_j in enumerate(unit):
                if i == j:
                    continue
                key = (value_i, value_j)
                coincidence[key] = coincidence.get(key, 0.0) + 1.0 / (m - 1)

    n = sum(coincidence.values())
    if n == 0:
        return None, "coincidence_matrix_empty"

    marginals: Counter[str] = Counter()
    for (value_i, _), weight in coincidence.items():
        marginals[value_i] += weight

    observed_disagreement = sum(weight for (i, j), weight in coincidence.items() if i != j)
    expected_disagreement = sum(
        marginals[i] * marginals[j] / (n - 1) for i in marginals for j in marginals if i != j
    )
    if expected_disagreement == 0:
        return None, "alpha_undefined_no_expected_disagreement_single_category"
    return 1 - observed_disagreement / expected_disagreement, None


def gwet_ac1_nominal(pairs: list[tuple[str, str]]) -> tuple[float | None, str | None]:
    if not pairs:
        return None, "no_complete_pairs"
    ratings = [value for pair in pairs for value in pair]
    total = len(ratings)
    categories = sorted(set(ratings))
    q = len(categories)
    if q < 2:
        return None, "ac1_undefined_single_observed_category"
    units = len(pairs)
    observed = sum(1 for a, b in pairs if a == b) / units
    expected = sum((ratings.count(c) / total) * (1 - ratings.count(c) / total) for c in categories) / (q - 1)
    if expected >= 1.0:
        return None, "ac1_undefined_degenerate_prevalence"
    return (observed - expected) / (1 - expected), None


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def bootstrap_interval(
    units: list[list[str]],
    pairs: list[tuple[str, str]],
    statistic: str,
    iterations: int,
    seed: int,
) -> dict:
    """Unit(scenario)-level percentile bootstrap. Documented deviation, see module docstring."""
    if iterations <= 0 or not units:
        return {"iterations": 0, "low": None, "high": None, "valid_resamples": 0, "reason": "disabled"}

    rng = random.Random(seed)
    n = len(units)
    draws: list[float] = []
    for _ in range(iterations):
        picked = [rng.randrange(n) for _ in range(n)]
        resampled_units = [units[i] for i in picked]
        resampled_pairs = [pairs[i] for i in picked]
        if statistic == "raw_agreement":
            value, _reason = raw_agreement(resampled_pairs), None
        elif statistic == "cohen_kappa_binary":
            value, _reason = cohen_kappa_binary(resampled_pairs)
        elif statistic == "krippendorff_alpha_nominal":
            value, _reason = krippendorff_alpha_nominal(resampled_units)
        elif statistic == "gwet_ac1_nominal":
            value, _reason = gwet_ac1_nominal(resampled_pairs)
        else:  # pragma: no cover - guarded by the caller
            raise ValueError(f"unknown statistic {statistic!r}")
        if value is not None:
            draws.append(float(value))

    if len(draws) < max(20, iterations // 100):
        return {
            "iterations": iterations,
            "low": None,
            "high": None,
            "valid_resamples": len(draws),
            "reason": "too_few_resamples_yielded_a_defined_statistic",
        }
    return {
        "iterations": iterations,
        "low": round(percentile(draws, 0.025), 6),
        "high": round(percentile(draws, 0.975), 6),
        "valid_resamples": len(draws),
        "point_estimate_fraction_defined": round(len(draws) / iterations, 4),
    }


# --------------------------------------------------------------------------- #
# sheet reading
# --------------------------------------------------------------------------- #
def label_entry(record: dict, phase: str, annotator: str, label: str) -> dict:
    block = (record.get(phase) or {}).get(annotator) or {}
    entry = block.get(label)
    return entry if isinstance(entry, dict) else {}


def cost_entry(record: dict, annotator: str) -> dict:
    block = ((record.get("phase_2") or {}).get("cost_evidence") or {}).get(annotator)
    return block if isinstance(block, dict) else {}


def collect(records: list[dict], phase: str, label: str) -> dict:
    """Gathers per-scenario values for one label in one phase."""
    units: list[list[str]] = []
    pairs: list[tuple[str, str]] = []
    complete: list[dict] = []
    values: list[str] = []
    missing: list[str] = []
    high_pairs: list[tuple[str, str]] = []
    high_evidence: list[bool] = []

    for record in records:
        scenario = record.get("scenario_id", "<unknown>")
        entries = {annotator: label_entry(record, phase, annotator, label) for annotator in ANNOTATORS}
        recorded = [entry.get("value") for entry in entries.values()]

        if all(value is None for value in recorded):
            missing.append(scenario)
            continue

        units.append([value for value in recorded if value is not None])
        values.extend(value for value in recorded if value is not None)

        if any(value is None for value in recorded):
            missing.append(scenario)
            continue

        pair = (recorded[0], recorded[1])
        pairs.append(pair)
        complete.append(
            {
                "scenario_id": scenario,
                "annotator_A": {
                    "value": entries["annotator_A"].get("value"),
                    "confidence": entries["annotator_A"].get("confidence"),
                    "evidence": entries["annotator_A"].get("evidence") or [],
                },
                "annotator_B": {
                    "value": entries["annotator_B"].get("value"),
                    "confidence": entries["annotator_B"].get("confidence"),
                    "evidence": entries["annotator_B"].get("evidence") or [],
                },
                "agree": pair[0] == pair[1],
            }
        )

        if all(entries[annotator].get("confidence") == HIGH_CONFIDENCE for annotator in ANNOTATORS):
            high_pairs.append(pair)
            high_evidence.append(
                all(bool(entries[annotator].get("evidence")) for annotator in ANNOTATORS)
            )

    return {
        "units": units,
        "pairs": pairs,
        "complete": complete,
        "values": values,
        "missing_scenarios": missing,
        "high_pairs": high_pairs,
        "high_evidence": high_evidence,
    }


def metrics_for(records: list[dict], phase: str, label: str, iterations: int, seed: int) -> dict:
    data = collect(records, phase, label)
    pairs = data["pairs"]
    units = data["units"]

    raw, raw_reason = raw_agreement(pairs), None
    if raw is None:
        raw_reason = "no_complete_pairs"

    kappa, kappa_reason = cohen_kappa_binary(pairs)
    alpha, alpha_reason = krippendorff_alpha_nominal(units)
    ac1, ac1_reason = gwet_ac1_nominal(pairs)

    uncertain_share = None
    if data["values"]:
        uncertain_share = sum(1 for value in data["values"] if value == "uncertain") / len(data["values"])

    high_agreement = raw_agreement(data["high_pairs"])
    evidence_complete = None
    if data["high_evidence"]:
        evidence_complete = sum(1 for flag in data["high_evidence"] if flag) / len(data["high_evidence"])

    disagreements = [row for row in data["complete"] if not row["agree"]]

    return {
        "label": label,
        "phase": phase,
        "scenarios_in_sheet": len(records),
        "scenarios_with_two_values": len(pairs),
        "scenarios_missing_at_least_one_value": len(data["missing_scenarios"]),
        "missing_scenarios": data["missing_scenarios"],
        "raw_agreement": round(raw, 6) if raw is not None else None,
        "raw_agreement_reason_if_none": raw_reason,
        "cohen_kappa_yes_vs_rest": round(kappa, 6) if kappa is not None else None,
        "cohen_kappa_undefined_reason": kappa_reason,
        "krippendorff_alpha_nominal": round(alpha, 6) if alpha is not None else None,
        "krippendorff_undefined_reason": alpha_reason,
        "gwet_ac1_nominal": round(ac1, 6) if ac1 is not None else None,
        "gwet_ac1_undefined_reason": ac1_reason,
        "uncertain_share_of_recorded_values": round(uncertain_share, 6) if uncertain_share is not None else None,
        "high_confidence_subset": {
            "scenarios": len(data["high_pairs"]),
            "raw_agreement": round(high_agreement, 6) if high_agreement is not None else None,
            "evidence_complete_rate": round(evidence_complete, 6) if evidence_complete is not None else None,
        },
        "disagreement_count": len(disagreements),
        "disagreements": disagreements,
        "bootstrap": {
            "raw_agreement": bootstrap_interval(units, pairs, "raw_agreement", iterations, seed),
            "cohen_kappa_yes_vs_rest": bootstrap_interval(units, pairs, "cohen_kappa_binary", iterations, seed),
            "krippendorff_alpha_nominal": bootstrap_interval(units, pairs, "krippendorff_alpha_nominal", iterations, seed),
            "gwet_ac1_nominal": bootstrap_interval(units, pairs, "gwet_ac1_nominal", iterations, seed),
        },
    }


def lf_conflict_cooccurrence(records: list[dict]) -> dict:
    """Preregistration §6 (v1.1): LF must be reported against TC/BC/AC co-occurrence.

    If `LF = yes` only ever occurs in samples that also carry a conflict label, LF
    has no independent construct and must be merged or withdrawn. This is computed
    on the final (phase_2) label set, counting a sample as `LF = yes` only when
    both annotators agree on it.
    """
    rows: list[dict] = []
    lf_yes_only = 0
    lf_yes_with_conflict = 0
    conflict_without_lf = 0

    for record in records:
        lf_a = label_entry(record, "phase_2", "annotator_A", "LF").get("value")
        lf_b = label_entry(record, "phase_2", "annotator_B", "LF").get("value")
        lf_agreed_yes = lf_a == "yes" and lf_b == "yes"

        conflicts = {
            label: sorted(
                {
                    value
                    for value in (
                        label_entry(record, "phase_2", "annotator_A", label).get("value"),
                        label_entry(record, "phase_2", "annotator_B", label).get("value"),
                    )
                    if value is not None
                }
            )
            for label in CONFLICT_LABELS
        }
        has_conflict = any("yes" in values for values in conflicts.values())

        if lf_agreed_yes and has_conflict:
            lf_yes_with_conflict += 1
        elif lf_agreed_yes:
            lf_yes_only += 1
        elif has_conflict:
            conflict_without_lf += 1

        if lf_agreed_yes or has_conflict:
            rows.append(
                {
                    "scenario_id": record.get("scenario_id"),
                    "LF_agreed_yes": lf_agreed_yes,
                    "LF_values": [lf_a, lf_b],
                    "conflict_values": conflicts,
                    "has_conflict": has_conflict,
                }
            )

    total_lf_yes = lf_yes_only + lf_yes_with_conflict
    if total_lf_yes == 0:
        verdict = "not_yet_computable_no_agreed_LF_yes"
        independent = None
    elif lf_yes_only == 0:
        verdict = "no_independent_construct_all_LF_yes_cooccur_with_conflict"
        independent = False
    else:
        verdict = "has_independent_cases"
        independent = True

    return {
        "status": "computed",
        "agreed_LF_yes": total_lf_yes,
        "LF_yes_without_any_conflict": lf_yes_only,
        "LF_yes_with_conflict": lf_yes_with_conflict,
        "conflict_without_LF_yes": conflict_without_lf,
        "verdict": verdict,
        "independence_supported": independent,
        "rows": rows,
        "guard": (
            "`LF_yes_without_any_conflict` is the only cell that shows LF is not a restatement of "
            "TC/BC/AC. If it is zero while `LF_yes_with_conflict` is non-zero, the preregistration "
            "requires merging or withdrawing LF rather than reporting it as an independent dimension."
        ),
    }


# --------------------------------------------------------------------------- #
# gate evaluation
# --------------------------------------------------------------------------- #
def evaluate_gates(metrics: dict[str, dict], adjudication: dict) -> tuple[list[dict], list[str]]:
    gates: list[dict] = []
    blockers: list[str] = []

    def note(gate: str, status: str, detail: str) -> None:
        gates.append({"gate": gate, "status": status, "detail": detail})

    # G1: core labels
    for label in CORE_LABELS:
        entry = metrics[label]
        alpha = entry["krippendorff_alpha_nominal"]
        raw = entry["raw_agreement"]
        if entry["scenarios_with_two_values"] == 0:
            note("G1", "not_evaluable", f"{label}: no scenario has two values yet")
            blockers.append(f"G1/{label}: not evaluable, no complete pair")
            continue
        if raw is not None and raw < G1_RAW:
            note("G1", "failed", f"{label}: raw agreement {raw} < {G1_RAW}")
            blockers.append(f"G1/{label}: raw agreement below threshold")
        if alpha is None:
            note(
                "G1",
                "not_evaluable",
                f"{label}: Krippendorff alpha undefined ({entry['krippendorff_undefined_reason']}); "
                "no agreement level can be claimed",
            )
            blockers.append(f"G1/{label}: alpha undefined, level not claimable")
        elif alpha < G1_ALPHA:
            note("G1", "failed", f"{label}: alpha {alpha} < {G1_ALPHA}")
            blockers.append(f"G1/{label}: alpha below threshold")
        else:
            level = "meets_target" if alpha >= G1_ALPHA_TARGET else "meets_minimum"
            note("G1", level, f"{label}: alpha {alpha} (target {G1_ALPHA_TARGET}, minimum {G1_ALPHA})")

    # G2: TC
    entry = metrics["TC"]
    raw, alpha = entry["raw_agreement"], entry["krippendorff_alpha_nominal"]
    if entry["scenarios_with_two_values"] == 0:
        note("G2", "not_evaluable", "TC: no scenario has two values yet")
        blockers.append("G2/TC: not evaluable, no complete pair")
    elif raw is not None and alpha is not None and raw >= G2_RAW and alpha >= G2_ALPHA:
        note("G2", "passed", f"TC: raw {raw} >= {G2_RAW}, alpha {alpha} >= {G2_ALPHA}")
    else:
        note(
            "G2",
            "failed_or_undefined",
            f"TC: raw {raw}, alpha {alpha} (undefined reason: {entry['krippendorff_undefined_reason']})",
        )
        blockers.append("G2/TC: agreement below threshold or undefined")

    # G3: exploratory labels may be downgraded instead of blocking
    for label in EXPLORATORY_LABELS:
        entry = metrics[label]
        alpha = entry["krippendorff_alpha_nominal"]
        if entry["scenarios_with_two_values"] == 0:
            note("G3", "not_evaluable", f"{label}: no complete pair")
        elif alpha is None:
            note("G3", "downgrade_recommended", f"{label}: alpha undefined ({entry['krippendorff_undefined_reason']})")
        elif alpha >= G3_ALPHA:
            note("G3", "retained_confirmatory", f"{label}: alpha {alpha} >= {G3_ALPHA}")
        else:
            note("G3", "downgrade_required", f"{label}: alpha {alpha} < {G3_ALPHA}")

    # G4: high-confidence subset
    high_scenarios = sum(metrics[label]["high_confidence_subset"]["scenarios"] for label in LABELS)
    if high_scenarios == 0:
        note("G4", "not_evaluable", "no scenario has both annotators at confidence=high")
        blockers.append("G4: no high-confidence pair to self-validate")
    else:
        rates = [
            metrics[label]["high_confidence_subset"]["raw_agreement"]
            for label in LABELS
            if metrics[label]["high_confidence_subset"]["raw_agreement"] is not None
        ]
        worst = min(rates) if rates else None
        if worst is not None and worst >= G4_RAW:
            note("G4", "passed", f"worst high-confidence subset agreement {worst} >= {G4_RAW}")
        else:
            note("G4", "failed", f"worst high-confidence subset agreement {worst} < {G4_RAW}")
            blockers.append("G4: high-confidence subset agreement below threshold")

    # G5: uncertain share
    for label in LABELS:
        share = metrics[label]["uncertain_share_of_recorded_values"]
        if share is None:
            note("G5", "not_evaluable", f"{label}: no recorded values")
        elif share > G5_UNCERTAIN_SHARE:
            if label == "LF":
                note(
                    "G5",
                    "shrink_definition_or_add_scenarios",
                    f"LF: uncertain share {share} > {G5_UNCERTAIN_SHARE}; per preregistration §7 rule 5, "
                    "first attribute this to the pair-only sample structure and add candidates that can "
                    "establish repeated touch, rather than withdrawing the label",
                )
                blockers.append(
                    f"G5/LF: uncertain share above 30%;要么补充能建立反复触碰证据的候选，"
                    "要么在有充分证据的子集上重新判定"
                )
            else:
                note("G5", "shrink_definition_required", f"{label}: uncertain share {share} > {G5_UNCERTAIN_SHARE}")
                blockers.append(f"G5/{label}: uncertain share above 30%, definition must be narrowed")
        else:
            note("G5", "passed", f"{label}: uncertain share {share} <= {G5_UNCERTAIN_SHARE}")

    # G6: adjudication coverage
    total_disagreements = sum(metrics[label]["disagreement_count"] for label in LABELS)
    decisions = [d for d in (adjudication.get("decisions") or []) if isinstance(d, dict)]
    missing_decisions = max(0, total_disagreements - len(decisions))
    if total_disagreements == 0:
        note("G6", "not_evaluable", "no disagreement exists yet; adjudication cannot be exercised")
        blockers.append("G6: adjudication path untested, no disagreement observed")
    elif missing_decisions == 0:
        note("G6", "passed", f"{total_disagreements} disagreements, all adjudicated")
    else:
        note("G6", "failed", f"{missing_decisions} of {total_disagreements} disagreements lack an adjudication decision")
        blockers.append("G6: disagreement not yet adjudicated")

    # G7: evidence completeness at high confidence
    high_evidence_rates = [
        metrics[label]["high_confidence_subset"]["evidence_complete_rate"]
        for label in LABELS
        if metrics[label]["high_confidence_subset"]["evidence_complete_rate"] is not None
    ]
    if not high_evidence_rates:
        note("G7", "not_evaluable", "no high-confidence pair with evidence to inspect")
    elif all(rate >= 1.0 for rate in high_evidence_rates):
        note("G7", "passed", "every high-confidence pair carries evidence on both sides")
    else:
        note("G7", "failed", f"high-confidence evidence completeness rates: {high_evidence_rates}")
        blockers.append("G7: a high-confidence label lacks evidence")

    return gates, blockers


# --------------------------------------------------------------------------- #
# report rendering
# --------------------------------------------------------------------------- #
def fmt(value: object) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def interval_text(entry: dict) -> str:
    if entry.get("low") is None or entry.get("high") is None:
        return "n/a"
    return f"[{entry['low']:.3f}, {entry['high']:.3f}]"


def render_report(payload: dict) -> str:
    metrics = payload["metrics"]
    lines: list[str] = []
    lines.append("# Gate A 双人标注一致性报告（Flask 真实历史试点）")
    lines.append("")
    lines.append(f"- 生成时间（UTC）：{payload['generated_at_utc']}")
    lines.append(f"- 标注表：`{payload['sheet']}`（SHA-256 `{payload['sheet_sha256']}`）")
    lines.append(f"- 标注包索引：`{payload['packet_index']}`")
    lines.append("- 统计口径：`annotation/preregistration.md` §6；门槛：同文件 §5")
    lines.append(f"- bootstrap：{payload['bootstrap']['iterations']} 次、种子 `{payload['bootstrap']['seed']}`，"
                 f"按**场景**重采样（见下方偏离说明）")
    lines.append("")
    lines.append(f"**状态：`{payload['status']}`；是否允许声称 Gate A 结果：`{str(payload['claim_allowed']).lower()}`**")
    lines.append("")
    if payload["claim_blockers"]:
        lines.append("未通过项（在全部通过之前，本试点不得表述为「已获得可接受的标注一致性」）：")
        lines.append("")
        for blocker in payload["claim_blockers"]:
            lines.append(f"- {blocker}")
        lines.append("")

    lines.append("## 1. 计数")
    lines.append("")
    lines.append(f"- 场景数：{payload['counts']['scenarios']}")
    lines.append(f"- 已双人填写的标签对：{payload['counts']['label_pairs_complete']}")
    lines.append(f"- 仍缺至少一方填写的标签对：{payload['counts']['label_pairs_pending']}")
    lines.append(f"- 分歧标签对：{payload['counts']['label_pairs_disagreement']}")
    lines.append(f"- 已裁决分歧：{payload['counts']['label_pairs_adjudicated']}")
    lines.append("")

    for number, phase in enumerate(PHASES, start=2):
        lines.append(f"## {number}. {phase} 逐标签指标")
        lines.append("")
        lines.append("| 标签 | 可用场景 | 原始一致率 | Cohen's κ (yes vs rest) | Krippendorff α (nominal) | Gwet AC1 | α 95% 区间 | uncertain 占比 | high 子集一致率 |")
        lines.append("|---|---|---|---|---|---|---|---|---|")
        for label in LABELS:
            entry = metrics[phase][label]
            lines.append(
                "| {label} | {n} | {raw} | {kappa} | {alpha} | {ac1} | {ci} | {unc} | {high} |".format(
                    label=label,
                    n=entry["scenarios_with_two_values"],
                    raw=fmt(entry["raw_agreement"]),
                    kappa=fmt(entry["cohen_kappa_yes_vs_rest"]),
                    alpha=fmt(entry["krippendorff_alpha_nominal"]),
                    ac1=fmt(entry["gwet_ac1_nominal"]),
                    ci=interval_text(entry["bootstrap"]["krippendorff_alpha_nominal"]),
                    unc=fmt(entry["uncertain_share_of_recorded_values"]),
                    high=fmt(entry["high_confidence_subset"]["raw_agreement"]),
                )
            )
        lines.append("")
        undefined = [
            (label, entry["krippendorff_undefined_reason"])
            for label in LABELS
            if (entry := metrics[phase][label])["krippendorff_alpha_nominal"] is None
        ]
        if undefined:
            lines.append("α 未定义的原因（**未定义不等于一致性好，也不等于一致性差**）：")
            lines.append("")
            for label, reason in undefined:
                lines.append(f"- `{label}`：{reason}")
            lines.append("")

    lines.append("## 4. 门槛判定（以 phase_2 为最终标签集）")
    lines.append("")
    if not payload["gates"]:
        lines.append("未做门槛判定：当前没有任何一个标签被两名标注者同时填写，"
                     "评估门槛会把「未测量」当成「未达标」，因此本报告不做该推断。")
        lines.append("")
    else:
        lines.append("| 门槛 | 状态 | 说明 |")
        lines.append("|---|---|---|")
        for gate in payload["gates"]:
            lines.append(f"| {gate['gate']} | {gate['status']} | {gate['detail']} |")
        lines.append("")

    lines.append("## 5. `LF` 独立性检查（预注册 §6 v1.1 要求）")
    lines.append("")
    lf = payload["lf_conflict_cooccurrence"]
    if lf["status"] != "computed" or lf["agreed_LF_yes"] == 0:
        lines.append(f"当前无法判定：`{lf['verdict']}`（尚无双方一致判为 `LF = yes` 的样本）。")
    else:
        lines.append("| 单元 | 场景数 |")
        lines.append("|---|---|")
        lines.append(f"| 双方一致 `LF = yes` | {lf['agreed_LF_yes']} |")
        lines.append(f"| 其中**不含**任何 TC/BC/AC 正例 | {lf['LF_yes_without_any_conflict']} |")
        lines.append(f"| 其中同时含冲突正例 | {lf['LF_yes_with_conflict']} |")
        lines.append(f"| 有冲突但未判 `LF = yes` | {lf['conflict_without_LF_yes']} |")
        lines.append("")
        if lf["independence_supported"] is False:
            lines.append("**判定：`LF` 缺乏独立构念。** 所有一致判为 `LF = yes` 的样本同时带有冲突正例，"
                         "说明它可能只是 TC/BC/AC 的另一种表述。按预注册 §6 与主文档 H6 的否决条款，"
                         "应将其并入冲突类维度或撤销，**不得**作为独立贡献报告。")
        else:
            lines.append("**判定：存在独立情形。** 至少有一个 `LF = yes` 样本不含任何冲突正例，"
                         "支持 `LF` 覆盖了冲突检测定义域之外的现象。")
    lines.append("")
    lines.append(f"> {lf['guard']}")
    lines.append("")

    lines.append("## 6. 裁决队列")
    lines.append("")
    if payload["adjudication_queue"]:
        lines.append(f"{len(payload['adjudication_queue'])} 条分歧已写入 `{payload['adjudication_queue_path']}`，"
                     "每条都必须由第三方裁决者在 `adjudication_log.md` 中记录分歧来源，禁止简单多数表决。")
    else:
        lines.append(f"当前无分歧样本，`{payload['adjudication_queue_path']}` 为空文件。")
        lines.append("")
        lines.append("注意：无分歧可能是真实一致，也可能是双方都未真正使用标签空间（例如统一填 `uncertain`）。"
                     "判定时必须结合上面各标签的 `uncertain` 占比与 high 子集计数一起读。")
    lines.append("")

    lines.append("## 7. 方法与偏离说明")
    lines.append("")
    for note in payload["method_notes"]:
        lines.append(f"- {note}")
    lines.append("")

    lines.append("## 8. 有效性威胁（本报告不得越界声称）")
    lines.append("")
    lines.append("- 场景数 n = 7，任何区间只用于显示不确定性宽度，不具备推断意义；不得报告 p 值或效应量。")
    lines.append("- 本报告只描述**标注可判定性**，不描述 ACCD 的发生率，也不构成「ACCD 不存在」的证据。")
    lines.append("- 人类并行 PR 是多 agent 并行任务的代理；`agent_context_summary` 不可得，`UA` 在本试点不可判定。")
    lines.append("- `post_integration_tests.status = not_executed`，`BC` 多数只能为 `uncertain`；"
                 "`BC` 的低一致性可能来自证据缺失而非构念分歧。")
    lines.append("- 候选集以负控为主，极端边际分布会同时压低 κ 与 α；AC1 作为流行率不敏感的对照值一并报告。")
    lines.append("")
    lines.append("## 9. 偏离与待登记事项")
    lines.append("")
    for item in payload["preregistration_deviations"]:
        lines.append(f"- {item}")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--labels", default=DEFAULT_SHEET)
    parser.add_argument("--report-json", default=DEFAULT_REPORT_JSON)
    parser.add_argument("--report-md", default=DEFAULT_REPORT_MD)
    parser.add_argument("--adjudication-queue", default=DEFAULT_QUEUE)
    parser.add_argument("--bootstrap", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=20260914)
    args = parser.parse_args()

    sheet_path = Path(args.labels)
    if not sheet_path.is_absolute():
        sheet_path = ROOT / sheet_path
    if not sheet_path.exists():
        print(json.dumps({"error": f"annotation sheet not found: {sheet_path}"}, ensure_ascii=False))
        return 2

    index_path = PACKETS_DIR / "index.json"
    if not index_path.exists():
        print(json.dumps({"error": f"packet index not found: {index_path}"}, ensure_ascii=False))
        return 2

    raw_sheet = sheet_path.read_bytes()
    sheet_sha = sha256_bytes(raw_sheet)
    records = [json.loads(line) for line in raw_sheet.decode("utf-8").splitlines() if line.strip()]
    index = json.loads(index_path.read_text(encoding="utf-8"))
    index_by_id = {row["scenario_id"]: row for row in index.get("packets", [])}

    # integrity: the sheet must still be bound to the frozen packets
    drift: list[dict] = []
    for record in records:
        scenario = record.get("scenario_id", "<unknown>")
        frozen = index_by_id.get(scenario)
        if not frozen:
            drift.append({"scenario_id": scenario, "issue": "not present in packets/index.json"})
            continue
        packet_path = ROOT / frozen["packet_path"]
        if not packet_path.exists():
            drift.append({"scenario_id": scenario, "issue": "packet file missing"})
            continue
        digest = sha256_bytes(packet_path.read_bytes())
        if digest != frozen["packet_sha256"]:
            drift.append({"scenario_id": scenario, "issue": "packet content drifted from frozen hash"})
        elif record.get("packet_sha256") and record["packet_sha256"] != digest:
            drift.append({"scenario_id": scenario, "issue": "sheet was created against a different packet revision"})

    metrics = {
        phase: {label: metrics_for(records, phase, label, args.bootstrap, args.seed) for label in LABELS}
        for phase in PHASES
    }

    final_metrics = metrics["phase_2"]
    adjudication_all = [record.get("adjudication") or {} for record in records]

    complete_pairs = sum(final_metrics[label]["scenarios_with_two_values"] for label in LABELS)
    total_pairs = len(records) * len(LABELS)
    pending_pairs = total_pairs - complete_pairs
    disagreements = sum(final_metrics[label]["disagreement_count"] for label in LABELS)

    decisions: list[dict] = []
    for block in adjudication_all:
        decisions.extend(d for d in (block.get("decisions") or []) if isinstance(d, dict))
    decided = set()
    for decision in decisions:
        if decision.get("label") and decision.get("scenario_id") in {r.get("scenario_id") for r in records}:
            decided.add((decision.get("scenario_id"), decision.get("label")))
    adjudicated_pairs = sum(
        1
        for label in LABELS
        for row in final_metrics[label]["disagreements"]
        if (row["scenario_id"], label) in decided
    )

    if complete_pairs == 0:
        status = "not_yet_computable"
        claim_allowed = False
        claim_blockers = [
            "标注表中没有任何一个标签被两名标注者同时填写；本脚本不会用缺失值代替阴性，"
            "因此不计算任何一致性数值。"
        ]
        gates: list[dict] = []
    elif pending_pairs > 0:
        status = "partial_no_claim"
        claim_allowed = False
        gates, blockers = evaluate_gates(final_metrics, {"decisions": decisions})
        claim_blockers = [f"仍有 {pending_pairs} 个标签对缺至少一方填写；部分数据不得用于声明门槛通过。"] + blockers
    else:
        gates, blockers = evaluate_gates(final_metrics, {"decisions": decisions})
        claim_blockers = list(blockers)
        claim_allowed = not blockers
        status = "computed_gates_met" if claim_allowed else "computed_claim_blocked"

    queue: list[dict] = []
    for label in LABELS:
        for row in final_metrics[label]["disagreements"]:
            if (row["scenario_id"], label) in decided:
                continue
            queue.append(
                {
                    "scenario_id": row["scenario_id"],
                    "label": label,
                    "phase": "phase_2",
                    "annotator_A": row["annotator_A"],
                    "annotator_B": row["annotator_B"],
                    "rule": "third annotator decides and must record the source of the disagreement (preregistration G6)",
                }
            )

    queue_path = Path(args.adjudication_queue)
    if not queue_path.is_absolute():
        queue_path = ROOT / queue_path
    write_text(queue_path, "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in queue))

    method_notes = [
        "原始一致率在两名标注者都填写了值的场景上计算；缺一方填写的场景计为 missing，不计为阴性。",
        "Cohen's κ 使用预注册的二元化：`yes` 为阳性，`no`/`uncertain`/`possible_ID` 为阴性；"
        "`possible_ID` 因此在二元分析中为阴性，其在三分分析中的信息由 α 与 AC1 保留。",
        "Krippendorff α 由一致矩阵计算（名义度量），允许只被一方评分的单元存在。",
        "Gwet AC1 作为流行率不敏感的对照指标与 κ 同时报告，两者均呈现，不做选择性报告。",
        "α / κ / AC1 在边际分布退化（例如全部标签都是同一个值）时**数学上未定义**；"
        "本报告把它们记为 `n/a` 并给出原因，绝不把「未定义」写成「一致性高」。",
        "结果视图依赖性是预注册要求：phase_1 与 phase_2 的分数必须同时报告。",
        "`LF` 与 `TC`/`BC`/`AC` 用不同证据：本报告单独给出共现矩阵（§5），"
        "因为「行为兼容但语义归属被稀释」在定义上不依赖任何冲突发生。",
    ]

    deviations = [
        "预注册 §6 写的是「标注者对层面的 bootstrap」。本试点只有 2 名标注者，标注者层面的重采样退化为单一抽样单元，"
        "因此实现为**场景（脚本单元）层面的重采样**；该替换必须登记到 `adjudication_log.md` 的「预注册变更」小节，"
        "并在论文中声明区间反映的是场景抽样不确定性。",
        "本脚本生成报告不代表标注已完成；在两名标注者独立完成 phase_1/phase_2 之前，报告状态恒为"
        "`not_yet_computable` 或 `partial_no_claim`。",
        "`LF` 的可判定性受样本结构限制：本试点每个样本只是一对 PR，"
        "`prediction_view.repeated_touch_evidence` 中的 follow-up 计数是**路径级代理**，"
        "不能证明符号级反复触碰。`LF` 的高 `uncertain` 比例可能来自该限制而非构念不可判定（手册 §7 威胁 5）。",
    ]

    payload = {
        "report_version": "1.0",
        "generated_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sheet": str(sheet_path),
        "sheet_sha256": sheet_sha,
        "packet_index": "annotation/packets/index.json",
        "packet_index_sheet": index.get("packet_version"),
        "status": status,
        "claim_allowed": claim_allowed,
        "claim_blockers": claim_blockers,
        "counts": {
            "scenarios": len(records),
            "label_pairs_total": total_pairs,
            "label_pairs_complete": complete_pairs,
            "label_pairs_pending": pending_pairs,
            "label_pairs_disagreement": disagreements,
            "label_pairs_adjudicated": adjudicated_pairs,
        },
        "packet_integrity": {"ok": not drift, "issues": drift},
        "bootstrap": {"iterations": args.bootstrap, "seed": args.seed, "resampling_unit": "scenario"},
        "metrics": metrics,
        "gates": gates,
        "lf_conflict_cooccurrence": lf_conflict_cooccurrence(records),
        "adjudication_queue": queue,
        "adjudication_queue_path": relative_label(queue_path),
        "method_notes": method_notes,
        "preregistration_deviations": deviations,
        "guards": [
            "本报告不提供 ACCD 发生率、检测器准确率或治理效果的任何结论。",
            "本报告不读取也不包含任何筛选器初审意见，符合 H7。",
            "n = 7，不做推断统计。",
            "`LF` 是探索性标签；本报告在任何情况下都不把它计入核心标签的成败判定。",
        ],
    }
    if drift:
        payload["claim_blockers"] = ["标注包完整性校验失败，标注表与冻结标注包不再绑定。"] + claim_blockers
        payload["claim_allowed"] = False
        payload["status"] = "integrity_failed"

    report_json = Path(args.report_json)
    if not report_json.is_absolute():
        report_json = ROOT / report_json
    write_text(report_json, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

    report_md = Path(args.report_md)
    if not report_md.is_absolute():
        report_md = ROOT / report_md
    write_text(report_md, render_report(payload))

    summary = {
        "status": payload["status"],
        "scenarios": len(records),
        "claim_allowed": payload["claim_allowed"],
        "label_pairs_complete": complete_pairs,
        "label_pairs_pending": pending_pairs,
        "disagreements_in_queue": len(queue),
        "packet_integrity_ok": not drift,
        "report_md": str(report_md),
        "report_json": str(report_json),
    }
    print(json.dumps(summary, ensure_ascii=False))
    if claim_blockers:
        for blocker in claim_blockers[:20]:
            print(f"BLOCKED  {blocker}", file=sys.stderr)
    return 2 if drift else 0


if __name__ == "__main__":
    raise SystemExit(main())
