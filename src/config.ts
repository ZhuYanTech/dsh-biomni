/**
 * The two configuration layers.
 *
 * `Config` is the COMPOSITION row (cordis.patch.yml): what the deployment
 * composes the plugin with, including the prompt text, which rides the request
 * prefix and must stay byte-stable across turns for the KV cache to hold.
 *
 * `PrefsSchema` is the USER layer (the settings document / the Settings page):
 * paths and limits only. It is registered as a settings namespace layered over
 * the composition row and resolved per access, so an edit applies without a
 * restart.
 */
import z from '@deepseek-ai/schemastery'
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
 * User-editable subset of the config, registered as the `biomni` settings
 * namespace. Paths and limits, not prompt text.
 */
export const PrefsSchema: z<BiomniPrefs> = z.object({
  python: z.string()
    .default(PYTHON_DEFAULT)
    .description('Interpreter used for each session worker. Point this at the venv that has Biomni installed.'),
  timeoutMs: z.number()
    .min(TIMEOUT_MS_MIN)
    .max(TIMEOUT_MS_MAX)
    .default(TIMEOUT_MS_DEFAULT)
    .description('Wall-clock limit for one snippet, in milliseconds. A timeout resets the interpreter.'),
  guardShellPython: z.boolean()
    .default(true)
    .description('Deny bash commands that invoke python or pip, redirecting them to run_python.'),
  dataPath: z.string()
    .default(DATA_PATH_DEFAULT)
    .description('Root holding biomni_data/data_lake. Empty follows Biomni: $BIOMNI_PATH, $BIOMNI_DATA_PATH, then ./data.'),
  idleTimeoutMs: z.union([z.const(0), z.number().min(IDLE_TIMEOUT_MS_MIN).max(IDLE_TIMEOUT_MS_MAX)])
    .default(IDLE_TIMEOUT_MS_DEFAULT)
    .description('Retire an interpreter after this long unused, in milliseconds. 0 keeps it for the life of the agent.'),
}) as unknown as z<BiomniPrefs>

/** The composition row. */
export const Config = z.object({
  python: z.string()
    .default(PYTHON_DEFAULT)
    .description('Interpreter used for each session worker.'),
  timeoutMs: z.number()
    .default(TIMEOUT_MS_DEFAULT)
    .description('Wall-clock limit for one snippet.'),
  description: z.string()
    .default(DEFAULT_TOOL_DESCRIPTION)
    .description('Model-facing tool description.'),
  guidance: z.string()
    .default(DEFAULT_GUIDANCE)
    .description('Prompt section describing the interpreter and its library; empty disables it.'),
  guardShellPython: z.boolean()
    .default(true)
    .description('Deny bash commands that invoke python or pip directly, redirecting them to run_python.'),
  dataPath: z.string()
    .default(DATA_PATH_DEFAULT)
    .description('Root holding biomni_data/data_lake; empty resolves as Biomni does.'),
  idleTimeoutMs: z.number()
    .default(IDLE_TIMEOUT_MS_DEFAULT)
    .description('Retire an interpreter after this long unused; 0 keeps it for the life of the agent.'),
})

/** The resolved composition row. */
export interface BiomniConfig {
  python: string
  timeoutMs: number
  description: string
  guidance: string
  guardShellPython: boolean
  dataPath: string
  idleTimeoutMs: number
}

/**
 * The prefs subset of a composition row — the `base` the settings namespace
 * layers over, so an unset user field falls back to what the deployment
 * composed rather than to the bare schema default.
 */
export function prefsBaseOf(config: BiomniConfig): BiomniPrefs {
  return {
    python: config.python,
    timeoutMs: clampTimeoutMs(config.timeoutMs),
    guardShellPython: config.guardShellPython,
    dataPath: config.dataPath,
    idleTimeoutMs: clampIdleTimeoutMs(config.idleTimeoutMs),
  }
}
