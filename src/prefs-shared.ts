/**
 * Shared Biomni preference vocabulary (types + constants), consumed by BOTH
 * halves: the host registers the schemastery schema over these values
 * (config.ts) and the client reads/writes them through the plugin's own fenced
 * settings route (client/prefs.ts, client/BiomniSection.tsx). Kept free of
 * schemastery so the browser bundle never pulls the schema runtime in.
 */

/** The user-settings namespace holding the Biomni preferences. */
export const BIOMNI_PREFS_NS = 'biomni'

/** User-facing Biomni preferences. */
export interface BiomniPrefs {
  /**
   * Interpreter each session worker is spawned from. The default `python3` is
   * the system interpreter, which on macOS is 3.9 and has none of Biomni's
   * library; point this at the venv built from
   * `python/requirements-biomni.txt`. Changing it retires running workers, so
   * the next call adopts the new interpreter with an empty namespace.
   */
  python: string
  /**
   * Wall-clock limit for one snippet, in milliseconds. A timeout resets that
   * session's interpreter: its state is unknowable once a call is abandoned
   * mid-execution.
   */
  timeoutMs: number
  /**
   * Whether bash commands that invoke `python` / `pip` directly are denied and
   * redirected to `run_python`. On by default, and it earns its keep: prompt
   * guidance alone was measured to fix only the model's FIRST choice — mid-task
   * it still fell back to `bash python3 -c`, reaching an interpreter without
   * the library.
   */
  guardShellPython: boolean
}

/** Range contract of {@link BiomniPrefs.timeoutMs}. */
export const TIMEOUT_MS_MIN = 1_000
export const TIMEOUT_MS_MAX = 3_600_000
export const TIMEOUT_MS_DEFAULT = 600_000

/** Fallback interpreter when nothing better is configured. */
export const PYTHON_DEFAULT = 'python3'

/** Fallback prefs used whenever the settings document is unreachable or malformed. */
export const BIOMNI_PREFS_DEFAULTS: BiomniPrefs = {
  python: PYTHON_DEFAULT,
  timeoutMs: TIMEOUT_MS_DEFAULT,
  guardShellPython: true,
}

/** Clamp one snippet timeout into the contract range (shared by schema and client reads). */
export function clampTimeoutMs(value: number): number {
  return Math.min(TIMEOUT_MS_MAX, Math.max(TIMEOUT_MS_MIN, Math.round(value)))
}

// ── The environment probe report ────────────────────────────────────────────
// Produced by python/probe.py, rendered by both the `/biomni` command (host)
// and the Settings section (client), so its shape is shared vocabulary.

/** One `biomni.tool` module as the probe found it. */
export interface ProbeModule {
  /** Module stem, e.g. `database`. */
  name: string
  /** Whether every module-level import resolves (gate 1: all-or-nothing). */
  importable: boolean
  /** Absent top-level imports that make it unimportable. */
  blockers: string[]
  /** Public functions defined in the module. */
  functions: number
  /** Of those, how many import something absent inside the body (gate 2). */
  blocked: number
}

/** The probe's whole report. */
export interface ProbeReport {
  /** `sys.executable` of the probed interpreter. */
  executable: string
  /** Its version, e.g. `3.11.9`. */
  python: string
  /** Installed biomni version, `'unknown'` when the distribution has none, null when absent. */
  biomni: string | null
  modules: ProbeModule[]
  totalFunctions: number
  blockedFunctions: number
  /**
   * Packages that gate function bodies, by how many functions each blocks.
   * Ordered most-blocking first.
   */
  missing: Record<string, number>
  /**
   * `tqdm` / `pandas` when absent. `biomni.tool.__init__` imports
   * `biomni.utils`, so these two gate EVERY module at once — and the resulting
   * import error names neither, which is why they are called out separately.
   */
  gate?: string[]
  /** Set instead of the survey when the probe itself failed. */
  error?: string
}

/** Whether a probe report describes a usable Biomni install. */
export function isBiomniInstalled(report: ProbeReport): boolean {
  return report.error === undefined && report.biomni !== null
}
