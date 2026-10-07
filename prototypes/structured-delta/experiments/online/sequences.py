"""Deterministic synthetic progress schedule, not real agent trajectories."""


def stages(base, final, branch):
    helper = f"_progress_{branch}.py"
    draft = dict(base)
    draft[helper] = "def ready():\n    return True\n"
    partial = dict(draft)
    changed = sorted(
        p for p in base.keys() | final.keys() if base.get(p) != final.get(p)
    )
    if changed:
        p = changed[0]
        if p in final:
            partial[p] = final[p]
        else:
            partial.pop(p, None)
    return [draft, partial, dict(final)]


def functional_complete(snapshot, final):
    return {
        k: v for k, v in snapshot.items() if not k.startswith("_progress_")
    } == final
