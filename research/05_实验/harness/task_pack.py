"""Runnable task packs: the construction truth E1/E3 are scored against.

Why this is a separate artifact from E2's pack
----------------------------------------------
`task-packs/detection-v1/pack.json` (`coord-taskpack-0.1`) is a *pure-function* pack: it feeds
`priorEvents` and `proposals` straight to the detector and scores recall/precision. It never
asks an agent to do anything, so it cannot produce a landed implementation and therefore cannot
carry the primary indicator (§5.2, redundant landing rate).

E1/E3 need the other kind: natural-language tasks an agent executes in a real repository, with
the intent equivalence declared **by construction**. This module defines and validates that
kind, `coord-runtime-pack-0.1`.

The one rule that matters
-------------------------
Truth is declared here and checked against itself, never inferred from the detector and never
inferred from entity overlap. §4's hard constraint is that overlap is not evidence of failed
coordination, so a pack whose labels disagree with its own declared entities is refused rather
than scored -- the same discipline `eval_e2.py` applies to `priorEvents`, for the same reason:
`declaration can be wrong; derivation cannot`. A pack is the declaration, so it is the thing
that must be checkable.

Specifically:
  * `true-collision` / `semantic-duplicate` must share an entity with another member of their
    own `intentGroup` -- that group is the construction's claim of "same intent".
  * `independent-control` must be **alone** in its `intentGroup`. Intent groups define "same
    intent", so a control sharing a group would be a duplicate by construction, whatever the
    author intended. A control may still share an *entity* with an unrelated task; that is the
    H9 case (overlap that must not be treated as evidence) and is deliberately allowed.
  * `hidden-dependency` must share no entity with any other task and must name what it depends
    on, so the dependency is a recorded claim rather than a reviewer's inference.

Entity existence is verified **mechanically** against the pinned commit when a local checkout is
available (`--repo`), and reported as unverified when it is not. This module never asserts that
a path exists because the author believed it did.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

PACK_SCHEMA = "coord-runtime-pack-0.1"

# Verbatim from `03_基准与标注/GateA标注与基准规范.md` §4 and `task-packs/detection-v1/pack.json`,
# so a pack written for E2 and one written here describe the same four structures.
TRUTH_KINDS: tuple[str, ...] = (
    "true-collision",
    "semantic-duplicate",
    "independent-control",
    "hidden-dependency",
)

# The kinds that claim "another task in my group is doing the same thing".
DUPLICATE_KINDS: tuple[str, ...] = ("true-collision", "semantic-duplicate")

_REPO_RELATIVE_PREFIXES = ("src/", "tests/", "docs/", "examples/")


def load_pack(path: str | Path) -> dict[str, Any]:
    text = Path(path).read_text(encoding="utf-8-sig")
    try:
        pack = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: invalid JSON at line {exc.lineno} column {exc.colno}: {exc.msg}") from exc
    if not isinstance(pack, dict):
        raise ValueError(f"{path}: a runtime pack must be a JSON object")
    return pack


def _entity_set(task: dict[str, Any]) -> set[str]:
    return {str(e) for e in (task.get("expectedEntities") or [])}


def validate_pack(pack: dict[str, Any]) -> list[str]:
    """Return every problem with a pack; an empty list means it may be run.

    Collecting all errors rather than raising on the first: a pack is edited by hand in one
    sitting, and fixing contradictions one round-trip at a time is how a check gets bypassed.
    """
    errors: list[str] = []

    if pack.get("schemaVersion") != PACK_SCHEMA:
        errors.append(f"schemaVersion must be {PACK_SCHEMA!r}, got {pack.get('schemaVersion')!r}")
    if pack.get("status") not in ("draft", "frozen"):
        errors.append(f"status must be 'draft' or 'frozen', got {pack.get('status')!r}")

    repo = pack.get("repo")
    if not isinstance(repo, dict):
        errors.append("repo must be an object naming the repository every task runs against")
        repo = {}
    else:
        for key in ("url", "commit"):
            if not repo.get(key):
                # A moving branch would let two rounds of the same arm run different code, and the
                # arm comparison would absorb the difference.
                errors.append(f"repo.{key} is required")

    tasks = pack.get("tasks")
    if not isinstance(tasks, list) or len(tasks) < 2:
        errors.append("tasks must contain at least 2 entries")
        return errors

    by_id: dict[str, dict[str, Any]] = {}
    groups: dict[str, list[str]] = {}
    kinds_present: set[str] = set()

    for index, task in enumerate(tasks):
        where = f"tasks[{index}]"
        if not isinstance(task, dict):
            errors.append(f"{where} must be an object")
            continue
        task_id = task.get("taskId")
        if not task_id:
            errors.append(f"{where}.taskId is required")
        elif task_id in by_id:
            # Capsules are keyed by task id, so a duplicate would merge two sessions into one and
            # remove exactly the redundancy the primary indicator counts.
            errors.append(f"{where}.taskId {task_id!r} is duplicated: capsules are keyed by task id")
        else:
            by_id[str(task_id)] = task

        kind = task.get("truthKind")
        if kind not in TRUTH_KINDS:
            errors.append(f"{where}.truthKind must be one of {list(TRUTH_KINDS)}, got {kind!r}")
        else:
            kinds_present.add(str(kind))

        group = task.get("intentGroup")
        if not group:
            errors.append(f"{where}.intentGroup is required: it is the construction's claim of same-intent")
        else:
            groups.setdefault(str(group), []).append(str(task_id or where))

        if not task.get("prompt"):
            errors.append(f"{where}.prompt is required: this is an executable task, not a fixture")
        if not task.get("developer"):
            errors.append(f"{where}.developer is required (the planned developer count is a sweep dimension)")
        if not task.get("why"):
            # The `why` is what makes a later disagreement about a label reviewable rather than a
            # matter of memory. E2's pack carries one per case; this keeps that property.
            errors.append(f"{where}.why is required: the label must be arguable from the file alone")

        entities = task.get("expectedEntities")
        if not isinstance(entities, list) or not entities:
            errors.append(
                f"{where}.expectedEntities is required: it is what the truth-consistency checks are "
                "performed against, and an empty list makes them vacuous"
            )
        else:
            for entity in entities:
                if not isinstance(entity, str) or not entity:
                    errors.append(f"{where}.expectedEntities must be non-empty strings")
                elif not entity.startswith(_REPO_RELATIVE_PREFIXES):
                    errors.append(
                        f"{where}.expectedEntities entry {entity!r} is not repo-relative; entities are "
                        "matched as paths, so a bare name would never coincide with another task's"
                    )

    if kinds_present and kinds_present != set(TRUTH_KINDS):
        # A pack missing a structure cannot exercise it, and a missing control is the failure mode
        # that makes precision meaningless: with no clean case, "flagged everything" scores 1.0.
        errors.append(
            f"pack is missing truth kinds {sorted(set(TRUTH_KINDS) - kinds_present)}: E1/E3 require all four "
            "structures (true collision, semantic duplicate, independent control, hidden dependency)"
        )

    # --- truth consistency, declared against declared ---------------------------------------
    group_members = {group: members for group, members in groups.items() if len(members) >= 2}
    if not group_members:
        errors.append(
            "no intent group has 2+ tasks: redundant landing rate is undefined by construction, so this "
            "pack cannot produce the primary indicator"
        )

    for group, members in sorted(group_members.items()):
        for member in members:
            task = by_id.get(member)
            if task is None:
                continue
            if task.get("truthKind") not in DUPLICATE_KINDS:
                errors.append(
                    f"task {member!r} is in intent group {group!r} with {len(members)} members but its "
                    f"truthKind is {task.get('truthKind')!r}: an intent group is the claim of same intent, "
                    "so every member of a multi-member group must be a duplicate kind (a control belongs "
                    "in a group of its own)"
                )
        # Pairwise, not a union: a union is non-empty as soon as any member declares any entity,
        # which would make this check vacuous. What must hold is that two members of the group
        # share an entity -- otherwise the declared collision is not a collision.
        entity_sets = [_entity_set(by_id[member]) for member in members if member in by_id]
        pairwise_shared: set[str] = set()
        for first in range(len(entity_sets)):
            for second in range(first + 1, len(entity_sets)):
                pairwise_shared |= entity_sets[first] & entity_sets[second]
        if not pairwise_shared:
            errors.append(
                f"intent group {group!r} declares duplicate work but no two members share an expected entity: "
                "either the group is mislabelled or the entities are, and the collision would never be real"
            )

    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("taskId") or f"tasks[{index}]")
        kind = task.get("truthKind")
        entities = _entity_set(task)

        if kind == "independent-control":
            group = str(task.get("intentGroup") or "")
            if len(groups.get(group, [])) > 1:
                errors.append(
                    f"independent-control {task_id!r} shares intent group {group!r}: a group is the claim of "
                    "same intent, so this control would be a duplicate by construction whatever the author meant"
                )
            if not entities:
                errors.append(f"independent-control {task_id!r} must declare what it touches, even if it overlaps")

        if kind == "hidden-dependency":
            clashes = sorted(
                entity
                for other in tasks
                if isinstance(other, dict) and other.get("taskId") != task.get("taskId")
                for entity in _entity_set(other) & entities
            )
            if clashes:
                # A dependency a shared-entity detector can see is not hidden; labelling it so would
                # inflate the recall ceiling and make I3 unfalsifiable.
                errors.append(
                    f"hidden-dependency {task_id!r} shares {clashes} with another task: with a shared entity it "
                    "is reachable by an entity-key detector and is therefore not hidden"
                )
            depends_on = task.get("dependsOn")
            if not isinstance(depends_on, list) or not depends_on:
                errors.append(f"hidden-dependency {task_id!r}.dependsOn must name at least one task")
            else:
                for target in depends_on:
                    if str(target) not in by_id:
                        errors.append(f"hidden-dependency {task_id!r}.dependsOn names unknown task {target!r}")
                    elif target == task.get("taskId"):
                        errors.append(f"hidden-dependency {task_id!r}.dependsOn names itself")

    return errors


def tasks_for_plan(pack: dict[str, Any]) -> list[dict[str, str]]:
    """Reduce a pack to the task shape a run plan consumes.

    Only the scheduling-relevant fields are carried over. `expectedEntities`, `truthKind`, `why`
    and `dependsOn` stay in the pack, because they are *analysis* truth: the harness must not be
    able to read them into a measurement, and the runner only needs to know what to run.
    """
    return [
        {
            "taskId": str(task["taskId"]),
            "intentGroup": str(task["intentGroup"]),
            "developer": str(task["developer"]),
            "prompt": str(task["prompt"]),
        }
        for task in pack["tasks"]
    ]


def verify_entities_against_repo(pack: dict[str, Any], repo_path: str | Path, commit: str | None = None) -> list[str]:
    """Check that every declared entity exists at the pinned commit.

    Mechanical on purpose. Prompts reference real symbols in real files, and an author's belief
    about a path is exactly the kind of claim this repository has learned to verify rather than
    trust. Returns a problem per missing path; an absent checkout is the caller's problem to
    report, not something to treat as verified.
    """
    revision = commit or str((pack.get("repo") or {}).get("commit") or "")
    if not revision:
        raise ValueError("no commit to verify against: pass one or set pack.repo.commit")
    problems: list[str] = []
    for task in pack.get("tasks") or []:
        for entity in task.get("expectedEntities") or []:
            completed = subprocess.run(
                ["git", "-C", str(repo_path), "cat-file", "-e", f"{revision}:{entity}"],
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                problems.append(f"{task.get('taskId')}: {entity} does not exist at {revision[:12]}")
    return problems


def _main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pack")
    parser.add_argument("--repo", default=None, help="local checkout used to verify entities exist at the pinned commit")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        pack = load_pack(args.pack)
    except ValueError as exc:
        print(json.dumps({"status": "unreadable", "error": str(exc)}, ensure_ascii=False, indent=2))
        return 2

    errors = validate_pack(pack)
    verified: list[str] = []
    unverified_reason: str | None = None
    if args.repo:
        verified = verify_entities_against_repo(pack, args.repo)
    else:
        unverified_reason = "no --repo given: entity existence was not checked against the pinned commit"

    report = {
        "pack": str(args.pack),
        "status": "invalid" if errors else "valid",
        "tasks": len(pack.get("tasks") or []),
        "truth_kinds": sorted({str(t.get("truthKind")) for t in pack.get("tasks") or []}),
        "intent_groups": sorted({str(t.get("intentGroup")) for t in pack.get("tasks") or []}),
        "errors": errors,
        "entities_missing_at_pinned_commit": verified,
        "entity_verification": "unverified" if unverified_reason else "checked",
        "entity_verification_note": unverified_reason,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else _render(report))
    if errors or verified:
        return 2 if errors else 1
    return 0


def _render(report: dict[str, Any]) -> str:
    lines = [
        f"pack   : {report['pack']}",
        f"status : {report['status']}",
        f"tasks  : {report['tasks']}",
        f"kinds  : {', '.join(report['truth_kinds'])}",
        f"groups : {', '.join(report['intent_groups'])}",
        f"entities: {report['entity_verification']}"
        + (f" ({report['entity_verification_note']})" if report["entity_verification_note"] else ""),
    ]
    for error in report["errors"]:
        lines.append(f"  ERROR: {error}")
    for missing in report["entities_missing_at_pinned_commit"]:
        lines.append(f"  MISSING: {missing}")
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(_main())
