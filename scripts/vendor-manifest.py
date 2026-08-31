#!/usr/bin/env python3
"""Capture Biomni's asset manifests into this repo, so they work without it.

Biomni describes two assets in `biomni/env_desc.py` as plain dicts: 76 datasets
(`data_lake_dict`) and 113 packages and CLI tools (`library_content_dict`).
`biomni/env_desc_cm.py` repeats the subset licensed for commercial use.

None of that is code. It is a curation artifact — the most valuable thing
Biomni has that nothing else does — and reading it should not cost a 1.3 GB
install. So it is captured here once and shipped with the plugin.

The captured copy is a FALLBACK, never an override. When Biomni is installed,
`_gates.py` reads the live `env_desc` so the manifest always matches the
version actually present; the copy only answers when there is nothing to read.
That ordering is what keeps this from silently going stale.

Usage:

    python3 scripts/vendor-manifest.py                    # from installed biomni
    python3 scripts/vendor-manifest.py path/to/biomni     # from a package dir

Writes data/biomni-manifest.json, which is reviewed like any other diff.
"""

import ast
import importlib.util
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "data" / "biomni-manifest.json"


def literal_dicts(path):
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


def locate(argv):
    """The biomni package directory, from argv or from the import path."""
    if len(argv) > 1:
        candidate = pathlib.Path(argv[1]).expanduser().resolve()
        if candidate.name != "biomni" and (candidate / "biomni").is_dir():
            candidate = candidate / "biomni"
        return candidate
    spec = importlib.util.find_spec("biomni")
    if spec is None or not spec.submodule_search_locations:
        return None
    return pathlib.Path(list(spec.submodule_search_locations)[0])


def version_of(root):
    """The captured version, from metadata when importable, else the source."""
    try:
        from importlib.metadata import version

        return version("biomni")
    except Exception:  # noqa: BLE001 - fall through to the source
        pass
    text = (root / "version.py")
    if text.is_file():
        for node in ast.parse(text.read_text(encoding="utf-8")).body:
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id in {"__version__", "VERSION"}
                for t in node.targets
            ):
                try:
                    return str(ast.literal_eval(node.value))
                except (ValueError, SyntaxError):
                    pass
    return "unknown"


def main():
    root = locate(sys.argv)
    if root is None or not root.is_dir():
        print("biomni not found; pass its package directory as an argument", file=sys.stderr)
        return 1

    full = literal_dicts(root / "env_desc.py")
    commercial = literal_dicts(root / "env_desc_cm.py")

    datasets = full.get("data_lake_dict", {})
    libraries = full.get("library_content_dict", {})
    if not datasets and not libraries:
        print(f"no manifests found under {root}", file=sys.stderr)
        return 1

    allowed = commercial.get("data_lake_dict")
    manifest = {
        "_comment": (
            "Captured from Biomni's env_desc by scripts/vendor-manifest.py. "
            "Data, not code — it lets the data lake and software catalogs work "
            "without a Biomni install. A live Biomni always takes precedence."
        ),
        "biomni": version_of(root),
        "source": "biomni/env_desc.py + env_desc_cm.py",
        "license": "MIT (Biomni, snap-stanford). Individual datasets carry their own terms.",
        # Sorted so a re-capture produces a reviewable diff rather than a reshuffle.
        "datasets": {name: str(datasets[name]) for name in sorted(datasets)},
        # null when this Biomni ships no commercial subset: unknown, not unrestricted.
        "commercialDatasets": None if allowed is None else sorted(allowed),
        "libraries": {name: str(libraries[name]) for name in sorted(libraries, key=str.lower)},
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    restricted = "unknown" if allowed is None else len(datasets) - len(allowed)
    print(f"wrote {OUT.relative_to(HERE.parent)}")
    print(f"  biomni      {manifest['biomni']}")
    print(f"  datasets    {len(datasets)} ({restricted} non-commercial)")
    print(f"  libraries   {len(libraries)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
