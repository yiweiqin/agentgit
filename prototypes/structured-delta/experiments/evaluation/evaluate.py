import argparse
import json
import platform
import time
from collections import Counter
from pathlib import Path
from ..delta.extractor import extract
from ..delta.interaction import detect, LEVELS
from ..baselines import file_overlap, ast_overlap, git_merge, embedding, llm_intent
from .runtime import snapshot, commutativity
from .metrics import score, grouped
from .freeze import verify


def run(root, benchmark, out, embedding_command=None, llm_command=None):
    frozen = verify(root)
    if out.exists():
        raise FileExistsError(f"Refusing to replace results: {out}")
    out.mkdir(parents=True)
    all_rows = {}
    records = []
    for path in sorted(benchmark.glob("case[0-9]*")):
        base, a, b = (snapshot(path / k) for k in ("base", "a", "b"))
        started = time.perf_counter()
        da, db = extract(base, a), extract(base, b)
        extracted_ms = (time.perf_counter() - started) * 1000
        started = time.perf_counter()
        preds = {
            "B1 File": file_overlap.predict(da, db),
            "B2 Line": ast_overlap.predict(da, db, "line"),
            "B2 AST/Symbol": ast_overlap.predict(da, db),
        }
        preds.update({level: detect(da, db, level) for level in LEVELS})
        detection_ms = (time.perf_counter() - started) * 1000
        patch_a, patch_b = ((path / f"patch_{k}.diff").read_text() for k in ("A", "B"))
        optional = {}
        for key, command, fn in (
            (
                "B4 Embedding",
                embedding_command,
                lambda cmd: embedding.predict(cmd, patch_a, patch_b, da, db),
            ),
            (
                "B5 LLM descriptions",
                llm_command,
                lambda cmd: llm_intent.predict(cmd, patch_a, patch_b),
            ),
        ):
            if command:
                try:
                    preds[key] = fn(command)
                    optional[key] = {"status": "ok"}
                except Exception as error:
                    optional[key] = {"status": "error", "error": str(error)}
            else:
                optional[key] = {"status": "not_configured"}
        # Gold, requirements and witness data are read only after predictions.
        gold = json.loads((path / "gold.json").read_text())
        checks = {k: (path / "checks" / f"{k}.py").read_text() for k in ("a", "b")}
        commute = commutativity(base, a, b, patch_a, patch_b, checks)
        preds["B3 Git merge"] = git_merge.predict(commute["three_way"]["ab"])
        rec = {
            "id": path.name,
            "gold": gold,
            "delta_a": da.to_dict(),
            "delta_b": db.to_dict(),
            "predictions": {k: v.to_dict() for k, v in preds.items()},
            "optional": optional,
            "timing": {
                "extract_ms": extracted_ms,
                "deterministic_all_rules_ms": detection_ms,
            },
            "commutativity": commute,
        }
        (out / f"{path.name}.json").write_text(
            json.dumps(rec, ensure_ascii=False, indent=2) + "\n"
        )
        records.append(rec)
        for method, prediction in preds.items():
            all_rows.setdefault(method, []).append(
                {
                    "id": path.name,
                    "gold": gold["label"],
                    "entities": gold["entities"],
                    "family": gold["family"],
                    "cross_file": gold["cross_file"],
                    "prediction": prediction.to_dict(),
                }
            )
        print(path.name, flush=True)
    # Unavailable optional results remain missing; partial subsets are explicitly marked.
    results = {
        method: {
            "aggregate": score(rows),
            "by_family": grouped(rows),
            "coverage": {"scored": len(rows), "total": len(records)},
        }
        for method, rows in all_rows.items()
    }
    errors = {
        method: {
            "false_positives": [
                r
                for r in rows
                if r["gold"] != "conflicting"
                and r["prediction"]["label"] == "conflicting"
            ],
            "false_negatives": [
                r
                for r in rows
                if r["gold"] == "conflicting"
                and r["prediction"]["label"] != "conflicting"
            ],
            "all_misclassified": [
                r for r in rows if r["gold"] != r["prediction"]["label"]
            ],
        }
        for method, rows in all_rows.items()
    }
    summary = {
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "freeze_created_at": frozen["created_at"],
        "cases": len(records),
        "labels": dict(Counter(r["gold"]["label"] for r in records)),
        "families": len({r["gold"]["family"] for r in records}),
        "cross_file_conflicts": sum(
            r["gold"]["label"] == "conflicting" and r["gold"]["cross_file"]
            for r in records
        ),
        "methods": results,
        "optional": {
            key: dict(Counter(r["optional"][key]["status"] for r in records))
            for key in ("B4 Embedding", "B5 LLM descriptions")
        },
        "errors": errors,
    }
    (out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps({k: v["aggregate"] for k, v in results.items()}, indent=2))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, default=Path("."))
    p.add_argument(
        "--benchmark", type=Path, default=Path("experiments/benchmark/cases")
    )
    p.add_argument("--out", type=Path, default=Path("experiments/results/run-001"))
    p.add_argument("--embedding-command")
    p.add_argument("--llm-command")
    a = p.parse_args()
    run(a.root, a.benchmark, a.out, a.embedding_command, a.llm_command)
