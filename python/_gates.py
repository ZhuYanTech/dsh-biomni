#!/usr/bin/env python3
"""Static analysis of Biomni's two dependency gates, shared by probe.py and skills.py.

Biomni declares three dependencies and needs far more. What it actually needs
hides behind two independent mechanisms:

  gate 1  module-level imports  -> whether a tool module imports AT ALL
  gate 2  imports inside function bodies -> whether an individual function runs

Gate 1 is all-or-nothing per module. Gate 2 is invisible to any module-level
check: a module that imports cleanly can still have functions that raise
ModuleNotFoundError when called.

Both consumers need the same verdicts — the environment report and the skill
catalog would be a bug factory if they could disagree about what is callable —
so the analysis lives here once.

Nothing is imported, only parsed: the probe stays fast and free of side
effects, and a module whose import would crash still gets reported instead of
taking the caller down.
"""

import ast
import importlib.util
import pathlib
import sys

__all__ = [
    "analyze_modules",
    "biomni_version",
    "spec_exists",
    "stdlib_names",
    "tool_dir",
    "universal_gate",
]

#: Packages that gate EVERY tool module at once. `biomni.tool.__init__` imports
#: `biomni.utils`, which needs these — so without them all 21 modules fail
#: identically, and the resulting ImportError names neither of them.
UNIVERSAL_GATE = ("tqdm", "pandas")


def spec_exists(name):
    """True when a module can be located without importing it."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def stdlib_names():
    """The stdlib module names to exclude from third-party import detection."""
    return set(getattr(sys, "stdlib_module_names", ()))


def _third_party(nodes, stdlib):
    """Top-level third-party package names imported by the given AST nodes."""
    out = set()
    for node in nodes:
        if isinstance(node, ast.Import):
            out.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            out.add(node.module.split(".")[0])
    return {m for m in out if m not in stdlib and m != "biomni"}


def biomni_version():
    """The installed biomni version, 'unknown' when it has no metadata, None when absent."""
    if not spec_exists("biomni"):
        return None
    try:
        from importlib.metadata import version

        return version("biomni")
    except Exception:  # noqa: BLE001 - absence is the answer, not a crash
        return "unknown"


def tool_dir():
    """The installed `biomni/tool` directory, or None when biomni is absent."""
    spec = importlib.util.find_spec("biomni") if spec_exists("biomni") else None
    if spec is None or not spec.submodule_search_locations:
        return None
    candidate = pathlib.Path(list(spec.submodule_search_locations)[0]) / "tool"
    return candidate if candidate.is_dir() else None


def universal_gate():
    """Which of the always-required packages are missing (see UNIVERSAL_GATE)."""
    return sorted(m for m in UNIVERSAL_GATE if not spec_exists(m))


def analyze_modules():
    """Analyze every tool module against both gates.

    Returns a list of dicts, one per module, sorted by name:

        name       module stem, e.g. "literature"
        importable whether every module-level import resolves (gate 1)
        blockers   sorted absent top-level packages (empty when importable)
        functions  [{"name": str, "blockedBy": [str, ...]}] for each public
                   function, where blockedBy lists the absent packages its own
                   body imports (gate 2; empty means callable)

    An empty list means biomni is absent or ships no tool directory.
    """
    directory = tool_dir()
    if directory is None:
        return []

    stdlib = stdlib_names()
    modules = []

    for path in sorted(directory.glob("*.py")):
        if path.stem == "__init__":
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue

        # Gate 1: module-level imports decide whether the module imports at all.
        blockers = sorted(m for m in _third_party(tree.body, stdlib) if not spec_exists(m))

        # Gate 2: imports inside function bodies decide whether each function runs.
        functions = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if node.name.startswith("_"):
                continue
            absent = sorted(m for m in _third_party(ast.walk(node), stdlib) if not spec_exists(m))
            functions.append({"name": node.name, "blockedBy": absent})

        modules.append({
            "name": path.stem,
            "importable": not blockers,
            "blockers": blockers,
            "functions": functions,
        })

    return modules
