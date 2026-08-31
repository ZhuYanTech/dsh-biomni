/**
 * The Biomni skill provider.
 *
 * This is the piece that answers what Biomni built `ToolRetriever` for. Biomni
 * needs a retrieval layer because 200+ tool schemas do not fit in context, so
 * it embeds them and selects a subset per prompt. DSH's skill system already
 * has that shape, and a better one: the session catalog carries only each
 * skill's `name` and `description`, and the full body loads on demand through
 * the `skill` tool. Twenty-one one-line rows cost almost nothing, and the model
 * pays for a module's signatures only in the turn it actually needs them —
 * selection by the model's own judgment rather than by embedding similarity.
 *
 * Discovery is cached because it costs a subprocess. The cache is dropped
 * whenever the interpreter setting changes, through the registration-scoped
 * `control.invalidate()` — a catalog generated from a different interpreter is
 * not stale, it is wrong.
 */
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
  type SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import type { BiomniSubprocessService } from '../context-types.ts'
import {
  advertisableModules,
  availableLibraries,
  DATA_LAKE_SKILL,
  presentDatasets,
  readCatalog,
  skillNameOf,
  SOFTWARE_SKILL,
  type CatalogDataLake,
  type CatalogDataset,
  type CatalogLibrary,
  type CatalogModule,
  type SkillCatalog,
} from './catalog.ts'
import {
  describeDataLake,
  describeModule,
  describeSoftware,
  renderDataLakeBody,
  renderSkillBody,
  renderSoftwareBody,
} from './render.ts'
import { loadStaticSkills, type StaticSkill } from './static.ts'

/** The provider name in the `ctx.skills` registry. */
export const PROVIDER_NAME = 'dsh-biomni'

/** What the provider needs from its host. */
export interface ProviderDeps {
  subprocess: BiomniSubprocessService
  /** The live interpreter setting, read per discovery. */
  python: () => string
  /** The live data lake root, read per discovery; empty defers to Biomni. */
  dataPath: () => string
  /** Reported when a catalog build fails; discovery itself never throws. */
  onError?: (error: unknown) => void
}

/**
 * What a candidate carries back to `get()`. Either a generated module skill or
 * one of the shipped markdown ones — the registry only stores the locator and
 * hands it back, so the two kinds never need a shared shape.
 */
type Locator =
  | { kind: 'module'; module: CatalogModule; biomni: string }
  | { kind: 'data-lake'; dataLake: CatalogDataLake; datasets: CatalogDataset[]; biomni: string }
  | { kind: 'software'; libraries: CatalogLibrary[]; biomni: string }
  | { kind: 'static'; skill: StaticSkill }

/** One shipped markdown skill as a candidate. */
function staticCandidate(skill: StaticSkill): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    path: skill.path,
    locator: { kind: 'static', skill } satisfies Locator,
  }
}

/**
 * Build the provider.
 *
 * @param deps - subprocess access plus the live interpreter setting.
 * @param control - the registration-scoped lifecycle handed in by
 *   `ctx.skills.registerProvider`; its signal aborts on disposal.
 * @returns the provider, plus an `invalidate` the caller wires to settings
 *   changes.
 */
export function createBiomniSkillProvider(
  deps: ProviderDeps,
  control: SkillProviderControl,
): SkillProvider & { invalidate: () => void } {
  /**
   * The last completed catalog, keyed by BOTH settings that decide what it
   * describes. The interpreter decides which functions are callable; the data
   * root decides which datasets exist. A catalog carried across a change in
   * either is not stale, it is wrong.
   */
  let cached: { key: string; catalog: SkillCatalog } | undefined
  /** An in-flight build, shared so concurrent discoveries spawn one process. */
  let building: Promise<SkillCatalog> | undefined

  const keyOf = (python: string, dataPath: string): string => `${python}\u0000${dataPath}`

  const catalogFor = async (signal?: AbortSignal): Promise<SkillCatalog> => {
    const python = deps.python()
    const dataPath = deps.dataPath()
    const key = keyOf(python, dataPath)
    if (cached !== undefined && cached.key === key) return cached.catalog
    if (building !== undefined) return building
    building = readCatalog(deps, python, dataPath, signal)
      .then((catalog) => {
        // Only cache a build that matches the settings still in force: a change
        // mid-build makes this catalog describe the wrong environment.
        if (keyOf(deps.python(), deps.dataPath()) === key) cached = { key, catalog }
        return catalog
      })
      .finally(() => { building = undefined })
    return building
  }

  return {
    name: PROVIDER_NAME,

    async list(options) {
      // The shipped skills do not depend on the interpreter: how to organize
      // the work and how to use run_python without losing results are useful
      // whether or not Biomni is installed. They are offered unconditionally,
      // and survive a failed catalog build.
      const shipped = loadStaticSkills().map(staticCandidate)

      // A failed build must not take the whole registry's discovery down: other
      // providers' skills stay usable, and `complete: false` tells the registry
      // not to cache this observation so the next lookup retries.
      let catalog: SkillCatalog
      try {
        catalog = await catalogFor(options.signal ?? control.signal)
      } catch (error) {
        deps.onError?.(error)
        return { candidates: shipped, complete: false }
      }
      if (catalog.error !== undefined) {
        deps.onError?.(new Error(catalog.error))
        return { candidates: shipped, complete: false }
      }
      // No biomni means no MODULE skills — those are real Python that has to
      // import. It does NOT mean no catalog: the data lake and the software
      // library are manifest-backed, and knowing what is already on the machine
      // is most useful precisely when Biomni is not installed yet.
      const biomni = catalog.biomni ?? catalog.manifest?.biomni ?? 'unknown'
      const modules = catalog.biomni === null ? [] : advertisableModules(catalog)

      const generated = modules.map((module): SkillCandidate => ({
        name: skillNameOf(module.name),
        description: describeModule(module),
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER_NAME,
        source: 'bundled',
        rank: BUNDLED_SKILL_RANK,
        resourceBase: {
          kind: 'opaque',
          description: `the biomni.tool.${module.name} module inside this session's Python interpreter`,
        },
        locator: { kind: 'module', module, biomni } satisfies Locator,
        metadata: {
          module: module.name,
          biomni,
          functions: module.functions.length,
        },
      }))

      // The data lake and the software library are separate assets from the
      // tool modules: neither is reachable through `biomni.tool`, and each is
      // useful in sessions where no tool module is. Both are advertised only
      // when this machine actually has something to offer under them.
      const extras: SkillCandidate[] = []

      const datasets = presentDatasets(catalog)
      const dataLake = catalog.dataLake
      if (dataLake !== undefined && datasets.length > 0) {
        extras.push({
          name: DATA_LAKE_SKILL,
          description: describeDataLake(datasets),
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER_NAME,
          source: 'bundled',
          rank: BUNDLED_SKILL_RANK,
          resourceBase: {
            kind: 'opaque',
            description: `Biomni's data lake on disk at ${dataLake.path}`,
          },
          locator: { kind: 'data-lake', dataLake, datasets, biomni } satisfies Locator,
          metadata: { biomni, datasets: datasets.length, path: dataLake.path },
        })
      }

      const libraries = availableLibraries(catalog)
      if (libraries.length > 0) {
        extras.push({
          name: SOFTWARE_SKILL,
          description: describeSoftware(libraries),
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER_NAME,
          source: 'bundled',
          rank: BUNDLED_SKILL_RANK,
          resourceBase: {
            kind: 'opaque',
            description: 'the bioinformatics packages and command-line tools installed on this machine',
          },
          locator: { kind: 'software', libraries, biomni } satisfies Locator,
          metadata: { biomni, entries: libraries.length },
        })
      }

      return [...shipped, ...generated, ...extras]
    },

    async get(candidate) {
      const locator = candidate.locator as Locator | undefined
      if (locator === undefined) return undefined
      const common = {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        provider: PROVIDER_NAME,
        source: candidate.source,
        ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
        ...(candidate.path === undefined ? {} : { path: candidate.path }),
        ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
        ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
      }
      if (locator.kind === 'static') {
        return { ...common, content: locator.skill.content } satisfies SkillDefinition
      }
      if (locator.kind === 'data-lake') {
        return {
          ...common,
          content: renderDataLakeBody(locator.dataLake, locator.datasets, locator.biomni),
        } satisfies SkillDefinition
      }
      if (locator.kind === 'software') {
        return {
          ...common,
          content: renderSoftwareBody(locator.libraries, locator.biomni),
        } satisfies SkillDefinition
      }
      return {
        ...common,
        content: renderSkillBody(locator.module, locator.biomni),
      } satisfies SkillDefinition
    },

    /** Drop the cached catalog and tell the registry to rediscover. */
    invalidate() {
      cached = undefined
      control.invalidate()
    },
  }
}
