/**
 * Rendering one tool module as a skill body.
 *
 * What the model gets is a function reference it can act on directly: real
 * signatures with Biomni's own parameter types, defaults, and prose. That is
 * strictly better than the introspection loop the system prompt otherwise
 * recommends — `dir()` plus `inspect.signature()` costs a call and does not
 * carry the parameter descriptions, which is where the actual meaning lives.
 *
 * Two framing decisions run through every body:
 *
 * 1. **Blocked functions are named, not hidden.** They are out of the usable
 *    list, but a trailing section says which package each one needs. Hiding
 *    them entirely would leave the model to rediscover the gap by calling and
 *    failing — and the observed failure mode is not a clean error report, it is
 *    a quietly hand-rolled substitute passed off as the tool's output.
 * 2. **Every body repeats how to call.** A skill body may be loaded into a turn
 *    where nothing else has established that Biomni lives behind `run_python`.
 */
import type {
  CatalogDataLake,
  CatalogDataset,
  CatalogFunction,
  CatalogLibrary,
  CatalogModule,
} from './catalog.ts'
import { isCallable } from './catalog.ts'

/** How many function names the one-line description names before trailing off. */
const NAMED_IN_DESCRIPTION = 4

/** One-line human summary of what a module covers, keyed by Biomni's stem. */
const MODULE_SUBJECTS: Record<string, string> = {
  biochemistry: 'assays and reaction analysis',
  bioengineering: 'biomaterials and devices',
  bioimaging: 'image-based analysis',
  biophysics: 'structural and biophysical analysis',
  cancer_biology: 'oncology-specific analysis',
  cell_biology: 'cell-level analysis',
  database: 'lookups across major biomedical databases',
  genetics: 'variant and heredity analysis',
  genomics: 'genome-scale sequence analysis',
  glycoengineering: 'glycan design',
  immunology: 'immune repertoire and response',
  lab_automation: 'protocol and instrument control',
  literature: 'paper search and full-text retrieval',
  microbiology: 'microbial analysis',
  molecular_biology: 'sequence and construct work',
  pathology: 'tissue and disease analysis',
  pharmacology: 'drugs, targets, pharmacokinetics',
  physiology: 'physiological modelling',
  support_tools: 'shared helpers',
  synthetic_biology: 'design and assembly',
  systems_biology: 'network and pathway analysis',
}

/**
 * The routing description the model sees in the session catalog.
 *
 * This is the only text that decides whether the skill is ever loaded, so it
 * names actual functions: a subject line alone ("drugs, targets") does not
 * distinguish this module from three others, while `query_drug_interactions`
 * does.
 */
export function describeModule(module: CatalogModule): string {
  const callable = module.functions.filter(isCallable)
  const subject = MODULE_SUBJECTS[module.name] ?? 'biomedical research functions'
  const named = callable.slice(0, NAMED_IN_DESCRIPTION).map(fn => fn.name).join(', ')
  const rest = callable.length > NAMED_IN_DESCRIPTION ? ', …' : ''
  return `Biomni ${module.name} tools callable in this session's Python interpreter — `
    + `${callable.length} functions for ${subject} (${named}${rest}). `
    + `Load before calling anything from biomni.tool.${module.name}, for exact signatures and parameter meanings.`
}

/** Render one parameter as a bullet. */
function renderParameter(parameter: { name: string; type: string; description: string; default?: string }): string {
  const type = parameter.type === '' ? '' : ` (${parameter.type}${parameter.default === undefined ? '' : `, default ${parameter.default}`})`
  const prose = parameter.description === '' ? '' : ` — ${parameter.description}`
  return `- \`${parameter.name}\`${type}${prose}`
}

/** The call signature line, defaults included. */
function renderSignature(fn: CatalogFunction): string {
  const args = [
    ...fn.required.map(parameter => parameter.name),
    ...fn.optional.map(parameter => `${parameter.name}=${parameter.default ?? '...'}`),
  ]
  return `${fn.name}(${args.join(', ')})`
}

/** Render one callable function. */
function renderFunction(fn: CatalogFunction): string {
  const lines = [`### \`${renderSignature(fn)}\``, '']
  if (fn.description !== '') lines.push(fn.description, '')
  if (fn.required.length > 0) {
    lines.push('Required:')
    for (const parameter of fn.required) lines.push(renderParameter(parameter))
    lines.push('')
  }
  if (fn.optional.length > 0) {
    lines.push('Optional:')
    for (const parameter of fn.optional) lines.push(renderParameter(parameter))
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render one module's complete skill body.
 * @param module - the module as the catalog reported it.
 * @param biomniVersion - the installed version, named so a stale body is obvious.
 */
export function renderSkillBody(module: CatalogModule, biomniVersion: string): string {
  const callable = module.functions.filter(isCallable)
  const blocked = module.functions.filter(fn => fn.known && fn.blockedBy.length > 0)
  const unverified = module.functions.filter(fn => !fn.known)
  const subject = MODULE_SUBJECTS[module.name] ?? 'biomedical research functions'

  const lines: string[] = [
    `# biomni.tool.${module.name}`,
    '',
    `${callable.length} callable functions for ${subject}, from Biomni ${biomniVersion}.`,
    '',
    '## How to call these',
    '',
    'They run in this session\'s persistent Python interpreter, reached ONLY through',
    'the `run_python` tool. Import once — the namespace persists across calls, so',
    'later calls build on what is already bound:',
    '',
    '```python',
    `from biomni.tool import ${module.name}`,
    '```',
    '',
    'This listing was generated from the interpreter that is actually configured, so',
    'the signatures below are the ones you will get. You do not need to introspect',
    'them again.',
    '',
    `## Functions (${callable.length})`,
    '',
  ]

  for (const fn of callable) lines.push(renderFunction(fn))

  if (blocked.length > 0) {
    lines.push(
      `## Not available in this environment (${blocked.length})`,
      '',
      'These exist in the module and import their dependencies inside the function',
      'body, so calling them raises `ModuleNotFoundError` here. That is an',
      'environment limit, not a problem to route around.',
      '',
      '**Report the missing package so it can be installed. Do NOT install it',
      'yourself, and do NOT reimplement the function** — a hand-rolled substitute is',
      'not the validated tool, and passing one off as the tool\'s output',
      'misrepresents the result.',
      '',
    )
    for (const fn of blocked) {
      lines.push(`- \`${fn.name}\` — needs ${fn.blockedBy.map(pkg => `\`${pkg}\``).join(', ')}`)
    }
    lines.push('')
  }

  if (unverified.length > 0) {
    lines.push(
      `## Advertised but not found in the module source (${unverified.length})`,
      '',
      'Biomni documents these, but its own module does not define them at this',
      'version. Treat them as absent unless a call proves otherwise.',
      '',
    )
    for (const fn of unverified) lines.push(`- \`${fn.name}\``)
    lines.push('')
  }

  return lines.join('\n')
}

// ── The data lake and the software library ──────────────────────────────────
// Biomni's other two assets. They get one skill each rather than one per entry:
// 76 datasets and 113 packages as separate catalog rows would cost more
// resident context than the module catalog they sit beside, for routing nobody
// needs at that granularity.

/** Human-readable byte size, for a listing a person also reads. */
function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** How many entry names a routing description carries before trailing off. */
const NAMED_IN_LISTING = 5

/** Comma-joined sample of names, truncated with an ellipsis. */
function sampleNames(names: string[]): string {
  return names.slice(0, NAMED_IN_LISTING).join(', ') + (names.length > NAMED_IN_LISTING ? ', …' : '')
}

/** The routing description for the data lake skill. */
export function describeDataLake(datasets: CatalogDataset[]): string {
  const names = datasets.map(entry => entry.name.replace(/\.[^.]+$/, ''))
  return `Biomni's local data lake — ${datasets.length} biomedical datasets downloaded on this machine `
    + `(${sampleNames(names)}). Load before answering anything that could be settled with local data `
    + 'rather than a web query: exact file names, paths, sizes and what each contains.'
}

/**
 * Render the data lake skill body.
 *
 * Only datasets actually on disk reach this function, so every path in the body
 * is one that resolves. The absolute directory is stated once and every entry
 * is relative to it, which is what keeps the model from inventing a root.
 */
export function renderDataLakeBody(dataLake: CatalogDataLake, datasets: CatalogDataset[], biomniVersion: string): string {
  const restricted = datasets.filter(entry => entry.commercial === false)
  const lines: string[] = [
    '# Biomni data lake',
    '',
    `${datasets.length} datasets are downloaded on this machine, from Biomni ${biomniVersion}.`,
    '',
    '## Where they are',
    '',
    'All paths below are relative to this directory, which is absolute and exists:',
    '',
    '```',
    dataLake.path,
    '```',
    '',
    'Read them in this session\'s persistent Python interpreter, through the',
    '`run_python` tool. The interpreter keeps state, so load a frame once and reuse it:',
    '',
    '```python',
    'import os',
    'import pandas as pd',
    `DATA = ${JSON.stringify(dataLake.path)}`,
    'df = pd.read_parquet(os.path.join(DATA, "<file>.parquet"))  # or read_csv for .csv/.tsv',
    'print(df.shape)',
    'print(df.head())',
    '```',
    '',
    '**Prefer these over a web query** when a question can be settled locally: they are',
    'already downloaded, already cleaned, and cost no network round trip.',
    '',
    '**Only the files listed below exist.** This listing was generated by checking the',
    'directory itself, so anything absent from it is not downloaded. If you need one',
    'that is not here, say which dataset is missing — do NOT guess a path, and do NOT',
    'substitute a web lookup while presenting it as the dataset.',
    '',
    `## Datasets (${datasets.length})`,
    '',
  ]

  for (const entry of datasets) {
    const size = formatBytes(entry.bytes)
    const marks = [size, entry.commercial === false ? 'non-commercial use only' : ''].filter(mark => mark !== '')
    lines.push(`- \`${entry.name}\`${marks.length > 0 ? ` (${marks.join(', ')})` : ''} — ${entry.description}`)
  }
  lines.push('')

  if (restricted.length > 0) {
    lines.push(
      restricted.length === 1
        ? '## Licence: one of these is non-commercial only'
        : `## Licence: ${restricted.length} of these are non-commercial only`,
      '',
      'Biomni ships a commercial-use subset, and these datasets are not in it. They are',
      'present and readable; the restriction is legal, not technical, so nothing will',
      'stop you from loading one. If the work is commercial, say which dataset carries',
      'the restriction rather than using it silently.',
      '',
    )
    for (const entry of restricted) lines.push(`- \`${entry.name}\``)
    lines.push('')
  }

  return lines.join('\n')
}

/** Section headings for the software listing, in the order they are rendered. */
const LIBRARY_SECTIONS: { kind: CatalogLibrary['kind']; title: string; lead: string }[] = [
  {
    kind: 'cli',
    title: 'Command-line tools',
    lead: 'These are binaries on PATH, not Python. Run them through the **bash** tool, or '
      + 'with `subprocess.run([...])` inside `run_python` when the output feeds straight '
      + 'into analysis. The shell guard only blocks `python` and `pip`, so these are not '
      + 'affected by it.',
  },
  {
    kind: 'python',
    title: 'Python packages',
    lead: 'Import these in `run_python`. They are installed in the same interpreter Biomni\'s '
      + 'own tools run in, so they compose directly with `biomni.tool` results.',
  },
  {
    kind: 'unknown',
    title: 'Others',
    lead: 'Biomni does not tag these; each was located as shown.',
  },
  {
    kind: 'r',
    title: 'R packages',
    lead: 'Reached with `subprocess.run(["Rscript", "-e", ...])`. R itself is present, but '
      + 'whether each package is installed was NOT verified — checking costs one R process '
      + 'each. Treat these as likely, not certain, and check before depending on one.',
  },
]

/**
 * The routing description for the software skill.
 *
 * The composition is stated rather than assumed: a machine with no CLI tools
 * installed must not advertise "command-line tools", or the description sends
 * the model to a skill that cannot answer what it came for. The sample names
 * lead with the CLI tools when there are any, since those are the part nothing
 * else in the session provides.
 */
export function describeSoftware(libraries: CatalogLibrary[]): string {
  const cli = libraries.filter(entry => entry.kind === 'cli').map(entry => entry.name)
  const packages = libraries.filter(entry => entry.kind !== 'cli').map(entry => entry.name)
  const composition = [
    cli.length > 0 ? `${cli.length} command-line tool${cli.length === 1 ? '' : 's'}` : '',
    packages.length > 0 ? `${packages.length} package${packages.length === 1 ? '' : 's'}` : '',
  ].filter(part => part !== '').join(' and ')
  const headline = sampleNames(cli.length > 0 ? cli : packages)
  return `Bioinformatics software installed alongside Biomni on this machine — ${composition} `
    + `(${headline}). Load before writing an analysis by hand or reaching for a web service: `
    + 'a validated tool for it may already be installed here.'
}

/**
 * Render the software library skill body.
 *
 * Entries that were verified absent never reach this function. What remains is
 * split by how it is actually invoked, because that is the distinction the
 * model gets wrong: a CLI tool is not importable, and a Python package is not
 * runnable from the shell.
 */
export function renderSoftwareBody(libraries: CatalogLibrary[], biomniVersion: string): string {
  const lines: string[] = [
    '# Bioinformatics software on this machine',
    '',
    `${libraries.length} of the packages and tools Biomni ${biomniVersion} expects are available here.`,
    '',
    'This listing was generated by checking this machine — for packages, whether the',
    'distribution is installed; for command-line tools, whether the binary is on PATH.',
    'Anything Biomni advertises but this environment lacks has been left out.',
    '',
    '**Check here before hand-rolling an analysis.** A validated tool that is already',
    'installed beats a reimplementation, and beats a web service that needs credentials.',
    '',
  ]

  for (const section of LIBRARY_SECTIONS) {
    const entries = libraries.filter(entry => entry.kind === section.kind)
    if (entries.length === 0) continue
    lines.push(`## ${section.title} (${entries.length})`, '', section.lead, '')
    for (const entry of entries) {
      const note = entry.available === null ? ' *(unverified)*' : ''
      const via = entry.kind === 'unknown' && entry.found !== null
        ? ` [${entry.found === 'cli' ? 'command' : 'Python package'}]`
        : ''
      lines.push(`- \`${entry.name}\`${via}${note} — ${entry.description}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
