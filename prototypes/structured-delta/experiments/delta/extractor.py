"""Python AST + simple requirements/JSON analysis; no tests, labels or intent input.

This is deliberately bounded analysis, not an equivalence prover or type checker.
"""

import ast
import copy
import difflib
import json
from pathlib import PurePosixPath
from .model import ProgramDelta, Symbol


def dump(node):
    return ast.dump(node, include_attributes=False) if node is not None else ""


class Canonical(ast.NodeTransformer):
    def visit_Compare(self, node):
        node = self.generic_visit(node)
        if len(node.ops) == 1 and isinstance(node.ops[0], (ast.Is, ast.IsNot)):
            if isinstance(node.left, ast.Constant) and node.left.value is None:
                node.left, node.comparators[0] = node.comparators[0], node.left
        return node

    def visit_If(self, node):
        node = self.generic_visit(node)
        # Invert only an explicit identity test, preserving Python == semantics.
        if (
            len(node.body) == len(node.orelse) == 1
            and isinstance(node.body[0], ast.Return)
            and isinstance(node.orelse[0], ast.Return)
            and isinstance(node.test, ast.Compare)
            and len(node.test.ops) == 1
            and isinstance(node.test.ops[0], ast.IsNot)
        ):
            node.test.ops[0] = ast.Is()
            node.body, node.orelse = node.orelse, node.body
        return node


def canonical(node):
    return dump(Canonical().visit(copy.deepcopy(node)))


def module_path(name, files, current="", level=0):
    if level:
        parts = list(PurePosixPath(current).parent.parts)
        parts = parts[: len(parts) - level + 1]
        name = ".".join(parts + ([name] if name else []))
    path = name.replace(".", "/")
    for candidate in (path + ".py", path + "/__init__.py"):
        if candidate in files:
            return candidate
    return None


def literal_type(n):
    if n is None:
        return "None"
    if isinstance(n, ast.Constant):
        return type(n.value).__name__
    if isinstance(n, ast.Dict):
        keys = [
            k.value
            for k in n.keys
            if isinstance(k, ast.Constant) and isinstance(k.value, str)
        ]
        return "dict:" + ",".join(sorted(keys))
    if isinstance(n, (ast.List, ast.ListComp)):
        return "list"
    if isinstance(n, ast.Tuple):
        return "tuple:" + str(len(n.elts))
    if (
        isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id in {"str", "int", "float", "dict", "list", "bool", "set"}
    ):
        return n.func.id
    return "unknown"


def state(snapshot):
    symbols, imports, unresolved = {}, {}, []
    for path, source in sorted(snapshot.items()):
        if not path.endswith(".py"):
            continue
        try:
            tree = ast.parse(source, filename=path)
        except SyntaxError as exc:
            unresolved.append(f"{path}:{exc.lineno}: {exc.msg}")
            continue
        aliases, module_imports = {}, set()
        globals_ = {
            n.id
            for stmt in tree.body
            if isinstance(stmt, (ast.Assign, ast.AnnAssign))
            for n in ast.walk(stmt)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)
        }
        defs = {
            stmt.name
            for stmt in tree.body
            if isinstance(stmt, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))
        }
        # Module-local aliases, including relative and package imports.
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom):
                target = module_path(n.module or "", snapshot, path, n.level)
                for alias in n.names:
                    entity = (
                        f"{target}::{alias.name}"
                        if target
                        else f"dependency:{n.module}"
                    )
                    aliases[alias.asname or alias.name] = entity
                    module_imports.add(entity)
            elif isinstance(n, ast.Import):
                for alias in n.names:
                    target = module_path(alias.name, snapshot)
                    aliases[alias.asname or alias.name.split(".")[0]] = (
                        f"{target}::"
                        if target
                        else f"dependency:{alias.name.split('.')[0]}"
                    )
                    module_imports.add(
                        aliases[alias.asname or alias.name.split(".")[0]]
                    )
        imports[path] = sorted(module_imports)

        def resolve(n, locals_):
            if isinstance(n, ast.Name):
                if n.id in locals_:
                    return None
                if n.id in aliases:
                    return aliases[n.id]
                if n.id in globals_ or n.id in defs:
                    return f"{path}::{n.id}"
            if isinstance(n, ast.Attribute):
                parent = resolve(n.value, locals_)
                if parent:
                    return parent + ("" if parent.endswith("::") else ".") + n.attr
            if isinstance(n, ast.Subscript):
                parent = resolve(n.value, locals_)
                if parent and isinstance(n.slice, ast.Constant):
                    return parent + "[" + repr(n.slice.value) + "]"
            return None

        def collect(n, qual):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                entity = f"{path}::{qual}{n.name}"
                is_func = not isinstance(n, ast.ClassDef)
                sig, returns, rexpr, reads, writes, calls = {}, [], [], set(), {}, []
                local_names = set()
                if is_func:
                    args = n.args
                    declared_global = {
                        name
                        for k in ast.walk(n)
                        if isinstance(k, ast.Global)
                        for name in k.names
                    }
                    local_names = {
                        k.id
                        for k in ast.walk(n)
                        if isinstance(k, ast.Name) and isinstance(k.ctx, ast.Store)
                    } - declared_global
                    local_names |= {
                        k.arg for k in ast.walk(args) if isinstance(k, ast.arg)
                    }
                    positional = args.posonlyargs + args.args
                    sig = {
                        "parameters": [a.arg for a in positional],
                        "required": len(positional) - len(args.defaults),
                        "maximum": None if args.vararg else len(positional),
                        "posonly": len(args.posonlyargs),
                        "kwonly": [a.arg for a in args.kwonlyargs],
                        "required_kwonly": [
                            a.arg
                            for a, d in zip(args.kwonlyargs, args.kw_defaults)
                            if d is None
                        ],
                        "kwargs": bool(args.kwarg),
                        "annotations": [
                            ast.unparse(a.annotation) if a.annotation else ""
                            for a in positional
                        ],
                        "return": ast.unparse(n.returns) if n.returns else "",
                    }
                    parents = {
                        child: parent
                        for parent in ast.walk(n)
                        for child in ast.iter_child_nodes(parent)
                    }
                    for k in ast.walk(n):
                        if isinstance(k, ast.Return):
                            returns.append(literal_type(k.value))
                            rexpr.append(canonical(k.value))
                        if isinstance(
                            k, (ast.Name, ast.Attribute, ast.Subscript)
                        ) and isinstance(k.ctx, ast.Load):
                            ref = resolve(k, local_names)
                            parent = parents.get(k)
                            # Attribute/subscript access uses its most specific resolved entity.
                            # Avoid inventing interference between distinct constant keys.
                            covered = isinstance(
                                parent, (ast.Attribute, ast.Subscript)
                            ) and resolve(parent, local_names)
                            if ref and not covered:
                                reads.add(ref)
                        if isinstance(k, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                            targets = (
                                k.targets if isinstance(k, ast.Assign) else [k.target]
                            )
                            for t in targets:
                                ref = resolve(t, local_names)
                                if ref:
                                    writes.setdefault(ref, []).append(canonical(k))
                        if isinstance(k, ast.Call):
                            ref = resolve(k.func, local_names)
                            if ref:
                                calls.append(
                                    {
                                        "target": ref,
                                        "argc": len(k.args),
                                        "keywords": [v.arg for v in k.keywords],
                                        "dynamic": any(
                                            isinstance(a, ast.Starred) for a in k.args
                                        )
                                        or any(v.arg is None for v in k.keywords),
                                        "source": entity,
                                    }
                                )
                                # Common collection mutation methods are writes to the collection.
                                if isinstance(
                                    k.func, ast.Attribute
                                ) and k.func.attr in {
                                    "append",
                                    "extend",
                                    "update",
                                    "pop",
                                    "clear",
                                    "add",
                                    "remove",
                                    "setdefault",
                                }:
                                    parent = resolve(k.func.value, local_names)
                                    if parent:
                                        writes.setdefault(parent, []).append(
                                            canonical(k)
                                        )
                            if isinstance(k.func, ast.Name) and k.func.id in {
                                "getattr",
                                "eval",
                                "exec",
                                "globals",
                            }:
                                unresolved.append(f"{entity}: dynamic call {k.func.id}")
                symbols[entity] = Symbol(
                    entity,
                    "function" if is_func else "class",
                    n.lineno,
                    n.end_lineno,
                    canonical(n),
                    sig,
                    sorted(set(returns)),
                    rexpr,
                    sorted(reads),
                    writes,
                    calls,
                    [canonical(s) for s in n.body],
                )
                for child in n.body:
                    if isinstance(
                        child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
                    ):
                        collect(child, qual + n.name + ".")
            elif isinstance(n, (ast.Assign, ast.AnnAssign)) and not qual:
                for t in n.targets if isinstance(n, ast.Assign) else [n.target]:
                    if isinstance(t, ast.Name):
                        entity = f"{path}::{t.id}"
                        symbols[entity] = Symbol(
                            entity,
                            "state",
                            n.lineno,
                            n.end_lineno,
                            canonical(n),
                            returns=[literal_type(n.value)],
                            value=canonical(n.value),
                        )

        for node in tree.body:
            collect(node, "")
    for path, source in snapshot.items():
        if path == "requirements.txt":
            for row, line in enumerate(source.splitlines(), 1):
                if line.strip() and not line.startswith("#"):
                    import re

                    name = re.split(r"[<>=!~\[; ]", line.strip())[0].replace("-", "_")
                    key = "dependency:" + name
                    symbols[key] = Symbol(
                        key, "dependency", row, row, line.strip(), value=line.strip()
                    )
        elif path.endswith(".json"):
            try:
                data = json.loads(source)
                if isinstance(data, dict):
                    for key, value in data.items():
                        entity = f"{path}::{key}"
                        symbols[entity] = Symbol(
                            entity,
                            "config",
                            1,
                            len(source.splitlines()),
                            json.dumps(value, sort_keys=True),
                            value=repr(value),
                        )
            except ValueError:
                unresolved.append(f"{path}: invalid JSON")
    return symbols, imports, unresolved


def extract(base, changed):
    old, oi, ou = state(base)
    new, ni, nu = state(changed)
    files = sorted(
        p for p in base.keys() | changed.keys() if base.get(p) != changed.get(p)
    )
    affected = sorted(
        k
        for k in old.keys() | new.keys()
        if k not in old or k not in new or old[k].canonical != new[k].canonical
    )
    # Canonical equivalence can hide a substantive syntactic edit (e.g. reversed None identity).
    raw_old, raw_new = {}, {}
    for p in files:
        for index, snapshot in ((raw_old, base), (raw_new, changed)):
            try:
                tree = ast.parse(snapshot.get(p, "")) if p.endswith(".py") else None
                if tree:

                    def walk(ns, prefix=""):
                        for n in ns:
                            if isinstance(
                                n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
                            ):
                                index[f"{p}::{prefix}{n.name}"] = dump(n)
                                walk(n.body, prefix + n.name + ".")

                    walk(tree.body)
            except SyntaxError:
                pass
    affected = sorted(
        set(affected)
        | {k for k in raw_old.keys() & raw_new.keys() if raw_old[k] != raw_new[k]}
    )
    operations, ast_ops, contracts, reads, writes, calls = [], [], {}, set(), {}, []
    for k in affected:
        a, b = old.get(k), new.get(k)
        kind = "create" if a is None else "delete" if b is None else "modify"
        operations.append({"entity": k, "operation": kind})
        for s in (a, b):
            if s:
                reads.update(s.reads)
                calls.extend(s.calls)
        # Only actual changed write effects, not every pre-existing write in a changed function.
        aw, bw = a.writes if a else {}, b.writes if b else {}
        for ref in aw.keys() | bw.keys():
            if aw.get(ref) != bw.get(ref):
                writes.setdefault(ref, []).extend(bw.get(ref, ["<removed>"]))
        if (b or a).kind in {"state", "config", "dependency"}:
            writes[k] = [b.value if b else "<deleted>"]
        if a and b:
            fields = {}
            if a.signature != b.signature:
                fields["signature"] = {"before": a.signature, "after": b.signature}
            if a.returns != b.returns:
                fields["return_type"] = {"before": a.returns, "after": b.returns}
            if a.value != b.value:
                fields["value"] = {"before": a.value, "after": b.value}
            if fields:
                contracts[k] = fields
            matcher = difflib.SequenceMatcher(
                a=a.statements, b=b.statements, autojunk=False
            )
            for op, i, j, x, y in matcher.get_opcodes():
                if op != "equal":
                    ast_ops.append(
                        {
                            "entity": k,
                            "operation": op,
                            "before": a.statements[i:j],
                            "after": b.statements[x:y],
                        }
                    )
    # Exact-body rename candidates (names excluded), retained as evidence, not guessed by spelling.
    for op in list(operations):
        if op["operation"] != "delete":
            continue
        a = old[op["entity"]]
        matches = [
            p["entity"]
            for p in operations
            if p["operation"] == "create"
            and new[p["entity"]].kind == a.kind
            and a.statements
            and a.statements == new[p["entity"]].statements
            and a.signature == new[p["entity"]].signature
        ]
        if len(matches) == 1:
            op["operation"] = "rename"
            op["to"] = matches[0]
    lines = {}
    for p in files:
        touched = set()
        for op, i, j, x, y in difflib.SequenceMatcher(
            a=base.get(p, "").splitlines(),
            b=changed.get(p, "").splitlines(),
            autojunk=False,
        ).get_opcodes():
            if op != "equal":
                touched.update(range(i + 1, j + 1) if j > i else [i + 0.5])
        lines[p] = sorted(touched)
    imports_old = {v for p in files for v in oi.get(p, [])}
    imports_new = {v for p in files for v in ni.get(p, [])}
    deps_old = {k for k in old if k.startswith("dependency:")} | imports_old
    deps_new = {k for k in new if k.startswith("dependency:")} | imports_new
    return ProgramDelta(
        files,
        affected,
        operations,
        sorted(reads),
        writes,
        {k: old[k].signature for k in affected if k in old},
        {k: new[k].signature for k in affected if k in new},
        {k: old[k].returns for k in affected if k in old},
        {k: new[k].returns for k in affected if k in new},
        sorted(deps_new - deps_old),
        sorted(deps_old - deps_new),
        contracts,
        sorted(imports_new),
        calls,
        ast_ops,
        lines,
        {k: old[k] for k in affected if k in old},
        {k: new[k] for k in affected if k in new},
        sorted(set(ou + nu)),
    )
