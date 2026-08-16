#!/usr/bin/env python3
"""Report what this interpreter can actually do, as one JSON object on stdout.

Answers the question that costs the most time when a tool call fails: is the
library here, which modules import, and which functions would raise on call.

Both of Biomni's dependency gates are checked statically — module-level imports
and lazy imports inside function bodies — using AST plus `find_spec`. Nothing is
imported, so the probe stays fast and free of side effects, and a module whose
import would crash still gets reported instead of taking the probe down.
"""

import ast
import importlib.util
import json
import os
import pathlib
import sys


def _spec(name):
    """True when a module can be located without importing it."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _third_party(nodes, stdlib):
    out = set()
    for node in nodes:
        if isinstance(node, ast.Import):
            out.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            out.add(node.module.split(".")[0])
    return {m for m in out if m not in stdlib and m != "biomni"}


def _distribution_version(name):
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:
        return None


def survey():
    report = {
        "executable": sys.executable,
        "python": sys.version.split()[0],
        "biomni": None,
        "modules": [],
        "blockedFunctions": 0,
        "totalFunctions": 0,
        "missing": {},
    }

    spec = importlib.util.find_spec("biomni") if _spec("biomni") else None
    if spec is None or not spec.submodule_search_locations:
        return report

    report["biomni"] = _distribution_version("biomni") or "unknown"
    tooldir = pathlib.Path(list(spec.submodule_search_locations)[0]) / "tool"
    if not tooldir.is_dir():
        return report

    stdlib = set(getattr(sys, "stdlib_module_names", ()))
    missing = {}

    for path in sorted(tooldir.glob("*.py")):
        if path.stem == "__init__":
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue

        # Gate 1: module-level imports decide whether the module imports at all.
        blockers = sorted(m for m in _third_party(tree.body, stdlib) if not _spec(m))

        # Gate 2: imports inside function bodies decide whether each function runs.
        functions = blocked = 0
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if node.name.startswith("_"):
                continue
            functions += 1
            absent = {m for m in _third_party(ast.walk(node), stdlib) if not _spec(m)}
            if absent:
                blocked += 1
                for m in absent:
                    missing.setdefault(m, 0)
                    missing[m] += 1

        report["modules"].append({
            "name": path.stem,
            "importable": not blockers,
            "blockers": blockers,
            "functions": functions,
            "blocked": blocked,
        })
        report["totalFunctions"] += functions
        report["blockedFunctions"] += blocked

    # biomni.tool.__init__ imports biomni.utils; without those, nothing imports.
    report["gate"] = sorted(m for m in ("tqdm", "pandas") if not _spec(m))
    report["missing"] = dict(sorted(missing.items(), key=lambda kv: -kv[1]))
    return report


if __name__ == "__main__":
    try:
        print(json.dumps(survey()))
    except Exception as exc:  # noqa: BLE001 - the caller renders this
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
