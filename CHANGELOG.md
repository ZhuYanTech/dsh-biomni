# Changelog

Measured figures throughout. Where a number appears here it was read off a real
run, not estimated — several of these releases exist because an estimate turned
out to be wrong.

## 0.2.1

**You can see the results, not just download them.**

The question people arrive at this panel with is "did that run produce the
right thing", and until now the only way to answer it was to save a file and
open another application. Each row in Settings → Biomni now expands: a figure
inline, a CSV or TSV as a real table, anything textual as its head.

- Bounded on the server, not in the browser: 2 MB for an inlined image, 64 KB
  of text, 50 rows by 30 columns. Anything cut is labelled as cut — a table
  that silently shows 50 of 4,000 rows is how someone concludes a gene is
  absent.
- Delimited files are split per RFC 4180 rather than on the delimiter. A quoted
  comma is ordinary in biological data — gene descriptions are full of them —
  and a preview that shifts every column after one invites a conclusion from a
  misread table.
- `svg` and `html` are shown as source, never rendered. Both can carry script
  and an agent writes them; the same reason no artifact is ever served as
  `text/html`.
- Which extensions preview lives in one table, `src/artifacts-shared.ts`, read
  by both halves. Two copies would drift, and drift here is silent: a button
  whose only answer is "no preview", or a previewable file with no way to ask.

**Fixed:** a symlink the interpreter planted was refused by the download route
but still **reported to the model as a file it wrote**, with the target's size.
Harmless in itself, but it is precisely the claim this plugin exists to
prevent — naming a result the operator is then refused. The worker now skips
links for the same reason the route does, so both sides agree.

## 0.2.0

**Results have somewhere to go.**

- `run_python` returns text capped at 16k characters, so a plot could not come
  back at all and a real table came back truncated. The interpreter now has an
  output directory bound in its namespace as `BIOMNI_OUT`, and **each call
  reports the files it wrote**, with sizes — costing nothing on the calls that
  write nothing, which is most of them.
- `/biomni-out` lists the directory; Settings → Biomni lists and downloads it.
  Read-only on both: the agent writes, the operator takes away.

**Fixed while writing the tests, and the reason they were worth writing:**
`path.resolve` folds away `..` but does **not follow symlinks**, and the thing
filling this directory is an agent that can call `os.symlink`. A link at
`BIOMNI_OUT/notes.txt` pointing at `/etc/passwd` passed every lexical
containment check and would have been served by the download route. Both sides
are now resolved through the filesystem with `realpath`, and the refusal is
tested against a link an actual `run_python` call created.

Downloads are capped at 100 MB and always sent as attachments with `nosniff`;
no artifact is ever served as `text/html`, since these are model-written files
on the harness's own origin.

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
