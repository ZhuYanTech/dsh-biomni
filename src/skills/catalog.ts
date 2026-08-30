/**
 * Reading the Biomni skill catalog out of the configured interpreter.
 *
 * The catalog is generated at RUNTIME rather than shipped as static markdown,
 * and that is the whole point. A skill body listing functions the user's actual
 * interpreter cannot call is the exact failure this project exists to prevent:
 * an agent that meets a missing lazy import quietly hand-rolls a substitute and
 * produces an answer that looks fine and did not come from the validated tool.
 * Generating from the installed library — through the same two-gate analysis
 * the environment report renders — means the skill catalog and the Settings
 * page cannot disagree about what is callable.
 */
import type { BiomniSubprocessService } from '../context-types.ts'
import { SKILLS_PATH } from '../python/paths.ts'

/** One parameter of an advertised function, as Biomni documents it. */
export interface CatalogParameter {
  name: string
  /** Biomni's own type string (`str`, `int`, `List[str]`, …); '' when unstated. */
  type: string
  description: string
  /** `repr()` of the default value; present on optional parameters only. */
  default?: string
}

/** One function Biomni advertises. */
export interface CatalogFunction {
  name: string
  description: string
  required: CatalogParameter[]
  optional: CatalogParameter[]
  /**
   * Absent packages this function's own body imports (gate 2). Non-empty means
   * calling it raises `ModuleNotFoundError` in this interpreter.
   */
  blockedBy: string[]
  /**
   * Whether the module actually defines a function by this name. False means
   * Biomni advertises something its own source does not define — reported as
   * unverified rather than claimed callable.
   */
  known: boolean
}

/** One tool module. */
export interface CatalogModule {
  /** Module stem as Biomni names it, e.g. `molecular_biology`. */
  name: string
  /** Whether every module-level import resolves (gate 1, all-or-nothing). */
  importable: boolean
  /** Absent top-level packages that make it unimportable. */
  blockers: string[]
  functions: CatalogFunction[]
}

/** One advertised dataset in Biomni's data lake. */
export interface CatalogDataset {
  /** File name as Biomni advertises it, e.g. `DepMap_Model.csv`. */
  name: string
  description: string
  /** Whether that file is actually on disk under the resolved root. */
  present: boolean
  /** Its size in bytes when present. */
  bytes: number | null
  /**
   * Whether Biomni's commercial-use subset includes it. `false` means the
   * dataset is restricted to non-commercial use; `null` means this Biomni
   * ships no such subset, so the question cannot be answered here.
   */
  commercial: boolean | null
}

/** The data lake as the catalog found it. */
export interface CatalogDataLake {
  /** Absolute directory that was searched. */
  path: string
  /** Whether that directory exists at all. */
  exists: boolean
  /** How many advertised datasets are actually there. */
  present: number
  entries: CatalogDataset[]
}

/** One advertised package or command-line tool. */
export interface CatalogLibrary {
  name: string
  /** As Biomni tags it; `unknown` when its description carries no tag. */
  kind: 'python' | 'r' | 'cli' | 'unknown'
  /** How it was actually located, when it was. */
  found: 'python' | 'cli' | null
  description: string
  /**
   * Whether it is installed. `null` is genuinely unverified — R packages on a
   * machine that has R, which would cost one process each to check.
   */
  available: boolean | null
}

/** The whole catalog. */
export interface SkillCatalog {
  /** Installed biomni version; null when the interpreter has none. */
  biomni: string | null
  modules: CatalogModule[]
  /** Biomni's data lake; absent from an older payload. */
  dataLake?: CatalogDataLake
  /** Biomni's software library; absent from an older payload. */
  libraries?: CatalogLibrary[]
  /** Set instead of the survey when generation failed inside Python. */
  error?: string
}

/** An empty catalog, used whenever generation fails. */
export const EMPTY_CATALOG: SkillCatalog = { biomni: null, modules: [] }

/** Skill name for the data lake listing. */
export const DATA_LAKE_SKILL = 'biomni-data-lake'

/** Skill name for the software library listing. */
export const SOFTWARE_SKILL = 'biomni-software'

/**
 * Generate the catalog by running `python/skills.py` in a throwaway process.
 *
 * Deliberately not the session's own worker: discovery happens outside any
 * agent turn, and a catalog build has no business leaving names behind in a
 * namespace the agent is using.
 *
 * @param ctx - the subprocess service.
 * @param python - the interpreter to read.
 * @param dataPath - the data lake root; empty defers to Biomni's own resolution.
 * @param signal - caller cancellation (the registry aborts discovery through it).
 */
export async function readCatalog(
  ctx: { subprocess: BiomniSubprocessService },
  python: string,
  dataPath: string,
  signal?: AbortSignal,
): Promise<SkillCatalog> {
  const handle = ctx.subprocess.spawn({
    // An empty data root is omitted rather than passed through, so the script
    // falls back to Biomni's own resolution instead of treating '' as a path.
    argv: dataPath === '' ? [python, SKILLS_PATH] : [python, SKILLS_PATH, dataPath],
    cwd: process.cwd(),
    // 218 functions with parameter metadata, plus 76 datasets and 113 library
    // entries; the observed payload is ~210 KB.
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4_000_000 }, stderr: { maxBytes: 8_192 } },
    graceMs: 5_000,
    ...(signal === undefined ? {} : { signal }),
  })
  const outcome = await handle.done
  if (outcome.exitCode !== 0) {
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    throw new Error(`skill catalog exited ${outcome.exitCode}: ${stderr.trim() || 'no output'}`)
  }
  return JSON.parse(handle.collected.stdout?.readFrom(0).text ?? '{}') as SkillCatalog
}

/**
 * The skill name for one module: kebab-case, package-prefixed.
 *
 * The registry requires `^[a-z0-9]+(?:-[a-z0-9]+)*$`, and Biomni's module stems
 * are snake_case (`molecular_biology`), so the underscores have to go.
 */
export function skillNameOf(module: string): string {
  return `biomni-${module.replace(/_/g, '-')}`
}

/** Whether a function can actually be called in the interpreter that was read. */
export function isCallable(fn: CatalogFunction): boolean {
  return fn.known && fn.blockedBy.length === 0
}

/**
 * The modules worth advertising: importable, and with at least one callable
 * function.
 *
 * An unimportable module has NO callable function — every entry under it would
 * be a promise the interpreter cannot keep — so it is left out of the catalog
 * rather than published with a warning nobody reads. The Settings page is where
 * unimportable modules and their blockers are shown.
 */
export function advertisableModules(catalog: SkillCatalog): CatalogModule[] {
  return catalog.modules.filter(
    module => module.importable && module.functions.some(isCallable),
  )
}

/**
 * The datasets worth advertising: the ones actually on disk.
 *
 * Same rule as unimportable modules, and it matters more here. A body listing
 * 76 datasets that are not downloaded does not produce a model that reports the
 * gap — it produces one that writes a plausible path into `pd.read_parquet`
 * and reports a plausible result. Where the data lake IS and what it is missing
 * belongs in the environment report, not in a skill body.
 */
export function presentDatasets(catalog: SkillCatalog): CatalogDataset[] {
  return catalog.dataLake?.entries.filter(entry => entry.present) ?? []
}

/**
 * The software worth advertising: what is installed, plus what could not be
 * verified.
 *
 * Unverified entries stay in — they are marked as such in the body, and the
 * alternative is hiding an R package that is in fact installed.
 */
export function availableLibraries(catalog: SkillCatalog): CatalogLibrary[] {
  return (catalog.libraries ?? []).filter(entry => entry.available !== false)
}
