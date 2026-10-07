"""Check exact source bytes and syntax without experimental data.

Historical AST digests document the original same-interpreter comparison.
They are not portable across Python AST schema and ast.dump format changes.
Exact byte hashes enforce source integrity on every supported interpreter.
"""

import ast
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def verify(root: Path = ROOT) -> None:
    manifest = json.loads((root / "SOURCE_PROVENANCE.json").read_text())
    paths = {
        path.relative_to(root).as_posix()
        for path in (root / "experiments").rglob("*.py")
        if "__pycache__" not in path.parts
        and "cases" not in path.parts
        and "results" not in path.parts
    }
    if paths != set(manifest["modules"]):
        raise ValueError("Published module inventory differs from provenance")
    for path, expected in manifest["modules"].items():
        content = (root / path).read_bytes()
        if digest(content) != expected["published_sha256"]:
            raise ValueError(f"Published source changed: {path}")
        ast.parse(content, filename=path)
    if digest((root / "PROTOCOL.md").read_bytes()) != manifest["protocol_sha256"]:
        raise ValueError("Historical protocol changed")
    print(f"Verified {len(paths)} published modules and historical protocol")


if __name__ == "__main__":
    verify()
