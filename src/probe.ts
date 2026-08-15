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
 * @param signal - caller cancellation.
 * @returns the parsed report (its `error` field is set when the survey itself
 * failed inside Python; a failure to run at all throws).
 */
export async function probeEnvironment(
  ctx: { subprocess: BiomniSubprocessService },
  python: string,
  signal?: AbortSignal,
): Promise<ProbeReport> {
  const handle = ctx.subprocess.spawn({
    argv: [python, PROBE_PATH],
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

  if (report.biomni === null || report.biomni === undefined) {
    lines.push('')
    lines.push('Biomni is NOT installed in this interpreter.')
    lines.push('Install it with python/requirements-biomni.txt, then point the')
    lines.push('`python` setting at that interpreter.')
    return lines.join('\n')
  }

  lines.push(`Biomni       ${report.biomni}`)

  // Without these nothing imports at all, and the resulting error names neither.
  if (report.gate !== undefined && report.gate.length > 0) {
    lines.push('')
    lines.push(`BROKEN: ${report.gate.join(' and ')} missing — this blocks EVERY tool module,`)
    lines.push('and the import error will not name them. Install them first.')
  }

  const usable = report.modules.filter(module => module.importable)
  const broken = report.modules.filter(module => !module.importable)
  const callable = report.totalFunctions - report.blockedFunctions

  lines.push('')
  lines.push(`Modules      ${usable.length}/${report.modules.length} importable`)
  lines.push(`Functions    ${callable}/${report.totalFunctions} callable`)

  if (broken.length > 0) {
    lines.push('')
    lines.push('Not importable:')
    for (const module of broken) lines.push(`  ${module.name.padEnd(20)} needs ${module.blockers.join(', ')}`)
  }

  const missing = Object.entries(report.missing ?? {})
  if (missing.length > 0) {
    lines.push('')
    lines.push('Importable, but these functions raise ModuleNotFoundError when called:')
    for (const [pkg, count] of missing.slice(0, MISSING_SHOWN)) {
      lines.push(`  ${pkg.padEnd(22)} ${count} function${count === 1 ? '' : 's'}`)
    }
    if (missing.length > MISSING_SHOWN) lines.push(`  ... and ${missing.length - MISSING_SHOWN} more packages`)
    lines.push('')
    lines.push(`  pip install ${missing.slice(0, MISSING_SHOWN).map(([pkg]) => pkg).join(' ')}`)
  }

  lines.push('')
  lines.push(`Shell python guard  ${prefs.guardShellPython ? 'on' : 'off'}`)
  lines.push(`Snippet timeout     ${Math.round(prefs.timeoutMs / 1000)}s`)
  return lines.join('\n')
}
