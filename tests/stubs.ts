/**
 * Stub cordis context for the host half.
 *
 * The stubs are deliberately shaped from the real seams' TYPES rather than from
 * what makes a test pass. An earlier version of this suite invented an async
 * `read()` on the collected-output reader; it passed here and then failed
 * against real dsh, because the seam's reader is a synchronous
 * `readFrom(offset)`. Every shape below is copied from the service face it
 * mirrors (src/context-types.ts).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { apply } from '../src/index.ts'
import type { BiomniConfig } from '../src/config.ts'
import type { ToolDefinition, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type {
  BiomniHttpRequest,
  BiomniHttpResponse,
  BiomniWebRoute,
  CommandInvocation,
  CommandResult,
  Context,
  SpawnOptions,
} from '../src/context-types.ts'
import type { BiomniPrefs } from '../src/prefs-shared.ts'

/** Everything the stub context recorded, for assertions. */
export interface Recorder {
  tools: ToolDefinition[]
  guards: ToolGuard[]
  commands: Array<{
    name: string
    description: string
    handler: (invocation: CommandInvocation) => Promise<CommandResult> | CommandResult
  }>
  routes: BiomniWebRoute[]
  sections: Array<{ name: string; order: number; text: string }>
  /** Skill providers registered, paired with the control each received. */
  skillProviders: Array<{ provider: SkillProvider; control: SkillProviderControl }>
  disposers: Array<() => void | Promise<void>>
  /** The mutable user layer over the composition base. */
  userLayer: Partial<BiomniPrefs>
  /** Listeners registered through `ctx.on`, keyed by event name. */
  listeners: Map<string, Array<(...args: never[]) => void>>
  /**
   * The config object the plugin was applied with.
   *
   * DSH 0.2 delivers live values as volatile references ON THE CONFIG, so a
   * commit is the Loader writing through those references — not a separate
   * user-layer document the plugin re-reads. {@link Recorder.setUser} does the
   * same thing, which is why it needs this.
   */
  config: Record<string, unknown> | null
  /** The settings document revision, bumped by every accepted update. */
  revision: number
  /** When set, `settings.update` rejects with this message. */
  updateRejection: string | null
  /** How many times a registered provider's control was invalidated. */
  invalidations: number
  /**
   * Write one live field and emit `settings/document-updated`, as a real
   * commit does. DSH 0.2 has no watcher callback: the event carries only the
   * entry id and a revision, and a listener that wants to know WHAT changed
   * re-reads. Faking a richer event here would let a plugin pass the tests
   * while relying on data the host never sends.
   */
  setUser(patch: Partial<BiomniPrefs>): void
}

/** Minimal `ctx.subprocess` over node:child_process. */
function stubSubprocess() {
  return {
    spawn(spec: SpawnOptions) {
      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      // Collect-mode readers, needed by the probe path; the worker path uses
      // the raw streams instead.
      const buffers: Record<string, string> = { stdout: '', stderr: '' }
      for (const stream of ['stdout', 'stderr'] as const) {
        if (spec.stdio[stream] !== 'pipe') child[stream]?.on('data', (c: Buffer) => { buffers[stream] += String(c) })
      }
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        // Mirrors the real SubprocessOutputReader: a SYNCHRONOUS
        // `readFrom(offset)` returning { text, nextOffset, lossy }.
        collected: {
          stdout: { readFrom: (from: number) => ({ text: (buffers.stdout ?? '').slice(from), nextOffset: (buffers.stdout ?? '').length, lossy: false }) },
          stderr: { readFrom: (from: number) => ({ text: (buffers.stderr ?? '').slice(from), nextOffset: (buffers.stderr ?? '').length, lossy: false }) },
        },
        done: new Promise<{ exitCode: number }>(resolve =>
          child.on('close', exitCode => { resolve({ exitCode: exitCode ?? 0 }) })),
        terminate: () => { child.kill('SIGTERM') },
        waitForExit: async () => {
          if (child.exitCode !== null) return { exitCode: child.exitCode }
          await new Promise(resolve => child.on('close', resolve))
          return { exitCode: child.exitCode ?? 0 }
        },
      }
    },
  }
}

/**
 * Build a stub context plus the recorder that observes it.
 * @param options.withoutWeb - drop the webServer/webRuntime services, as a
 * headless profile does, so the child fiber never activates.
 * @param options.withoutSkills - drop the skills service, so the skill
 * provider's child fiber never activates.
 */
/** The workspace every stub context reports, created once per test process. */
export const workspaceRoot = mkdtempSync(join(tmpdir(), 'dsh-biomni-ws-'))

/** ctx → its recorder, so `applyWithConfig` can find it. */
const RECORDERS = new WeakMap<object, Recorder>()

export function stubContext(
  options: { withoutWeb?: boolean; withoutSkills?: boolean } = {},
): { ctx: Context; rec: Recorder } {
  const rec: Recorder = {
    tools: [],
    guards: [],
    commands: [],
    routes: [],
    sections: [],
    skillProviders: [],
    disposers: [],
    userLayer: {},
    listeners: new Map(),
    config: null,
    revision: 1,
    updateRejection: null,
    invalidations: 0,
    setUser(patch) {
      Object.assign(rec.userLayer, patch)
      rec.revision += 1
      // Move the volatile references, as the Loader does on an accepted write.
      // Writing `rec.userLayer` alone would leave the plugin reading the old
      // value while `describe()` reported the new one — a split the real host
      // cannot produce, and a stub that allowed it would hide a real bug.
      const config = rec.config
      if (config !== null) {
        for (const [key, value] of Object.entries(patch)) {
          const ref = config[key]
          if (isVolatile(ref)) updateVolatile(ref, createVolatile(value))
        }
      }
      for (const listener of rec.listeners.get('settings/document-updated') ?? []) {
        ;(listener as (ns: string, revision: number) => void)('biomni', rec.revision)
      }
    },
  }

  /**
 * The resolved form values the host would report from `describe()`.
 *
 * Read back out of the config's volatile references rather than recomputed:
 * those ARE the resolved value (schema defaults → composition base → user
 * layer, merged by the Loader), and they are what the plugin itself reads. A
 * stub that kept its own parallel copy could report one value while the
 * plugin used another — a split the real host cannot produce, and the kind of
 * fiction AGENTS.md §8 is about.
 */
  const resolved = (): BiomniPrefs => {
    const config = rec.config
    if (config === null) return { ...rec.userLayer } as BiomniPrefs
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(config)) {
      if (isVolatile(value)) out[key] = value.get()
    }
    return out as unknown as BiomniPrefs
  }

  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => { rec.tools.push(definition); return () => {} },
      guard: (guard: ToolGuard) => { rec.guards.push(guard); return () => {} },
    },
    settings: {
      // Mirrors the real `SettingsForms` (DSH 0.2): no `register`, no scope.
      // The plugin's own Config is the form, and `ns` is the profile entry id.
      describe: () => [{
        ns: 'biomni',
        value: resolved(),
        applies: 'live' as const,
        revision: rec.revision,
      }],
      writable: true,
      update: async (_ns: string, patch: object, expectedRevision?: number) => {
        if (rec.updateRejection !== null) throw new Error(rec.updateRejection)
        if (expectedRevision !== undefined && expectedRevision !== rec.revision) {
          throw new Error(`settings revision conflict: expected ${expectedRevision}, have ${rec.revision}`)
        }
        rec.setUser(patch as Partial<BiomniPrefs>)
      },
    },
    commands: {
      register: (definition: Recorder['commands'][number]) => { rec.commands.push(definition); return () => {} },
    },
    subprocess: stubSubprocess(),
    // danger-full-access short-circuits confinement, keeping this suite off the
    // host's sandbox backend; confinement itself is covered by booting dsh.
    sandbox: { confine: (argv: string[]) => ({ argv }) },
    // A throwaway workspace, so the kernel's output directory lands in a temp
    // tree rather than writing biomni-out/ into the repo during a test run.
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' as const, workspaceRoot }) },
    systemPrompt: {
      section: (section: { name: string; order: number; text: string }) => {
        rec.sections.push(section)
        return () => {}
      },
    },
    logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    ...(options.withoutSkills === true ? {} : {
      skills: {
        registerProvider: (create: (control: SkillProviderControl) => SkillProvider) => {
          const control: SkillProviderControl = {
            signal: new AbortController().signal,
            invalidate: () => { rec.invalidations += 1 },
          }
          rec.skillProviders.push({ provider: create(control), control })
          return () => {}
        },
      },
    }),
    ...(options.withoutWeb === true ? {} : {
      webServer: {
        register: (route: BiomniWebRoute) => { rec.routes.push(route); return () => {} },
      },
      webRuntime: { trustedHosts: [] as readonly string[] },
    }),
    /**
     * Event subscription (DSH 0.2 replaced `SettingsScope.watch` with
     * `settings/document-updated`). Returns a disposer, as cordis does.
     */
    on: (event: string, listener: (...args: never[]) => void) => {
      const list = rec.listeners.get(event) ?? []
      list.push(listener)
      rec.listeners.set(event, list)
      return () => {
        const current = rec.listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    effect: (factory: () => unknown) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') rec.disposers.push(cleanup as () => void)
    },
    // Cordis activates the child fiber only once every named service exists.
    // With `withoutWeb`, the web services are absent and the callback never
    // runs — which is exactly what a headless profile does.
    inject: (services: string[], callback: (child: Context) => void) => {
      if (services.every(service => (ctx as unknown as Record<string, unknown>)[service] !== undefined)) {
        callback(ctx)
      }
    },
  } as unknown as Context

  RECORDERS.set(ctx, rec)
  return { ctx, rec }
}

/** An agent owner, as the worker pool keys on it. */
/**
 * Mount the plugin the way the Loader does: hand it its config, and let the
 * recorder keep the volatile references so a later {@link Recorder.setUser}
 * moves the same ones the plugin is reading.
 *
 * Tests call this instead of `apply` directly. Calling `apply` yourself still
 * works, but a `setUser` afterwards then updates only the reported document
 * and not the plugin's live values — a split the real host cannot produce.
 */
export function applyWithConfig(
  ctx: Context,
  config: BiomniConfig,
): void {
  const rec = RECORDERS.get(ctx)
  if (rec !== undefined) rec.config = config as unknown as Record<string, unknown>
  apply(ctx, config)
}

export function stubOwner(rec: Recorder): { ctx: { effect: Context['effect'] } } {
  return {
    ctx: {
      effect: ((factory: () => unknown) => {
        const cleanup = factory()
        if (typeof cleanup === 'function') rec.disposers.push(cleanup as () => void)
      }) as Context['effect'],
    },
  }
}

/** A fake HTTP request for the route handler. */
export function fakeRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = { host: '127.0.0.1:3080' },
): BiomniHttpRequest {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    url,
    method: 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  } as BiomniHttpRequest
}

/** A capturing HTTP response. */
export function fakeResponse(): BiomniHttpResponse & { status: number; body: unknown } {
  const res = {
    statusCode: 200,
    status: 0,
    body: undefined as unknown,
    writeHead(status: number) { res.status = status },
    end(payload?: string | Uint8Array) {
      res.body = typeof payload === 'string' ? JSON.parse(payload) : payload
    },
  }
  return res
}
