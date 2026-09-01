/**
 * The environment probe: what this interpreter can ACTUALLY do.
 *
 * This answers the question that costs the most time when a tool call fails.
 * Biomni declares three dependencies (pydantic, langchain, python-dotenv) and
 * everything its tools actually need is undeclared, behind two independent
 * gates:
 *
 *   gate 1  module-level imports — all-or-nothing per module, so a module
 *           either imports fully or not at all
 *   gate 2  lazy imports inside function bodies — a module that imports
 *           cleanly can still have functions that raise ModuleNotFoundError
 *           when called, and no module-level analysis finds these
 *
 * Gate 2 is the one that surprises people, and it is not a long tail: `scipy`
 * alone gates 43 functions. It was found the way these things usually are — an
 * agent called `literature.query_pubmed`, got a missing `pymed`, and quietly
 * hand-rolled its own PubMed client instead. Importable is not callable.
 */
import type { BiomniPrefs, ProbeReport } from './prefs-shared.ts'
import type { BiomniSubprocessService } from './context-types.ts'
import { PROBE_PATH } from './python/paths.ts'

/**
 * Run the environment probe in a throwaway process.
 *
 * Deliberately not the session's own worker: the report must be available
 * before any worker exists, and a probe has no business leaving names behind in
 * a namespace the agent is using.
 *
 * @param ctx - the subprocess service.
 * @param python - the interpreter to survey.
 * @param dataPath - the data lake root; empty defers to Biomni's own resolution.
 * @param signal - caller cancellation.
 * @returns the parsed report (its `error` field is set when the survey itself
 * failed inside Python; a failure to run at all throws).
 */
export async function probeEnvironment(
  ctx: { subprocess: BiomniSubprocessService },
  python: string,
  dataPath = '',
  signal?: AbortSignal,
): Promise<ProbeReport> {
  const handle = ctx.subprocess.spawn({
    // Empty is omitted rather than passed, so the script falls back to Biomni's
    // own resolution instead of treating '' as a path.
    argv: dataPath === '' ? [python, PROBE_PATH] : [python, PROBE_PATH, dataPath],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1_000_000 }, stderr: { maxBytes: 8_192 } },
    graceMs: 5_000,
    ...(signal === undefined ? {} : { signal }),
  })
  const outcome = await handle.done
  // Collected streams stay readable after settlement; readFrom(0) is the batch
  // read, and it is synchronous.
  if (outcome.exitCode !== 0) {
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    throw new Error(`probe exited ${outcome.exitCode}: ${stderr.trim() || 'no output'}`)
  }
  return JSON.parse(handle.collected.stdout?.readFrom(0).text ?? '{}') as ProbeReport
}

/** How many packages the text report lists before summarizing the rest. */
const MISSING_SHOWN = 10

/**
 * Format the probe's report for a human reading it in a terminal (the `/biomni`
 * command). The Settings section renders the same data structurally instead.
 */
export function renderReport(report: ProbeReport, prefs: BiomniPrefs): string {
  const lines: string[] = []
  lines.push(`Interpreter  ${report.executable}`)
  lines.push(`Python       ${report.python}`)

  if (report.error !== undefined) return `${lines.join('\n')}\n\nProbe failed: ${report.error}`

  const absent = report.biomni === null || report.biomni === undefined
  if (absent) {
    lines.push('')
    lines.push('Biomni is NOT installed in this interpreter, so there are no tool-module')
    lines.push('skills. Install it with python/requirements-biomni.txt, then point the')
    lines.push('`python` setting at that interpreter.')
    lines.push('')
    lines.push('The data lake and software figures below still hold: they come from the')
    lines.push('manifest shipped with this plugin, checked against this machine.')
  } else {
    lines.push(`Biomni       ${report.biomni}`)
  }

  // Without these nothing imports at all, and the resulting error names neither.
  if (report.gate !== undefined && report.gate.length > 0) {
    lines.push('')
    lines.push(`BROKEN: ${report.gate.join(' and ')} missing — this blocks EVERY tool module,`)
    lines.push('and the import error will not name them. Install them first.')
  }

  const usable = report.modules.filter(module => module.importable)
  const broken = report.modules.filter(module => !module.importable)
  const callable = report.totalFunctions - report.blockedFunctions

  if (report.modules.length > 0) {
    lines.push('')
    lines.push(`Modules      ${usable.length}/${report.modules.length} importable`)
    lines.push(`Functions    ${callable}/${report.totalFunctions} callable`)
  }

  if (broken.length > 0) {
    lines.push('')
    lines.push('Not importable:')
    for (const module of broken) lines.push(`  ${module.name.padEnd(20)} needs ${module.blockers.join(', ')}`)
  }

  const missing = Object.entries(report.missing ?? {})
  if (missing.length > 0) {
    lines.push('')
    lines.push('Importable, but these functions raise ModuleNotFoundError when called:')
    const cost = report.optionalCostMb ?? {}
    for (const [pkg, count] of missing.slice(0, MISSING_SHOWN)) {
      // A package's price belongs next to its name. Without it, "install rdkit"
      // (151 MB, one function) reads exactly like "install scipy" (shared, 43).
      const price = cost[pkg] === undefined ? '' : `  — ${cost[pkg]} MB for ${count === 1 ? 'it' : 'them'}`
      lines.push(`  ${pkg.padEnd(22)} ${count} function${count === 1 ? '' : 's'}${price}`)
    }
    if (missing.length > MISSING_SHOWN) lines.push(`  ... and ${missing.length - MISSING_SHOWN} more packages`)

    // Suggest only the cheap ones by default; the priced ones are a deliberate
    // choice, not something to paste without reading.
    const cheap = missing.slice(0, MISSING_SHOWN).map(([pkg]) => pkg).filter(pkg => cost[pkg] === undefined)
    if (cheap.length > 0) {
      lines.push('')
      lines.push(`  pip install ${cheap.join(' ')}`)
    }
    const priced = missing.map(([pkg]) => pkg).filter(pkg => cost[pkg] !== undefined)
    if (priced.length > 0) {
      lines.push('')
      lines.push(`  Deliberately outside the core tier: ${priced.map(pkg => `${pkg} (${cost[pkg]} MB)`).join(', ')}.`)
      lines.push('  See python/requirements-biomni-extras.txt for what each one buys.')
    }
  }

  // The data lake and the software library are separate assets from the tool
  // modules, and each has its own advertised-vs-actual gap. Reported apart from
  // the function counts because that is what they are: a machine can have every
  // module importable and no data lake at all.
  const dataLake = report.dataLake
  if (dataLake !== undefined) {
    lines.push('')
    if (!dataLake.exists) {
      lines.push(`Data lake    not found at ${dataLake.path}`)
      lines.push(`             ${dataLake.advertised} datasets are advertised and none are downloaded.`)
      lines.push('             Point the `dataPath` setting at the root holding biomni_data/.')
    } else {
      const via = report.manifest?.source === 'vendored' ? ' (shipped manifest)' : ''
      lines.push(`Data lake    ${dataLake.present}/${dataLake.advertised} datasets at ${dataLake.path}${via}`)
      if (dataLake.restricted > 0) {
        lines.push(`             ${dataLake.restricted} of those are licensed for non-commercial use only.`)
      }
    }
  }

  const libraries = Object.entries(report.libraries ?? {})
  if (libraries.length > 0) {
    const total = libraries.reduce((sum, [, tally]) => sum + tally.advertised, 0)
    const available = libraries.reduce((sum, [, tally]) => sum + tally.available, 0)
    lines.push('')
    lines.push(`Software     ${available}/${total} of Biomni's packages and CLI tools installed`)
    for (const [kind, tally] of libraries.sort(([a], [b]) => a.localeCompare(b))) {
      const unverified = tally.unverified > 0 ? `, ${tally.unverified} unverified` : ''
      lines.push(`  ${kind.padEnd(20)} ${tally.available}/${tally.advertised}${unverified}`)
    }
  }

  lines.push('')
  lines.push(`Shell python guard  ${prefs.guardShellPython ? 'on' : 'off'}`)
  lines.push(`Snippet timeout     ${Math.round(prefs.timeoutMs / 1000)}s`)
  // Worth stating, because it is the one setting here that can take work away:
  // a retired interpreter is an emptied namespace. Measured cost of keeping
  // one: 298 MB resident with the usual stack imported, 74 MB bare.
  lines.push(prefs.idleTimeoutMs > 0
    ? `Idle retirement     after ${Math.round(prefs.idleTimeoutMs / 60_000)} min unused (~298 MB each, reported to the model)`
    : 'Idle retirement     off — interpreters live as long as their agent')
  return lines.join('\n')
}
