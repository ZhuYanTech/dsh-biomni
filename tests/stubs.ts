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
  /** Settings watchers, invoked by {@link Recorder.setUser}. */
  watchers: Array<(next: BiomniPrefs, prev: BiomniPrefs) => void | Promise<void>>
  /** The settings document revision, bumped by every accepted update. */
  revision: number
  /** When set, `settings.update` rejects with this message. */
  updateRejection: string | null
  /** How many times a registered provider's control was invalidated. */
  invalidations: number
  /** Write one user-layer field and fire the watchers, as a real commit would. */
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
    watchers: [],
    revision: 1,
    updateRejection: null,
    invalidations: 0,
    setUser(patch) {
      const prev = resolved()
      Object.assign(rec.userLayer, patch)
      rec.revision += 1
      const next = resolved()
      for (const watcher of rec.watchers) void watcher(next, prev)
    },
  }

  let base: Partial<BiomniPrefs> = {}
  const resolved = (): BiomniPrefs => ({ ...base, ...rec.userLayer } as BiomniPrefs)

  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => { rec.tools.push(definition); return () => {} },
      guard: (guard: ToolGuard) => { rec.guards.push(guard); return () => {} },
    },
    settings: {
      register: (_ns: string, _schema: unknown, options?: { base?: Partial<BiomniPrefs> }) => {
        base = options?.base ?? {}
        return {
          get: resolved,
          watch: (fn: (next: BiomniPrefs, prev: BiomniPrefs) => void) => {
            rec.watchers.push(fn)
            return () => {}
          },
          update: async () => {},
          replace: async () => {},
        }
      },
      describe: () => [{
        ns: 'biomni',
        value: resolved(),
        applies: 'live' as const,
        revision: rec.revision,
      }],
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

  return { ctx, rec }
}

/** An agent owner, as the worker pool keys on it. */
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
