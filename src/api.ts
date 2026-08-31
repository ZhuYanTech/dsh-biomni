/**
 * The /biomni JSON API method table.
 *
 * `settings.get` / `settings.update` are why this route exists at all. DSH's
 * settings RPC domain (packages/host/apiproxy) filters `settings.describe`
 * through a HARDCODED allowlist:
 *
 *     const WEB_SETTINGS_NAMESPACES = ['agent-loop', 'shell', 'locale',
 *       'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek']
 *
 * commented "a future registration does not become remotely readable or
 * writable by default". There is no config field and no extension point, so a
 * third-party namespace resolves `status: 'unavailable'` and a settings card
 * built on that RPC can neither read nor write — it must render nothing.
 *
 * The way around it is not to use that RPC. The host owns the namespace
 * through the settings seam IN-PROCESS (where no allowlist applies) and serves
 * it over this plugin's own fenced route instead. The write keeps the seam's
 * revision guard, so a stale editor is still refused.
 */
import type { ArtifactListing } from './artifacts.ts'
import type { DatasetCatalog, FetchReport } from './datasets.ts'
import type { ProbeReport } from './prefs-shared.ts'
import { BiomniError } from './wire.ts'

/** The current resolved value of the namespace plus its revision. */
export interface SettingsView {
  value?: unknown
  revision?: number
}

/**
 * The in-process settings face the host fills once the settings service is
 * available. Undefined while the deployment has no settings service — the
 * client then falls back to the schema defaults and the plugin keeps working
 * exactly as composed.
 */
export interface BiomniSettingsFace {
  /** The current resolved value + revision. */
  get(): SettingsView
  /** Merge a patch (revision-guarded) and return the fresh resolved view. */
  update(patch: Record<string, unknown>, expectedRevision?: number): Promise<SettingsView>
}

/** What `env.probe` hands back. */
export interface ProbeResult {
  /** The interpreter that was surveyed (the resolved `python` setting). */
  python: string
  /** The report, or null when the probe could not be run at all. */
  report: ProbeReport | null
  /** Why it could not be run; absent on success. */
  error?: string
}

/** The dependencies the method table closes over. */
export interface ApiDeps {
  /** The in-process settings face, or undefined when there is no settings service. */
  settings: () => BiomniSettingsFace | undefined
  /** The resolved interpreter path. */
  python: () => string
  /** Run the environment survey against one interpreter. */
  probe: (python: string) => Promise<ProbeReport>
  /** The data lake catalog: what exists, what it costs, what is already here. */
  datasets: () => Promise<DatasetCatalog>
  /** Fetch datasets by manifest name. */
  fetch: (names: string[], acceptNonCommercial: boolean) => Promise<FetchReport>
  /** What the interpreter has written into the session's output directory. */
  artifacts: () => Promise<ArtifactListing>
}

/** One API method: an unknown JSON payload in, a JSON-serializable value out. */
export type ApiMethod = (payload: unknown) => unknown | Promise<unknown>

/** Build the method table. */
export function buildApi(deps: ApiDeps): Record<string, ApiMethod> {
  return {
    /** The resolved Biomni settings section and its revision. */
    'settings.get': () => deps.settings()?.get() ?? { value: undefined, revision: undefined },

    /**
     * Merge a patch into the settings section. `expectedRevision` carries the
     * seam's optimistic-concurrency guard: a stale editor is refused rather
     * than allowed to clobber a concurrent write.
     */
    'settings.update': async (payload: unknown) => {
      const settings = deps.settings()
      if (settings === undefined) {
        throw new BiomniError('settings-rejected', 'no settings service in this deployment', 503)
      }
      const record = payload as { patch?: unknown; expectedRevision?: unknown } | null
      const patch = record?.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new BiomniError('bad-request', 'missing or invalid "patch"')
      }
      const expectedRevision = typeof record?.expectedRevision === 'number'
        ? record.expectedRevision
        : undefined
      try {
        return await settings.update(patch as Record<string, unknown>, expectedRevision)
      } catch (cause) {
        const message = (cause as Error | undefined)?.message ?? String(cause)
        // The seam's conflict is a normal outcome the editor re-reads and
        // retries from, not a server fault.
        const conflict = /revision|conflict/i.test(message)
        throw new BiomniError(
          conflict ? 'settings-conflict' : 'settings-rejected',
          message,
          conflict ? 409 : 400,
        )
      }
    },

    /**
     * Survey the configured interpreter. A probe that cannot run at all is
     * reported in the envelope rather than thrown: "your interpreter path is
     * wrong" is the single most common answer here, and it deserves to reach
     * the panel as data rather than as a transport failure.
     */
    'env.probe': async (): Promise<ProbeResult> => {
      const python = deps.python()
      try {
        return { python, report: await deps.probe(python) }
      } catch (cause) {
        return { python, report: null, error: (cause as Error | undefined)?.message ?? String(cause) }
      }
    },

    /**
     * The data lake catalog. Same envelope reasoning as `env.probe`: a helper
     * that cannot run is usually a wrong interpreter path, which is data the
     * panel should render rather than a transport failure.
     */
    'datasets.list': async (): Promise<{ catalog: DatasetCatalog | null; error?: string }> => {
      try {
        return { catalog: await deps.datasets() }
      } catch (cause) {
        return { catalog: null, error: (cause as Error | undefined)?.message ?? String(cause) }
      }
    },

    /**
     * Fetch datasets by manifest name.
     *
     * A write, so it is strict where the reads are forgiving: a malformed
     * payload is refused rather than coerced. The licence acknowledgement has
     * to arrive as an explicit `true` — defaulting it either way would make a
     * deliberate choice implicit, and it is the one thing here that is not
     * reversible by deleting a file.
     */
    'datasets.fetch': async (payload: unknown): Promise<FetchReport> => {
      const record = payload as { names?: unknown; acceptNonCommercial?: unknown } | null
      const names = record?.names
      if (!Array.isArray(names) || names.length === 0 || !names.every(n => typeof n === 'string' && n !== '')) {
        throw new BiomniError('bad-request', 'missing or invalid "names"')
      }
      return deps.fetch(names as string[], record?.acceptNonCommercial === true)
    },

    /**
     * The output directory. Unlike the dataset helpers this needs no
     * subprocess — it is a directory read — so a failure here is a real fault
     * and is allowed to throw.
     */
    'artifacts.list': (): Promise<ArtifactListing> => deps.artifacts(),
  }
}
