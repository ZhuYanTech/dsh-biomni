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
import concurrent.futures
import importlib.util
import json
import pathlib
import sys
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "data" / "biomni-manifest.json"

#: Where Biomni publishes the data lake (biomni/agent/a1.py). Public, no
#: credentials. Sizes are read from here rather than guessed, because the range
#: is four orders of magnitude — 4 KB to 6.2 GB — and "download the data lake"
#: is a very different proposition per file.
BUCKET = "https://biomni-release.s3.amazonaws.com/data_lake/"


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


def remote_sizes(names, workers=12):
    """Content-Length for each dataset, or None where the bucket did not answer.

    Best-effort by design: a capture run offline still produces a usable
    manifest, just without the sizes. Missing is recorded as null rather than
    zero, so a reader can tell "unknown" from "empty".
    """

    def head(name):
        request = urllib.request.Request(BUCKET + urllib.parse.quote(name), method="HEAD")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return name, int(response.headers.get("Content-Length") or 0) or None
        except Exception:  # noqa: BLE001 - absence is the answer, not a crash
            return name, None

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        return dict(pool.map(head, names))


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
    print(f"reading sizes for {len(datasets)} datasets from the bucket...", file=sys.stderr)
    sizes = remote_sizes(list(datasets))
    manifest = {
        "_comment": (
            "Captured from Biomni's env_desc by scripts/vendor-manifest.py. "
            "Data, not code — it lets the data lake and software catalogs work "
            "without a Biomni install. A live Biomni always takes precedence."
        ),
        "biomni": version_of(root),
        "source": "biomni/env_desc.py + env_desc_cm.py",
        "license": "MIT (Biomni, snap-stanford). Individual datasets carry their own terms.",
        "bucket": BUCKET,
        # Sorted so a re-capture produces a reviewable diff rather than a reshuffle.
        # Each entry is {description, bytes} — bytes null when the bucket did
        # not answer, which is unknown rather than zero.
        "datasets": {
            name: {"description": str(datasets[name]), "bytes": sizes.get(name)}
            for name in sorted(datasets)
        },
        # null when this Biomni ships no commercial subset: unknown, not unrestricted.
        "commercialDatasets": None if allowed is None else sorted(allowed),
        "libraries": {name: str(libraries[name]) for name in sorted(libraries, key=str.lower)},
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    restricted = "unknown" if allowed is None else len(datasets) - len(allowed)
    known = [s for s in sizes.values() if s]
    total = sum(known) / 1e9
    print(f"wrote {OUT.relative_to(HERE.parent)}")
    print(f"  biomni      {manifest['biomni']}")
    print(f"  datasets    {len(datasets)} ({restricted} non-commercial), {total:.1f} GB total")
    if len(known) != len(datasets):
        print(f"  WARNING     {len(datasets) - len(known)} dataset sizes unresolved")
    print(f"  libraries   {len(libraries)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
