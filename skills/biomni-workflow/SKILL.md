---
name: biomni-workflow
description: How to run a biomedical task through this session's persistent Python interpreter and Biomni's tool library — decomposing the work, capturing every result so it is visible, and handling a missing dependency honestly. Load at the start of any Biomni or biomedical analysis task.
whenToUse: Starting a biomedical research task, or any task that will call biomni.tool functions through run_python.
---

# Working with Biomni here

This environment gives you one **persistent Python interpreter** per session, reached
only through the `run_python` tool, with Biomni's tool library installed in it. The
operating discipline below is drawn from Biomni's own agent protocol and from failures
measured in this deployment.

## 1. Plan before you run

Write the plan first, as a checklist, and keep it visible. Biomni's own agent protocol
uses a numbered list marked `[ ]` → `[✓]`, and marks a failed step `[✗]` **with the
reason** rather than silently replacing it. Use `todo_write` here — it is the same
discipline with a native surface.

A step that failed and a step that was never run look identical in a transcript unless
you say which happened.

## 2. Decompose; do not resend one large script

The namespace persists. Import once, load data once, then build on what is bound:

```python
# call 1
from biomni.tool import database
```
```python
# call 2 — `database` is still bound
hits = database.query_uniprot(prompt="human TP53")
print(hits)
```

One large script re-runs everything on every fix, and a failure halfway through leaves
you unable to tell which half ran. Small steps also mean a traceback points at one
thing.

## 3. Print what you want to see — this is the most common way to lose work

`run_python` returns whatever the code writes to stdout and stderr, plus the `repr` of a
trailing bare expression. **A snippet that ends in an assignment returns nothing**, and
the result is then invisible to you even though the call succeeded and the value is
still bound in the namespace.

Biomni's own protocol states this as a rule: *save the output and print the result.*

```python
# wrong — the call ran, the value is bound, and you cannot see any of it
result = database.query_uniprot(prompt="human TP53")
```
```python
# right
result = database.query_uniprot(prompt="human TP53")
print(result)
```
```python
# also right — a trailing bare expression reports its repr, like a REPL
result = database.query_uniprot(prompt="human TP53")
result
```

For large results print a summary rather than the whole object: `df.shape`,
`df.head()`, `len(hits)`, the first few records. Output is capped, and a clipped dump
is worse than a deliberate summary.

## Anything that is not short text goes in a file

`BIOMNI_OUT` is already bound in the namespace — a directory the operator can see and
download from. Write results there instead of trying to print them:

```python
fig.savefig(BIOMNI_OUT / "volcano.png", dpi=150)
df.to_csv(BIOMNI_OUT / "differential_hits.csv", index=False)
records.to_parquet(BIOMNI_OUT / "annotated.parquet")
```

Files written there are named back to you after the call, with their sizes, so you know
the write landed without reading the file again. Then print the *summary* — the shape,
the top rows, the count — and let the file carry the rest.

Nothing stops you writing elsewhere, but nothing reports on it either. A path you chose
yourself is one you will have to remember and describe; one under `BIOMNI_OUT` is one
the operator can open.

Print like a research log: what you are about to do, the parameters used, the shape of
what came back. The transcript is the record of the analysis.

## 4. Get signatures from the module's skill, not from guesswork

Each importable tool module has a `biomni-<module>` skill carrying its exact function
signatures, parameter types, defaults, and what each parameter means — generated from
the interpreter that is actually configured. Load the one you need before calling into
a module for the first time.

Those skills also list which modules and functions this environment **cannot** run.
Failing that, introspection is cheap because the interpreter persists:

```python
import inspect
from biomni.tool import database
print([n for n in dir(database) if not n.startswith("_")])
print(inspect.signature(database.query_uniprot))
print(database.query_uniprot.__doc__)
```

## 5. A missing dependency is a finding, not an obstacle

Biomni's modules import some dependencies inside function bodies, so a module that
imports cleanly can still raise `ModuleNotFoundError` when you call one of its
functions.

When that happens: **say which package is missing and stop.** Do not install it, and do
not write your own version of the function.

This is not a style preference. It happened here: an agent called
`literature.query_pubmed`, hit a missing `pymed`, and quietly hand-rolled its own PubMed
client. The answer it produced looked completely normal and did not come from the
validated tool — which makes it unreviewable, because nothing in the output says the
provenance changed.

The same applies to a module that will not import at all, and to a function that needs
credentials you do not have. Report the gap.

## 6. Some functions call their own model

A few functions (`query_uniprot` and a handful of others in `database` and `genomics`)
turn a natural-language prompt into a query by calling a language model *inside the
tool*. They need their own credentials and may fail with a missing-package error until
configured. Prefer the direct API function when one exists for what you need.

## 7. State what is analysis and what is inference

Distinguish what the tools returned from what you concluded. Name the method and any
parameters that affect the result (thresholds, reference versions, multiple-testing
correction). A number without its method is not reproducible, and reproducibility is
the point of using a validated tool library.

## Boundaries

- Never run `python`, `python3`, `pip`, or a `.py` script through `bash`. That is a
  different interpreter without this library, it cannot see your namespace, and the
  attempt is denied.
- Installing packages is the operator's job; the interpreter is provisioned outside the
  session.
- Confinement covers file effects only. Biomni tools call external APIs freely, so
  treat network calls as observable and be deliberate about what you send.
