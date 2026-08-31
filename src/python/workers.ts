/**
 * Owner-scoped worker pool: one Python process per agent, created on first use
 * and torn down when the agent or this plugin goes away.
 *
 * The persistent namespace is the whole point — imports, dataframes, and fitted
 * models defined in one call are still bound in the next, which is the
 * execution model Biomni's agent depends on.
 */
import type {
  BiomniSandboxService,
  BiomniSandboxPolicyService,
  BiomniSubprocessService,
  Context,
  SubprocessHandle,
} from '../context-types.ts'
import { join } from 'node:path'
import { WorkerChannel } from './channel.ts'
import { OUTPUT_DIR_NAME, WORKER_PATH } from './paths.ts'

/** The subset of the resolved settings a worker needs at spawn time. */
export interface WorkerConfig {
  readonly python: string
}

/** An agent, as the pool keys on it. Its own fiber owns the worker's lifetime. */
export interface WorkerOwner {
  ctx: Pick<Context, 'effect'>
}

/** One live interpreter. */
export interface WorkerEntry {
  handle: SubprocessHandle
  channel: WorkerChannel
}

/** The services the pool needs (named so tests can supply a stub). */
export interface WorkerHost {
  effect: Context['effect']
  subprocess: BiomniSubprocessService
  sandbox: BiomniSandboxService
  sandboxPolicy: BiomniSandboxPolicyService
}

export interface WorkerPool {
  /** The owner's interpreter, started on first use. */
  get(owner: WorkerOwner): Promise<WorkerEntry>
  /** Retire one owner's interpreter; the next call starts an empty one. */
  reset(owner: WorkerOwner): Promise<void>
  /** Retire every interpreter, so the next call adopts changed settings. */
  resetAll(): Promise<void>
}

export function pythonWorkers(ctx: WorkerHost, config: WorkerConfig): WorkerPool {
  const pending = new WeakMap<WorkerOwner, Promise<WorkerEntry>>()
  const live = new Map<WorkerOwner, WorkerEntry>()
  const lifecycle = new AbortController()

  const close = async (owner: WorkerOwner): Promise<void> => {
    const entry = live.get(owner)
    if (entry === undefined) return
    live.delete(owner)
    entry.handle.terminate()
    await entry.handle.waitForExit()
  }

  ctx.effect(() => async () => {
    lifecycle.abort(new Error('dsh-biomni disposed during worker startup'))
    await Promise.all([...live.keys()].map(owner => close(owner)))
  })

  const spawn = async (owner: WorkerOwner): Promise<WorkerEntry> => {
    // The policy is resolved once, when this agent's worker starts. A worker
    // already running keeps the confinement it was born with; a mode change
    // takes effect on the next reset.
    const policy = ctx.sandboxPolicy.resolve()
    // Under the workspace root, so results land where the user already looks
    // rather than in a plugin-private directory they have to be told about.
    // Passed to the worker rather than agreed by convention: two places
    // computing the same path is how they come to disagree.
    const outDir = join(policy.workspaceRoot, OUTPUT_DIR_NAME)
    const base = [config.python, '-u', WORKER_PATH, outDir]
    const argv = policy.mode === 'danger-full-access'
      ? base
      : ctx.sandbox.confine(base, { mode: policy.mode, workspaceRoot: policy.workspaceRoot }).argv

    const handle = ctx.subprocess.spawn({
      argv,
      cwd: policy.workspaceRoot,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        // The worker never writes diagnostics itself; anything here is the
        // interpreter failing to start, which is worth a bounded tail.
        stderr: { maxBytes: 8_192 },
      },
      graceMs: 5_000,
      signal: lifecycle.signal,
      env: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    })

    const entry: WorkerEntry = { handle, channel: new WorkerChannel(handle) }
    live.set(owner, entry)
    // An agent that ends takes its interpreter with it.
    owner.ctx.effect(() => () => { void close(owner) })
    return entry
  }

  return {
    async get(owner) {
      const existing = live.get(owner)
      if (existing !== undefined) return existing
      let starting = pending.get(owner)
      if (starting === undefined) {
        starting = spawn(owner).finally(() => { pending.delete(owner) })
        pending.set(owner, starting)
      }
      return starting
    },
    reset: close,
    async resetAll() {
      await Promise.all([...live.keys()].map(owner => close(owner)))
    },
  }
}
