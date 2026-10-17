/**
 * The plugin's configuration — one schema, two lifetimes.
 *
 * DSH 0.2 removed the separate settings document: `settingsNamespace` and
 * `settings.register()` are gone, `settings.yaml` is migrated into the profile,
 * and a plugin's own cordis `Config` IS what the Settings page renders
 * (`SettingsForms.describe()` projects this schema). So the old split between a
 * composition row and a `PrefsSchema` user layer collapses into this file.
 *
 * What survives the collapse is the distinction that actually mattered, now
 * expressed per field rather than per schema:
 *
 *   `.volatile()`  — editable live. The value arrives as a stable reference
 *                    whose `.get()` returns the current snapshot, so reading it
 *                    per access (never caching at apply time) is what makes
 *                    "an edit applies without a restart" true. That used to be
 *                    a hand-written getter object in index.ts; the runtime
 *                    provides it now.
 *
 *   plain          — changing it remounts the plugin. Correct for `description`
 *                    and `guidance`: they ride the request prefix and must stay
 *                    byte-stable across turns or the KV cache is lost, so a
 *                    mid-session edit SHOULD rebuild the whole thing rather
 *                    than silently change the prompt under a live session.
 *
 * Which field is which is a behavioural contract, not a formatting choice.
 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cosmokit'
import {
  clampIdleTimeoutMs,
  clampTimeoutMs,
  DATA_PATH_DEFAULT,
  IDLE_TIMEOUT_MS_DEFAULT,
  IDLE_TIMEOUT_MS_MAX,
  IDLE_TIMEOUT_MS_MIN,
  PYTHON_DEFAULT,
  TIMEOUT_MS_DEFAULT,
  TIMEOUT_MS_MAX,
  TIMEOUT_MS_MIN,
  type BiomniPrefs,
} from './prefs-shared.ts'
import { DEFAULT_GUIDANCE, DEFAULT_TOOL_DESCRIPTION } from './prompt.ts'

export { BIOMNI_PREFS_NS } from './prefs-shared.ts'

/**
 * The live, user-editable fields.
 *
 * Kept as a named object so `PrefsSchema` (the Settings form's shape) and
 * `Config` (the whole plugin row) cannot drift apart: there is one definition,
 * spread into both.
 *
 * Every field here is `.volatile()`. Adding one that is not makes editing it
 * remount every session's interpreter — losing the namespaces — which is the
 * kind of regression nobody notices until a user complains that saving a path
 * threw away their work.
 */
const LIVE_FIELDS = {
  python: z.string()
    .default(PYTHON_DEFAULT)
    .description('Interpreter used for each session worker. Point this at the venv that has Biomni installed.')
    .volatile(),
  timeoutMs: z.number()
    .min(TIMEOUT_MS_MIN)
    .max(TIMEOUT_MS_MAX)
    .default(TIMEOUT_MS_DEFAULT)
    .description('Wall-clock limit for one snippet, in milliseconds. A timeout resets the interpreter.')
    .volatile(),
  guardShellPython: z.boolean()
    .default(true)
    .description('Deny bash commands that invoke python or pip, redirecting them to run_python.')
    .volatile(),
  dataPath: z.string()
    .default(DATA_PATH_DEFAULT)
    .description('Root holding biomni_data/data_lake. Empty follows Biomni: $BIOMNI_PATH, $BIOMNI_DATA_PATH, then ./data.')
    .volatile(),
  idleTimeoutMs: z.union([z.const(0), z.number().min(IDLE_TIMEOUT_MS_MIN).max(IDLE_TIMEOUT_MS_MAX)])
    .default(IDLE_TIMEOUT_MS_DEFAULT)
    .description('Retire an interpreter after this long unused, in milliseconds. 0 keeps it for the life of the agent.')
    .volatile(),
} as const

/**
 * The Settings page's shape.
 *
 * Exported for the tests and the client, which need to know which fields are
 * user-editable without importing the prompt text alongside them.
 */
export const PrefsSchema = z.object({ ...LIVE_FIELDS })

/** The plugin row: the live fields, plus the text that may not change under a session. */
export const Config = z.object({
  ...LIVE_FIELDS,
  description: z.string()
    .default(DEFAULT_TOOL_DESCRIPTION)
    .description('Model-facing tool description. Changing it remounts the plugin: it rides the request prefix.'),
  guidance: z.string()
    .default(DEFAULT_GUIDANCE)
    .description('Prompt section describing the interpreter and its library; empty disables it. Remounts on change.'),
})

/**
 * The resolved plugin row as `apply` receives it.
 *
 * The live fields are references, not values. `python` is a `Volatile<string>`
 * and `python.get()` is the current interpreter — writing `config.python`
 * where a string is wanted is a type error, which is the point: it is no
 * longer possible to accidentally cache a setting at apply time.
 */
export interface BiomniConfig {
  python: Volatile<string>
  timeoutMs: Volatile<number>
  guardShellPython: Volatile<boolean>
  dataPath: Volatile<string>
  idleTimeoutMs: Volatile<number>
  description: string
  guidance: string
}

/**
 * Read every live field once, clamped — for a caller that needs a plain
 * snapshot (a report, a wire response) rather than the references.
 *
 * Never hold the result across an await or a call boundary: the whole contract
 * of a volatile field is that it may have changed by then.
 */
export function snapshotPrefs(config: BiomniConfig): BiomniPrefs {
  return {
    python: config.python.get(),
    timeoutMs: clampTimeoutMs(config.timeoutMs.get()),
    guardShellPython: config.guardShellPython.get(),
    dataPath: config.dataPath.get(),
    idleTimeoutMs: clampIdleTimeoutMs(config.idleTimeoutMs.get()),
  }
}
