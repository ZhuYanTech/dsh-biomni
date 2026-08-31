/**
 * dsh-biomni host half.
 *
 * Registers one model-facing tool, `run_python`, backed by a single Python
 * process per agent session. Imports, dataframes, and fitted models defined in
 * one call are still there in the next, so the agent builds up state in small
 * steps instead of re-running one large script — the execution model Biomni's
 * agent depends on, reproduced as a dsh plugin rather than as a fork.
 *
 * Around that kernel, three generated skill catalogs — the tool modules, the
 * data lake, and the installed bioinformatics software — each advertising only
 * what this machine can actually deliver, and:
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
import { join } from 'node:path'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { BiomniHttpResponse, Context } from './context-types.ts'
import { BIOMNI_PREFS_NS, Config, PrefsSchema, prefsBaseOf, type BiomniConfig } from './config.ts'
import type { BiomniPrefs } from './prefs-shared.ts'
import { buildApi, type BiomniSettingsFace } from './api.ts'
import { shellPythonGuard } from './guard.ts'
import {
  contentTypeOf,
  listArtifacts,
  MAX_DOWNLOAD_BYTES,
  readArtifact,
  renderArtifacts,
  resolveArtifact,
} from './artifacts.ts'
import { fetchDatasets, listDatasets, renderDatasets } from './datasets.ts'
import { probeEnvironment, renderReport } from './probe.ts'
import { OUTPUT_DIR_NAME } from './python/paths.ts'
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

/** The one GET under that prefix: `?name=` downloads an artifact. */
const ARTIFACT_DOWNLOAD = 'artifacts.get'

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
    get dataPath() { return scope.get().dataPath },
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

  // Things that must react to a changed environment. A running worker keeps the
  // executable it was started with, and a catalog generated against a different
  // interpreter or data root is not stale but wrong, so both are retired.
  //
  // The two settings differ in blast radius: `python` changes what the worker
  // IS, so live interpreters go too; `dataPath` only changes which datasets the
  // catalog can see, and retiring a session's namespace over it would throw
  // away the user's work for nothing.
  const onCatalogChanged = new Set<() => void>()
  let currentPython = live.python
  let currentDataPath = live.dataPath
  scope.watch((next) => {
    const pythonChanged = next.python !== currentPython
    const dataPathChanged = next.dataPath !== currentDataPath
    if (!pythonChanged && !dataPathChanged) return
    currentPython = next.python
    currentDataPath = next.dataPath
    if (pythonChanged) void workers.resetAll()
    for (const react of onCatalogChanged) react()
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

  ctx.effect(() => ctx.tools.guard(shellPythonGuard(() => live.guardShellPython, () => live.python)))
  ctx.effect(() => ctx.tools.register(runPythonTool(workers, live, config.description)))

  // ── The /biomni command ──────────────────────────────────────────────────
  ctx.effect(() => ctx.commands.register({
    name: 'biomni',
    description: 'report what this session\'s Python interpreter can actually do',
    recordInput: false,
    handler: async (invocation) => {
      try {
        const report = await probeEnvironment(ctx, live.python, live.dataPath, invocation.signal)
        return { kind: 'success', text: renderReport(report, live) }
      } catch (cause) {
        return {
          kind: 'error',
          text: `Could not probe ${live.python}: ${String((cause as Error | undefined)?.message ?? cause)}`,
        }
      }
    },
  }))

  // A read-only listing, deliberately separate from `/biomni`: the environment
  // report answers "can this machine run the tools", and this answers "what
  // data is here and what would more cost". Fetching is not a slash command —
  // it is an operator action with a licence decision and up to 6 GB attached,
  // and it belongs on a surface that can present both.
  ctx.effect(() => ctx.commands.register({
    name: 'biomni-datasets',
    description: 'list Biomni\'s data lake: what is on disk, what is available, and what each costs',
    recordInput: false,
    handler: async (invocation) => {
      try {
        return { kind: 'success', text: renderDatasets(await listDatasets(datasetRunner(invocation.signal))) }
      } catch (cause) {
        return {
          kind: 'error',
          text: `Could not read the dataset catalog: ${String((cause as Error | undefined)?.message ?? cause)}`,
        }
      }
    },
  }))

  // The third read-only command. `/biomni` answers "can this machine run the
  // tools", `/biomni-datasets` "what data is here", and this one "what has the
  // work produced" — which before 0.2.0 had no answer at all.
  ctx.effect(() => ctx.commands.register({
    name: 'biomni-out',
    description: 'list what the interpreter has written to this session\'s output directory',
    recordInput: false,
    handler: async () => {
      try {
        return { kind: 'success', text: renderArtifacts(await listArtifacts(outputRoot())) }
      } catch (cause) {
        return {
          kind: 'error',
          text: `Could not read the output directory: ${String((cause as Error | undefined)?.message ?? cause)}`,
        }
      }
    },
  }))

  // ── The fenced JSON API ──────────────────────────────────────────────────
  // Where the interpreter writes results. Resolved from the same sandbox policy
  // the worker is spawned under, so the directory the plugin lists is the one
  // the worker was handed.
  const outputRoot = (): string => join(ctx.sandboxPolicy.resolve().workspaceRoot, OUTPUT_DIR_NAME)

  /**
   * Serve one artifact for download.
   *
   * Every failure is a 404 rather than a distinguishing error: the name comes
   * off the wire, and telling a caller apart "not there" from "outside the
   * root" would turn this into a probe for the surrounding filesystem.
   */
  const serveArtifact = async (name: string, res: BiomniHttpResponse): Promise<void> => {
    const path = await resolveArtifact(outputRoot(), name)
    if (path === undefined) {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'no such artifact' } })
      return
    }
    const result = await readArtifact(path)
    if ('tooLarge' in result) {
      writeJson(res, 413, {
        ok: false,
        error: {
          code: 'too-large',
          message: `${name} is ${result.tooLarge} bytes, over the ${MAX_DOWNLOAD_BYTES} download limit; `
            + `open it directly at ${path}`,
        },
      })
      return
    }
    res.writeHead(200, {
      'content-type': contentTypeOf(name),
      'content-length': String(result.body.byteLength),
      // Always an attachment. These are model-written files served from the
      // harness's own origin, and rendering one in place would make writing a
      // file a way to run script there.
      'content-disposition': `attachment; filename="${name.split('/').pop() ?? 'artifact'}"`,
      'x-content-type-options': 'nosniff',
    })
    res.end(result.body)
  }

  /** What both the dataset catalog and the fetcher need, read live. */
  const datasetRunner = (signal?: AbortSignal) => ({
    ctx,
    python: live.python,
    dataPath: live.dataPath,
    ...(signal === undefined ? {} : { signal }),
  })

  const api = buildApi({
    settings: () => settingsFace,
    python: () => live.python,
    probe: python => probeEnvironment(ctx, python, live.dataPath),
    datasets: () => listDatasets(datasetRunner()),
    fetch: (names, acceptNonCommercial) => fetchDatasets(datasetRunner(), names, acceptNonCommercial),
    artifacts: () => listArtifacts(outputRoot()),
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
        dataPath: () => live.dataPath,
        onError: (error) => {
          // Discovery failing is worth saying once; it must not be silent, and
          // it must not be fatal.
          sctx.logger.warn(`skill catalog unavailable: ${String((error as Error | undefined)?.message ?? error)}`)
        },
      }, control)
      onCatalogChanged.add(provider.invalidate)
      return provider
    }), 'dsh-biomni: skill provider')
    sctx.effect(() => () => { onCatalogChanged.clear() })
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
        const url = new URL(req.url ?? '/', 'http://dsh.internal')

        // The one GET on this prefix. A download is a browser navigation, so
        // it cannot be a POST like every other method here; it is kept to a
        // single named path rather than making the whole prefix method-open.
        if (url.pathname === `${API_PREFIX}/${ARTIFACT_DOWNLOAD}`) {
          if (req.method !== 'GET') {
            writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
            return
          }
          await serveArtifact(url.searchParams.get('name') ?? '', res)
          return
        }

        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = url.pathname
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
