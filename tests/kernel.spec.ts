/**
 * Integration test for the execution kernel: the real plugin module driven
 * through a stub context, so framing, worker lifecycle, and serialization are
 * exercised without booting a harness or needing model credentials.
 *
 * Needs only a bare `python3` — no Biomni. The Biomni-specific assertions live
 * in biomni.spec.ts, which skips when the interpreter has no Biomni.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import type { BiomniConfig } from '../src/config.ts'
import { listArtifacts, resolveArtifact } from '../src/artifacts.ts'
import { OUTPUT_DIR_NAME } from '../src/python/paths.ts'
import { stubContext, stubOwner, workspaceRoot } from './stubs.ts'

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

/**
 * The dataset fetcher's refusals, run against the real script.
 *
 * These paths never touch the network, which is the point: both are decided
 * from the manifest before anything is requested. They live here rather than in
 * the Biomni lane because they hold with or without Biomni installed — the
 * manifest ships with the plugin.
 */
describe('the dataset fetcher', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-biomni-fetch-'))
  const script = fileURLToPath(new URL('../python/fetch.py', import.meta.url))

  /** Run fetch.py and parse its single JSON object. */
  function fetchPy(args: string[]): { results?: { name: string; status: string; detail?: string }[] } {
    try {
      return JSON.parse(execFileSync(PYTHON, [script, '--root', root, ...args], { encoding: 'utf8' }))
    } catch (error) {
      // A refusal exits non-zero by design; the payload is still on stdout.
      return JSON.parse((error as { stdout: string }).stdout)
    }
  }

  it('lists the catalog with a size on every entry', () => {
    const listed = JSON.parse(
      execFileSync(PYTHON, [script, '--list', '--root', root], { encoding: 'utf8', maxBuffer: 1e8 }),
    ) as { total: number; entries: { name: string; bytes: number | null; size: string }[] }
    expect(listed.total).toBeGreaterThan(50)
    for (const entry of listed.entries) {
      expect(entry.bytes, `${entry.name} has no size`).toBeGreaterThan(0)
      expect(entry.size).not.toBe('?')
    }
  })

  it('refuses a name that is not in the manifest', () => {
    // The manifest is the allowlist. A name outside it is never turned into a
    // URL, so this cannot be aimed at another host or another path.
    const report = fetchPy(['../../etc/passwd'])
    expect(report.results?.[0]).toMatchObject({ status: 'unknown' })
  })

  it('refuses a non-commercial dataset without the acknowledgement', () => {
    // The licence is tracked apart from availability everywhere in this
    // plugin; this is the point where it binds.
    const report = fetchPy(['BindingDB_All_202409.tsv'])
    expect(report.results?.[0]).toMatchObject({ status: 'restricted' })
    expect(report.results?.[0]?.detail).toContain('accept-noncommercial')
  })

  it('writes nothing when it refuses', () => {
    // A refusal that left a zero-byte file behind would read as present to the
    // probe, which is worse than the refusal it was meant to be.
    fetchPy(['BindingDB_All_202409.tsv'])
    fetchPy(['../../etc/passwd'])
    const lake = join(root, 'biomni_data', 'data_lake')
    const listing = existsSync(lake) ? readdirSync(lake) : []
    expect(listing).toEqual([])
  })
})

/**
 * The artifact outlet, driven through the real tool.
 *
 * `run_python` returns text capped at 16k characters, so a plot cannot come
 * back at all and a real table comes back truncated. The interpreter writes to
 * a directory instead, and the point of these tests is that the write is
 * REPORTED — a file the model does not know it wrote is barely better than no
 * file.
 */
describe('the artifact outlet', () => {
  const outDir = join(workspaceRoot, OUTPUT_DIR_NAME)

  it('binds the output directory in the namespace', async () => {
    // Bound, not merely documented: a path the model reconstructs from prose
    // is a path it gets wrong, and then the file lands where nothing looks.
    const result = await run('print(BIOMNI_OUT)')
    expect(result.trim()).toBe(outDir)
  })

  it('names what a call wrote, with sizes', async () => {
    const result = await run(
      'BIOMNI_OUT.mkdir(parents=True, exist_ok=True)\n'
      + '(BIOMNI_OUT / "hits.csv").write_text("gene,lfc\\nTP53,2.1\\n")\n'
      + 'print("saved")',
    )
    expect(result).toContain('saved')
    expect(result).toMatch(/wrote to the session output directory: hits\.csv \(\d+ B\)/)
  })

  it('says nothing when a call writes nothing', async () => {
    // The cost of this feature has to be zero on the calls that do not use it,
    // which is most of them.
    const result = await run('print("just thinking")')
    expect(result.trim()).toBe('just thinking')
    expect(result).not.toContain('output directory')
  })

  it('reports a rewrite as updated rather than as a new file', async () => {
    await run('(BIOMNI_OUT / "notes.txt").write_text("one")')
    const result = await run('(BIOMNI_OUT / "notes.txt").write_text("two")\nprint("again")')
    expect(result).toMatch(/notes\.txt \(\d+ B, updated\)/)
  })

  it('sees files written into subdirectories', async () => {
    // A figure saved under figures/ is still a result.
    const result = await run(
      '(BIOMNI_OUT / "figures").mkdir(parents=True, exist_ok=True)\n'
      + '(BIOMNI_OUT / "figures" / "volcano.png").write_bytes(b"x" * 4096)\n'
      + 'print("plotted")',
    )
    expect(result).toContain('figures/volcano.png')
  })

  it('hands those files to the listing the panel and command read', async () => {
    // The two halves have to agree: what the tool result claimed was written
    // is what the operator can then find and download.
    const listing = await listArtifacts(outDir)
    const names = listing.entries.map(entry => entry.name)
    expect(names).toContain('hits.csv')
    expect(names).toContain('figures/volcano.png')
    await expect(resolveArtifact(outDir, 'figures/volcano.png')).resolves.toBeDefined()
  })

  it('refuses to serve a symlink the interpreter planted', async () => {
    // The agent writing into this directory can call os.symlink, and
    // path.resolve does not follow links — so the containment check resolves
    // both sides through the filesystem. Exercised here against a link an
    // actual run_python call created, not a synthetic one.
    const target = join(workspaceRoot, 'outside-secret.txt')
    writeFileSync(target, 'not yours')
    const result = await run(
      'import os\n'
      + 'BIOMNI_OUT.mkdir(parents=True, exist_ok=True)\n'
      + 'link = BIOMNI_OUT / "innocent.txt"\n'
      + 'link.unlink(missing_ok=True)\n'
      + `os.symlink(${JSON.stringify(target)}, link)\n`
      + 'print("linked")',
    )
    // Symlink creation can be unavailable; the refusal is what matters.
    if (result.includes('linked')) {
      await expect(resolveArtifact(outDir, 'innocent.txt')).resolves.toBeUndefined()
    }
  })
})
