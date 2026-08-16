/**
 * Client-side read of the user-facing Biomni preferences.
 *
 * The host owns the namespace through the settings seam (in-process); the DSH
 * settings RPC domain only serves allowlisted namespaces to configuration
 * clients, so the client reads and writes THIS namespace through the plugin's
 * own fenced /biomni routes instead (api.settingsGet / api.settingsUpdate).
 *
 * Any failure — route rejected, namespace absent, a field of the wrong type, a
 * value out of the contract range — falls back to the schema defaults. The
 * settings section must keep working exactly as composed when the settings
 * surface is missing.
 */
import {
  BIOMNI_PREFS_DEFAULTS,
  clampTimeoutMs,
  type BiomniPrefs,
} from '../prefs-shared.ts'
import { api } from './api.ts'

export { BIOMNI_PREFS_DEFAULTS, clampTimeoutMs }
export type { BiomniPrefs }

/**
 * Validate one raw resolved value into {@link BiomniPrefs}. Used for the
 * settings.get payload AND the settings.update response (both carry the
 * layered resolved value); any malformed field falls back to its default.
 * @param value - the raw resolved section from the settings wire.
 * @returns validated prefs (always well-formed).
 */
export function parsePrefs(value: unknown): BiomniPrefs {
  if (value === null || typeof value !== 'object') return { ...BIOMNI_PREFS_DEFAULTS }
  const record = value as Record<string, unknown>
  return {
    python: typeof record.python === 'string' && record.python.trim() !== ''
      ? record.python
      : BIOMNI_PREFS_DEFAULTS.python,
    timeoutMs: typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs)
      ? clampTimeoutMs(record.timeoutMs)
      : BIOMNI_PREFS_DEFAULTS.timeoutMs,
    guardShellPython: typeof record.guardShellPython === 'boolean'
      ? record.guardShellPython
      : BIOMNI_PREFS_DEFAULTS.guardShellPython,
  }
}

/**
 * Read the resolved preferences through the plugin's settings route.
 * @returns validated prefs and the document revision; the defaults with an
 * undefined revision when the route rejects or the response is malformed.
 */
export async function loadPrefs(): Promise<{ prefs: BiomniPrefs; revision?: number }> {
  try {
    const view = await api.settingsGet()
    return {
      prefs: parsePrefs(view.value),
      ...(view.revision === undefined ? {} : { revision: view.revision }),
    }
  } catch {
    // Transport/fence rejection or a malformed response: keep the defaults.
    return { prefs: { ...BIOMNI_PREFS_DEFAULTS } }
  }
}
