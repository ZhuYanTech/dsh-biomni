# Changelog

Measured figures throughout. Where a number appears here it was read off a real
run, not estimated — several of these releases exist because an estimate turned
out to be wrong.

## 0.1.1

**One command builds the environment, and proves it works.**

- `scripts/setup-env.sh` replaces the four-step venv recipe. It prefers
  [uv](https://docs.astral.sh/uv/) when present — **11 seconds against minutes
  for pip**, on resolutions verified identical (279 of 312 functions callable
  either way) — and falls back to pip otherwise.
- The script **runs the probe and refuses to report success unless Biomni
  imports**. This is the point of it: an environment built on Python 3.9, or one
  where a wheel failed quietly, is indistinguishable from a working one until
  the first tool call.
- `Dockerfile` builds the interpreter as an image for deployments that would
  rather provision once. CI builds it and runs the probe inside it, so "it
  builds" is checked rather than asserted — it could not be verified on the
  machine it was written on.

## 0.1.0

**A data lake browser in Settings → Biomni.**

- All 76 datasets with sizes, on-disk ones first, a filter, one fetch at a time.
- Every row carries its size. The catalog spans four orders of magnitude, so a
  list of names with a Fetch button beside each would make a 4 KB assay table
  and a 6.2 GB binding database look like the same action.
- The licence is a gate, not a warning: fetching one of the 35 non-commercial
  datasets needs a ticked acknowledgement, and `fetch.py` refuses independently
  of what the UI enabled.

**Fixed:** Biomni's own `env_desc` records no dataset sizes — its downloader
takes the lake whole, so it never needed them. Preferring the live manifest
therefore discarded them, and **installing Biomni made the fetch UI strictly
worse than not installing it**. Sizes are now merged into the live catalog.
Found by running the suite against a real interpreter.

## 0.0.4

**Fetch datasets by name, with the price and the licence up front.**

- The lake is **15.1 GB**, not the 11 GB previously claimed, and ranges from a
  4 KB file to a 6.2 GB one. `python/fetch.py` fetches by name; every surface
  quotes the size first.
- Two refusals live in the fetcher, not the caller: a name outside the manifest
  is never turned into a URL, and a non-commercial dataset needs an explicit
  acknowledgement.
- Downloads land on `.part` and are renamed only when complete, so an
  interrupted fetch never leaves something the probe reads as present.
- `/biomni-datasets` lists the catalog. Fetching is deliberately not a
  model-facing tool: it is an operator action with a licence decision and up to
  6 GB attached.

## 0.0.3

**The Python requirements are tiered by measured cost per function.**

| moved to extras | exclusive cost | buys |
|---|---|---|
| `rdkit` | 151 MB | 1 function |
| `cobra` | 147 MB | 2 functions |
| `scholarly` | 119 MB | 1 function |
| `statsmodels` | 68 MB | 2 functions |

- Core is **77 packages, 806 MB, 279 of 312 functions**. The full set is 131
  packages and 1.3 GB for 286. The extra **494 MB buys seven functions**.
- The report prices missing packages and keeps the expensive ones out of the
  copy-pasteable `pip install` line, so pasting it cannot cost 300 MB by
  surprise.

## 0.0.2

**The plugin works with no Biomni installed.**

- Biomni's dataset and software manifests are plain dicts — curation, not code.
  They are captured into `data/biomni-manifest.json`, so a fresh install
  immediately answers which datasets are on this machine and which tools are
  installed. Only the tool-module skills still need the library.
- A live Biomni always wins; the shipped copy is a fallback, never an override.
  Which source answered is reported rather than left implicit.

**Fixed:** sixteen peer dependencies pinned to exact `0.1.0-rc.6`, of which
`lib/` imports three. The rest were build-time type dependencies, and pinning
one that is never imported (`dsh-agent`) made the graph unsatisfiable against
the `rc.8` that upstream's own `^rc.6` range resolves to. A bare `npm install`
went from ERESOLVE to 20 packages in 2s.

## 0.0.1

First tagged release: a persistent per-session Python interpreter, three
generated skill catalogs that advertise only what the machine can deliver, an
environment probe that never averages "advertised" and "available" into one
number, and a shell guard defending the right-interpreter invariant.
