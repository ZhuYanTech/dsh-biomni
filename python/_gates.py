#!/usr/bin/env python3
"""What this environment can ACTUALLY do with Biomni, shared by probe.py and skills.py.

Biomni advertises three kinds of asset, and every one of them can be advertised
without being usable here. Each is checked on its own axis, and the axes are
never merged into a single "availability" number:

  tool functions   gate 1  module-level imports  -> does the module import AT ALL
                   gate 2  imports inside bodies -> does the individual function run
  data lake        is the advertised file actually on disk under the data root
                   (and, independently, does its licence permit commercial use)
  software library is the advertised package or CLI actually installed

Gate 1 is all-or-nothing per module. Gate 2 is invisible to any module-level
check: a module that imports cleanly can still have functions that raise
ModuleNotFoundError when called. Presence on disk is invisible to both.

Merging any of these into one number is the single mistake that matters here.
An agent that meets an advertised-but-absent thing does not report the gap: it
quietly invents a substitute — a hand-rolled function, or a plausible file path
and a plausible result — and the answer looks fine and is not.

Both consumers need identical verdicts — the environment report and the skill
catalog would be a bug factory if they could disagree — so the analysis lives
here once.

Nothing is imported, only parsed: the probe stays fast and free of side
effects, and a module whose import would crash still gets reported instead of
taking the caller down.
"""

import ast
import importlib.util
import json
import os
import pathlib
import sys

__all__ = [
    "analyze_modules",
    "biomni_version",
    "data_lake_dir",
    "data_lake_entries",
    "library_entries",
    "manifest",
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


# ── The data lake and the software library ──────────────────────────────────
# Biomni's other two assets live in `biomni/env_desc.py` as two plain dicts:
# `data_lake_dict` (76 datasets) and `library_content_dict` (113 packages and
# CLI tools). Neither is reachable through `biomni.tool`, and both are read the
# same way the tool descriptions are — parsed and literal-evaluated, never
# executed.
#
# The same discipline applies as for functions, because the failure mode is the
# same and worse: a model told about a dataset that is not on disk does not
# report the gap, it invents a path and then invents a result. So each entry
# carries what is ADVERTISED and what is ACTUALLY THERE as separate facts.
#
# Datasets carry a third, independent axis: `env_desc_cm.py` is the
# commercial-use subset (41 of 76). Absence from it is a LICENCE restriction,
# not a technical one — a dataset can be present on disk, callable, and still
# not usable in a commercial context. Merging that into "available" would be
# the same mistake as merging the two import gates.

#: Where the data lake sits under the configured root, as Biomni lays it out
#: (`biomni/agent/a1.py`: `os.path.join(path, "biomni_data", "data_lake")`).
DATA_LAKE_SUBPATH = ("biomni_data", "data_lake")

#: How Biomni's library descriptions tag an entry's kind.
_KIND_PREFIXES = {
    "[Python Package]": "python",
    "[R Package]": "r",
    "[CLI Tool]": "cli",
}


def _literal_dicts(path):
    """Every top-level `name = {...}` literal in a module, without importing it."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, SyntaxError):
        return {}
    out = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, SyntaxError):
                continue
            if isinstance(value, dict):
                out[target.id] = value
    return out


def _biomni_root():
    """The installed `biomni` package directory, or None when absent."""
    spec = importlib.util.find_spec("biomni") if spec_exists("biomni") else None
    if spec is None or not spec.submodule_search_locations:
        return None
    return pathlib.Path(list(spec.submodule_search_locations)[0])


#: The manifest captured into this repo by scripts/vendor-manifest.py. Same
#: relative position in the published package as in the source tree.
VENDORED_MANIFEST = pathlib.Path(__file__).resolve().parent.parent / "data" / "biomni-manifest.json"


def _vendored():
    """The shipped manifest, or None when it is absent or unreadable.

    Never allowed to raise: a missing or corrupt copy must degrade to "no
    manifest", not take the probe down with it.
    """
    try:
        with open(VENDORED_MANIFEST, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def manifest():
    """Biomni's asset manifests, and where they came from.

    Returns ``(datasets, libraries, commercial, source, version)`` where
    ``source`` is one of:

        'live'      read from an installed biomni; always matches that install
        'vendored'  read from the copy shipped with this plugin
        'none'      neither available

    A live install ALWAYS wins. The shipped copy is a fallback so the data lake
    and software catalogs work without a 1.3 GB install — it is not an
    override, because a manifest that disagrees with the installed library is
    exactly the kind of confident wrong answer this plugin exists to prevent.

    ``commercial`` is the set of dataset names cleared for commercial use, or
    None when this source does not say — which means unknown, not unrestricted.
    """
    root = _biomni_root()
    if root is not None:
        full = _literal_dicts(root / "env_desc.py")
        cm = _literal_dicts(root / "env_desc_cm.py")
        datasets = full.get("data_lake_dict")
        libraries = full.get("library_content_dict")
        if datasets or libraries:
            allowed = cm.get("data_lake_dict")
            return (
                datasets or {},
                libraries or {},
                None if allowed is None else set(allowed),
                "live",
                biomni_version() or "unknown",
            )

    data = _vendored()
    if data is not None:
        allowed = data.get("commercialDatasets")
        return (
            data.get("datasets") or {},
            data.get("libraries") or {},
            None if allowed is None else set(allowed),
            "vendored",
            str(data.get("biomni", "unknown")),
        )

    return {}, {}, None, "none", "unknown"


def data_lake_dir(explicit=None):
    """Resolve the data lake directory.

    Precedence matches Biomni's own (`biomni/config.py`): an explicit setting,
    then `BIOMNI_PATH` / `BIOMNI_DATA_PATH`, then `./data`. Always returned
    absolute — the catalog builder and the session worker run from different
    working directories, so a relative path would resolve to two places.
    """
    base = explicit or os.environ.get("BIOMNI_PATH") or os.environ.get("BIOMNI_DATA_PATH") or "./data"
    return pathlib.Path(base).expanduser().resolve().joinpath(*DATA_LAKE_SUBPATH)


def data_lake_entries(explicit=None):
    """Advertised datasets joined with what is actually on disk.

    Returns ``{"path", "exists", "present", "source", "entries"}``
    where each entry is::

        name        the file name Biomni advertises
        description Biomni's own one-line description
        present     whether that file exists under the resolved directory
        bytes       its size when present, else None
        commercial  True/False per env_desc_cm, None when that file is absent

    An empty ``entries`` means biomni is absent or ships no descriptors; that is
    an answer, not a failure.
    """
    directory = data_lake_dir(explicit)
    advertised, _, allowed, source, _ = manifest()

    entries = []
    for name in sorted(advertised):
        path = directory / name
        try:
            size = path.stat().st_size if path.is_file() else None
        except OSError:
            size = None
        entries.append({
            "name": name,
            "description": str(advertised[name]),
            "present": size is not None,
            "bytes": size,
            "commercial": None if allowed is None else name in allowed,
        })

    return {
        "path": str(directory),
        "exists": directory.is_dir(),
        "present": sum(1 for entry in entries if entry["present"]),
        # Which manifest answered. A reader has to be able to tell "this
        # environment has no Biomni, so the list is the shipped one" from
        # "this is what the installed Biomni says".
        "source": source,
        "entries": entries,
    }


def _distribution_installed(name):
    """Whether a distribution by this name is installed."""
    try:
        from importlib.metadata import PackageNotFoundError, distribution

        try:
            distribution(name)
            return True
        except PackageNotFoundError:
            return False
    except Exception:  # noqa: BLE001 - absence is the answer, not a crash
        return False


def _python_available(name):
    """A package counts as present if pip knows it or its module can be located.

    Both are needed: Biomni keys this dict by DISTRIBUTION name, which is often
    not the import name (`biopython` imports as `Bio`), while a few entries name
    the module instead.
    """
    return _distribution_installed(name) or spec_exists(name.replace("-", "_"))


def library_entries():
    """Advertised software joined with what this environment actually has.

    Returns a list of dicts, sorted by name::

        name        as Biomni names it
        kind        'python' | 'r' | 'cli' | 'unknown' (from the description tag)
        found       'python' | 'cli' | None — how it was actually located
        description Biomni's description, tag stripped
        available   True / False / None, where None means genuinely unverified

    ``available`` is None only for R packages on a machine that HAS R: checking
    them means starting an R process per package, which a catalog build has no
    business doing. Saying "unverified" is the honest answer; claiming either
    way would be a guess.
    """
    import shutil

    _, advertised, _, _, _ = manifest()
    has_r = shutil.which("Rscript") is not None

    entries = []
    for name in sorted(advertised, key=str.lower):
        raw = str(advertised[name])
        kind = "unknown"
        description = raw
        for prefix, tag in _KIND_PREFIXES.items():
            if raw.startswith(prefix):
                kind = tag
                description = raw[len(prefix):].strip()
                break

        found = None
        if kind == "python":
            available = _python_available(name)
            found = "python" if available else None
        elif kind == "cli":
            available = shutil.which(name) is not None
            found = "cli" if available else None
        elif kind == "r":
            # No R at all is a definite no; with R present, per-package checks
            # would cost a process each, so the answer stays unverified.
            available = False if not has_r else None
        else:
            # Untagged entries are a mix of packages and binaries, so both are
            # tried and whichever hits decides the kind that gets reported.
            if _python_available(name):
                available, found = True, "python"
            elif shutil.which(name) is not None:
                available, found = True, "cli"
            else:
                available = False

        entries.append({
            "name": name,
            "kind": kind,
            "found": found,
            "description": description,
            "available": available,
        })

    return entries
