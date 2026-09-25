"""Regression tests for runnable task packs and their plan integration.

Every rule tested here exists because breaking it is silent. A pack that claims a collision
between two tasks that share no entity produces a primary indicator of zero that looks like a
finding. A control that shares an intent group is a duplicate by construction whatever the author
meant. A "hidden" dependency on a shared entity is reachable by an entity-key detector, so
labelling it hidden inflates the recall ceiling and makes `I3` unfalsifiable. None of those turn
anything red on their own.

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

_HARNESS_DIR = Path(__file__).resolve().parents[1]
_EXPERIMENT_DIR = _HARNESS_DIR.parent
_REPO_DIR = _EXPERIMENT_DIR.parent / "03_基准与标注" / "benchmark" / "real-history" / "flask" / "repo"
_SHIPPED_PACK = _EXPERIMENT_DIR / "task-packs" / "runtime-v0" / "pack.json"
_SHIPPED_PLAN = _HARNESS_DIR / "plans" / "e3-skeleton.json"

sys.path.insert(0, str(_HARNESS_DIR))

import arm_runner  # noqa: E402
import task_pack  # noqa: E402


def task(task_id, group, kind, entities, *, developer="d1", depends_on=None, why="because"):
    entry = {
        "taskId": task_id,
        "intentGroup": group,
        "developer": developer,
        "truthKind": kind,
        "prompt": f"do {task_id}",
        "expectedEntities": entities,
        "why": why,
    }
    if depends_on is not None:
        entry["dependsOn"] = depends_on
    return entry


def pack_of(tasks, **overrides):
    pack = {
        "pack": "test",
        "schemaVersion": task_pack.PACK_SCHEMA,
        "status": "draft",
        "repo": {"url": "https://example.invalid/r.git", "commit": "a" * 40},
        "tasks": tasks,
    }
    pack.update(overrides)
    return pack


def complete_pack():
    """A minimal pack that satisfies every structural requirement, so a test can break one thing."""
    return pack_of(
        [
            task("T-dup-a", "G-dup", "true-collision", ["src/a.py"]),
            task("T-dup-b", "G-dup", "semantic-duplicate", ["src/a.py"], developer="d2"),
            task("T-ctrl", "G-ctrl", "independent-control", ["src/b.py"], developer="d2"),
            task("T-hidden", "G-hidden", "hidden-dependency", ["src/c.py"], developer="d2", depends_on=["T-dup-a"]),
        ]
    )


class ShippedPackTest(unittest.TestCase):
    def test_the_shipped_pack_is_structurally_valid(self):
        self.assertTrue(_SHIPPED_PACK.exists(), f"missing {_SHIPPED_PACK}")
        errors = task_pack.validate_pack(task_pack.load_pack(_SHIPPED_PACK))
        self.assertEqual(errors, [], errors)

    def test_every_declared_entity_exists_at_the_pinned_commit(self):
        # The point of declaring entities is that they are checkable. Without a local checkout the
        # check cannot run, and it says so rather than passing: "unverified" and "verified" are
        # different states, and conflating them is how a pack ships referencing paths that do not
        # exist and every task fails for the wrong reason.
        if not (_REPO_DIR / ".git").exists():
            self.skipTest(f"no local checkout at {_REPO_DIR}; entity verification cannot run")
        pack = task_pack.load_pack(_SHIPPED_PACK)
        problems = task_pack.verify_entities_against_repo(pack, _REPO_DIR)
        self.assertEqual(problems, [], problems)

    def test_verification_reports_a_missing_path_instead_of_passing(self):
        if not (_REPO_DIR / ".git").exists():
            self.skipTest(f"no local checkout at {_REPO_DIR}")
        pack = pack_of([task("T", "G", "true-collision", ["src/flask/definitely_not_here.py"])])
        problems = task_pack.verify_entities_against_repo(pack, _REPO_DIR)
        self.assertEqual(len(problems), 1)
        self.assertIn("does not exist", problems[0])


class StructuralValidationTest(unittest.TestCase):
    def test_complete_pack_is_valid(self):
        self.assertEqual(task_pack.validate_pack(complete_pack()), [])

    def test_wrong_schema_version_is_rejected(self):
        errors = task_pack.validate_pack(pack_of(complete_pack()["tasks"], schemaVersion="nope"))
        self.assertTrue(any("schemaVersion" in e for e in errors), errors)

    def test_unknown_status_is_rejected(self):
        errors = task_pack.validate_pack(pack_of(complete_pack()["tasks"], status="whatever"))
        self.assertTrue(any("status must be" in e for e in errors), errors)

    def test_missing_truth_kind_is_rejected(self):
        # A pack without a control makes precision meaningless: with no clean case, "flag
        # everything" scores a perfect recall.
        tasks = [t for t in complete_pack()["tasks"] if t["truthKind"] != "independent-control"]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("missing truth kinds" in e for e in errors), errors)

    def test_duplicate_task_id_is_rejected(self):
        tasks = complete_pack()["tasks"] + [task("T-dup-a", "G-x", "independent-control", ["src/d.py"], developer="d3")]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("duplicated" in e for e in errors), errors)

    def test_empty_entities_are_rejected(self):
        tasks = complete_pack()["tasks"]
        tasks[0]["expectedEntities"] = []
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("expectedEntities is required" in e for e in errors), errors)

    def test_non_repo_relative_entity_is_rejected(self):
        # Entities are matched as paths; a bare name would never coincide with another task's, so
        # the collision would be structurally impossible.
        tasks = complete_pack()["tasks"]
        tasks[0]["expectedEntities"] = ["a.py"]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("repo-relative" in e for e in errors), errors)

    def test_missing_why_is_rejected(self):
        tasks = complete_pack()["tasks"]
        del tasks[0]["why"]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("why is required" in e for e in errors), errors)

    def test_group_with_no_pairwise_shared_entity_is_rejected(self):
        # The union of member entities is non-empty here, so a union-based check would pass. Only a
        # pairwise intersection catches that the two "duplicates" are on different files.
        tasks = complete_pack()["tasks"]
        tasks[1]["expectedEntities"] = ["src/other.py"]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("share an expected entity" in e for e in errors), errors)

    def test_control_sharing_an_intent_group_is_rejected(self):
        tasks = complete_pack()["tasks"]
        tasks[2]["intentGroup"] = "G-dup"
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("shares intent group" in e for e in errors), errors)

    def test_control_may_share_an_entity_with_an_unrelated_task(self):
        # This is the H9 case and must stay legal: overlap is not evidence of failed coordination,
        # so a control on the same file as a duplicate is a required shape, not an error.
        tasks = complete_pack()["tasks"]
        tasks[2]["expectedEntities"] = ["src/a.py"]
        self.assertEqual(task_pack.validate_pack(pack_of(tasks)), [])

    def test_hidden_dependency_sharing_an_entity_is_rejected(self):
        tasks = complete_pack()["tasks"]
        tasks[3]["expectedEntities"] = ["src/a.py"]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("not hidden" in e for e in errors), errors)

    def test_hidden_dependency_without_depends_on_is_rejected(self):
        tasks = complete_pack()["tasks"]
        del tasks[3]["dependsOn"]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("dependsOn must name" in e for e in errors), errors)

    def test_hidden_dependency_naming_an_unknown_task_is_rejected(self):
        tasks = complete_pack()["tasks"]
        tasks[3]["dependsOn"] = ["T-nope"]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("unknown task" in e for e in errors), errors)

    def test_hidden_dependency_naming_itself_is_rejected(self):
        tasks = complete_pack()["tasks"]
        tasks[3]["dependsOn"] = ["T-hidden"]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("names itself" in e for e in errors), errors)

    def test_pack_without_a_duplicate_group_is_rejected(self):
        tasks = [
            task("T-ctrl-a", "G-a", "independent-control", ["src/a.py"]),
            task("T-ctrl-b", "G-b", "independent-control", ["src/b.py"], developer="d2"),
            task("T-hidden", "G-h", "hidden-dependency", ["src/c.py"], developer="d2", depends_on=["T-ctrl-a"]),
        ]
        errors = task_pack.validate_pack(pack_of(tasks))
        self.assertTrue(any("no intent group has 2+ tasks" in e for e in errors), errors)

    def test_missing_repo_commit_is_rejected(self):
        errors = task_pack.validate_pack(pack_of(complete_pack()["tasks"], repo={"url": "https://example.invalid/r.git"}))
        self.assertTrue(any("repo.commit" in e for e in errors), errors)


class TasksForPlanTest(unittest.TestCase):
    def test_only_scheduling_fields_are_handed_to_the_runner(self):
        # The runner must not be able to read analysis truth into a measurement: if `truthKind`
        # reached a plan, a future change could score against the label instead of the ledger.
        reduced = task_pack.tasks_for_plan(complete_pack())
        self.assertEqual(
            set(reduced[0]),
            {"taskId", "intentGroup", "developer", "prompt"},
        )
        for entry in reduced:
            self.assertNotIn("truthKind", entry)
            self.assertNotIn("expectedEntities", entry)


class PlanPackIntegrationTest(unittest.TestCase):
    def _write(self, directory: Path, pack: dict, plan_overrides: dict | None = None):
        pack_path = directory / "pack.json"
        pack_path.write_text(json.dumps(pack), encoding="utf-8")
        plan = {
            "status": "skeleton",
            "schemaVersion": arm_runner.PLAN_SCHEMA,
            "experiment": "E3",
            "topology": "in-process-multi-session",
            "arms": ["A1-instrument"],
            "rounds": 8,
            "concurrency": 2,
            "timeoutSeconds": 420,
            "pack": "pack.json",
            "repo": {"path": "/exp/repo", "commit": "a" * 40, "url": "https://example.invalid/r.git"},
            "plugin": {"entry": "/exp/plugin/src/index.ts", "driverEntry": "/exp/plugin/src/round-driver.ts"},
            "dsh": {"binary": "/exp/dsh", "profile": "coord-inproc"},
        }
        plan.update(plan_overrides or {})
        plan_path = directory / "plan.json"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        return plan_path

    def test_pack_tasks_are_injected_into_the_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(Path(tmp), complete_pack())
            plan = arm_runner.load_plan(path)
            self.assertEqual(
                [t["taskId"] for t in plan["tasks"]],
                ["T-dup-a", "T-dup-b", "T-ctrl", "T-hidden"],
            )
            self.assertEqual(arm_runner.validate_plan(plan), [])

    def test_pack_errors_surface_through_plan_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(Path(tmp), pack_of([task("T-1", "G-1", "true-collision", ["src/a.py"])]))
            errors = arm_runner.validate_plan(arm_runner.load_plan(path))
            self.assertTrue(any(e.startswith("pack: ") for e in errors), errors)

    def test_frozen_plan_may_not_reference_a_draft_pack(self):
        with tempfile.TemporaryDirectory() as tmp:
            plan = pack_of(
                [
                    task("T-1", "G-1", "true-collision", ["src/a.py"]),
                    task("T-2", "G-1", "semantic-duplicate", ["src/a.py"], developer="d2"),
                    task("T-c", "G-c", "independent-control", ["src/b.py"], developer="d2"),
                    task("T-h", "G-h", "hidden-dependency", ["src/c.py"], developer="d2", depends_on=["T-1"]),
                ]
            )
            path = self._write(Path(tmp), plan, {"status": "frozen"})
            errors = arm_runner.validate_plan(arm_runner.load_plan(path))
            self.assertTrue(any("freeze the pack" in e for e in errors), errors)

    def test_declaring_both_a_pack_and_inline_tasks_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(
                Path(tmp),
                pack_of(
                    [
                        task("T-1", "G-1", "true-collision", ["src/a.py"]),
                        task("T-2", "G-1", "semantic-duplicate", ["src/a.py"], developer="d2"),
                    ]
                ),
                {"tasks": [{"taskId": "T-x", "intentGroup": "G-x", "developer": "d1", "prompt": "p"}]},
            )
            errors = arm_runner.validate_plan(arm_runner.load_plan(path))
            self.assertTrue(any("not both" in e for e in errors), errors)

    def test_provenance_carries_the_pack_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(
                Path(tmp),
                pack_of(
                    [
                        task("T-1", "G-1", "true-collision", ["src/a.py"]),
                        task("T-2", "G-1", "semantic-duplicate", ["src/a.py"], developer="d2"),
                    ],
                    status="frozen",
                ),
            )
            entries = arm_runner.provenance(arm_runner.load_plan(path), path)
            self.assertIn("pack_sha256", entries)
            self.assertEqual(entries["pack_status"], "frozen")


class ShippedPlanTest(unittest.TestCase):
    def test_shipped_skeleton_plan_validates_and_pulls_real_tasks(self):
        plan = arm_runner.load_plan(_SHIPPED_PLAN)
        self.assertEqual(arm_runner.validate_plan(plan), [])
        self.assertEqual(len(plan["tasks"]), 8)
        self.assertTrue(all("placeholder" not in t["prompt"].lower() for t in plan["tasks"]))

    def test_shipped_plan_co_schedules_every_duplicate_group(self):
        # The runner's whole collision structure depends on the pack's task order; if a group's
        # members drift apart, its duplicate work is scheduled in separate rounds and never
        # collides, which is a structural zero no reader of the results could see.
        plan = arm_runner.load_plan(_SHIPPED_PLAN)
        groups: dict[str, list[str]] = {}
        for entry in plan["tasks"]:
            groups.setdefault(entry["intentGroup"], []).append(entry["taskId"])
        concurrency = int(plan["concurrency"])
        for group, members in groups.items():
            if len(members) < 2:
                continue
            covered = any(
                len(
                    {
                        plan["tasks"][(r + s) % len(plan["tasks"])]["taskId"]
                        for s in range(concurrency)
                    }
                    & set(members)
                )
                >= 2
                for r in range(int(plan["rounds"]))
            )
            self.assertTrue(covered, f"intent group {group} is never co-scheduled")


if __name__ == "__main__":
    unittest.main()
