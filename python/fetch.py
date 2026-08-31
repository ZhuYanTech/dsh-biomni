#!/usr/bin/env python3
"""Fetch individual data lake datasets, and say what each one costs first.

Biomni's own flow downloads the lake as a set: point it at a directory and it
pulls what is missing. That is the wrong shape here, because the set is 15.1 GB
and the individual files span four orders of magnitude — 4 KB to 6.2 GB. Almost
nobody wants all 76; they want two or three, and they want to know the size
before committing.

So this fetches BY NAME, from the manifest. Three consequences follow:

  * a name not in the manifest is refused rather than turned into a URL, so
    this cannot be pointed at arbitrary hosts,
  * a dataset restricted to non-commercial use is refused unless that is
    acknowledged explicitly — the licence is a separate axis from availability
    everywhere else in this plugin, and it stays separate at the moment it
    actually binds,
  * the size is reported before the transfer, not after.

Downloads land on a `.part` file and are renamed only once complete, so an
interrupted fetch never leaves something that looks present to the probe.

Usage:

    python3 fetch.py --list [--root DIR]
    python3 fetch.py --root DIR NAME [NAME ...] [--accept-noncommercial]

Emits one JSON object on stdout.
"""

import argparse
import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request

import _gates

#: Fallback when the manifest carries no bucket (an older captured copy).
DEFAULT_BUCKET = "https://biomni-release.s3.amazonaws.com/data_lake/"

#: Read size. Large enough that a multi-GB file is not syscall-bound.
CHUNK = 1 << 20


def bucket_url():
    """Where to fetch from, preferring whatever the manifest recorded."""
    data = _gates._vendored() or {}
    url = data.get("bucket")
    return url if isinstance(url, str) and url.startswith("https://") else DEFAULT_BUCKET


def _human(size):
    """Bytes as a short human string; '?' when the size is unknown."""
    if not size:
        return "?"
    units = ["B", "KB", "MB", "GB", "TB"]
    value, unit = float(size), 0
    while value >= 1024 and unit < len(units) - 1:
        value /= 1024
        unit += 1
    return f"{value:.0f} {units[unit]}" if value >= 10 or unit == 0 else f"{value:.1f} {units[unit]}"


def download(name, target, url, timeout=60):
    """Fetch one dataset to `target`, atomically. Returns (ok, detail)."""
    part = target.with_name(target.name + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "dsh-biomni"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                return False, f"HTTP {response.status}"
            written = 0
            with open(part, "wb") as handle:
                while True:
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    handle.write(chunk)
                    written += len(chunk)
        # Rename last: until this point the probe sees nothing, which is the
        # truth. A half file that looks present is worse than an absent one.
        os.replace(part, target)
        return True, written
    except Exception as exc:  # noqa: BLE001 - reported, never raised
        try:
            part.unlink(missing_ok=True)
        except OSError:
            pass
        return False, f"{type(exc).__name__}: {exc}"


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("names", nargs="*", help="dataset file names from the manifest")
    parser.add_argument("--root", default=None, help="data root holding biomni_data/")
    parser.add_argument("--list", action="store_true", help="report the catalog and exit")
    parser.add_argument(
        "--accept-noncommercial",
        action="store_true",
        help="acknowledge the licence on datasets outside Biomni's commercial subset",
    )
    args = parser.parse_args()

    datasets, _, allowed, source, biomni = _gates.manifest()
    directory = _gates.data_lake_dir(args.root)

    def restricted(name):
        """True when the licence is known AND excludes commercial use."""
        return allowed is not None and name not in allowed

    if args.list or not args.names:
        entries = []
        for name in sorted(datasets):
            path = directory / name
            entries.append({
                "name": name,
                "description": datasets[name]["description"],
                "bytes": datasets[name]["bytes"],
                "size": _human(datasets[name]["bytes"]),
                "present": path.is_file(),
                "commercial": None if allowed is None else not restricted(name),
            })
        print(json.dumps({
            "path": str(directory),
            "source": source,
            "biomni": biomni,
            "total": len(entries),
            "present": sum(1 for e in entries if e["present"]),
            "entries": entries,
        }))
        return 0

    results = []
    base = bucket_url()
    directory.mkdir(parents=True, exist_ok=True)

    for name in args.names:
        target = directory / name
        if name not in datasets:
            # Refused rather than resolved: a name outside the manifest is
            # either a typo or an attempt to point this at something else.
            results.append({"name": name, "status": "unknown", "detail": "not in the manifest"})
            continue
        if target.is_file():
            results.append({"name": name, "status": "present", "bytes": target.stat().st_size})
            continue
        if restricted(name) and not args.accept_noncommercial:
            results.append({
                "name": name,
                "status": "restricted",
                "detail": "outside Biomni's commercial-use subset; pass --accept-noncommercial",
                "bytes": datasets[name]["bytes"],
            })
            continue

        ok, detail = download(name, target, base + urllib.parse.quote(name))
        results.append(
            {"name": name, "status": "fetched", "bytes": detail} if ok
            else {"name": name, "status": "failed", "detail": detail}
        )

    print(json.dumps({"path": str(directory), "results": results}))
    return 0 if all(r["status"] in {"fetched", "present"} for r in results) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - the caller renders this
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        sys.exit(1)
