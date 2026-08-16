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

/** The whole catalog. */
export interface SkillCatalog {
  /** Installed biomni version; null when the interpreter has none. */
  biomni: string | null
  modules: CatalogModule[]
  /** Set instead of the survey when generation failed inside Python. */
  error?: string
}

/** An empty catalog, used whenever generation fails. */
export const EMPTY_CATALOG: SkillCatalog = { biomni: null, modules: [] }

/**
 * Generate the catalog by running `python/skills.py` in a throwaway process.
 *
 * Deliberately not the session's own worker: discovery happens outside any
 * agent turn, and a catalog build has no business leaving names behind in a
 * namespace the agent is using.
 *
 * @param ctx - the subprocess service.
 * @param python - the interpreter to read.
 * @param signal - caller cancellation (the registry aborts discovery through it).
 */
export async function readCatalog(
  ctx: { subprocess: BiomniSubprocessService },
  python: string,
  signal?: AbortSignal,
): Promise<SkillCatalog> {
  const handle = ctx.subprocess.spawn({
    argv: [python, SKILLS_PATH],
    cwd: process.cwd(),
    // 218 functions with parameter metadata; the observed payload is ~200 KB.
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
