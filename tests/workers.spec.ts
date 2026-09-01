/**
 * Interpreter lifetime: what keeps a Python process alive, what ends it, and
 * what the model is told when one ends without being asked.
 *
 * The pool is driven directly here rather than through the plugin, because the
 * behaviour under test is measured in milliseconds and the prefs layer clamps
 * the idle timeout to a five-minute floor — correctly, for a person setting it.
 * That clamp is covered in prefs.spec.ts.
 *
 * Needs only a bare `python3`.
 */
import { describe, expect, it } from 'vitest'
import { pythonWorkers, type WorkerHost, type WorkerOwner, type WorkerPool } from '../src/python/workers.ts'
import { retirementNotice, runPythonTool } from '../src/python/tool.ts'
import { stubContext, stubOwner } from './stubs.ts'

const PYTHON = process.env.DSH_BIOMNI_PYTHON ?? 'python3'

/** A pool with a live idle timeout the test can change between calls. */
function poolWith(idleTimeoutMs: number) {
  const { ctx, rec } = stubContext()
  const config = { python: PYTHON, idleTimeoutMs }
  const pool = pythonWorkers(ctx as unknown as WorkerHost, config)
  const owner = stubOwner(rec) as WorkerOwner
  return { pool, owner, rec, config }
}

/** Poll until `predicate` holds; the pool retires on a timer, not on a call. */
async function until(predicate: () => boolean, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('the idle timeout', () => {
  it('retires an interpreter that goes unused, and reports it on the next call', async () => {
    const { pool, owner, rec } = poolWith(150)
    const first = await pool.get(owner)
    await first.channel.request('x = 1', AbortSignal.timeout(10_000))
    expect(pool.liveCount()).toBe(1)

    // Nothing calls it; the timer, not a later call, is what ends it.
    await until(() => pool.liveCount() === 0)

    const second = await pool.get(owner)
    expect(second.retiredBecause).toMatchObject({ reason: 'idle' })
    // A fresh process: the namespace really is empty, which is the reason the
    // notice has to exist at all.
    const frame = await second.channel.request('print("x" in dir())', AbortSignal.timeout(10_000))
    expect(frame.output).toContain('False')

    // And the debt is paid once — a second call must not re-announce it.
    const third = await pool.get(owner)
    expect(third.retiredBecause).toBeUndefined()
    await Promise.all(rec.disposers.map(dispose => dispose()))
  })

  it('keeps an interpreter alive while it is being used', async () => {
    // The clock restarts on each call, so a session working steadily is never
    // interrupted however long it runs.
    const { pool, owner, rec } = poolWith(400)
    await pool.get(owner)
    for (let round = 0; round < 5; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 120))
      const entry = await pool.get(owner)
      expect(entry.retiredBecause).toBeUndefined()
      await entry.channel.request(`n = ${round}`, AbortSignal.timeout(10_000))
      pool.touch(owner)
    }
    // Total elapsed is well past 400ms, and the namespace survived all of it.
    const frame = await (await pool.get(owner)).channel.request('print(n)', AbortSignal.timeout(10_000))
    expect(frame.output.trim()).toBe('4')
    await Promise.all(rec.disposers.map(dispose => dispose()))
  })

  it('never retires when the timeout is zero', async () => {
    const { pool, owner, rec } = poolWith(0)
    await pool.get(owner)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(pool.liveCount()).toBe(1)
    expect((await pool.get(owner)).retiredBecause).toBeUndefined()
    await Promise.all(rec.disposers.map(dispose => dispose()))
  })

  it('follows a changed setting without a restart', async () => {
    // The pool reads the timeout per arm, so an operator lowering it in
    // Settings does not need every session to cycle first.
    const { pool, owner, rec, config } = poolWith(0)
    await pool.get(owner)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(pool.liveCount()).toBe(1)

    ;(config as { idleTimeoutMs: number }).idleTimeoutMs = 100
    pool.touch(owner)
    await until(() => pool.liveCount() === 0)
    await Promise.all(rec.disposers.map(dispose => dispose()))
  })
})

describe('an interpreter retired for a changed setting', () => {
  it('is reported as such, not as an idle retirement', async () => {
    // Same empty namespace, different cause — and the model can only act on
    // the difference if it is told which one happened.
    const { pool, owner, rec } = poolWith(0)
    await pool.get(owner)
    await pool.resetAll('settings')
    expect(pool.liveCount()).toBe(0)
    expect((await pool.get(owner)).retiredBecause).toMatchObject({ reason: 'settings' })
    await Promise.all(rec.disposers.map(dispose => dispose()))
  })

  it('leaves no debt when the reset was requested', async () => {
    // The tool's own reset path (a timeout, a crash) already tells the model.
    // A second notice on top of that one is noise.
    const { pool, owner, rec } = poolWith(0)
    await pool.get(owner)
    await pool.reset(owner)
    expect((await pool.get(owner)).retiredBecause).toBeUndefined()
    await Promise.all(rec.disposers.map(dispose => dispose()))
  })
})

describe('retirementNotice', () => {
  it('names the cause, the empty namespace, and what to do', async () => {
    const text = retirementNotice({ reason: 'idle', idleMs: 31 * 60_000 })
    expect(text).toContain('31 minutes')
    expect(text).toContain('empty namespace')
    expect(text).toMatch(/re-run/i)
  })

  it('rounds up rather than saying zero minutes', () => {
    // "idle for 0 minutes and retired" reads as a bug in the plugin.
    expect(retirementNotice({ reason: 'idle', idleMs: 900 })).toContain('1 minute')
  })

  it('says the interpreter changed when that is what happened', () => {
    const text = retirementNotice({ reason: 'settings', idleMs: 0 })
    expect(text).toContain('interpreter changed')
    expect(text).not.toContain('idle')
  })
})

describe('the notice reaching the model', () => {
  /** A pool that hands out one retired-for-idle entry, then clean ones. */
  function poolStub(): { pool: WorkerPool; calls: number } {
    const state = { calls: 0 }
    const channel = {
      request: async () => ({
        ok: true, output: 'hello\n', value: null, error: null,
        truncated: false, outputChars: 6, artifacts: [], artifactCount: 0,
      }),
    }
    const pool = {
      get: async () => {
        state.calls += 1
        return {
          handle: {} as never,
          channel: channel as never,
          ...(state.calls === 1 ? { retiredBecause: { reason: 'idle' as const, idleMs: 1_800_000 } } : {}),
        }
      },
      touch: () => {},
      reset: async () => {},
      resetAll: async () => {},
      liveCount: () => 1,
    }
    return { pool: pool as unknown as WorkerPool, calls: state.calls }
  }

  it('leads the first result after a retirement, then stops', async () => {
    // Leading, not trailing: the model reads the output and acts on it, and a
    // caveat below a successful-looking result is a caveat that gets skipped.
    const { pool } = poolStub()
    const tool = runPythonTool(pool, { timeoutMs: 10_000 }, 'run python')
    const owner = {} as WorkerOwner
    const exec = { agent: owner, signal: new AbortController().signal } as never

    const first = await tool.execute({ code: 'print("hello")' }, exec) as string
    expect(first.startsWith('Note:')).toBe(true)
    expect(first).toContain('30 minutes')
    expect(first).toContain('hello')

    const second = await tool.execute({ code: 'print("hello")' }, exec) as string
    expect(second).not.toContain('Note:')
    expect(second).toContain('hello')
  })
})
