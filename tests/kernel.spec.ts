/**
 * Integration test for the execution kernel: the real plugin module driven
 * through a stub context, so framing, worker lifecycle, and serialization are
 * exercised without booting a harness or needing model credentials.
 *
 * Needs only a bare `python3` — no Biomni. The Biomni-specific assertions live
 * in biomni.spec.ts, which skips when the interpreter has no Biomni.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import type { BiomniConfig } from '../src/config.ts'
import { stubContext, stubOwner } from './stubs.ts'

const PYTHON = process.env.DSH_BIOMNI_PYTHON ?? 'python3'

const { ctx, rec } = stubContext()
apply(ctx, new Config({ python: PYTHON }) as unknown as BiomniConfig)

const owner = stubOwner(rec)
const tool = rec.tools[0]!
const run = (code: string): Promise<string> =>
  tool.execute({ code }, { agent: owner, signal: new AbortController().signal } as never) as Promise<string>

afterAll(async () => {
  await Promise.all(rec.disposers.map(dispose => dispose()))
})

describe('plugin shape', () => {
  it('identifies itself and declares only the interpreter\'s services', () => {
    expect(name).toBe('dsh-biomni')
    expect(inject).toEqual([
      'tools',
      'subprocess',
      'sandbox',
      'sandboxPolicy',
      'systemPrompt',
      'settings',
      'commands',
    ])
    // The web services belong to a child fiber; see the headless case below.
    expect(inject).not.toContain('webServer')
  })

  it('registers exactly one model-facing tool', () => {
    expect(rec.tools).toHaveLength(1)
    expect(tool.name).toBe('run_python')
  })

  it('contributes the environment section in the tool-guidance order band', () => {
    const section = rec.sections.find(candidate => candidate.name === 'biomni:python-environment')
    expect(section).toBeDefined()
    // 100-199 is the convention for tool guidance, after the deployment persona.
    expect(section!.order).toBeGreaterThanOrEqual(100)
    expect(section!.order).toBeLessThan(200)
  })

  it('mounts the fenced API route', () => {
    const route = rec.routes.find(candidate => candidate.path === '/biomni/api')
    expect(route).toBeDefined()
    expect(route!.kind).toBe('prefix')
  })

  it('registers the skill provider', () => {
    expect(rec.skillProviders).toHaveLength(1)
    expect(rec.skillProviders[0]!.provider.name).toBe('dsh-biomni')
  })

  it('invalidates the skill catalog when the interpreter changes', async () => {
    // A catalog built from another interpreter describes functions this session
    // cannot call. Its own context: changing the interpreter is a destructive
    // edit, and the shared one above is still serving the live-interpreter
    // tests.
    const isolated = stubContext()
    apply(isolated.ctx, new Config({ python: PYTHON }) as unknown as BiomniConfig)
    expect(isolated.rec.invalidations).toBe(0)
    isolated.rec.setUser({ python: '/some/other/venv/bin/python' })
    expect(isolated.rec.invalidations).toBe(1)
    // Same value again is not a change, so it must not churn the catalog.
    isolated.rec.setUser({ python: '/some/other/venv/bin/python' })
    expect(isolated.rec.invalidations).toBe(1)
    await Promise.all(isolated.rec.disposers.map(dispose => dispose()))
  })

  it('keeps the interpreter when the deployment has no skills service', async () => {
    const bare = stubContext({ withoutSkills: true })
    apply(bare.ctx, new Config({ python: PYTHON }) as unknown as BiomniConfig)
    expect(bare.rec.tools).toHaveLength(1)
    expect(bare.rec.skillProviders).toHaveLength(0)
    await Promise.all(bare.rec.disposers.map(dispose => dispose()))
  })

  it('keeps the interpreter under a headless profile that has no web server', async () => {
    // The routes carry the Settings section only. A deployment running
    // @deepseek-ai/dsh-headless has no webServer, and losing run_python there
    // because of a UI nobody asked for would be the wrong trade.
    const headless = stubContext({ withoutWeb: true })
    apply(headless.ctx, new Config({ python: PYTHON }) as unknown as BiomniConfig)
    expect(headless.rec.tools).toHaveLength(1)
    expect(headless.rec.commands.map(command => command.name)).toContain('biomni')
    expect(headless.rec.routes).toHaveLength(0)
    await Promise.all(headless.rec.disposers.map(dispose => dispose()))
  })
})

describe('the persistent interpreter', () => {
  it('carries state across separate tool calls', async () => {
    // The property the whole design exists for.
    await expect(run('import math\nradius = 2')).resolves.toBe('(no output)')
    await expect(run('print(f"area={math.pi * radius ** 2:.4f}")')).resolves.toBe('area=12.5664')
  })

  it('reports a trailing bare expression like a REPL', async () => {
    await expect(run('radius * 10')).resolves.toBe('20')
  })

  it('captures output from child processes', async () => {
    // fd-level capture is how CLI-backed tools (BLAST, samtools) will report.
    await expect(run('import subprocess; subprocess.run(["echo", "child stdout"]); None'))
      .resolves.toBe('child stdout')
  })

  it('returns tracebacks with the worker frames stripped', async () => {
    const failure = await run('radius / 0')
    expect(failure).toMatch(/ZeroDivisionError: division by zero/)
    // Worker frames invite the model to "fix" our file.
    expect(failure).not.toMatch(/worker\.py/)
  })

  it('survives an error inside it', async () => {
    await expect(run('radius')).resolves.toBe('2')
  })

  it('serializes calls for one agent', async () => {
    // One interpreter cannot run two snippets at once; interleaving them would
    // corrupt each other's captured output.
    const [first, second] = await Promise.all([
      run('import time; time.sleep(0.2); print("slow")'),
      run('print("fast")'),
    ])
    expect(first).toBe('slow')
    expect(second).toBe('fast')
  })

  it('rejects an empty snippet', async () => {
    await expect(run('   ')).rejects.toThrow(/non-empty/)
  })

  it('requires an owning agent', async () => {
    await expect(
      tool.execute({ code: '1' }, { signal: new AbortController().signal } as never),
    ).rejects.toThrow(/owning agent/)
  })
})

describe('the /biomni command', () => {
  it('reports the interpreter even when Biomni is absent', async () => {
    const command = rec.commands.find(candidate => candidate.name === 'biomni')
    expect(command).toBeDefined()
    const report = await command!.handler({ signal: new AbortController().signal })
    expect(report.kind).toBe('success')
    expect(report.text).toMatch(/Interpreter\s+\S+/)
    expect(report.text).toMatch(/Python\s+3\./)
  })
})

describe('the output cap', () => {
  it('truncates output that would swamp the context', async () => {
    // The cap is a CONTEXT budget, not a memory one: whatever survives is
    // pasted into the model's next request. 200_000 characters — where this
    // started — is roughly 50k tokens, so one stray print of a real dataframe
    // would evict most of a session's working context.
    const result = await run('print("x" * 40_000)')
    expect(result.length).toBeLessThan(20_000)
  })

  it('says how much was lost and what to do instead', async () => {
    // "[output clipped]" leaves the model to guess the fix, and the guess it
    // makes is to re-run the same call.
    const result = await run('print("x" * 40_000)')
    expect(result).toMatch(/Output truncated: showing the first \d+ of \d+ characters/)
    expect(result).toMatch(/re-running this will truncate again/)
    expect(result).toMatch(/narrower slice/)
  })

  it('leaves output under the cap exactly as written', async () => {
    const result = await run('print("hello")')
    expect(result).toBe('hello')
    expect(result).not.toMatch(/truncated/)
  })
})
