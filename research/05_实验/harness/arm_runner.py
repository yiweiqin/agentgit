"""E1/E3 arm runner: plan -> isolated rounds -> ledgers -> verdict.

Why this exists
---------------
`preregistration.md` §5 fixes the arms (`A0`-`A4`), the unit of analysis (the round), the
primary indicator (redundant landing rate) and the `E-K4` guard.  §9 records that none of it
could be run, because no orchestrator existed: the harness directory held one-off
`remote_*.sh` probes, `synth_stream.py`, `xcheck_e0.py` and `eval_e2.py`, and nothing that
could drive a concurrency sweep or collect an arm's ledger.

This is that orchestrator.  It is split so the parts which decide what an experiment *means*
are pure and testable without a machine:

    plan parsing / validation / expansion      pure
    overlay + round-script rendering           pure
    outcome parsing, reconciliation            pure
    metrics, `E-K4` verdict                    pure
    provisioning and round execution           requires a machine (`run`)

Four decisions that are load-bearing
------------------------------------
1. **The ledger path is a directory, not a `.jsonl` file.**  `store.ts#ledgerFilePath` treats
   a path ending in `.jsonl` as the file itself, while `coord_ledger.py#ledger_path` always
   resolves `<dir>/events.jsonl`.  A `.jsonl` ledger path therefore makes the TypeScript side
   write one file and the Python side read another, and the Python report comes back empty --
   indistinguishable from "no contention found".  Arms get a *directory*; both agree.

2. **The run label is joined to the host session id through the host's own session
   directory, never through the ledger.**  The plugin never records the working directory, so
   there is no way to tell from the ledger which session a label belongs to.  Guessing
   "the one session with no match yet" breaks the moment two sessions run concurrently --
   which is every round.  The round script therefore reads the session id out of
   `$DSH_HOME/sessions/**/session-*/` after the session ends, and that id is what
   reconciliation closes capsules with.  A wrong join here would attribute one session's
   writes to another and silently swap the arms.

3. **Reconciliation is derived, never fabricated in place.**  The host wiring never emits
   `lifecycle_integrated` (rejection R4.2), so without reconciliation every capsule stays
   open and `B(t)` grows monotonically whatever the agents did -- E1's existence condition
   would be satisfied by the absence of a feature.  The runner appends the closing event into
   a *derived* ledger and leaves the collected evidence untouched.  The rule is mechanical
   and frozen here: exit 0 **and** a non-empty worktree diff means `integrated`; anything else
   means `abandoned`.

4. **Topology is a first-class field, and it is guarded.**  `ledgerScope: 'cross-session'` is
   implemented by reading an instance's **in-memory** event list
   (`governor.ts#visibleContention` via `#scopedEvents`).  The file is append-only and never
   read back, so N separate `dsh` *processes* sharing a ledger directory do not see each
   other; only sessions inside one host process do.  That is rejection R4.3, and it means
   `A3`/`A4` under `multi-process` cannot produce a treatment effect at all.  The runner
   refuses that combination with exit 2 rather than producing a plausible zero.

Usage
-----
    python harness/arm_runner.py expand  --plan harness/plans/e3-skeleton.json
    python harness/arm_runner.py dry-run --plan harness/plans/e3-skeleton.json --out results/E3/staging
    python harness/arm_runner.py report  --results results/E3
    python harness/arm_runner.py run     --plan harness/plans/e3-skeleton.json --results results/E3

`run` needs `DSH_SSH_HOST` / `DSH_SSH_PASSWORD` in the environment and reuses
`harness/remote.py`, so there is one SSH implementation rather than two.

Exit codes are the three-way verdict used everywhere else in this experiment:

    0  measured, every frozen check met
    1  measured, at least one check missed -> a result, and an iteration trigger
    2  could not measure -> the measurement itself is broken
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import statistics
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Sequence

_HARNESS_DIR = Path(__file__).resolve().parent
_EXPERIMENT_DIR = _HARNESS_DIR.parent
_ROOT_DIR = _EXPERIMENT_DIR.parent
_PLUGIN_DIR = _ROOT_DIR / "04_协调插件"
_TS_DIR = _PLUGIN_DIR / "dsh-coord-governor"

# The analysis instrument is the single source of truth for the wire format.  The runner
# writes its derived events through it rather than reimplementing `evt-<sha256>`; a third
# implementation of the ledger shape is a third thing that can silently drift.
sys.path.insert(0, str(_PLUGIN_DIR))
import coord_ledger  # noqa: E402  (path is set immediately above, on purpose)

sys.path.insert(0, str(_HARNESS_DIR))
import task_pack  # noqa: E402  (same directory; kept out of the plugin import above)

PLAN_SCHEMA = "coord-runplan-0.1"

# Arms as numbered in `preregistration.md` §5.1, plus the ablations `config.ts` defines.
# Literals rather than an import, because this file must run under plain python3 on the
# machine; `tests/test_arm_runner.py` reads `src/config.ts` and fails if the two drift.
PREREG_ARMS: tuple[str, ...] = (
    "A0-baseline",
    "A1-instrument",
    "A2-inert",
    "A3-advisory",
    "A4-gated",
)
ABLATION_ARMS: tuple[str, ...] = ("A4-session-only", "A4-detect-only")
ARM_NAMES: tuple[str, ...] = PREREG_ARMS + ABLATION_ARMS

# Arms whose entire point is reading other sessions' in-flight work.  Under a multi-process
# topology `governor.ts` sees only its own process, so these arms are inert; refusing is the
# difference between a null result and an invalid one.
ARMS_REQUIRING_SHARED_VIEW: tuple[str, ...] = ("A3-advisory", "A4-gated")

TOPOLOGIES: tuple[str, ...] = ("in-process-multi-session", "multi-process")

# Frozen in `preregistration.md` §5.6, kept here so the verdict cannot be re-derived with
# different numbers once the data exists.
E_K4_MEAN_DROP = 0.15
E_K4_PARALLEL_FRACTION_DROP = 0.25

# Frozen in §5.4 as the bound on the two-stage rule.  This is not the sample size: the N is
# written into the preregistration after E1's variance exists.
MIN_ROUNDS, MAX_ROUNDS = 8, 40


# --------------------------------------------------------------------------------------
# plan: schema, validation, expansion
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Run:
    """One agent session: one task, one worktree, one `DSH_HOME`."""

    experiment: str
    arm: str
    round_index: int
    session_index: int
    task_id: str
    intent_group: str
    developer: str
    label: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def label_for(experiment: str, arm: str, round_index: int, session_index: int) -> str:
    """Deterministic, filesystem-safe run label, with zero-padded indices.

    Zero-padded so `r2` does not sort after `r10` in a directory listing.  The listing order
    is the round order, which is the `B(t)` series order; a listing that lies about it
    invites a human diff to compare the wrong two rounds.
    """
    return f"{experiment}-{arm.replace('/', '_')}-r{round_index:03d}-s{session_index:02d}"


def _session_task(plan: dict[str, Any], round_index: int, session_index: int) -> dict[str, Any]:
    """Which task a given session runs.

    Index `(round + session) % len(tasks)` spreads each round across the task list while
    remaining a pure function of the plan, so two people expanding the same plan drive the
    same sessions.  Overlap is therefore a property of the plan's task ordering, and is
    validated by {@link _expansion}.
    """
    tasks = plan["tasks"]
    return tasks[(round_index + session_index) % len(tasks)]


def _expansion(plan: dict[str, Any]) -> tuple[list[str], list[Run]]:
    """Expand a plan into (errors that need the expansion, runs).

    Separate from {@link validate_plan} so the collision-coverage check and the actual
    expansion cannot disagree: both come from this one function.
    """
    errors: list[str] = []
    concurrency = plan.get("concurrency")
    rounds = plan.get("rounds")
    tasks = plan.get("tasks")

    if not isinstance(concurrency, int) or isinstance(concurrency, bool) or concurrency < 1:
        return errors, []
    if not isinstance(rounds, int) or isinstance(rounds, bool) or rounds < 1:
        return errors, []
    if not isinstance(tasks, list) or len(tasks) < 2:
        return errors, []
    if not plan.get("experiment") or not isinstance(plan.get("arms"), list) or not plan["arms"]:
        return errors, []

    runs: list[Run] = []
    for arm in plan["arms"]:
        for round_index in range(rounds):
            for session_index in range(concurrency):
                task = _session_task(plan, round_index, session_index)
                runs.append(
                    Run(
                        experiment=str(plan["experiment"]),
                        arm=str(arm),
                        round_index=round_index,
                        session_index=session_index,
                        task_id=str(task.get("taskId")),
                        intent_group=str(task.get("intentGroup")),
                        developer=str(task.get("developer")),
                        label=label_for(str(plan["experiment"]), str(arm), round_index, session_index),
                    )
                )

    # Every intent group with 2+ tasks must be co-scheduled in at least one round.  Otherwise
    # the plan declares duplication it never creates, and the primary indicator is
    # structurally zero for a reason no reader of the results could see.
    groups: dict[str, list[str]] = {}
    for task in tasks:
        groups.setdefault(str(task.get("intentGroup")), []).append(str(task.get("taskId")))
    for group, members in sorted(groups.items()):
        if len(members) < 2:
            continue
        member_set = set(members)
        if not any(
            len(
                {
                    _session_task(plan, round_index, session_index)["taskId"]
                    for session_index in range(concurrency)
                }
                & member_set
            )
            >= 2
            for round_index in range(rounds)
        ):
            errors.append(
                f"intent group {group!r} is never co-scheduled at concurrency={concurrency}: "
                "its duplicate work would be scheduled apart and never collide"
            )
    return errors, runs


def expand_runs(plan: dict[str, Any]) -> list[Run]:
    """Every run the plan defines, in a stable order (arm, round, session)."""
    errors, runs = _expansion(plan)
    if errors:
        raise ValueError("; ".join(errors))
    return runs


def validate_plan(plan: dict[str, Any]) -> list[str]:
    """Return every problem with a plan; an empty list means it may run.

    Collecting all errors rather than raising on the first is deliberate: a plan has several
    independent fields a human edits in one sitting, and fixing them one round-trip at a time
    is how a check gets bypassed instead of satisfied.
    """
    errors: list[str] = []

    if plan.get("schemaVersion") != PLAN_SCHEMA:
        errors.append(f"schemaVersion must be {PLAN_SCHEMA!r}, got {plan.get('schemaVersion')!r}")

    if plan.get("experiment") not in ("E1", "E3"):
        errors.append(f"experiment must be 'E1' or 'E3', got {plan.get('experiment')!r}")

    # --- task source: a validated runtime pack, or inline (rehearsal) tasks -----------------
    pack = plan.get("_pack")
    if pack is not None:
        errors.extend(f"pack: {error}" for error in task_pack.validate_pack(pack))
        if plan.get("status") == "frozen" and pack.get("status") != "frozen":
            # Same discipline as the pre-registration's own DRAFT/FROZEN split. A frozen plan
            # pointing at a draft pack freezes a design around task text that is still moving, and
            # the intent groups are the truth the primary indicator is scored against.
            errors.append(
                f"plan.status is 'frozen' but pack.status is {pack.get('status')!r}: freeze the pack "
                "before freezing the plan that measures against it"
            )
    if "pack" in plan and plan.get("_inline_tasks"):
        # With both present it is ambiguous which text the sessions ran, and only the pack carries
        # validated truth.
        errors.append(
            "a plan may declare either `pack` or inline `tasks`, not both: with both present it is "
            "ambiguous which text the sessions ran, and only the pack's labels have been checked"
        )

    # `status` mirrors the pre-registration's DRAFT/FROZEN distinction.  A skeleton plan is
    # useful for `expand` and `dry-run` (it proves the machinery is wired) and must never
    # produce data, because its tasks are placeholders and its indicator would be measured
    # on work nobody designed.
    if plan.get("status") not in ("skeleton", "frozen"):
        errors.append(f"status must be 'skeleton' or 'frozen', got {plan.get('status')!r}")

    topology = plan.get("topology")
    if topology not in TOPOLOGIES:
        errors.append(f"topology must be one of {TOPOLOGIES}, got {topology!r}")

    arms = plan.get("arms")
    if not isinstance(arms, list) or not arms:
        errors.append("arms must list at least one arm")
        arms = []
    for arm in arms:
        if arm not in ARM_NAMES:
            errors.append(f"unknown arm {arm!r}; known: {list(ARM_NAMES)}")
    if "A1-instrument" not in arms and ("A3-advisory" in arms or "A4-gated" in arms):
        # §7: a governance effect is compared against `A1`, never `A0`, because `A0` cannot
        # separate the observer effect from the intervention.
        errors.append(
            "A3/A4 require A1-instrument in the same plan: governance is compared against the "
            "placebo (recording on, governance off), not against the bare baseline"
        )
    if topology == "multi-process":
        for arm in arms:
            if arm in ARMS_REQUIRING_SHARED_VIEW:
                errors.append(
                    f"{arm} requires topology 'in-process-multi-session': under 'multi-process' the "
                    "plugin reads only its own process's in-memory events (R4.3), so the treatment "
                    "cannot fire and a null result would be indistinguishable from a broken one"
                )
    elif topology == "in-process-multi-session":
        # The supported path for a shared view: every session of a round is created through the
        # same `ctx.agents` registry inside one host process (`dsh-agent-loop`'s `Config.agents`
        # is documented as "agents created or resumed at plugin startup", and `dsh-base` leaves
        # it empty precisely so overlays can fill it). `round-driver.ts` does the creating.
        driver = (plan.get("plugin") or {}).get("driverEntry")
        if not driver:
            errors.append(
                "topology 'in-process-multi-session' requires plugin.driverEntry (the mounted "
                "round-driver module). Without it the round has no way to create its sessions, "
                "and the shared view A3/A4 depend on does not exist"
            )

    rounds = plan.get("rounds")
    if not isinstance(rounds, int) or isinstance(rounds, bool):
        errors.append("rounds must be an integer")
    elif not MIN_ROUNDS <= rounds <= MAX_ROUNDS:
        errors.append(
            f"rounds must be within the §5.4 bound {MIN_ROUNDS}..{MAX_ROUNDS}, got {rounds} (the exact "
            "N is frozen separately by the two-stage rule; this bound is not the sample size)"
        )

    concurrency = plan.get("concurrency")
    if not isinstance(concurrency, int) or isinstance(concurrency, bool) or concurrency < 2:
        errors.append("concurrency must be an integer >= 2: the independent variable is parallelism")

    timeout = plan.get("timeoutSeconds")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:
        errors.append("timeoutSeconds must be a positive integer")

    tasks = plan.get("tasks")
    if not isinstance(tasks, list) or len(tasks) < 2:
        errors.append("tasks must contain at least 2 entries")
        tasks = []
    seen_task_ids: set[str] = set()
    groups: dict[str, list[str]] = {}
    for index, task in enumerate(tasks):
        where = f"tasks[{index}]"
        task_id = task.get("taskId")
        if not task_id:
            errors.append(f"{where}.taskId is required")
        elif task_id in seen_task_ids:
            # Capsules are keyed by task id, so a duplicate merges two sessions into one
            # capsule and removes exactly the redundancy the primary indicator counts.
            errors.append(f"{where}.taskId {task_id!r} is duplicated: capsules are keyed by task id")
        else:
            seen_task_ids.add(task_id)
        if not task.get("prompt"):
            errors.append(f"{where}.prompt is required")
        group = task.get("intentGroup")
        if not group:
            errors.append(
                f"{where}.intentGroup is required: it is the construction truth the primary "
                "indicator is scored against, and it must not come from the detector"
            )
        else:
            groups.setdefault(str(group), []).append(str(task_id or where))
        if not task.get("developer"):
            errors.append(f"{where}.developer is required (the planned developer count is a sweep dimension)")

    if tasks and not any(len(members) >= 2 for members in groups.values()):
        errors.append(
            "no intent group has 2+ tasks: redundant landing rate is undefined by construction, so "
            "this plan would spend a machine and produce no primary indicator"
        )

    expansion_errors, _ = _expansion(plan)
    errors.extend(expansion_errors)

    for key in ("repo", "plugin", "dsh"):
        if not isinstance(plan.get(key), dict):
            errors.append(f"{key} must be an object")

    repo = plan.get("repo") or {}
    if repo:
        if not repo.get("commit"):
            errors.append("repo.commit is required: every round must replay one pinned revision")
        if not repo.get("path"):
            errors.append("repo.path is required (the machine-local checkout, not a URL)")

    dsh = plan.get("dsh") or {}
    if dsh:
        for key in ("binary", "profile"):
            if not dsh.get(key):
                errors.append(f"dsh.{key} is required")

    plugin = plan.get("plugin") or {}
    if plugin and not plugin.get("entry"):
        errors.append("plugin.entry is required (path to the Cordis entry module on the machine)")

    return errors


def load_plan(path: str | Path) -> dict[str, Any]:
    """Load a plan, resolving its task pack into `tasks` when it references one.

    A plan may either declare its tasks inline (useful for a rehearsal) or point at a runtime
    pack (the real thing). When it points at a pack, the pack's truth is validated by
    `validate_plan`, not here, so a contradiction is reported alongside every other problem
    rather than aborting the load.
    """
    plan_path = Path(path)
    text = plan_path.read_text(encoding="utf-8-sig")
    try:
        plan = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path}: invalid JSON at line {exc.lineno} column {exc.colno}: {exc.msg}") from exc
    if not isinstance(plan, dict):
        raise ValueError(f"{path}: plan must be a JSON object")

    pack_ref = plan.get("pack")
    if pack_ref:
        # Recorded before the pack's tasks are injected, so `validate_plan` can still tell an
        # inline task list from a derived one and refuse a plan that declares both.
        plan["_inline_tasks"] = "tasks" in plan
        pack_path = Path(str(pack_ref))
        if not pack_path.is_absolute():
            pack_path = (plan_path.resolve().parent / pack_path).resolve()
        pack = task_pack.load_pack(pack_path)
        plan["_pack"] = pack
        plan["_pack_path"] = str(pack_path)
        if not plan["_inline_tasks"]:
            plan["tasks"] = task_pack.tasks_for_plan(pack)
    return plan


# --------------------------------------------------------------------------------------
# rendering: Cordis overlay and the round script
# --------------------------------------------------------------------------------------


def render_overlay(
    arm: str,
    ledger_dir: str,
    plugin_entry: str,
    driver: tuple[str, str, str] | None = None,
) -> str:
    """The `--patch` overlay that mounts one arm, and optionally the round driver.

    Shape copied from the run verified against a live host (`remote_verify_fix.sh` §5): a
    `--patch` overlay is repeatable and per-run, so an arm cannot leak its install into the
    next arm the way mutating the profile did.  One overlay per (arm, round), because the
    ledger path is per-round and an overlay reused across rounds would silently point every
    round at the first round's ledger.

    `arm` is placed in the config rather than passed as a flag so the ledger itself carries
    the arm that produced it; a round whose data lands under the wrong arm is otherwise
    undetectable.

    `driver`, when given, is `(driver_entry, spec_path, done_marker)`.  It is mounted in the
    same overlay as the governor because the whole point of the in-process topology is that
    both live in one process: the governor's cross-session view is its own in-memory event
    list, so the driver that creates the sessions must share that process.
    """
    if arm not in ARM_NAMES:
        raise ValueError(f"unknown arm {arm!r}")

    # `A0-baseline` is defined as *the plugin not being mounted at all* -- that is what makes it
    # the bare baseline, and what distinguishes it from `A2-inert` ("loaded in the process but
    # touching nothing: prices mere presence"). Mounting the governor for A0 and A2 alike would
    # silently collapse those two arms into one, and `A1 - A2` would stop isolating recording cost.
    # `remote_verify_fix.sh` runs its A0 arm with no overlay for the same reason.
    #
    # Under the in-process topology the driver still has to be mounted for A0, because it is what
    # creates the round's sessions -- it is the launcher, not an instrument. It records nothing.
    listener = ""
    if arm != "A0-baseline":
        listener = (
            "- insert:\n"
            "    - id: coord-governor\n"
            f"      name: {plugin_entry}\n"
            "      config:\n"
            f"        arm: {arm}\n"
            f"        ledgerPath: {ledger_dir}\n"
        )
    if driver is None:
        return listener
    driver_entry, spec_path, done_marker = driver
    # The done marker is written by the driver only after every session is disposed, so its
    # presence means the round is closed rather than merely quiet. Stated as a YAML comment above
    # the insert rather than inside `config:`, so the generator never depends on how the host's
    # YAML reader treats interleaved comments in a mapping.
    prefix = "# coord-round-driver: the done marker is written after every session is disposed,\n# so its presence means the round is closed, not merely quiet.\n"
    insert = listener if listener else "- insert:\n"
    return prefix + insert + (
        "    - id: coord-round-driver\n"
        f"      name: {driver_entry}\n"
        "      config:\n"
        f"        specPath: {spec_path}\n"
        f"        doneMarker: {done_marker}\n"
    )


def round_spec_path(experiment_root: str, experiment: str, arm: str, round_index: int) -> str:
    return str(PurePosixPath(experiment_root) / "round-specs" / experiment / f"{arm}-r{round_index:03d}.json")


def done_marker_path(experiment_root: str, experiment: str, arm: str, round_index: int) -> str:
    return str(PurePosixPath(experiment_root) / "done" / experiment / f"{arm}-r{round_index:03d}")


def render_round_spec(plan: dict[str, Any], arm: str, round_index: int, experiment_root: str) -> str:
    """The driver's input for one round: one entry per session, with a stable session id.

    The session id is minted here rather than by the host, because the harness has to map a run
    label back to the host's session id to close that session's capsule, and the plugin never
    records the working directory. Passing the id in makes the join exact instead of inferred.
    """
    experiment = str(plan["experiment"])
    runs = [run for run in expand_runs(plan) if run.arm == arm and run.round_index == round_index]
    if not runs:
        raise ValueError(f"no runs for arm={arm} round={round_index}")
    tasks_by_id = {str(t["taskId"]): t for t in plan["tasks"]}
    spec = {
        "experiment": experiment,
        "arm": arm,
        "roundIndex": round_index,
        "outcomeRoot": f"{experiment_root}/outcomes/{experiment}",
        "doneMarker": done_marker_path(experiment_root, experiment, arm, round_index),
        "sessions": [
            {
                "label": run.label,
                # `session-<label>`: the `session-` prefix is what the host's own session
                # directories use, so a ledger/trace join keeps working either way.
                "sessionId": f"session-{run.label}",
                "cwd": f"{experiment_root}/worktrees/{run.label}",
                "prompt": str(tasks_by_id[run.task_id]["prompt"]),
            }
            for run in runs
        ],
    }
    return json.dumps(spec, ensure_ascii=False, indent=2) + "\n"


def round_ledger_dir(experiment_root: str, experiment: str, arm: str, round_index: int) -> str:
    """One ledger **directory** per (arm, round).

    A directory, not a `.jsonl` file: see decision 1 in the module docstring.  Shared by every
    session in the round, which is what makes the round the unit of analysis and cross-session
    contention observable at all.
    """
    return str(PurePosixPath(experiment_root) / "ledgers" / experiment / f"{arm}-r{round_index:03d}")


def overlay_path(experiment_root: str, arm: str, round_index: int) -> str:
    return str(PurePosixPath(experiment_root) / "overlays" / f"{arm}-r{round_index:03d}.yml")


def prompt_path(experiment_root: str, run: Run) -> str:
    return str(PurePosixPath(experiment_root) / "prompts" / f"{run.label}.txt")


def _q(value: str) -> str:
    """Quote for bash.

    Every remote path here is generated by this module; the only untrusted content is a task
    prompt, which is uploaded as a file and read with `cat` precisely so it never reaches
    this function.
    """
    return shlex.quote(value)


def _shell_path(value: str) -> str:
    """Render a path for bash, expanding a leading `~` while keeping the rest quoted.

    `shlex.quote` is wrong for a tilde path: it produces `'~/.coord-dsh.env'`, and a tilde
    inside quotes is a literal character, so `[ -f ... ]` is false, the credentials are never
    sourced, and every session dies with `MISSING_CREDENTIAL` -- which reads like a broken
    key rather than a quoting bug.  The tilde is translated to `$HOME` and the rest is
    double-quoted with `"` escaped.
    """
    if value == "~":
        return '"$HOME"'
    if value.startswith("~/"):
        return '"$HOME/' + value[2:].replace("\\", "\\\\").replace('"', '\\"') + '"'
    return shlex.quote(value)


def render_round_script(
    plan: dict[str, Any],
    arm: str,
    round_index: int,
    experiment_root: str,
    dsh_env_file: str,
) -> str:
    """A bash script that runs one round's sessions concurrently and records their outcomes.

    Dispatches on topology: `in-process-multi-session` starts the host **once** and lets the
    mounted round driver create every session inside it, because that shared process is the
    mechanism. `multi-process` starts one `dsh` per session.
    """
    if plan.get("topology") == "in-process-multi-session":
        return render_inprocess_round_script(plan, arm, round_index, experiment_root, dsh_env_file)

    # --- multi-process backend: one host process per session --------------------------------
    # Concurrency by backgrounding is the point: a sweep driven sequentially makes the
    # independent variable (simultaneity) an artefact of how long each session took, which is
    # exactly what `A0` vs `A1` must not be allowed to absorb.
    #
    # Two details exist because their failure modes are silent:
    #
    # * **Prompts are read from files, not interpolated.** PowerShell mangles nested quotes
    #   through SSH, and a prompt that loses half its words produces a session that ran, exited
    #   0, and did nothing -- a failure this repository has already paid for once.
    # * **The host session id is read from the session directory, not the ledger.** See decision
    #   2 in the module docstring. If it cannot be found the outcome says so, and reconciliation
    #   refuses rather than closing the wrong capsule.
    runs = [run for run in expand_runs(plan) if run.arm == arm and run.round_index == round_index]
    if not runs:
        raise ValueError(f"no runs for arm={arm} round={round_index}")

    experiment = str(plan["experiment"])
    overlay = overlay_path(experiment_root, arm, round_index)
    ledger = round_ledger_dir(experiment_root, experiment, arm, round_index)
    timeout = int(plan["timeoutSeconds"])
    common_env = (plan.get("dsh") or {}).get("env") or {}

    lines = [
        "#!/usr/bin/env bash",
        f"# Generated by arm_runner.py -- arm={arm} round={round_index}",
        "# Do not edit on the machine: the next run overwrites it, and a hand-edited round is no",
        "# longer the round the plan describes.",
        "set -uo pipefail",
        "",
        f"LEDGER_DIR={_q(ledger)}",
        f"OVERLAY={_q(overlay)}",
        f"REPO={_q(str(plan['repo']['path']))}",
        f"COMMIT={_q(str(plan['repo']['commit']))}",
        f"WORKTREE_ROOT={_q(experiment_root + '/worktrees')}",
        f"HOME_ROOT={_q(experiment_root + '/dsh-home')}",
        f"PROMPT_ROOT={_q(experiment_root + '/prompts')}",
        f"OUTCOME_ROOT={_q(experiment_root + '/outcomes/' + experiment)}",
        f"DSH={_q(str(plan['dsh']['binary']))}",
        f"PROFILE={_q(str(plan['dsh']['profile']))}",
        f"TIMEOUT={timeout}",
        "",
        "# Credentials come from an environment file: not from the command line (visible in `ps`",
        "# for the whole round) and not from the repository (§7).",
        f"DSH_ENV_FILE={_shell_path(dsh_env_file)}",
        'if [ -f "$DSH_ENV_FILE" ]; then set -a; . "$DSH_ENV_FILE"; set +a; fi',
    ]
    # `machine-assessment.md` §5: the machine ships Node 12 on PATH and a usable Node 24 off
    # it, so the verified invocation prepends the Node prefix.  Without this every session
    # fails at boot, and the failure looks like a DSH bug rather than a PATH omission.
    for entry in (plan.get("dsh") or {}).get("pathPrepend") or []:
        lines.append(f"export PATH={_q(str(entry))}:\"$PATH\"")
    for key, value in sorted(common_env.items()):
        lines.append(f"export {key}={_q(str(value))}")

    lines += [
        "",
        'mkdir -p "$LEDGER_DIR" "$WORKTREE_ROOT" "$HOME_ROOT" "$PROMPT_ROOT" "$OUTCOME_ROOT"',
        "",
        "run_one() {",
        '  local label="$1"',
        '  local worktree="$WORKTREE_ROOT/$label"',
        '  local dsh_home="$HOME_ROOT/$label"',
        '  local outdir="$OUTCOME_ROOT/$label"',
        '  local prompt_file="$PROMPT_ROOT/$label.txt"',
        '  local outcome="$outdir/outcome.env"',
        "",
        '  rm -rf "$worktree"; mkdir -p "$outdir" "$dsh_home"',
        "  # A worktree per session, not per round: two sessions in one working tree overwrite",
        "  # each other's files, and the resulting diff belongs to neither. The round still",
        "  # exits 0, so the damage is silent.",
        '  if ! git -C "$REPO" worktree add --detach --force "$worktree" "$COMMIT" >"$outdir/worktree.log" 2>&1; then',
        "    {",
        '      echo "LABEL=$label"',
        '      echo "SESSION="',
        '      echo "EXIT=99"',
        '      echo "SECONDS=0"',
        '      echo "LANDED=no"',
        '      echo "CHANGED=0"',
        '      echo "REASON=worktree-add-failed"',
        '    } > "$outcome"',
        "    return",
        "  fi",
        "",
        '  local started=$(date +%s)',
        "  (",
        '    cd "$worktree" || exit 98',
        '    export DSH_HOME="$dsh_home"',
        '    timeout "$TIMEOUT" "$DSH" --profile "$PROFILE" --patch "$OVERLAY" "$(cat "$prompt_file")"',
        '  ) >"$outdir/stdout.txt" 2>"$outdir/stderr.txt"',
        "  local rc=$?",
        "  local elapsed=$(( $(date +%s) - started ))",
        "",
        "  # The join to the host session id. `basename` of a `session-*` directory under this",
        "  # run's private DSH_HOME; the newest one is this run's, because the home is private.",
        '  local session_id=""',
        '  local session_dir=$(find "$dsh_home" -type d -name "session-*" -printf "%T@ %p\\n" 2>/dev/null | sort -rn | head -n1 | cut -d" " -f2-)',
        '  if [ -n "$session_dir" ]; then session_id=$(basename "$session_dir"); fi',
        "",
        "  # Landing is mechanical and frozen: a clean exit plus a non-empty worktree diff.",
        "  # Whether the work was *correct* is not this harness's job, and judging it here would",
        "  # let the harness decide the outcome it is supposed to observe.",
        '  local changed=0 landed=no reason=ok',
        '  changed=$(git -C "$worktree" status --porcelain 2>/dev/null | wc -l | tr -d " ")',
        '  if [ "$rc" -eq 0 ] && [ "$changed" -gt 0 ]; then landed=yes; fi',
        '  if [ "$rc" -eq 124 ]; then reason=timeout; fi',
        '  if [ -z "$session_id" ]; then reason=session-id-not-found; fi',
        "",
        "  {",
        '    echo "LABEL=$label"',
        '    echo "SESSION=$session_id"',
        '    echo "EXIT=$rc"',
        '    echo "SECONDS=$elapsed"',
        '    echo "LANDED=$landed"',
        '    echo "CHANGED=$changed"',
        '    echo "REASON=$reason"',
        '  } > "$outcome"',
        "",
        "  # Kept as evidence of what landed, without committing it: the harness must not create",
        "  # commits, because a commit is a reconciliation act and reconciling is what is measured.",
        '  git -C "$worktree" add -A >/dev/null 2>&1',
        '  git -C "$worktree" diff --cached --stat > "$outdir/diffstat.txt" 2>/dev/null',
        "}",
        "",
        "pids=()",
    ]

    for run in runs:
        lines.append(f"run_one {_q(run.label)} & pids+=($!)")

    lines += [
        "",
        "# `wait` on each pid individually: `wait` with no argument returns 0 for a round in",
        "# which every session failed, which would report a broken round as a clean one.",
        "status=0",
        'for pid in "${pids[@]}"; do wait "$pid" || status=1; done',
        "",
        "# Reconciliation events are deliberately NOT written here: they are derived locally",
        "# from the collected outcome files, so the evidence on the machine stays as produced.",
        f'echo "round complete: arm={arm} round={round_index} sessions={len(runs)}"',
        "exit $status",
        "",
    ]
    return "\n".join(lines)


def render_inprocess_round_script(
    plan: dict[str, Any],
    arm: str,
    round_index: int,
    experiment_root: str,
    dsh_env_file: str,
) -> str:
    """One host process for the whole round; the mounted driver creates the sessions.

    Why one process: `ledgerScope: 'cross-session'` is `governor.ts#visibleContention` reading
    the instance's in-memory event list. N processes sharing a ledger *file* cannot see each
    other, because the file is append-only and never read back (R4.3). One process makes the
    scope real, and that is the difference between measuring governance and measuring nothing.

    Why the script, not the driver, decides landing: the driver owns no git worktree, so it
    cannot see a diff. Landing is `exit 0` **and** a non-empty worktree diff, computed here from
    the per-run worktrees and appended to the driver's outcome files. `parse_outcome` is
    last-wins, so the appended keys are authoritative.

    Why SIGTERM instead of `process.exit` from the driver: the session log is compressed on
    flush, so exiting from inside can truncate the evidence. The launcher drains on SIGTERM by
    disposing the root, which is the documented exit path.
    """
    runs = [run for run in expand_runs(plan) if run.arm == arm and run.round_index == round_index]
    if not runs:
        raise ValueError(f"no runs for arm={arm} round={round_index}")

    experiment = str(plan["experiment"])
    overlay = overlay_path(experiment_root, arm, round_index)
    ledger = round_ledger_dir(experiment_root, experiment, arm, round_index)
    spec = round_spec_path(experiment_root, experiment, arm, round_index)
    done = done_marker_path(experiment_root, experiment, arm, round_index)
    timeout = int(plan["timeoutSeconds"])
    common_env = (plan.get("dsh") or {}).get("env") or {}

    lines = [
        "#!/usr/bin/env bash",
        f"# Generated by arm_runner.py -- in-process arm={arm} round={round_index}",
        "# One host process; the round driver creates every session inside it. Do not edit on the",
        "# machine: the next run overwrites it.",
        "set -uo pipefail",
        "",
        f"LEDGER_DIR={_q(ledger)}",
        f"OVERLAY={_q(overlay)}",
        f"SPEC={_q(spec)}",
        f"DONE={_q(done)}",
        f"REPO={_q(str(plan['repo']['path']))}",
        f"COMMIT={_q(str(plan['repo']['commit']))}",
        f"WORKTREE_ROOT={_q(experiment_root + '/worktrees')}",
        f"HOME_ROOT={_q(experiment_root + '/dsh-home')}",
        f"OUTCOME_ROOT={_q(experiment_root + '/outcomes/' + experiment)}",
        f"HOST_LOG={_q(experiment_root + '/host-logs/' + experiment + '-' + arm + f'-r{round_index:03d}')}",
        f"DSH={_q(str(plan['dsh']['binary']))}",
        f"PROFILE={_q(str(plan['dsh']['profile']))}",
        f"TIMEOUT={timeout}",
        "",
        f"DSH_ENV_FILE={_shell_path(dsh_env_file)}",
        'if [ -f "$DSH_ENV_FILE" ]; then set -a; . "$DSH_ENV_FILE"; set +a; fi',
    ]
    for entry in (plan.get("dsh") or {}).get("pathPrepend") or []:
        lines.append(f"export PATH={_q(str(entry))}:\"$PATH\"")
    for key, value in sorted(common_env.items()):
        lines.append(f"export {key}={_q(str(value))}")

    lines += [
        "",
        'mkdir -p "$LEDGER_DIR" "$WORKTREE_ROOT" "$HOME_ROOT" "$OUTCOME_ROOT" "$(dirname "$HOST_LOG")"',
        'rm -f "$DONE"',
        "",
        "# One worktree per session, created up front: the driver receives these paths as each",
        "# session's `cwd`, which is how two sessions of a round avoid overwriting each other.",
        "prepare_worktrees() {",
    ]
    for run in runs:
        lines.append(f"  git -C \"$REPO\" worktree add --detach --force \"$WORKTREE_ROOT/{run.label}\" \"$COMMIT\" >/dev/null 2>&1 || true")
    lines += [
        "}",
        "prepare_worktrees",
        "",
        "# The credentials and PATH are already exported into this shell, so the child inherits",
        "# them; `DSH_HOME` is per round, so two rounds cannot share session state.",
        'DSH_HOME="$HOME_ROOT/round-r' + f"{round_index:03d}" + '" "$DSH" --profile "$PROFILE" --patch "$OVERLAY" \\',
        '  >"$HOST_LOG.stdout.txt" 2>"$HOST_LOG.stderr.txt" &',
        "HOST_PID=$!",
        "",
        "# Poll for the driver's done marker. A marker written before the outcomes existed would",
        "# let the harness collect a half-written round, which the driver avoids by writing it last.",
        "timed_out=0",
        'deadline=$(( $(date +%s) + TIMEOUT ))',
        'while [ ! -f "$DONE" ]; do',
        '  if ! kill -0 "$HOST_PID" 2>/dev/null; then break; fi',
        '  if [ "$(date +%s)" -ge "$deadline" ]; then timed_out=1; break; fi',
        "  sleep 1",
        "done",
        "",
        "# SIGTERM, not SIGKILL: the launcher drains on SIGTERM by disposing the root, which is",
        "# what flushes the compressed session logs. SIGKILL would truncate exactly the evidence",
        "# this round exists to produce.",
        'kill -TERM "$HOST_PID" 2>/dev/null || true',
        'wait "$HOST_PID" 2>/dev/null || true',
        "",
        "# Landing is mechanical and frozen (see the docstring): computed here because the driver",
        "# has no git view, and appended because `parse_outcome` is last-wins.",
        "for label in " + " ".join(_q(run.label) for run in runs) + "; do",
        '  outcome="$OUTCOME_ROOT/$label/outcome.env"',
        '  mkdir -p "$(dirname "$outcome")"',
        '  if [ ! -f "$outcome" ]; then',
        '    printf \'LABEL=%s\\nSESSION=\\nEXIT=99\\nSECONDS=0\\nREASON=driver-produced-no-outcome\\n\' "$label" > "$outcome"',
        "  fi",
        '  changed=$(git -C "$WORKTREE_ROOT/$label" status --porcelain 2>/dev/null | wc -l | tr -d " ")',
        '  exit_code=$(sed -n "s/^EXIT=//p" "$outcome" | tail -n1)',
        '  landed=no',
        '  if [ "$exit_code" = "0" ] && [ "$changed" -gt 0 ]; then landed=yes; fi',
        '  printf \'CHANGED=%s\\nLANDED=%s\\n\' "$changed" "$landed" >> "$outcome"',
        '  if [ "$timed_out" -eq 1 ]; then printf \'REASON=timeout\\n\' >> "$outcome"; fi',
        "done",
        "",
        f'echo "round complete (in-process): arm={arm} round={round_index} sessions={len(runs)} timed_out=$timed_out"',
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------------------
# outcomes
# --------------------------------------------------------------------------------------


@dataclass
class Outcome:
    """One session's mechanical result, as written by the round script."""

    label: str
    session_id: str
    exit_code: int
    seconds: int
    landed: bool
    changed: int
    reason: str
    experiment: str = ""
    arm: str = ""
    round_index: int = -1
    session_index: int = -1
    task_id: str = ""
    intent_group: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


_KV = re.compile(r"^([A-Z_]+)=(.*)$")


def parse_outcome(text: str) -> dict[str, str]:
    """Parse the `KEY=value` file the round script writes.

    Not JSON: the writer is bash, and emitting JSON from a shell is a reliable source of
    malformed results.  Every value here is a single token, so there is nothing to escape.
    """
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        match = _KV.match(line)
        if match:
            values[match.group(1)] = match.group(2)
    return values


def outcome_from_file(path: Path, run: Run | None = None) -> Outcome:
    values = parse_outcome(path.read_text(encoding="utf-8", errors="replace"))
    required = ("EXIT", "LANDED", "CHANGED")
    missing = [key for key in required if key not in values]
    if missing:
        # The in-process driver writes EXIT but not LANDED/CHANGED: it owns no git worktree, so
        # it cannot see a diff, and the round script appends those two keys afterwards. A missing
        # key means the landing was never decided, and defaulting to "did not land" would quietly
        # move real work out of the numerator of the primary indicator.
        raise ValueError(
            f"{path}: missing {missing}. Landing is decided by the round script from the run's "
            "worktree; a missing LANDED means that step did not run, not that the run failed."
        )
    try:
        exit_code = int(values.get("EXIT", "99"))
        seconds = int(values.get("SECONDS", "0"))
        changed = int(values.get("CHANGED", "0"))
    except ValueError as exc:
        raise ValueError(f"{path}: non-numeric field: {values}") from exc
    return Outcome(
        label=values.get("LABEL", path.parent.name),
        session_id=values.get("SESSION", ""),
        exit_code=exit_code,
        seconds=seconds,
        landed=values.get("LANDED", "no") == "yes",
        changed=changed,
        reason=values.get("REASON", "unknown"),
        experiment=run.experiment if run else "",
        arm=run.arm if run else "",
        round_index=run.round_index if run else -1,
        session_index=run.session_index if run else -1,
        task_id=run.task_id if run else "",
        intent_group=run.intent_group if run else "",
    )


# --------------------------------------------------------------------------------------
# reconciliation: derived lifecycle events
# --------------------------------------------------------------------------------------


def read_raw_ledger(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{lineno}: malformed JSON") from exc
        if isinstance(record, dict):
            events.append(record)
    return events


def reconcile(events: Sequence[dict[str, Any]], outcomes: Sequence[Outcome]) -> list[dict[str, Any]]:
    """Append one closing lifecycle event per session, timestamped at that session's last event.

    Why at the session's own last event and not at collection time: `B(t)` is a time series,
    and closing every capsule when the harness noticed would draw one vertical drop at the end
    of each round instead of a curve.

    Why a session with no events gets no closing event: writing one would invent a capsule for
    a session that never touched anything, and `B(t)` would then depend on how many sessions
    were *launched* rather than on how many worked.

    Why a landed session without a session id is an error: its capsule would stay open and
    inflate `B(t)` permanently, in the arm that happened to hit the bug.  Failing loudly keeps
    that from looking like a finding.
    """
    known_sessions = {str(e.get("session_id")) for e in events if e.get("session_id")}
    last_stamp: dict[str, str] = {}
    for event in events:
        session = event.get("session_id")
        stamp = event.get("timestamp_utc")
        if session and stamp:
            current = last_stamp.get(str(session))
            if current is None or str(stamp) > current:
                last_stamp[str(session)] = str(stamp)

    derived = list(events)
    for outcome in sorted(outcomes, key=lambda item: item.label):
        if not outcome.session_id:
            if outcome.landed:
                raise ValueError(
                    f"{outcome.label} landed but its host session id was not captured, so its capsule "
                    "cannot be closed and B(t) would be inflated. Fix session-id capture before "
                    "trusting this round."
                )
            continue
        if outcome.session_id not in known_sessions:
            # The session ran but wrote nothing to the ledger, so there is no capsule to close.
            continue
        stamp = last_stamp.get(outcome.session_id)
        if not stamp:
            continue
        try:
            when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        except ValueError:
            when = datetime.now(timezone.utc)
        kind = "lifecycle_integrated" if outcome.landed else "lifecycle_abandoned"
        reason = (
            "harness reconcile: exit 0 and the worktree diff is non-empty"
            if outcome.landed
            else f"harness reconcile: exit={outcome.exit_code} changed={outcome.changed} reason={outcome.reason}"
        )
        try:
            derived.append(
                coord_ledger.build_event(
                    kind=kind,
                    session_id=outcome.session_id,
                    developer=None,
                    # Session-fallback attribution, matching what the plugin writes for
                    # `file_write`: the host declares no task id, so the session stands in as
                    # the task.  If the plugin ever emits a declared id, this line and
                    # `governor.ts#attribute` must change together or the capsules split.
                    task_id=outcome.session_id,
                    entities=[],
                    reason=reason,
                    hook_input={"hook_event_name": "harness/reconcile"},
                    now=when,
                )
            )
        except coord_ledger.LedgerError as exc:
            raise ValueError(f"cannot build a reconciliation event for {outcome.label}: {exc}") from exc
    return derived


def reconcile_round(ledger_dir: Path, outcomes: Sequence[Outcome]) -> list[dict[str, Any]]:
    """Reconcile one round's raw ledger against its outcome files."""
    raw_path = ledger_dir / coord_ledger.LEDGER_FILENAME
    if not raw_path.exists():
        raise FileNotFoundError(f"no ledger at {raw_path}: the round produced no evidence")
    return reconcile(read_raw_ledger(raw_path), outcomes)


# --------------------------------------------------------------------------------------
# metrics
# --------------------------------------------------------------------------------------


def _parse_ts(value: Any) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def parallelism_from_series(series: Sequence[dict[str, Any]]) -> dict[str, float]:
    """Mirror of `ledger.ts#computeParallelism`.

    The Python report does not compute effective parallelism and the TypeScript one does, so
    one side must be mirrored.  Mirroring here (rather than requiring Node on the analysis
    host) keeps the runner runnable on a machine that only has python3, which is the machine
    `machine-assessment.md` describes.  The mirror obligation is discharged by
    `tests/test_arm_runner.py`, which compares this against the TypeScript CLI when node is
    available and skips -- loudly -- when it is not.
    """
    if not series:
        return {"mean": 0.0, "peak": 0, "openAtEnd": 0, "observedHours": 0.0, "parallelHours": 0.0, "parallelFraction": 0.0}
    points = sorted(series, key=lambda p: str(p.get("timestamp_utc", "")))
    total_hours = max(0.0, (_parse_ts(points[-1]["timestamp_utc"]) - _parse_ts(points[0]["timestamp_utc"])).total_seconds() / 3600.0)
    area = 0.0
    parallel_hours = 0.0
    for index in range(len(points) - 1):
        span = max(0.0, (_parse_ts(points[index + 1]["timestamp_utc"]) - _parse_ts(points[index]["timestamp_utc"])).total_seconds() / 3600.0)
        open_now = int(points[index].get("open_capsules", 0))
        area += open_now * span
        if open_now >= 2:
            parallel_hours += span
    open_at_end = int(points[-1].get("open_capsules", 0))
    return {
        "mean": area / total_hours if total_hours > 0 else float(open_at_end),
        "peak": max(int(p.get("open_capsules", 0)) for p in points),
        "openAtEnd": open_at_end,
        "observedHours": total_hours,
        "parallelHours": parallel_hours,
        "parallelFraction": parallel_hours / total_hours if total_hours > 0 else 0.0,
    }


@dataclass
class RoundMetrics:
    """One (arm, round). §5.7 makes rounds the random effect, so this is the unit of analysis."""

    arm: str
    round_index: int
    events: int
    sessions_launched: int
    landed: int
    redundant_landings: int
    landed_functions: int
    redundant_landing_rate: float | None
    parallelism_mean: float
    parallel_fraction: float
    backlog_end: int
    integrated_capsules: int
    decayed_capsules: int
    contested_entities: int
    writes_after_context_loss: int
    gate_denied: int
    advisory_injected: int
    sessions_without_session_id: int
    rate_is_meaningful: bool
    lambda_produced_per_hour: float | None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def round_metrics(
    arm: str,
    round_index: int,
    reconciled: Sequence[dict[str, Any]],
    outcomes: Sequence[Outcome],
    report: dict[str, Any],
) -> RoundMetrics:
    """Fold one reconciled round into the numbers the preregistration fixes.

    Redundant landing is counted against the **plan's** declared intent groups, never against
    the detector's output and never against entity overlap.  §4's hard constraint is that
    overlap is not evidence of failed coordination, and the primary indicator is exactly where
    violating it would be invisible.
    """
    landed_outcomes = [o for o in outcomes if o.landed]
    groups: dict[str, list[Outcome]] = {}
    for outcome in landed_outcomes:
        groups.setdefault(outcome.intent_group, []).append(outcome)
    redundant = sum(len(members) - 1 for members in groups.values() if len(members) >= 2)
    landed_functions = len(landed_outcomes)

    counts = report.get("counts") or {}
    parallelism = parallelism_from_series(report.get("backlog_series") or [])

    def kind_count(kind: str) -> int:
        return sum(1 for event in reconciled if event.get("kind") == kind)

    return RoundMetrics(
        arm=arm,
        round_index=round_index,
        events=int(counts.get("events", 0)),
        sessions_launched=len(outcomes),
        landed=landed_functions,
        redundant_landings=redundant,
        landed_functions=landed_functions,
        redundant_landing_rate=(redundant / landed_functions) if landed_functions else None,
        parallelism_mean=float(parallelism["mean"]),
        parallel_fraction=float(parallelism["parallelFraction"]),
        backlog_end=int(counts.get("open_capsules", 0)),
        integrated_capsules=int(counts.get("integrated_capsules", 0)),
        decayed_capsules=int(counts.get("decayed_capsules", 0)),
        contested_entities=int(counts.get("contested_entities", 0)),
        writes_after_context_loss=int(report.get("writes_after_context_loss", 0)),
        gate_denied=kind_count("gate_denied"),
        advisory_injected=kind_count("advisory_injected"),
        sessions_without_session_id=sum(1 for o in outcomes if not o.session_id),
        rate_is_meaningful=bool((report.get("rates") or {}).get("rate_is_meaningful")),
        lambda_produced_per_hour=(report.get("rates") or {}).get("lambda_produced_per_hour"),
    )


def _describe(values: Sequence[float]) -> dict[str, Any]:
    """Mean, variance and n. §5.7 forbids reporting means without the variance."""
    clean = [float(v) for v in values]
    if not clean:
        return {"n": 0, "mean": None, "variance": None, "sd": None, "min": None, "max": None}
    if len(clean) == 1:
        return {"n": 1, "mean": clean[0], "variance": None, "sd": None, "min": clean[0], "max": clean[0]}
    return {
        "n": len(clean),
        "mean": statistics.fmean(clean),
        "variance": statistics.variance(clean),
        "sd": statistics.stdev(clean),
        "min": min(clean),
        "max": max(clean),
    }


@dataclass
class ArmSummary:
    arm: str
    rounds: int
    rounds_with_defined_rate: int
    redundant_landing_rate_pooled: float | None
    redundant_landing_rate_per_round: dict[str, Any]
    landed_functions_per_round: dict[str, Any]
    parallelism_mean: dict[str, Any]
    parallel_fraction: dict[str, Any]
    backlog_end: dict[str, Any]
    integrated_capsules: dict[str, Any]
    decayed_capsules: dict[str, Any]
    gate_denied_per_round: dict[str, Any]
    advisory_injected_per_round: dict[str, Any]
    per_round: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def summarise_arm(arm: str, rounds: Sequence[RoundMetrics]) -> ArmSummary:
    """Aggregate one arm's rounds.

    The primary indicator is reported pooled (total redundant / total landed) **and** as the
    distribution of per-round values.  Pooling alone hides a round that landed nothing; the
    distribution alone lets a tiny round dominate the mean.  §5.7 requires the variance, so
    both are kept.
    """
    defined = [r.redundant_landing_rate for r in rounds if r.redundant_landing_rate is not None]
    total_redundant = sum(r.redundant_landings for r in rounds)
    total_landed = sum(r.landed_functions for r in rounds)
    return ArmSummary(
        arm=arm,
        rounds=len(rounds),
        rounds_with_defined_rate=len(defined),
        redundant_landing_rate_pooled=(total_redundant / total_landed) if total_landed else None,
        redundant_landing_rate_per_round=_describe([v for v in defined if v is not None]),
        landed_functions_per_round=_describe([r.landed_functions for r in rounds]),
        parallelism_mean=_describe([r.parallelism_mean for r in rounds]),
        parallel_fraction=_describe([r.parallel_fraction for r in rounds]),
        backlog_end=_describe([r.backlog_end for r in rounds]),
        integrated_capsules=_describe([r.integrated_capsules for r in rounds]),
        decayed_capsules=_describe([r.decayed_capsules for r in rounds]),
        gate_denied_per_round=_describe([r.gate_denied for r in rounds]),
        advisory_injected_per_round=_describe([r.advisory_injected for r in rounds]),
        per_round=[r.as_dict() for r in rounds],
    )


def relative_drop(reference: float | None, treatment: float | None) -> float | None:
    """(reference - treatment) / reference, or None when it cannot be computed.

    None rather than 0 when the reference is zero: "no parallel work to begin with" is not
    "no drop", and treating it as such would silently pass the K4 guard on exactly the runs
    where the guard matters most.
    """
    if reference is None or treatment is None or reference == 0:
        return None
    return (reference - treatment) / reference


def e_k4_checks(summaries: dict[str, ArmSummary]) -> dict[str, Any]:
    """§5.6, frozen before the data. A3/A4 are compared against A1, never against A0."""
    reference = summaries.get("A1-instrument")
    checks: list[dict[str, Any]] = []
    for arm in ("A3-advisory", "A4-gated"):
        treatment = summaries.get(arm)
        if reference is None or treatment is None:
            continue
        mean_drop = relative_drop(reference.parallelism_mean.get("mean"), treatment.parallelism_mean.get("mean"))
        fraction_drop = relative_drop(reference.parallel_fraction.get("mean"), treatment.parallel_fraction.get("mean"))
        triggered = (mean_drop is not None and mean_drop > E_K4_MEAN_DROP) or (
            fraction_drop is not None and fraction_drop > E_K4_PARALLEL_FRACTION_DROP
        )
        checks.append(
            {
                "arm": arm,
                "reference": "A1-instrument",
                "parallelism_mean_drop": mean_drop,
                "parallelism_mean_threshold": E_K4_MEAN_DROP,
                "parallel_fraction_drop": fraction_drop,
                "parallel_fraction_threshold": E_K4_PARALLEL_FRACTION_DROP,
                "triggered": triggered,
                "interpretation": (
                    "a win here is throttling, not governance: report the configuration as admission "
                    "control and do not claim AI governance (total K4)"
                    if triggered
                    else "the win, if any, is not explained by reduced parallelism"
                ),
            }
        )
    return {"checks": checks, "triggered": any(c["triggered"] for c in checks)}


def verdict(summaries: dict[str, ArmSummary], k4: dict[str, Any]) -> dict[str, Any]:
    """Three-way outcome. A missing primary indicator is a broken measurement, not a zero."""
    problems: list[str] = []
    for arm, summary in sorted(summaries.items()):
        if summary.rounds == 0:
            problems.append(f"{arm}: no rounds collected")
        elif summary.rounds_with_defined_rate == 0:
            problems.append(
                f"{arm}: no round landed any work, so the primary indicator is undefined for every "
                "round -- that is not a rate of zero, it is an absent measurement"
            )
    if problems:
        return {"status": "could-not-measure", "exit_code": 2, "problems": problems, "k4": k4}
    if k4.get("triggered"):
        return {
            "status": "measured-with-kill-trigger",
            "exit_code": 1,
            "problems": [],
            "k4": k4,
            "triggers": ["K4: A3/A4 bought their result by suppressing parallelism"],
        }
    return {"status": "measured", "exit_code": 0, "problems": [], "k4": k4, "triggers": []}


# --------------------------------------------------------------------------------------
# provenance (§7: lock every version that could explain a result)
# --------------------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def provenance(plan: dict[str, Any], plan_path: Path) -> dict[str, Any]:
    entries: dict[str, Any] = {
        "plan": str(plan_path),
        "plan_sha256": sha256_file(plan_path),
        "repo_commit": (plan.get("repo") or {}).get("commit"),
        "dsh_profile": (plan.get("dsh") or {}).get("profile"),
        "plugin_entry": (plan.get("plugin") or {}).get("entry"),
        "topology": plan.get("topology"),
        "rounds": plan.get("rounds"),
        "concurrency": plan.get("concurrency"),
        "arms": plan.get("arms"),
    }
    # The pack is the construction truth the primary indicator is scored against, so its exact
    # bytes belong in provenance next to the plan: a pack edited after a run would otherwise make
    # the run's numbers unattributable to any text.
    pack_path = plan.get("_pack_path")
    if pack_path and Path(pack_path).exists():
        entries["pack"] = str(pack_path)
        entries["pack_sha256"] = sha256_file(Path(pack_path))
        entries["pack_status"] = (plan.get("_pack") or {}).get("status")
    for label, path in (
        ("preregistration", _EXPERIMENT_DIR / "preregistration.md"),
        ("plugin_src", _TS_DIR / "src" / "plugin.ts"),
        ("plugin_config", _TS_DIR / "src" / "config.ts"),
        ("analysis_python", _PLUGIN_DIR / "coord_ledger.py"),
    ):
        if path.exists():
            entries[f"{label}_sha256"] = sha256_file(path)
            entries[label] = str(path)
    return entries


# --------------------------------------------------------------------------------------
# staging: everything the machine receives, rendered before it is needed
# --------------------------------------------------------------------------------------


def stage(plan: dict[str, Any], out_dir: Path, experiment_root: str, dsh_env_file: str) -> dict[str, Any]:
    """Render overlays, prompts and round scripts into `out_dir`.

    Used by `dry-run` and by `run`, so the artifacts that touch a paid machine are exactly the
    artifacts that were validated offline.
    """
    runs = expand_runs(plan)
    overlays_dir = out_dir / "overlays"
    prompts_dir = out_dir / "prompts"
    scripts_dir = out_dir / "round-scripts"
    specs_dir = out_dir / "round-specs"
    for directory in (overlays_dir, prompts_dir, scripts_dir, specs_dir):
        directory.mkdir(parents=True, exist_ok=True)

    experiment = str(plan["experiment"])
    entry = str(plan["plugin"]["entry"])
    in_process = plan.get("topology") == "in-process-multi-session"
    driver_entry = str((plan.get("plugin") or {}).get("driverEntry") or "")
    for arm in plan["arms"]:
        for round_index in range(int(plan["rounds"])):
            driver = (
                (
                    driver_entry,
                    round_spec_path(experiment_root, experiment, arm, round_index),
                    done_marker_path(experiment_root, experiment, arm, round_index),
                )
                if in_process
                else None
            )
            (overlays_dir / f"{arm}-r{round_index:03d}.yml").write_text(
                render_overlay(
                    arm, round_ledger_dir(experiment_root, experiment, arm, round_index), entry, driver
                ),
                encoding="utf-8",
                newline="\n",
            )
            if in_process:
                (specs_dir / f"{arm}-r{round_index:03d}.json").write_text(
                    render_round_spec(plan, arm, round_index, experiment_root),
                    encoding="utf-8",
                    newline="\n",
                )

    tasks_by_id = {str(t["taskId"]): t for t in plan["tasks"]}
    for run in runs:
        (prompts_dir / f"{run.label}.txt").write_text(
            str(tasks_by_id[run.task_id]["prompt"]) + "\n", encoding="utf-8", newline="\n"
        )

    for arm in plan["arms"]:
        for round_index in range(int(plan["rounds"])):
            (scripts_dir / f"{arm}-r{round_index:03d}.sh").write_text(
                render_round_script(plan, arm, round_index, experiment_root, dsh_env_file),
                encoding="utf-8",
                newline="\n",
            )

    return {
        "runs": len(runs),
        "topology": plan.get("topology"),
        "overlays": len(list(overlays_dir.glob("*.yml"))),
        "round_specs": len(list(specs_dir.glob("*.json"))),
        "prompts": len(list(prompts_dir.glob("*.txt"))),
        "round_scripts": len(list(scripts_dir.glob("*.sh"))),
    }


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def _cmd_expand(args: argparse.Namespace) -> int:
    plan = load_plan(args.plan)
    errors = validate_plan(plan)
    if errors:
        print(json.dumps({"status": "invalid-plan", "errors": errors}, ensure_ascii=False, indent=2))
        return 2
    runs = expand_runs(plan)
    payload = {"plan": str(args.plan), "count": len(runs), "runs": [r.as_dict() for r in runs]}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"plan  : {args.plan}")
        print(f"runs  : {len(runs)}  (arms={len(plan['arms'])} rounds={plan['rounds']} concurrency={plan['concurrency']})")
        for run in runs:
            print(f"  {run.label:<44} task={run.task_id:<28} group={run.intent_group:<22} dev={run.developer}")
    return 0


def _cmd_dry_run(args: argparse.Namespace) -> int:
    plan = load_plan(args.plan)
    errors = validate_plan(plan)
    if errors:
        print(json.dumps({"status": "invalid-plan", "errors": errors}, ensure_ascii=False, indent=2))
        return 2
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    experiment_root = str(plan.get("experimentRoot", "/root/autodl-tmp/coord-exp"))
    counts = stage(plan, out_dir, experiment_root, str(plan.get("dshEnvFile", "~/.coord-dsh.env")))
    manifest = {
        "status": "dry-run",
        "plan": str(args.plan),
        "out": str(out_dir),
        **counts,
        "provenance": provenance(plan, Path(args.plan)),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


def _load_rounds(results_dir: Path) -> dict[str, list[RoundMetrics]]:
    by_arm: dict[str, list[RoundMetrics]] = {}
    path = results_dir / "rounds.jsonl"
    if not path.exists():
        return by_arm
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        missing = [k for k in RoundMetrics.__dataclass_fields__ if k not in payload]
        if missing:
            raise ValueError(f"{path}: round record is missing {missing}; refusing to analyse a partial record")
        metrics = RoundMetrics(**{k: payload[k] for k in RoundMetrics.__dataclass_fields__})
        by_arm.setdefault(metrics.arm, []).append(metrics)
    return by_arm


def _cmd_report(args: argparse.Namespace) -> int:
    """Aggregate collected rounds and apply the frozen checks. Never needs a machine."""
    results_dir = Path(args.results)
    by_arm = _load_rounds(results_dir)
    if not by_arm:
        print(json.dumps({"status": "could-not-measure", "exit_code": 2, "problems": [f"no round records under {results_dir}"]}, ensure_ascii=False, indent=2))
        return 2

    summaries = {arm: summarise_arm(arm, sorted(items, key=lambda m: m.round_index)) for arm, items in sorted(by_arm.items())}
    k4 = e_k4_checks(summaries)
    outcome = verdict(summaries, k4)
    report = {
        "status": outcome["status"],
        "results": str(results_dir),
        "arms": {arm: summary.as_dict() for arm, summary in summaries.items()},
        "e_k4": k4,
        "verdict": outcome,
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"results: {results_dir}")
        print(f"{'arm':<18}{'rounds':<8}{'redundant':<12}{'P_mean':<10}{'pf':<9}{'B_end':<9}{'landed':<8}")
        for arm, summary in summaries.items():
            rate = summary.redundant_landing_rate_pooled
            mean = summary.parallelism_mean["mean"]
            fraction = summary.parallel_fraction["mean"]
            backlog = summary.backlog_end["mean"]
            landed = summary.landed_functions_per_round["mean"]
            print(
                f"{arm:<18}{summary.rounds:<8}"
                f"{(f'{rate:.3f}' if rate is not None else 'n/a'):<12}"
                f"{(f'{mean:.3f}' if mean is not None else 'n/a'):<10}"
                f"{(f'{fraction:.3f}' if fraction is not None else 'n/a'):<9}"
                f"{(f'{backlog:.2f}' if backlog is not None else 'n/a'):<9}"
                f"{(f'{landed:.2f}' if landed is not None else 'n/a'):<8}"
            )
        for check in k4["checks"]:
            print(
                f"E-K4 {check['arm']} vs {check['reference']}: "
                f"{'TRIGGERED' if check['triggered'] else 'not triggered'} "
                f"(P drop={check['parallelism_mean_drop']}, pf drop={check['parallel_fraction_drop']})"
            )
        for problem in outcome.get("problems", []):
            print(f"problem: {problem}")
        print(f"status: {outcome['status']}")
    return int(outcome["exit_code"])


def _remote_module():
    """Import `remote.py` lazily, so `expand`/`dry-run`/`report` never need paramiko."""
    sys.path.insert(0, str(_HARNESS_DIR))
    import remote  # type: ignore

    return remote


def _cmd_run(args: argparse.Namespace) -> int:  # pragma: no cover - requires a live machine
    """Drive the plan on the experimental machine.

    Kept deliberately thin: stage, upload, run each round, download, analyse.  Every decision
    about *meaning* lives in the pure functions above, so a failure here is an infrastructure
    failure and cannot be mistaken for a result.
    """
    plan = load_plan(args.plan)
    errors = validate_plan(plan)
    if errors:
        print(json.dumps({"status": "invalid-plan", "errors": errors}, ensure_ascii=False, indent=2))
        return 2
    if plan.get("status") == "skeleton" and not args.allow_skeleton:
        # A skeleton's tasks are placeholders, so any data it produced would be measured on
        # work nobody designed.  Refusing is cheaper than explaining the result later.
        print(
            json.dumps(
                {
                    "status": "could-not-measure",
                    "exit_code": 2,
                    "error": "plan.status is 'skeleton': placeholder tasks must not produce data. Freeze the "
                    "plan (status='frozen') once its tasks and intent groups are real, or pass --allow-skeleton "
                    "only to rehearse the wiring, and label whatever comes out as a rehearsal.",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2

    rounds_file = Path(args.results) / "rounds.jsonl"
    if rounds_file.exists() and not args.resume:
        # A full run appends, so re-running into the same directory would count every round
        # twice and the arm summary would look like twice as many rounds of evidence. That is
        # worse than refusing, because duplicated evidence is still plausible evidence.
        print(
            json.dumps(
                {
                    "status": "could-not-measure",
                    "exit_code": 2,
                    "error": f"{rounds_file} already exists: a full run appends to it, so re-running here would "
                    "double-count every round. Use a fresh --results directory, or pass --resume to continue a "
                    "run that was interrupted (combine with --only-arm/--only-round when possible).",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2

    remote = _remote_module()
    experiment_root = str(plan.get("experimentRoot", "/root/autodl-tmp/coord-exp"))
    experiment = str(plan["experiment"])
    dsh_env_file = str(plan.get("dshEnvFile", "~/.coord-dsh.env"))
    results_dir = Path(args.results)
    results_dir.mkdir(parents=True, exist_ok=True)

    staging = results_dir / "staging"
    staging.mkdir(parents=True, exist_ok=True)
    stage(plan, staging, experiment_root, dsh_env_file)

    runs = expand_runs(plan)
    client = remote.connect()
    try:
        code, out, err = remote.run_script(client, _render_prepare_script(plan, experiment_root), timeout=1800)
        print(out, end="")
        if code != 0:
            print(err, file=sys.stderr)
            return 2

        # Upload the staged tree; `sftp_upload` makes the remote directories and strips the
        # UTF-8 BOMs Windows editors add, which are fatal in a shebang and in package.json.
        remote.sftp_upload(client, str(staging), f"{experiment_root}/_staging")
        remote.run(
            client,
            f"cp -r {shlex.quote(experiment_root)}/_staging/overlays {shlex.quote(experiment_root)}/ && "
            f"cp -r {shlex.quote(experiment_root)}/_staging/prompts {shlex.quote(experiment_root)}/ && "
            f"mkdir -p {shlex.quote(experiment_root)}/round-scripts {shlex.quote(experiment_root)}/round-specs && "
            f"cp -r {shlex.quote(experiment_root)}/_staging/round-scripts/. {shlex.quote(experiment_root)}/round-scripts/ && "
            f"cp -r {shlex.quote(experiment_root)}/_staging/round-specs/. {shlex.quote(experiment_root)}/round-specs/",
            timeout=300,
        )

        for arm in plan["arms"]:
            if args.only_arm and arm != args.only_arm:
                continue
            for round_index in range(int(plan["rounds"])):
                if args.only_round is not None and round_index != args.only_round:
                    continue
                script_path = staging / "round-scripts" / f"{arm}-r{round_index:03d}.sh"
                script = _strip_bom(script_path.read_bytes()).decode("utf-8")
                code, out, err = remote.run_script(client, script, timeout=int(plan["timeoutSeconds"]) + 900)
                print(f"[{experiment} {arm} r{round_index:03d}] exit={code}")
                if code not in (0, 1):
                    # A round that timed out or crashed is a broken measurement, not a result.
                    # Continuing would bias the arm toward whichever rounds happened to be cheap.
                    print(out[-2000:], end="")
                    print(err[-2000:], file=sys.stderr)
                    return 2

                ledger = round_ledger_dir(experiment_root, experiment, arm, round_index)
                local_round = results_dir / "raw" / f"{arm}-r{round_index:03d}"
                (local_round / "outcomes").mkdir(parents=True, exist_ok=True)
                remote.sftp_download(
                    client, f"{ledger}/{coord_ledger.LEDGER_FILENAME}", str(local_round / coord_ledger.LEDGER_FILENAME)
                )
                remote.sftp_download(
                    client, f"{experiment_root}/outcomes/{experiment}", str(local_round / "outcomes")
                )

                outcomes = _collect_outcomes(local_round, runs)
                derived = reconcile_round(local_round, outcomes)
                reconciled_dir = local_round / "reconciled"
                reconciled_dir.mkdir(exist_ok=True)
                (reconciled_dir / coord_ledger.LEDGER_FILENAME).write_text(
                    "\n".join(json.dumps(e, ensure_ascii=False, sort_keys=True) for e in derived) + "\n",
                    encoding="utf-8",
                    newline="\n",
                )
                metrics = round_metrics(arm, round_index, derived, outcomes, coord_ledger.compute_report(reconciled_dir))
                with (results_dir / "rounds.jsonl").open("a", encoding="utf-8", newline="\n") as handle:
                    handle.write(json.dumps(metrics.as_dict(), ensure_ascii=False, sort_keys=True) + "\n")

        (results_dir / "provenance.json").write_text(
            json.dumps(provenance(plan, Path(args.plan)), ensure_ascii=False, indent=2), encoding="utf-8"
        )
    finally:
        client.close()

    return _cmd_report(argparse.Namespace(results=str(results_dir), json=args.json))


def _strip_bom(raw: bytes) -> bytes:
    """Drop a leading UTF-8 BOM. See `remote.py` for why these three bytes matter here."""
    return raw[3:] if raw.startswith(b"\xef\xbb\xbf") else raw


def _collect_outcomes(local_round: Path, runs: Sequence[Run]) -> list[Outcome]:
    """Read the outcome files the round produced, joined back to the plan's runs."""
    by_label = {run.label: run for run in runs}
    outcomes: list[Outcome] = []
    for path in sorted((local_round / "outcomes").glob("*/outcome.env")):
        run = by_label.get(path.parent.name)
        outcomes.append(outcome_from_file(path, run))
    if not outcomes:
        raise ValueError(f"no outcome files under {local_round / 'outcomes'}: the round produced no result")
    return outcomes


def _render_prepare_script(plan: dict[str, Any], experiment_root: str) -> str:
    """Clone or fetch the pinned revision and create the run directories.

    A pinned commit, not a branch: a moving branch would let two rounds of the same arm run
    different code, and the arm comparison would absorb the difference.
    """
    repo = plan["repo"]
    path = str(repo["path"])
    url = str(repo.get("url", ""))
    commit = str(repo["commit"])
    return "\n".join(
        [
            "#!/usr/bin/env bash",
            "set -uo pipefail",
            f"REPO={_q(path)}",
            f"EXP_ROOT={_q(experiment_root)}",
            'if [ ! -d "$REPO/.git" ]; then',
            f"  mkdir -p {_q(str(PurePosixPath(path).parent))}",
            f"  git clone --filter=blob:none {_q(url)} \"$REPO\" || exit 2",
            "fi",
            'git -C "$REPO" fetch --all --tags --quiet || true',
            f'git -C "$REPO" cat-file -e {_q(commit)}^{{commit}} || {{ echo "missing pinned commit {commit}"; exit 2; }}',
            'mkdir -p "$EXP_ROOT/ledgers" "$EXP_ROOT/worktrees" "$EXP_ROOT/dsh-home" '
            '"$EXP_ROOT/outcomes" "$EXP_ROOT/overlays" "$EXP_ROOT/prompts" "$EXP_ROOT/round-scripts"',
            f'echo "prepare ok: $(git -C "$REPO" rev-parse --short {_q(commit)})"',
            "",
        ]
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    expand = sub.add_parser("expand", help="validate a plan and list every run it defines")
    expand.add_argument("--plan", required=True)
    expand.add_argument("--json", action="store_true")
    expand.set_defaults(func=_cmd_expand)

    dry = sub.add_parser("dry-run", help="render overlays, prompts and round scripts without a machine")
    dry.add_argument("--plan", required=True)
    dry.add_argument("--out", required=True)
    dry.set_defaults(func=_cmd_dry_run)

    report = sub.add_parser("report", help="aggregate collected rounds and apply the frozen checks")
    report.add_argument("--results", required=True)
    report.add_argument("--json", action="store_true")
    report.set_defaults(func=_cmd_report)

    run = sub.add_parser("run", help="drive the plan on the experimental machine")
    run.add_argument("--plan", required=True)
    run.add_argument("--results", default="results")
    run.add_argument("--only-arm", default=None, choices=list(ARM_NAMES))
    run.add_argument("--only-round", type=int, default=None)
    run.add_argument("--allow-skeleton", action="store_true", help="rehearse the wiring with a placeholder plan; the output is not data")
    run.add_argument("--resume", action="store_true", help="continue a run whose rounds.jsonl already exists")
    run.add_argument("--json", action="store_true")
    run.set_defaults(func=_cmd_run)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(
            json.dumps({"status": "could-not-measure", "exit_code": 2, "error": str(exc)}, ensure_ascii=False, indent=2),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
