"""Frozen rule ladder. Overlap establishes scope; concrete effects decide conflict.

Scores are ordinal rule strengths, never calibrated probabilities.
"""

from .model import Prediction

LEVELS = (
    "File",
    "File + Symbol",
    "File + Symbol + Dependency",
    "File + Symbol + Dependency + Contract",
    "Full Structured Delta",
)


def related(a, b):
    return (
        a == b
        or a.startswith(b + ".")
        or b.startswith(a + ".")
        or a.startswith(b + "[")
        or b.startswith(a + "[")
    )


def detect(a, b, level="Full Structured Delta"):
    depth = LEVELS.index(level)
    files = sorted(set(a.files) & set(b.files))
    scope = sorted({x for x in a.symbols for y in b.symbols if related(x, y)})
    deps = sorted(
        {x for x in a.symbols for y in b.reads + b.imports if related(x, y)}
        | {x for x in b.symbols for y in a.reads + a.imports if related(x, y)}
    )
    interference = sorted(
        {x for x in a.writes for y in list(b.writes) + b.reads if related(x, y)}
        | {x for x in b.writes for y in a.reads if related(x, y)}
    )
    signals = {
        "scope_overlap": scope,
        "dependency_overlap": deps if depth >= 2 else [],
        "read_write_interference": interference if depth == 4 else [],
        "contract_incompatibility": [],
        "redundancy": False,
        "unresolved": sorted(set(a.unresolved + b.unresolved)),
    }

    def result(label, entities, reason, score=0):
        return Prediction(
            label, list(dict.fromkeys(entities))[:3], score, [reason], signals
        )

    if depth == 0:
        return result(
            "conflicting" if files else "independent",
            ["file:" + p for p in files],
            "File intersection only",
            0.5 if files else 0,
        )
    if depth == 1:
        return result(
            "conflicting" if scope else "independent",
            scope,
            "Symbol intersection only",
            0.5 if scope else 0,
        )
    if depth == 2:
        return result(
            "conflicting" if scope or deps else "independent",
            scope + deps,
            "Symbol or dependency intersection only",
            0.5 if scope or deps else 0,
        )
    if depth == 4 and a.symbols and set(a.symbols) == set(b.symbols):
        if (
            set(a.after) == set(b.after)
            and all(a.after[k].canonical == b.after[k].canonical for k in a.after)
            and set(a.before) == set(b.before)
            and all(a.before[k].canonical == b.before[k].canonical for k in a.before)
        ):
            signals["redundancy"] = True
            return result(
                "redundant",
                scope or a.symbols,
                "Equal normalized AST transformations",
                0.02,
            )
    for source, target in ((a, b), (b, a)):
        for op in source.operations:
            k = op["entity"]
            if op["operation"] in {"delete", "rename"} and any(
                related(k, t) for t in target.symbols + target.reads + target.imports
            ):
                signals["contract_incompatibility"].append(k)
                return result(
                    "conflicting",
                    [k],
                    f"{op['operation']} intersects changed implementation or surviving consumer",
                    0.98,
                )
        for k, contract in source.contracts_changed.items():
            consumers = [c for c in target.calls if related(c["target"], k)]
            referenced = any(related(k, t) for t in target.reads + target.imports)
            if "signature" in contract and consumers:
                sig = contract["signature"]["after"]
                for call in consumers:
                    if call["dynamic"]:
                        continue
                    keywords = set(call["keywords"])
                    params = sig.get("parameters", [])
                    required = params[: sig.get("required", 0)]
                    bad = (
                        sig.get("maximum") is not None and call["argc"] > sig["maximum"]
                    )
                    bad |= any(p not in keywords for p in required[call["argc"] :])
                    bad |= any(
                        p not in keywords for p in sig.get("required_kwonly", [])
                    )
                    bad |= bool(
                        keywords
                        - set(params[sig.get("posonly", 0) :])
                        - set(sig.get("kwonly", []))
                    ) and not sig.get("kwargs")
                    if bad:
                        signals["contract_incompatibility"].append(k)
                        return result(
                            "conflicting",
                            [k],
                            "Changed signature rejects an observed call",
                            0.96,
                        )
            if referenced and ("return_type" in contract or "value" in contract):
                # Conservative: this prototype cannot prove adaptation at the use site.
                signals["contract_incompatibility"].append(k)
                return result(
                    "conflicting",
                    [k],
                    "Consumer references a changed return/configuration/dependency contract",
                    0.85,
                )
    if depth == 4:
        if interference:
            return result(
                "conflicting",
                interference,
                "Changed writes intersect concurrent reads or writes",
                0.82,
            )
        for k in scope:
            if k in a.after and k in b.after and k in a.before and k in b.before:
                aa, bb, old = a.after[k], b.after[k], a.before[k]
                if (
                    aa.return_exprs != old.return_exprs
                    and bb.return_exprs != old.return_exprs
                    and aa.return_exprs != bb.return_exprs
                ):
                    return result(
                        "conflicting",
                        [k],
                        "Different concurrent replacements of return behavior",
                        0.8,
                    )
                if (
                    aa.signature != old.signature
                    and bb.signature != old.signature
                    and aa.signature != bb.signature
                ):
                    return result(
                        "conflicting",
                        [k],
                        "Different concurrent function signatures",
                        0.85,
                    )
        # Different creations at the same qualified symbol collide even without returns.
        for k in set(a.after) & set(b.after) - set(a.before) - set(b.before):
            if a.after[k].canonical != b.after[k].canonical:
                return result(
                    "conflicting",
                    [k],
                    "Different definitions create the same symbol",
                    0.9,
                )
    if scope or deps:
        return result(
            "compatible",
            scope + deps,
            "Shared scope/dependency without a recognized incompatible effect",
            0.15,
        )
    return result("independent", [], "No resolved interaction", 0)
