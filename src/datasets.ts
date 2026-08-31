/**
 * The data lake, as something you can act on rather than only measure.
 *
 * Up to 0.0.3 the plugin could tell you which of the 76 datasets were on disk
 * and refused to talk about the rest — correct, and a dead end. Acquisition was
 * "use Biomni's own flow", which fetches the set.
 *
 * The set is 15.1 GB and the files span four orders of magnitude, from a 4 KB
 * assay table to a 6.2 GB binding database. Nobody wants the set; they want two
 * or three. So this fetches by name, and the size is known BEFORE the transfer
 * because it is recorded in the manifest.
 *
 * Two refusals are load-bearing, and both live in python/fetch.py where the
 * work happens rather than here where they could be bypassed:
 *
 *   * a name outside the manifest is never turned into a URL,
 *   * a dataset outside Biomni's commercial-use subset needs an explicit
 *     acknowledgement — the licence is tracked as its own axis everywhere else
 *     in this plugin, and this is the moment it actually binds.
 */
import type { BiomniSubprocessService } from './context-types.ts'
import { FETCH_PATH } from './python/paths.ts'

/** One dataset as the catalog knows it. */
export interface DatasetEntry {
  name: string
  description: string
  /** Published size in bytes; null when the manifest has no figure. */
  bytes: number | null
  /** That size, pre-formatted, so every surface renders it identically. */
  size: string
  /** Whether the file is on disk under the resolved data root. */
  present: boolean
  /**
   * Whether Biomni's commercial-use subset includes it. `false` means fetching
   * needs an acknowledgement; `null` means this manifest does not say, which is
   * unknown rather than unrestricted.
   */
  commercial: boolean | null
}

/** The whole catalog, with where it was read from. */
export interface DatasetCatalog {
  /** Absolute directory the datasets live in. */
  path: string
  /** Which manifest answered (see CatalogManifest). */
  source: 'live' | 'vendored' | 'none'
  biomni: string
  total: number
  present: number
  entries: DatasetEntry[]
}

/** What happened to one requested dataset. */
export interface FetchResult {
  name: string
  /**
   * `fetched` downloaded now, `present` already there, `restricted` needs the
   * licence acknowledgement, `unknown` is not in the manifest, `failed` tried
   * and did not finish.
   */
  status: 'fetched' | 'present' | 'restricted' | 'unknown' | 'failed'
  bytes?: number
  detail?: string
}

/** A whole fetch run. */
export interface FetchReport {
  path: string
  results: FetchResult[]
}

/** Arguments shared by both calls. */
interface Runner {
  ctx: { subprocess: BiomniSubprocessService }
  python: string
  dataPath: string
  signal?: AbortSignal
}

/** Run fetch.py and parse its single JSON object. */
async function run<T>(
  { ctx, python, signal }: Runner,
  args: string[],
  maxBytes: number,
): Promise<T> {
  const handle = ctx.subprocess.spawn({
    argv: [python, FETCH_PATH, ...args],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 8_192 } },
    graceMs: 5_000,
    ...(signal === undefined ? {} : { signal }),
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  // A non-zero exit is normal here: it means some dataset was refused or
  // failed, and the payload says which. Only an unparsable payload is fatal.
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    throw new Error(`dataset helper exited ${outcome.exitCode}: ${stderr.trim() || stdout.trim() || 'no output'}`)
  }
  const error = (parsed as { error?: unknown }).error
  if (typeof error === 'string') throw new Error(error)
  return parsed as T
}

/** The dataset catalog: what exists, what it costs, and what is already here. */
export async function listDatasets(runner: Runner): Promise<DatasetCatalog> {
  const args = ['--list', ...(runner.dataPath === '' ? [] : ['--root', runner.dataPath])]
  return run<DatasetCatalog>(runner, args, 400_000)
}

/**
 * Fetch datasets by name.
 * @param names - manifest names; anything else is refused, not resolved.
 * @param acceptNonCommercial - acknowledge the licence on restricted datasets.
 */
export async function fetchDatasets(
  runner: Runner,
  names: string[],
  acceptNonCommercial = false,
): Promise<FetchReport> {
  if (names.length === 0) throw new Error('name at least one dataset to fetch')
  const args = [
    ...(runner.dataPath === '' ? [] : ['--root', runner.dataPath]),
    ...(acceptNonCommercial ? ['--accept-noncommercial'] : []),
    ...names,
  ]
  return run<FetchReport>(runner, args, 200_000)
}

/** How many entries the text listing shows before summarizing. */
const LISTED = 40

/**
 * Render the catalog for a terminal (the `/biomni-datasets` command).
 *
 * Present datasets come first: they are the ones that can be used right now,
 * and the rest is a shopping list. Every row carries a size, because that is
 * the number the decision actually turns on.
 */
export function renderDatasets(catalog: DatasetCatalog): string {
  const present = catalog.entries.filter(entry => entry.present)
  const absent = catalog.entries.filter(entry => !entry.present)
  const totalBytes = catalog.entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
  const restricted = absent.filter(entry => entry.commercial === false).length

  const lines: string[] = [
    `Data lake    ${catalog.present}/${catalog.total} datasets on disk`,
    `Location     ${catalog.path}`,
    `Catalog      Biomni ${catalog.biomni}${catalog.source === 'vendored' ? ' (shipped manifest)' : ''}`
      + `, ${(totalBytes / 1e9).toFixed(1)} GB if you took all of it`,
  ]

  if (present.length > 0) {
    lines.push('', `On disk (${present.length}):`)
    for (const entry of present) {
      const mark = entry.commercial === false ? '  [non-commercial]' : ''
      lines.push(`  ${entry.size.padStart(8)}  ${entry.name}${mark}`)
    }
  }

  if (absent.length > 0) {
    lines.push('', `Available to fetch (${absent.length}):`)
    for (const entry of absent.slice(0, LISTED)) {
      const mark = entry.commercial === false ? '  [non-commercial]' : ''
      lines.push(`  ${entry.size.padStart(8)}  ${entry.name}${mark}`)
    }
    if (absent.length > LISTED) lines.push(`  ... and ${absent.length - LISTED} more`)
  }

  lines.push('', 'Fetch one by name:', '')
  lines.push(`  <python> ${FETCH_PATH} --root <data-root> <name>`)
  if (restricted > 0) {
    lines.push('')
    lines.push(`${restricted} of the datasets above are outside Biomni's commercial-use subset.`)
    lines.push('Fetching those needs --accept-noncommercial: the restriction is legal, not')
    lines.push('technical, so nothing else will stop you from using them.')
  }
  return lines.join('\n')
}
