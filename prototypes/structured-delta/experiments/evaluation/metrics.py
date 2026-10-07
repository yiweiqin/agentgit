"""Metrics have explicit denominators; null means undefined, never zero-filled."""

from ..delta.model import LABELS


def ratio(n, d):
    return n / d if d else None


def score(rows):
    confusion = {a: {b: 0 for b in LABELS} for a in LABELS}
    for r in rows:
        confusion[r["gold"]][r["prediction"]["label"]] += 1
    f1 = []
    per_class = {}
    for label in LABELS:
        tp = confusion[label][label]
        fp = sum(confusion[g][label] for g in LABELS if g != label)
        fn = sum(confusion[label][p] for p in LABELS if p != label)
        v = 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0.0
        f1.append(v)
        per_class[label] = {
            "precision": ratio(tp, tp + fp),
            "recall": ratio(tp, tp + fn),
            "f1": v,
            "support": tp + fn,
        }
    compat = [r for r in rows if r["gold"] == "compatible"]
    cross = [r for r in rows if r["gold"] == "conflicting" and r["cross_file"]]
    local = [r for r in rows if r["entities"]]
    top1 = sum(
        bool(r["prediction"]["entities"])
        and r["prediction"]["entities"][0] in r["entities"]
        for r in local
    )
    recall3 = sum(
        bool(set(r["prediction"]["entities"][:3]) & set(r["entities"])) for r in local
    )
    cp = per_class["conflicting"]
    return {
        "n": len(rows),
        "macro_f1": sum(f1) / 4,
        "conflict_precision": cp["precision"],
        "conflict_recall": cp["recall"],
        "compatible_false_positive_rate": ratio(
            sum(r["prediction"]["label"] == "conflicting" for r in compat), len(compat)
        ),
        "cross_file_conflict_recall": ratio(
            sum(r["prediction"]["label"] == "conflicting" for r in cross), len(cross)
        ),
        "localization_top1": ratio(top1, len(local)),
        "localization_recall3": ratio(recall3, len(local)),
        "denominators": {
            "compatible": len(compat),
            "cross_file_conflicting": len(cross),
            "localization": len(local),
        },
        "per_class": per_class,
        "confusion": confusion,
    }


def grouped(rows):
    return {
        family: score([r for r in rows if r["family"] == family])
        for family in sorted({r["family"] for r in rows})
    }
