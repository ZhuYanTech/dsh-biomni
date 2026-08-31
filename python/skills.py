#!/usr/bin/env python3
"""Emit the Biomni skill catalog as one JSON object on stdout.

Biomni ships structured metadata for the functions it advertises to its own
agent, in `biomni/tool/tool_description/<module>.py`: a plain `description`
list of dicts carrying each function's name, prose description, and required /
optional parameters with types and defaults. That is the material a skill body
needs, and it is far better than anything derived from signatures alone.

Three catalogs are emitted, and each joins what Biomni ADVERTISES with what
this environment actually HAS:

  * tool functions — from `tool_description`, 218 functions across 21 modules
    (the curated subset Biomni exposes; the modules define more public
    functions, the rest being helpers Biomni does not surface), joined with the
    callability verdicts from `_gates`,
  * the data lake — 76 datasets, joined with what is actually on disk under
    the configured data root, and independently with the commercial-use subset,
  * the software library — 113 packages and CLI tools, joined with what is
    actually installed.

The last two read Biomni's MANIFEST, which this plugin also ships a copy of, so
they answer with no Biomni installed. The tool functions cannot: they are real
Python that has to import.

All three verdicts come from `_gates`, the same module the environment report
reads, so the skill catalog and the Settings page cannot disagree about what
this environment can do.

An optional argv[1] overrides the data lake root; without it the resolution
follows Biomni's own (BIOMNI_PATH / BIOMNI_DATA_PATH / ./data).

The description files are read with `ast.literal_eval`, not exec: they are pure
data, and a catalog build has no business executing code out of site-packages.

Nothing is imported from biomni itself, so a module whose import would crash
still contributes its catalog entry — marked unimportable, which is exactly
what the reader needs to know.
"""

import ast
import json
import pathlib
import sys

import _gates


def _description_list(path):
    """The `description = [...]` literal from one tool_description module.

    Parsed and literal-evaluated rather than executed. Returns an empty list
    when the file has no such assignment or holds anything non-literal.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return []
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if "description" not in targets:
            continue
        try:
            value = ast.literal_eval(node.value)
        except (ValueError, SyntaxError):
            return []
        return value if isinstance(value, list) else []
    return []


def _parameter(raw, with_default):
    """Normalize one parameter entry from Biomni's metadata."""
    out = {
        "name": str(raw.get("name", "")),
        "type": str(raw.get("type", "")),
        "description": str(raw.get("description", "") or ""),
    }
    if with_default:
        # `default` is a real value (None, 10, "supplementary_info", ...);
        # repr keeps it renderable without inventing a type mapping.
        out["default"] = repr(raw.get("default"))
    return out


def catalog(data_path=None):
    # The data lake and the software library come from the MANIFEST, which is
    # shipped with this plugin as a fallback. Both therefore work with no
    # Biomni installed at all — which is the common starting state, and the one
    # where knowing what is already on the machine helps most.
    datasets, libraries, _, source, manifest_version = _gates.manifest()
    report = {
        "biomni": _gates.biomni_version(),
        "manifest": {"source": source, "biomni": manifest_version},
        "modules": [],
        "dataLake": _gates.data_lake_entries(data_path),
        "libraries": _gates.library_entries(),
    }

    # The tool modules are different: they are real Python that has to import,
    # so they need the library actually present.
    if report["biomni"] is None:
        return report

    directory = _gates.tool_dir()
    if directory is None:
        return report
    describe_dir = directory / "tool_description"

    # Callability verdicts, keyed by module then function name.
    gates = {module["name"]: module for module in _gates.analyze_modules()}

    if not describe_dir.is_dir():
        return report

    for path in sorted(describe_dir.glob("*.py")):
        if path.stem.startswith("_"):
            continue
        entries = _description_list(path)
        if not entries:
            continue

        gate = gates.get(path.stem, {})
        blocked_by = {
            function["name"]: function["blockedBy"]
            for function in gate.get("functions", [])
        }

        functions = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name", ""))
            if not name:
                continue
            functions.append({
                "name": name,
                "description": str(entry.get("description", "") or ""),
                "required": [
                    _parameter(p, with_default=False)
                    for p in entry.get("required_parameters", []) or []
                    if isinstance(p, dict)
                ],
                "optional": [
                    _parameter(p, with_default=True)
                    for p in entry.get("optional_parameters", []) or []
                    if isinstance(p, dict)
                ],
                # Absent from the AST walk means Biomni advertises a function
                # its module does not define — report it as unverified rather
                # than silently claiming it is callable.
                "blockedBy": blocked_by.get(name, []),
                "known": name in blocked_by,
            })

        if not functions:
            continue
        report["modules"].append({
            "name": path.stem,
            "importable": gate.get("importable", False),
            "blockers": gate.get("blockers", []),
            "functions": functions,
        })

    return report


if __name__ == "__main__":
    try:
        print(json.dumps(catalog(sys.argv[1] if len(sys.argv) > 1 else None)))
    except Exception as exc:  # noqa: BLE001 - the caller renders this
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
