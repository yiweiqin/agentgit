"""Reproduce the pilot in a fresh ignored workspace without overwriting a run."""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[1]


def run_module(workspace: Path, module: str, *arguments: str) -> None:
    environment = os.environ.copy()
    environment.pop("PYTHONPATH", None)
    subprocess.run(
        [sys.executable, "-B", "-m", module, *arguments],
        cwd=workspace,
        env=environment,
        check=True,
    )


def reproduce(output: Path) -> None:
    output = output.resolve()
    if output == SOURCE_ROOT or SOURCE_ROOT.is_relative_to(output):
        raise ValueError("Output must not contain the published source directory")
    output.mkdir(parents=True, exist_ok=False)
    shutil.copytree(
        SOURCE_ROOT / "experiments",
        output / "experiments",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "cases", "results"),
    )
    shutil.copyfile(SOURCE_ROOT / "PROTOCOL.md", output / "PROTOCOL.md")
    run_module(output, "experiments.benchmark.build")
    run_module(output, "experiments.evaluation.validate")
    run_module(output, "experiments.evaluation.freeze")
    run_module(output, "experiments.evaluation.evaluate")
    run_module(output, "experiments.online.simulator")
    run_module(
        output,
        "experiments.evaluation.report",
        "--static",
        "experiments/results/run-001",
        "--online",
        "experiments/results/online-001",
        "--out",
        "REPORT.md",
    )
    print(f"Report: {output / 'REPORT.md'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=SOURCE_ROOT / "artifacts/pilot-001")
    reproduce(parser.parse_args().out)
