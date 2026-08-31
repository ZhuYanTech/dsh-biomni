#!/usr/bin/env python3
"""Report what this interpreter can actually do, as one JSON object on stdout.

Answers the question that costs the most time when a tool call fails: is the
library here, which modules import, and which functions would raise on call.

The analysis itself lives in `_gates.py`, shared with `skills.py` so the
environment report and the skill catalog can never disagree about what is
available. This script only aggregates those verdicts into the counts, the
missing-package histogram, and the data lake / software tallies the report
renders.

An optional argv[1] overrides the data lake root, as in skills.py.
"""

import json
import sys

import _gates


def _data_lake(data_path):
    """Counts only — the Settings page reports the tally, not 76 file names."""
    survey = _gates.data_lake_entries(data_path)
    entries = survey["entries"]
    return {
        "path": survey["path"],
        "exists": survey["exists"],
        "advertised": len(entries),
        "present": survey["present"],
        # Of what is actually on disk, how much carries a commercial-use
        # restriction. Counted over present files because that is what a user
        # can act on; a restricted dataset they never downloaded is not a risk.
        "restricted": sum(1 for e in entries if e["present"] and e["commercial"] is False),
    }


def _libraries():
    """Counts per kind, so the report can say what is missing without listing 113."""
    tally = {}
    for entry in _gates.library_entries():
        bucket = tally.setdefault(entry["kind"], {"advertised": 0, "available": 0, "unverified": 0})
        bucket["advertised"] += 1
        if entry["available"] is True:
            bucket["available"] += 1
        elif entry["available"] is None:
            bucket["unverified"] += 1
    return tally


def survey(data_path=None):
    report = {
        "executable": sys.executable,
        "python": sys.version.split()[0],
        "biomni": None,
        "modules": [],
        "blockedFunctions": 0,
        "totalFunctions": 0,
        "missing": {},
    }

    report["biomni"] = _gates.biomni_version()

    # Manifest-backed, so they are reported whether or not Biomni is installed.
    _, _, _, source, manifest_version = _gates.manifest()
    report["manifest"] = {"source": source, "biomni": manifest_version}
    report["dataLake"] = _data_lake(data_path)
    report["libraries"] = _libraries()

    # The module survey needs the library itself.
    if report["biomni"] is None:
        return report

    missing = {}
    for module in _gates.analyze_modules():
        blocked = 0
        for function in module["functions"]:
            if not function["blockedBy"]:
                continue
            blocked += 1
            for package in function["blockedBy"]:
                missing[package] = missing.get(package, 0) + 1

        report["modules"].append({
            "name": module["name"],
            "importable": module["importable"],
            "blockers": module["blockers"],
            "functions": len(module["functions"]),
            "blocked": blocked,
        })
        report["totalFunctions"] += len(module["functions"])
        report["blockedFunctions"] += blocked

    report["gate"] = _gates.universal_gate()
    report["missing"] = dict(sorted(missing.items(), key=lambda kv: -kv[1]))
    return report


if __name__ == "__main__":
    try:
        print(json.dumps(survey(sys.argv[1] if len(sys.argv) > 1 else None)))
    except Exception as exc:  # noqa: BLE001 - the caller renders this
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
