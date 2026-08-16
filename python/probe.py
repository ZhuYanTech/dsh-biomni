#!/usr/bin/env python3
"""Report what this interpreter can actually do, as one JSON object on stdout.

Answers the question that costs the most time when a tool call fails: is the
library here, which modules import, and which functions would raise on call.

The two-gate analysis itself lives in `_gates.py`, shared with `skills.py` so
the environment report and the skill catalog can never disagree about what is
callable. This script only aggregates those verdicts into counts and the
missing-package histogram the report renders.
"""

import json
import sys

import _gates


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

    report["biomni"] = _gates.biomni_version()
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
        print(json.dumps(survey()))
    except Exception as exc:  # noqa: BLE001 - the caller renders this
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
