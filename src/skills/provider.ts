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
  readCatalog,
  skillNameOf,
  type CatalogModule,
  type SkillCatalog,
} from './catalog.ts'
import { describeModule, renderSkillBody } from './render.ts'

/** The provider name in the `ctx.skills` registry. */
export const PROVIDER_NAME = 'dsh-biomni'

/** What the provider needs from its host. */
export interface ProviderDeps {
  subprocess: BiomniSubprocessService
  /** The live interpreter setting, read per discovery. */
  python: () => string
  /** Reported when a catalog build fails; discovery itself never throws. */
  onError?: (error: unknown) => void
}

/** A module resolved for one candidate, carried as the opaque locator. */
interface Locator {
  module: CatalogModule
  biomni: string
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
  /** The last completed catalog, keyed by the interpreter that produced it. */
  let cached: { python: string; catalog: SkillCatalog } | undefined
  /** An in-flight build, shared so concurrent discoveries spawn one process. */
  let building: Promise<SkillCatalog> | undefined

  const catalogFor = async (signal?: AbortSignal): Promise<SkillCatalog> => {
    const python = deps.python()
    if (cached !== undefined && cached.python === python) return cached.catalog
    if (building !== undefined) return building
    building = readCatalog(deps, python, signal)
      .then((catalog) => {
        // Only cache a build that matches the setting still in force: a change
        // mid-build makes this catalog describe the wrong interpreter.
        if (deps.python() === python) cached = { python, catalog }
        return catalog
      })
      .finally(() => { building = undefined })
    return building
  }

  return {
    name: PROVIDER_NAME,

    async list(options) {
      // A failed build must not take the whole registry's discovery down: other
      // providers' skills stay usable, and `complete: false` tells the registry
      // not to cache this observation so the next lookup retries.
      let catalog: SkillCatalog
      try {
        catalog = await catalogFor(options.signal ?? control.signal)
      } catch (error) {
        deps.onError?.(error)
        return { candidates: [], complete: false }
      }
      if (catalog.error !== undefined) {
        deps.onError?.(new Error(catalog.error))
        return { candidates: [], complete: false }
      }
      // No biomni is an authoritative answer, not a failure: this interpreter
      // genuinely has no Biomni skills to offer.
      const biomni = catalog.biomni
      if (biomni === null) return []

      return advertisableModules(catalog).map((module): SkillCandidate => ({
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
        locator: { module, biomni } satisfies Locator,
        metadata: {
          module: module.name,
          biomni,
          functions: module.functions.length,
        },
      }))
    },

    async get(candidate) {
      const locator = candidate.locator as Locator | undefined
      if (locator === undefined) return undefined
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        provider: PROVIDER_NAME,
        source: candidate.source,
        ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
        ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
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
