/**
 * Owner-scoped worker pool: one Python process per agent, created on first use
 * and torn down when the agent or this plugin goes away.
 *
 * The persistent namespace is the whole point — imports, dataframes, and fitted
 * models defined in one call are still bound in the next, which is the
 * execution model Biomni's agent depends on.
 *
 * That namespace is also what an interpreter costs to keep. Measured on a
 * worker with the usual stack imported (numpy, pandas, scipy, matplotlib,
 * scikit-learn): **298 MB resident against 74 MB bare**, held for as long as
 * the agent exists — which for a session left open overnight is all night. So
 * an interpreter that has gone unused for `idleTimeoutMs` is retired.
 *
 * Retiring one is not free, and the pool treats the cost as the important
 * part: the namespace goes with it, and a namespace that disappears silently
 * is precisely the failure mode this plugin exists to prevent — the model
 * still believes `df` is bound and reasons from a variable that no longer
 * exists. Every retirement the model did not ask for is therefore RECORDED,
 * and reported on the next call through {@link WorkerEntry.retiredBecause}.
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

/** The subset of the resolved settings the pool reads. Live: re-read per use. */
export interface WorkerConfig {
  readonly python: string
  /** Milliseconds an interpreter may sit unused before retirement; 0 = never. */
  readonly idleTimeoutMs: number
}

/**
 * Why an interpreter the model did not reset went away.
 *
 * `'idle'` — it sat unused past `idleTimeoutMs`.
 * `'settings'` — the configured interpreter changed, so the old process could
 * not be what the next call is supposed to reach.
 */
export type RetirementReason = 'idle' | 'settings'

/** One retirement, kept until the owner's next call reports it. */
export interface Retirement {
  reason: RetirementReason
  /** How long the interpreter had been unused, milliseconds. */
  idleMs: number
}

/** An agent, as the pool keys on it. Its own fiber owns the worker's lifetime. */
export interface WorkerOwner {
  ctx: Pick<Context, 'effect'>
}

/** One live interpreter. */
export interface WorkerEntry {
  handle: SubprocessHandle
  channel: WorkerChannel
  /**
   * Set on the FIRST entry handed out after an unrequested retirement, and
   * cleared by that hand-out. The caller owes the model an explanation for the
   * empty namespace it is about to find; nobody else will give one.
   */
  retiredBecause?: Retirement
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
  /**
   * Mark the owner's interpreter as used just now, restarting its idle clock.
   * Called when a snippet FINISHES: arming only at the start would retire an
   * interpreter in the middle of a long call.
   */
  touch(owner: WorkerOwner): void
  /**
   * Retire one owner's interpreter; the next call starts an empty one.
   *
   * This is the requested kind, so no retirement is recorded: the caller asked
   * for it and is already telling the model.
   */
  reset(owner: WorkerOwner): Promise<void>
  /**
   * Retire every interpreter, so the next call adopts changed settings.
   *
   * Unrequested from the model's point of view — an operator changed the
   * interpreter path mid-session — so each owner is left a `'settings'`
   * retirement to find.
   */
  resetAll(reason?: RetirementReason): Promise<void>
  /** How many interpreters are currently running. */
  liveCount(): number
}

export function pythonWorkers(ctx: WorkerHost, config: WorkerConfig): WorkerPool {
  const pending = new WeakMap<WorkerOwner, Promise<WorkerEntry>>()
  const live = new Map<WorkerOwner, WorkerEntry>()
  /** Armed idle timers, one per live interpreter. */
  const idle = new Map<WorkerOwner, { timer: ReturnType<typeof setTimeout>; since: number }>()
  /** Unrequested retirements waiting to be reported on the owner's next call. */
  const owed = new WeakMap<WorkerOwner, Retirement>()
  const lifecycle = new AbortController()

  const disarm = (owner: WorkerOwner): void => {
    const armed = idle.get(owner)
    if (armed === undefined) return
    clearTimeout(armed.timer)
    idle.delete(owner)
  }

  const close = async (owner: WorkerOwner, reason?: RetirementReason): Promise<void> => {
    const entry = live.get(owner)
    // Read the clock BEFORE disarming; disarm() drops the record it lives in.
    const since = idle.get(owner)?.since
    disarm(owner)
    if (entry === undefined) return
    live.delete(owner)
    if (reason !== undefined) {
      owed.set(owner, { reason, idleMs: since === undefined ? 0 : Date.now() - since })
    }
    entry.handle.terminate()
    await entry.handle.waitForExit()
  }

  /**
   * (Re)start an owner's idle clock. `unref` where the runtime supports it: a
   * pending idle timer must never be the reason a process stays alive.
   */
  const arm = (owner: WorkerOwner): void => {
    disarm(owner)
    const timeoutMs = config.idleTimeoutMs
    if (timeoutMs <= 0 || !live.has(owner)) return
    const since = Date.now()
    const timer = setTimeout(() => {
      idle.delete(owner)
      owed.set(owner, { reason: 'idle', idleMs: Date.now() - since })
      const entry = live.get(owner)
      if (entry === undefined) return
      live.delete(owner)
      entry.handle.terminate()
    }, timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    idle.set(owner, { timer, since })
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
    arm(owner)
    // An agent that ends takes its interpreter with it.
    owner.ctx.effect(() => () => { void close(owner) })
    return entry
  }

  /** Attach and consume any retirement the owner has not been told about. */
  const withDebt = (owner: WorkerOwner, entry: WorkerEntry): WorkerEntry => {
    const debt = owed.get(owner)
    if (debt === undefined) return entry
    owed.delete(owner)
    return { ...entry, retiredBecause: debt }
  }

  return {
    async get(owner) {
      const existing = live.get(owner)
      // A live interpreter still restarts its clock here, so a call that runs
      // for an hour is not retired the moment it began.
      if (existing !== undefined) { arm(owner); return withDebt(owner, existing) }
      let starting = pending.get(owner)
      if (starting === undefined) {
        starting = spawn(owner).finally(() => { pending.delete(owner) })
        pending.set(owner, starting)
      }
      return withDebt(owner, await starting)
    },
    touch: arm,
    reset: owner => close(owner),
    async resetAll(reason) {
      await Promise.all([...live.keys()].map(owner => close(owner, reason)))
    },
    liveCount: () => live.size,
  }
}
