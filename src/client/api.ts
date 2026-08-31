/**
 * Typed fetch wrapper over the /biomni JSON API.
 *
 * Every call posts to `/biomni/api/<method>`. The routes carry the same
 * Host-header trust fence as the /api gateway, which same-origin browser
 * access passes naturally. Failures surface as {@link BiomniApiError} with the
 * wire code, so the caller can distinguish a settings conflict (re-read and
 * retry) from a transport failure (keep the defaults).
 */
import type { DatasetCatalog, DatasetEntry, FetchReport } from '../datasets.ts'
import type { ProbeReport } from '../prefs-shared.ts'

export type { DatasetCatalog, DatasetEntry, FetchReport }

/** One wire failure. */
export class BiomniApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The settings section's resolved value plus its revision. */
export interface SettingsView {
  value?: unknown
  revision?: number
}

/** What `env.probe` hands back. */
export interface ProbeResult {
  python: string
  report: ProbeReport | null
  error?: string
}

async function call<T>(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/biomni/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw new BiomniApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new BiomniApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

export const api = {
  /** Read the resolved Biomni settings section and its revision. */
  settingsGet: (signal?: AbortSignal) => call<SettingsView>('settings.get', {}, signal),
  /**
   * Merge a patch into the settings section. `expectedRevision` is the
   * optimistic-concurrency guard: a stale writer is refused with the
   * `settings-conflict` code rather than clobbering a concurrent write.
   */
  settingsUpdate: (patch: Record<string, unknown>, expectedRevision?: number) =>
    call<SettingsView>('settings.update', {
      patch,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    }),
  /** Survey the configured interpreter (slow: it starts a Python process). */
  envProbe: (signal?: AbortSignal) => call<ProbeResult>('env.probe', {}, signal),

  /** The data lake catalog: what exists, what it costs, what is already here. */
  datasetsList: (signal?: AbortSignal) =>
    call<{ catalog: DatasetCatalog | null; error?: string }>('datasets.list', {}, signal),

  /**
   * Fetch datasets by manifest name.
   *
   * `acceptNonCommercial` has to be passed explicitly for a restricted
   * dataset; the host refuses otherwise, independently of whatever the UI
   * decided to enable.
   */
  datasetsFetch: (names: string[], acceptNonCommercial = false) =>
    call<FetchReport>('datasets.fetch', { names, acceptNonCommercial }),
}
