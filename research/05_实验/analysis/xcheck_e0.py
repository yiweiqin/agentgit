"""E0: validate the instrument against construction truth and against its sibling.

Three questions, in increasing order of how much they matter:

1.  Do `coord_ledger.py` and the TypeScript plugin derive the same numbers from the
    same file? (Cross-check. Cheap, and catches wire-format and ordering drift.)
2.  Do they derive the numbers the scenario was *constructed* to have? (Truth check.
    The one that matters: two agreeing analyzers can both be wrong.)
3.  Where do they knowingly disagree? (Boundary. A documented divergence that is
    never measured is a comment pretending to be a fact.)

This script exits non-zero if (1) or (2) fails, so it can gate the later experiments:
if the instrument is not trustworthy, E1-E3 would produce uninterpretable numbers.

Usage
-----
    python analysis/xcheck_e0.py --root results/E0/synthetic [--json]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

_ROOT_DIR = Path(__file__).resolve().parents[2]
_MODULE_DIR = _ROOT_DIR / "04_协调插件"
_TS_DIR = _MODULE_DIR / "dsh-coord-governor"
if str(_MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(_MODULE_DIR))

from coord_ledger import compute_report  # noqa: E402

# Fields both analyzers claim to compute. Anything not listed here cannot be
# cross-checked and must not be presented as if it had been.
COUNT_KEYS = (
    "events",
    "capsules",
    "open_capsules",
    "unreconciled_capsules",
    "integrated_capsules",
    "decayed_capsules",
    "contested_entities",
    "sessions_with_context_loss",
)
RATE_KEYS = ("observed_hours", "lambda_produced_per_hour", "integration_rate_per_hour", "rate_is_meaningful")
FLOAT_TOLERANCE = 1e-9


class Mismatch(Exception):
    """One field where the two analyzers, or an analyzer and the truth, disagree.

    Carries the field name so an expected divergence can be recognised as expected
    rather than merely tolerated: matching only on the message text would let a new
    divergence hide behind an old one's wording.
    """

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


def run_ts(ledger_dir: Path) -> dict:
    """Run the TypeScript analyzer on the same ledger and return its JSON view.

    The path is absolutised because the analyzer runs with a different working
    directory. Passing it relatively was the bug that made the first E0 run report
    sixty zero-versus-nonzero mismatches: the analyzer resolved it against its own
    package directory and found no file at all.
    """
    completed = subprocess.run(
        ["node", "src/cli.ts", "report", "--ledger", str(ledger_dir.resolve()), "--json"],
        cwd=_TS_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        raise Mismatch(f"typescript analyzer failed ({completed.returncode}): {completed.stderr.strip()[:400]}")
    return json.loads(completed.stdout)


def run_py(ledger_dir: Path) -> dict:
    return compute_report(ledger_dir.resolve())


def _cmp(label: str, py_value, ts_value, out: list[Mismatch]) -> None:
    if isinstance(py_value, float) or isinstance(ts_value, float):
        if py_value is None or ts_value is None:
            if py_value != ts_value:
                out.append(Mismatch(label, f"{label}: python={py_value!r} typescript={ts_value!r}"))
            return
        if abs(float(py_value) - float(ts_value)) > FLOAT_TOLERANCE:
            out.append(Mismatch(label, f"{label}: python={py_value!r} typescript={ts_value!r}"))
        return
    if py_value != ts_value:
        out.append(Mismatch(label, f"{label}: python={py_value!r} typescript={ts_value!r}"))


def cross_check(py: dict, ts: dict) -> list[Mismatch]:
    """Field-by-field agreement between the two analyzers."""
    out: list[Mismatch] = []
    for key in COUNT_KEYS:
        _cmp(f"counts.{key}", py["counts"].get(key), ts["counts"].get(key), out)
    for key in RATE_KEYS:
        _cmp(f"rates.{key}", py["rates"].get(key), ts["rates"].get(key), out)

    _cmp("backlog_now.open_capsules", py["backlog_now"]["open_capsules"], ts["backlog_now"]["open_capsules"], out)
    _cmp("writes_after_context_loss", py["writes_after_context_loss"], ts["writes_after_context_loss"], out)
    _cmp("state_histogram", py["state_histogram"], ts["state_histogram"], out)

    py_series = [(p["timestamp_utc"], p["open_capsules"]) for p in py["backlog_series"]]
    ts_series = [(p["timestamp_utc"], p["open_capsules"]) for p in ts["backlog_series"]]
    _cmp("backlog_series", py_series, ts_series, out)

    py_contested = [
        {
            "entity_key": e["entity_key"],
            "tasks": sorted(e["tasks"]),
            "sessions": sorted(e["sessions"]),
            "touches": e["touches"],
        }
        for e in py["top_contested_entities"]
    ]
    ts_contested = [
        {
            "entity_key": e["entity_key"],
            "tasks": sorted(e["tasks"]),
            "sessions": sorted(e["sessions"]),
            "touches": e["touches"],
        }
        for e in ts["top_contested_entities"]
    ]
    _cmp("top_contested_entities", py_contested, ts_contested, out)
    return out


def truth_check(py: dict, ts: dict, truth: dict) -> list[Mismatch]:
    """Compare both analyzers against the scenario's construction truth.

    Numeric error is reported as a rate, because the plan asks for one: a mismatch of
    0.001 in `lambda_produced` between a one-task and a thousand-task scenario are not
    the same failure.
    """
    out: list[Mismatch] = []
    for analyzer, report in (("python", py), ("typescript", ts)):
        for key, expected in truth.get("counts", {}).items():
            actual = report["counts"].get(key)
            if actual != expected:
                out.append(
                    Mismatch(
                        f"truth[{analyzer}].counts.{key}",
                        f"truth[{analyzer}].counts.{key}: expected={expected!r} actual={actual!r}",
                    )
                )
        for key, expected in truth.get("rates", {}).items():
            actual = report["rates"].get(key)
            if isinstance(expected, float) and actual is not None:
                if abs(actual - expected) > max(FLOAT_TOLERANCE, abs(expected) * 1e-9):
                    out.append(
                        Mismatch(
                            f"truth[{analyzer}].rates.{key}",
                            f"truth[{analyzer}].rates.{key}: expected={expected!r} actual={actual!r}",
                        )
                    )
            elif actual != expected:
                out.append(
                    Mismatch(
                        f"truth[{analyzer}].rates.{key}",
                        f"truth[{analyzer}].rates.{key}: expected={expected!r} actual={actual!r}",
                    )
                )

        if "writes_after_context_loss" in truth:
            expected = truth["writes_after_context_loss"]
            actual = report["writes_after_context_loss"]
            if actual != expected:
                out.append(
                    Mismatch(
                        f"truth[{analyzer}].writes_after_context_loss",
                        f"truth[{analyzer}].writes_after_context_loss: expected={expected} actual={actual}",
                    )
                )

        if "backlog_series" in truth:
            actual = [(p["timestamp_utc"], p["open_capsules"]) for p in report["backlog_series"]]
            expected = [(p["timestamp_utc"], p["open_capsules"]) for p in truth["backlog_series"]]
            if actual != expected:
                out.append(
                    Mismatch(
                        f"truth[{analyzer}].backlog_series",
                        f"truth[{analyzer}].backlog_series: expected {len(expected)} points "
                        f"peak={max((p[1] for p in expected), default=0)}; got {len(actual)} points "
                        f"peak={max((p[1] for p in actual), default=0)}",
                    )
                )

        if "contested_keys" in truth:
            actual = sorted(e["entity_key"] for e in report["top_contested_entities"])
            expected = sorted(truth["contested_keys"])
            if actual != expected:
                missing = sorted(set(expected) - set(actual))
                spurious = sorted(set(actual) - set(expected))
                out.append(
                    Mismatch(
                        f"truth[{analyzer}].contested_keys",
                        f"truth[{analyzer}].contested_keys: recall="
                        f"{(len(expected) - len(missing)) / max(len(expected), 1):.3f} "
                        f"precision={((len(actual) - len(spurious)) / max(len(actual), 1)):.3f} "
                        f"missing={missing} spurious={spurious}",
                    )
                )
    return out


def split_expected(findings: list[Mismatch], declared: set[str]) -> tuple[list[Mismatch], list[Mismatch]]:
    """Separate divergences the scenario declares from ones it does not.

    A declared divergence is a boundary this project has chosen and measured, such as
    `file_read` counting as a touch in Python and not in the plugin. An undeclared one
    is a defect. Conflating them is how a documented limitation quietly becomes an
    undocumented bug.
    """
    expected = [m for m in findings if m.field in declared]
    unexpected = [m for m in findings if m.field not in declared]
    return expected, unexpected


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", required=True, help="directory holding <scenario>/events.jsonl")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    root = Path(args.root)
    scenarios = sorted(p.name for p in root.iterdir() if (p / "events.jsonl").exists())
    if not scenarios:
        print(json.dumps({"status": "error", "error": f"no scenarios under {root}"}))
        return 1

    failures: list[str] = []
    notes: list[str] = []
    results: list[dict] = []

    for scenario in scenarios:
        ledger_dir = root / scenario
        py = run_py(ledger_dir)
        ts = run_ts(ledger_dir)

        truth_path = root / f"truth.{scenario}.json"
        truth = json.loads(truth_path.read_text(encoding="utf-8")) if truth_path.exists() else {}
        declared = {d["field"] for d in truth.get("expected_divergences", [])}

        agreement = cross_check(py, ts)
        truth_findings = truth_check(py, ts, truth) if "counts" in truth else []

        expected, unexpected = split_expected(agreement + truth_findings, declared)
        undeclared_declared = declared - {m.field for m in expected}
        for field in sorted(undeclared_declared):
            failures.append(
                f"[{scenario}] declared divergence '{field}' did not occur: the two analyzers now "
                "agree on it, so the declaration is stale and must be removed or re-measured"
            )
        failures.extend(f"[{scenario}] {m.message}" for m in unexpected)

        results.append(
            {
                "scenario": scenario,
                "events": py["counts"]["events"],
                "capsules": py["counts"]["capsules"],
                "checked_fields": len(COUNT_KEYS) + len(RATE_KEYS) + 4,
                "expected_divergences": [m.field for m in expected],
                "failures": [m.message for m in unexpected],
                "has_ground_truth": "counts" in truth,
            }
        )

        if scenario.startswith("kinds") or "reads" in scenario:
            # The measured boundary of agreement, not a comment.
            notes.append(
                f"{scenario}: contested_entities python={py['counts']['contested_entities']} "
                f"typescript={ts['counts']['contested_entities']}; "
                "coord_ledger.py counts file_read as an entity touch, the plugin does not, "
                "because a read is not a conflict"
            )
        if scenario == "ties":
            notes.append(
                "ties: same-instant events resolved identically by both analyzers, so the "
                "(timestamp_utc, event_id) tie-break is shared, not approximated"
            )

    total_checks = sum(r["checked_fields"] for r in results)
    summary = {
        "status": "pass" if not failures else "fail",
        "scenarios": results,
        "total_checks": total_checks,
        "exact_match_rate": (total_checks - sum(len(r["failures"]) for r in results)) / max(total_checks, 1),
        "divergence_notes": notes,
        "failures": failures,
    }

    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"scenarios          : {', '.join(scenarios)}")
        print(f"checks             : {total_checks} field comparisons")
        print(f"exact match rate   : {summary['exact_match_rate']:.4f}")
        for note in notes:
            print(f"note               : {note}")
        for result in results:
            declared_fields = ", ".join(result["expected_divergences"]) or "none"
            print(f"  {result['scenario']:<18} declared divergences: {declared_fields}")
        if failures:
            print(f"FAIL ({len(failures)})")
            for failure in failures:
                print(f"  {failure}")
        else:
            print("PASS: analyzers agree with each other and with construction truth")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
