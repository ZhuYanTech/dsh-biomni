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
import type { CatalogFunction, CatalogModule } from './catalog.ts'
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
