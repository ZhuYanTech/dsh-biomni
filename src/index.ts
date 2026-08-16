/**
 * dsh-biomni host half.
 *
 * Registers one model-facing tool, `run_python`, backed by a single Python
 * process per agent session. Imports, dataframes, and fitted models defined in
 * one call are still there in the next, so the agent builds up state in small
 * steps instead of re-running one large script — the execution model Biomni's
 * agent depends on, reproduced as a dsh plugin rather than as a fork.
 *
 * Around that kernel:
 * - a system-prompt section and a bash guard, which together are what make the
 *   model actually USE the interpreter (both were needed; see prompt.ts and
 *   guard.ts for the measurements),
 * - the `biomni` settings namespace, layered over the composition row and
 *   resolved per access so an edit applies without a restart,
 * - the `/biomni` slash command and the fenced `/biomni/api` routes, which
 *   serve the environment probe and the settings section to the browser.
 *
 * Nothing here patches the harness. The plugin is composed into a profile as an
 * ordinary out-of-tree bundle.
 */
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Context } from './context-types.ts'
import { BIOMNI_PREFS_NS, Config, PrefsSchema, prefsBaseOf, type BiomniConfig } from './config.ts'
import type { BiomniPrefs } from './prefs-shared.ts'
import { buildApi, type BiomniSettingsFace } from './api.ts'
import { shellPythonGuard } from './guard.ts'
import { probeEnvironment, renderReport } from './probe.ts'
import { pythonWorkers } from './python/workers.ts'
import { runPythonTool } from './python/tool.ts'
import { createBiomniSkillProvider } from './skills/provider.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { readJsonBody, writeError, writeJson, writeOk, BiomniError } from './wire.ts'

export { Config }
export type { BiomniConfig }
export type { Context } from './context-types.ts'
export type {
  BiomniPrefs,
  ProbeModule,
  ProbeReport,
} from './prefs-shared.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-biomni'

/**
 * Services required before mounting: the ones the INTERPRETER needs.
 *
 * `webServer` / `webRuntime` are deliberately absent. They carry the Settings
 * section, and a headless profile (`@deepseek-ai/dsh-headless` instead of the
 * web app) has neither — listing them here would keep the whole plugin from
 * activating there, taking `run_python` down with a UI nobody asked for. The
 * routes mount from a child fiber instead, so the kernel works either way.
 */
export const inject = [
  'tools',
  'subprocess',
  'sandbox',
  'sandboxPolicy',
  'systemPrompt',
  'settings',
  'commands',
]

/** The route prefix this plugin owns. */
const API_PREFIX = '/biomni/api'

export function apply(ctx: Context, config: BiomniConfig): void {
  // ── Settings ─────────────────────────────────────────────────────────────
  // The composition row is the deployment's base; a user's settings document
  // layers over it. Reading through the scope on every access is what lets an
  // edit take effect without a restart.
  const ns = settingsNamespace(BIOMNI_PREFS_NS)
  const scope = ctx.settings.register<BiomniPrefs>(ns, PrefsSchema, { base: prefsBaseOf(config) })

  /** The live resolved prefs, re-read per property access. */
  const live: BiomniPrefs = {
    get python() { return scope.get().python },
    get timeoutMs() { return scope.get().timeoutMs },
    get guardShellPython() { return scope.get().guardShellPython },
  }

  // The in-process face the fenced routes call. `describe()` is the seam's own
  // read; no allowlist applies to it in-process (see api.ts for why that
  // matters).
  const settingsView = (): { value?: unknown; revision?: number } => {
    const descriptor = ctx.settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
    return descriptor === undefined
      ? { value: undefined, revision: undefined }
      : { value: descriptor.value, revision: descriptor.revision }
  }
  const settingsFace: BiomniSettingsFace = {
    get: settingsView,
    update: async (patch, expectedRevision) => {
      await ctx.settings.update(ns, patch, expectedRevision)
      return settingsView()
    },
  }

  // ── The interpreter pool ─────────────────────────────────────────────────
  const workers = pythonWorkers(ctx, live)

  // Things that must react to a changed interpreter. A running worker keeps the
  // executable it was started with, and a skill catalog generated from a
  // different interpreter is not stale but wrong, so both are retired.
  const onPythonChanged = new Set<() => void>()
  let currentPython = live.python
  scope.watch((next) => {
    if (next.python === currentPython) return
    currentPython = next.python
    void workers.resetAll()
    for (const react of onPythonChanged) react()
  })

  // ── Model-facing surfaces ────────────────────────────────────────────────
  // 100-199 is the convention for tool guidance, after the deployment persona.
  // Kept on the composition config rather than settings: the text rides the
  // request prefix, and a user editing it mid-session would cost the KV cache.
  if (config.guidance.trim().length > 0) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'biomni:python-environment',
      order: 120,
      text: config.guidance,
    }))
  }

  ctx.effect(() => ctx.tools.guard(shellPythonGuard(() => live.guardShellPython)))
  ctx.effect(() => ctx.tools.register(runPythonTool(workers, live, config.description)))

  // ── The /biomni command ──────────────────────────────────────────────────
  ctx.effect(() => ctx.commands.register({
    name: 'biomni',
    description: 'report what this session\'s Python interpreter can actually do',
    recordInput: false,
    handler: async (invocation) => {
      try {
        const report = await probeEnvironment(ctx, live.python, invocation.signal)
        return { kind: 'success', text: renderReport(report, live) }
      } catch (cause) {
        return {
          kind: 'error',
          text: `Could not probe ${live.python}: ${String((cause as Error | undefined)?.message ?? cause)}`,
        }
      }
    },
  }))

  // ── The fenced JSON API ──────────────────────────────────────────────────
  const api = buildApi({
    settings: () => settingsFace,
    python: () => live.python,
    probe: python => probeEnvironment(ctx, python),
  })

  // ── The skill catalog ────────────────────────────────────────────────────
  // One skill per importable tool module, generated from the configured
  // interpreter. This is the answer to what Biomni built ToolRetriever for: the
  // session catalog carries only a name and a one-line description per module,
  // and the model loads a module's full signatures on demand. Mounted from a
  // child fiber so a deployment without the skills service still works.
  ctx.inject(['skills'], (sctx) => {
    sctx.effect(() => sctx.skills.registerProvider((control) => {
      const provider = createBiomniSkillProvider({
        subprocess: ctx.subprocess,
        python: () => live.python,
        onError: (error) => {
          // Discovery failing is worth saying once; it must not be silent, and
          // it must not be fatal.
          sctx.logger.warn(`skill catalog unavailable: ${String((error as Error | undefined)?.message ?? error)}`)
        },
      }, control)
      onPythonChanged.add(provider.invalidate)
      return provider
    }), 'dsh-biomni: skill provider')
    sctx.effect(() => () => { onPythonChanged.clear() })
  })

  // Mounted from a child fiber so a deployment without a web server (headless)
  // keeps the interpreter and simply has no Settings section.
  ctx.inject(['webServer', 'webRuntime'], (wctx) => {
    // The same Host-header trust fence the /api gateway applies, read per
    // request from the live service value so it tracks the same trust source.
    const fence = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
      isTrustedApiRequest(req, wctx.webRuntime.trustedHosts)

    wctx.effect(() => wctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        if (!fence(req)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith(`${API_PREFIX}/`)
          ? pathname.slice(API_PREFIX.length + 1)
          : undefined
        if (method === undefined || method.includes('/')) {
          writeError(res, new BiomniError('not-found', 'unknown biomni API method', 404))
          return
        }
        try {
          const payload = await readJsonBody(req)
          const handler = api[method]
          if (handler === undefined) {
            throw new BiomniError('not-found', `unknown biomni API method "${method}"`, 404)
          }
          writeOk(res, await handler(payload))
        } catch (error) {
          writeError(res, error)
        }
      },
    }), 'dsh-biomni: /biomni/api routes')
  })
}
