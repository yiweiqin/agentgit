"""Real Git application/merges and subprocess checks; never used by extractor."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def snapshot(path):
    return {
        p.relative_to(path).as_posix(): p.read_text()
        for p in sorted(path.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts and ".git" not in p.parts
    }


def digest(state):
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()


def write(root, state):
    for p, s in state.items():
        dest = root / p
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(s)


def git(root, *args, input=None, check=True):
    env = {
        **os.environ,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_AUTHOR_NAME": "Delta Research",
        "GIT_AUTHOR_EMAIL": "delta@example.invalid",
        "GIT_COMMITTER_NAME": "Delta Research",
        "GIT_COMMITTER_EMAIL": "delta@example.invalid",
        "GIT_AUTHOR_DATE": "2026-10-07T00:00:00Z",
        "GIT_COMMITTER_DATE": "2026-10-07T00:00:00Z",
    }
    # Ignore inherited repository selection, avoiding accidental parent /tmp/.git.
    for key in (
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ):
        env.pop(key, None)
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        input=input,
        capture_output=True,
        text=True,
        env=env,
        timeout=20,
    )
    if check and result.returncode:
        raise RuntimeError(
            f"Git {args[0]} failed ({result.returncode}): {result.stderr}"
        )
    return result


def check_state(state, checks):
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="delta-check-") as temp:
        root = Path(temp)
        write(root, state)
        results = []
        for name, code in [
            (
                "syntax",
                'import ast\nfrom pathlib import Path\nfor p in Path(".").rglob("*.py"): ast.parse(p.read_text(),filename=str(p))',
            )
        ] + list(checks.items()):
            try:
                # -I plus explicit cwd in sys.path: no installed project/PYTHONPATH leakage.
                result = subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        "-B",
                        "-c",
                        'import sys; sys.path.insert(0, ".")\n' + code,
                    ],
                    cwd=root,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                results.append(
                    {
                        "check": name,
                        "passed": result.returncode == 0,
                        "exit_code": result.returncode,
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                    }
                )
            except subprocess.TimeoutExpired as exc:
                results.append(
                    {
                        "check": name,
                        "passed": False,
                        "exit_code": None,
                        "error": "timeout",
                        "stdout": str(exc.stdout),
                        "stderr": str(exc.stderr),
                    }
                )
    return {
        "passed": all(r["passed"] for r in results),
        "checks": results,
        "elapsed_ms": (time.perf_counter() - started) * 1000,
    }


def strict_order(base, patches, checks):
    with tempfile.TemporaryDirectory(prefix="delta-apply-") as temp:
        root = Path(temp)
        git(root, "init", "-q")
        write(root, base)
        steps = []
        for patch in patches:
            r = git(root, "apply", "--whitespace=nowarn", "-", input=patch, check=False)
            steps.append(
                {
                    "applied": r.returncode == 0,
                    "stderr": r.stderr,
                    "exit_code": r.returncode,
                }
            )
            if r.returncode:
                return {
                    "applied": False,
                    "steps": steps,
                    "state_hash": None,
                    "tests": None,
                }
        state = snapshot(root)
        return {
            "applied": True,
            "steps": steps,
            "state_hash": digest(state),
            "tests": check_state(state, checks),
        }


def merged_pair(base, a, b, checks=None):
    """Git merge-tree in both parent orders, with fixed config and actual tree states."""
    with tempfile.TemporaryDirectory(prefix="delta-git-") as temp:
        root = Path(temp)
        git(root, "init", "-q")

        def commit(state, message):
            old = snapshot(root)
            for p in old.keys() - state.keys():
                (root / p).unlink()
            write(root, state)
            git(root, "add", "-A")
            git(root, "commit", "--allow-empty", "-qm", message)
            return git(root, "rev-parse", "HEAD").stdout.strip()

        base_id = commit(base, "base")
        a_id = commit(a, "A")
        git(root, "checkout", "-q", base_id)
        b_id = commit(b, "B")
        out = {}
        for key, left, right in (("ab", a_id, b_id), ("ba", b_id, a_id)):
            r = git(root, "merge-tree", "--write-tree", left, right, check=False)
            if r.returncode not in (0, 1):
                raise RuntimeError("merge-tree infrastructure error: " + r.stderr)
            rows = r.stdout.splitlines()
            tree = rows[0]
            conflict_paths = sorted(
                {
                    line.split("\t", 1)[1]
                    for line in rows[1:]
                    if "\t" in line
                    and line.split("\t")[0].split()[-1:] in (["1"], ["2"], ["3"])
                }
            )
            # git show via each tracked tree path avoids filesystem archive extraction.
            names = git(root, "ls-tree", "-r", "--name-only", tree).stdout.splitlines()
            state = {p: git(root, "show", f"{tree}:{p}").stdout for p in names}
            clean = r.returncode == 0
            out[key] = {
                "clean": clean,
                "conflict_paths": conflict_paths,
                "state_hash": digest(state),
                "tests": check_state(state, checks or {}) if clean else None,
                "raw": r.stdout,
                "state": state,
            }
        out["both_clean"] = out["ab"]["clean"] and out["ba"]["clean"]
        out["states_differ"] = (
            out["ab"]["state_hash"] != out["ba"]["state_hash"]
            if out["both_clean"]
            else None
        )
        return out


def commutativity(base, a, b, patch_a, patch_b, checks):
    merge = merged_pair(base, a, b, checks)
    strict = {
        "ab": strict_order(base, [patch_a, patch_b], checks),
        "ba": strict_order(base, [patch_b, patch_a], checks),
    }
    strict["both_apply"] = strict["ab"]["applied"] and strict["ba"]["applied"]
    strict["states_differ"] = (
        strict["ab"]["state_hash"] != strict["ba"]["state_hash"]
        if strict["both_apply"]
        else None
    )
    return {"strict_patch": strict, "three_way": merge}
