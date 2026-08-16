/**
 * The Biomni-specific lane: what the probe reports against an interpreter that
 * actually has the library, and whether the tool library is reachable from the
 * persistent interpreter.
 *
 * SKIPPED unless `DSH_BIOMNI_PYTHON` points at an interpreter with Biomni
 * installed, so the default `pnpm test` works on a bare interpreter. Run it
 * with:
 *
 *     DSH_BIOMNI_PYTHON=/abs/path/.venv/bin/python pnpm run test:biomni
 */
import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index.ts'
import type { BiomniConfig } from '../src/config.ts'
import { probeEnvironment } from '../src/probe.ts'
import { stubContext, stubOwner } from './stubs.ts'

const PYTHON = process.env.DSH_BIOMNI_PYTHON

/** Whether the configured interpreter can import biomni at all. */
function hasBiomni(): boolean {
  if (PYTHON === undefined) return false
  try {
    execFileSync(PYTHON, ['-c', 'import biomni'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const available = hasBiomni()

const { ctx, rec } = stubContext()
if (available) apply(ctx, new Config({ python: PYTHON }) as unknown as BiomniConfig)

afterAll(async () => {
  await Promise.all(rec.disposers.map(dispose => dispose()))
})

describe.skipIf(!available)('against a real Biomni interpreter', () => {
  it('reports the installed version and the module inventory', async () => {
    const report = await probeEnvironment(ctx, PYTHON!)
    expect(report.biomni).not.toBeNull()
    expect(report.modules.length).toBeGreaterThan(0)
    expect(report.totalFunctions).toBeGreaterThan(0)
  })

  it('distinguishes importable from callable', async () => {
    const report = await probeEnvironment(ctx, PYTHON!)
    // The whole point of the two-gate probe: a module that imports cleanly can
    // still have functions that raise on call. These are separate counts, and
    // conflating them is the bug this asserts against.
    const importable = report.modules.filter(module => module.importable).length
    expect(importable).toBeLessThanOrEqual(report.modules.length)
    expect(report.blockedFunctions).toBeLessThanOrEqual(report.totalFunctions)
  })

  it('flags the two packages that gate every module at once', async () => {
    const report = await probeEnvironment(ctx, PYTHON!)
    // biomni.tool.__init__ imports biomni.utils, so tqdm and pandas gate all
    // 21 modules — and the import error names neither.
    expect(report.gate).toBeDefined()
    expect(report.gate).toEqual([])
  })

  it('reaches the tool library from the persistent interpreter', async () => {
    const tool = rec.tools[0]!
    const owner = stubOwner(rec)
    const result = await tool.execute(
      { code: 'from biomni.tool import literature\nlen([n for n in dir(literature) if not n.startswith("_")])' },
      { agent: owner, signal: new AbortController().signal } as never,
    ) as string
    expect(Number(result)).toBeGreaterThan(0)
  })
})
