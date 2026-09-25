"""List every import in the plugin source, marking host-package value imports.

Written as a file rather than an inline command because nesting Python quoting through
PowerShell mangles the script badly enough to produce misleading syntax errors.

A *value* import of a `@deepseek-ai/*` package from a path-mounted plugin resolves that
package through a second location and loads a duplicate copy. That is a known failure mode
here (a duplicate request-extension registry broke every model call), so it is worth being
able to assert mechanically that none exists.
"""

from __future__ import annotations

import pathlib
import re
import sys

SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

STATEMENT = re.compile(r"^import\b", re.M)


def statement_end(lines: list[str], start: int) -> int:
    """Return the last line index of the import statement beginning at `start`."""
    index = start
    while index + 1 < len(lines):
        tail = lines[index].rstrip()
        if tail.endswith("'") or tail.endswith('"') or tail.endswith(";"):
            break
        index += 1
    return index


def main() -> int:
    found_value = False
    print("=== host-package imports ===")
    for path in sorted(SRC.glob("*.ts")):
        lines = path.read_text(encoding="utf-8").splitlines()
        index = 0
        while index < len(lines):
            if lines[index].startswith("import"):
                end = statement_end(lines, index)
                joined = " ".join(part.strip() for part in lines[index : end + 1])
                if "@deepseek-ai/" in joined:
                    type_only = joined.startswith("import type")
                    if not type_only:
                        found_value = True
                    label = "TYPE-ONLY" if type_only else ">>> VALUE IMPORT <<<"
                    print(f"  {path.name}:{index + 1}  {label}")
                    print(f"      {joined[:120]}")
                index = end + 1
            else:
                index += 1

    print()
    print("=== all module specifiers, per file ===")
    for path in sorted(SRC.glob("*.ts")):
        text = path.read_text(encoding="utf-8")
        specs = sorted(set(re.findall(r"""from\s+['"]([^'"]+)['"]""", text)))
        host = [s for s in specs if s.startswith("@") and not s.startswith("./")]
        print(f"  {path.name}: host={host or 'none'}")

    print()
    print("=== deep import chain walk (follows relative imports) ===")
    seen: set[str] = set()
    queue = [SRC / "index.ts"]
    host_hits: list[str] = []
    while queue:
        current = queue.pop()
        if not current.exists() or str(current) in seen:
            continue
        seen.add(str(current))
        text = current.read_text(encoding="utf-8")
        for spec in re.findall(r"""from\s+['"]([^'"]+)['"]""", text):
            if spec.startswith("@deepseek-ai/"):
                # Distinguish type-only by looking at the whole statement is hard here, so
                # report the specifier and let the one-line scan above classify it.
                host_hits.append(f"{current.name} -> {spec}")
            elif spec.startswith("."):
                queue.append((current.parent / spec).resolve())
    for hit in sorted(set(host_hits)):
        print(f"  {hit}")

    print()
    print(f"VALUE host imports found: {found_value}")
    return 1 if found_value else 0


if __name__ == "__main__":
    raise SystemExit(main())
