/**
 * The two pieces of model-facing text: the tool description and the system
 * prompt section.
 *
 * Both are composition config rather than user settings, deliberately. They
 * ride the request prefix, so a user editing them mid-session would invalidate
 * the KV cache for every turn that follows.
 */

/** Model-facing description of the `run_python` tool. */
export const DEFAULT_TOOL_DESCRIPTION = [
  'Execute Python in this session\'s dedicated, persistent interpreter.',
  'THIS IS THE ONLY WAY TO RUN PYTHON. Do not run `python`, `python3`, `pip`, or a',
  '.py script through the bash tool: that reaches a different interpreter that does',
  'NOT have this environment\'s scientific and biomedical libraries installed, so it',
  'will fail on any real analysis and cannot see state from earlier calls.',
  '',
  'Variables, imports, and loaded data persist across calls for the whole session, so',
  'work in several small steps — import once, load data once, then build on it — rather',
  'than resending one large script.',
  '',
  'Returns whatever the code writes to stdout and stderr, so print anything you need to',
  'see; a trailing bare expression additionally reports its repr, like a REPL.',
].join('\n')

/**
 * Environment guidance for the system prompt.
 *
 * A tool description alone loses the competition for "run some Python" against
 * the familiar bash tool — measured, not assumed — so the framing is stated
 * once at the prompt level instead.
 *
 * The module inventory is listed but the ~183 individual functions are not:
 * they would not fit, and they do not need to. The interpreter is persistent,
 * so runtime introspection costs one call and never goes stale, which is a
 * cheaper answer to the problem Biomni solves with a retrieval layer.
 *
 * Kept static rather than probed so the request prefix stays byte-stable
 * across turns and the KV cache holds.
 */
export const DEFAULT_GUIDANCE = `# Python environment

This session has its own persistent Python interpreter, reached ONLY through the
\`run_python\` tool. Never invoke \`python\`, \`python3\`, \`pip\`, or a .py script through
the bash tool: that is a different interpreter, without the libraries below, and it
cannot see state from earlier calls.

State persists across \`run_python\` calls for the whole session. Import once, load data
once, then build on what is already bound.

## Biomedical tool library

\`biomni.tool\` provides research functions, grouped by module:

  database (41)            lookups across major biomedical databases
  pharmacology (23)        drugs, targets, pharmacokinetics
  molecular_biology (18)   sequence and construct work
  microbiology (12)        microbial analysis
  physiology (11)          physiological modelling
  immunology (10)          immune repertoire and response
  literature (8)           paper search and full-text retrieval
  synthetic_biology (8)    design and assembly
  pathology (7)            tissue and disease analysis
  systems_biology (7)      network and pathway analysis
  bioengineering (7)       biomaterials and devices
  biochemistry (6)         assays and reaction analysis
  cancer_biology (6)       oncology-specific analysis
  cell_biology (5)         cell-level analysis
  support_tools (5)        shared helpers
  biophysics (3)           structural and biophysical analysis
  glycoengineering (3)     glycan design
  lab_automation (3)       protocol and instrument control

Do not guess function names or signatures. Each module above has a \`biomni-<module>\`
skill carrying its exact signatures, parameter types, defaults, and what each parameter
means — load that skill before calling into a module you have not used yet. The skills
are generated from the interpreter that is actually configured, so they list only what
this environment can really call, and they name what it cannot.

Which modules exist here is therefore whatever the skill catalog offers; do not assume a
module is present because it is listed above. Failing that, introspection is cheap
because the interpreter persists:

    import inspect
    from biomni.tool import database
    print([n for n in dir(database) if not n.startswith("_")])
    print(inspect.signature(database.query_uniprot))
    print(database.query_uniprot.__doc__)

A module that imports fine can still have individual functions that raise
\`ModuleNotFoundError\` on call, because some import their dependencies lazily in the
body. That is an environment limit, not a mistake to route around: report which package
is missing so it can be installed. Do NOT try to install it yourself, and do not quietly
reimplement the function — a hand-rolled substitute is not the validated tool, and
passing one off as the tool's output misrepresents the result.

Some functions call a language model internally to turn a prompt into a query. Those
need their own credentials and may fail with a missing-package error; prefer the direct
API functions when one exists.`
