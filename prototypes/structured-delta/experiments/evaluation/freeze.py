"""Freeze all protocol, code and benchmark bytes before formal evaluation."""

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def hashes(root):
    paths = [root / "PROTOCOL.md"] + sorted((root / "experiments").rglob("*"))
    return {
        p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in paths
        if p.is_file()
        and "__pycache__" not in p.parts
        and "results" not in p.parts
        and p.suffix in {".py", ".md", ".json", ".diff", ".txt"}
    }


def verify(root):
    frozen = json.loads((root / "FREEZE.json").read_text())
    current = hashes(root)
    if frozen["sha256"] != current:
        changed = sorted(
            k
            for k in frozen["sha256"].keys() | current.keys()
            if frozen["sha256"].get(k) != current.get(k)
        )
        raise RuntimeError(
            "Frozen inputs changed; create a new protocol version, retain old runs: "
            + str(changed)
        )
    return frozen


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--root", type=Path, default=Path("."))
    args = p.parse_args()
    dest = args.root / "FREEZE.json"
    if dest.exists():
        raise FileExistsError("Refusing to replace existing freeze")
    dest.write_text(
        json.dumps(
            {
                "created_at": datetime.now(timezone.utc).isoformat(),
                "sha256": hashes(args.root),
            },
            indent=2,
        )
        + "\n"
    )
    print(dest)
