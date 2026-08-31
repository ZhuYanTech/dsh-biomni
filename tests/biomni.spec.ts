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
import {
  advertisableModules,
  availableLibraries,
  isCallable,
  presentDatasets,
  readCatalog,
} from '../src/skills/catalog.ts'
import { renderDataLakeBody, renderSkillBody, renderSoftwareBody } from '../src/skills/render.ts'
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
    const report = await probeEnvironment(ctx, PYTHON!, '')
    expect(report.biomni).not.toBeNull()
    expect(report.modules.length).toBeGreaterThan(0)
    expect(report.totalFunctions).toBeGreaterThan(0)
  })

  it('distinguishes importable from callable', async () => {
    const report = await probeEnvironment(ctx, PYTHON!, '')
    // The whole point of the two-gate probe: a module that imports cleanly can
    // still have functions that raise on call. These are separate counts, and
    // conflating them is the bug this asserts against.
    const importable = report.modules.filter(module => module.importable).length
    expect(importable).toBeLessThanOrEqual(report.modules.length)
    expect(report.blockedFunctions).toBeLessThanOrEqual(report.totalFunctions)
  })

  it('flags the two packages that gate every module at once', async () => {
    const report = await probeEnvironment(ctx, PYTHON!, '')
    // biomni.tool.__init__ imports biomni.utils, so tqdm and pandas gate all
    // 21 modules — and the import error names neither.
    expect(report.gate).toBeDefined()
    expect(report.gate).toEqual([])
  })

  it('generates a skill catalog that agrees with the probe', async () => {
    // The two must never disagree about what is callable — they share the
    // analysis in python/_gates.py precisely so they cannot.
    const [report, catalog] = await Promise.all([
      probeEnvironment(ctx, PYTHON!, ''),
      readCatalog(ctx, PYTHON!, ''),
    ])
    expect(catalog.biomni).toBe(report.biomni)

    for (const module of catalog.modules) {
      const probed = report.modules.find(candidate => candidate.name === module.name)
      expect(probed, `probe is missing ${module.name}`).toBeDefined()
      expect(module.importable).toBe(probed!.importable)
      expect(module.blockers).toEqual(probed!.blockers)
    }
  })

  it('advertises only modules with something callable', async () => {
    const catalog = await readCatalog(ctx, PYTHON!, '')
    const advertised = advertisableModules(catalog)
    expect(advertised.length).toBeGreaterThan(0)
    for (const module of advertised) {
      expect(module.importable).toBe(true)
      expect(module.functions.some(isCallable)).toBe(true)
    }
    // Biomni 0.0.8 cannot import these without torch/esm/SimpleITK.
    const names = advertised.map(module => module.name)
    expect(names).not.toContain('genomics')
    expect(names).not.toContain('bioimaging')
  })

  it('renders a body carrying real signatures', async () => {
    const catalog = await readCatalog(ctx, PYTHON!, '')
    const literature = catalog.modules.find(module => module.name === 'literature')
    expect(literature).toBeDefined()
    const body = renderSkillBody(literature!, catalog.biomni!)
    expect(body).toContain('query_pubmed')
    expect(body).toContain('The search query string.')
  })


  // ── The data lake and the software library ────────────────────────────────
  // Biomni's other two assets, read from env_desc rather than the tool tree.
  // Both are advertised-vs-actual joins, and the assertions are that the two
  // sides stay separate.

  it('reads the advertised data lake without needing it downloaded', async () => {
    const catalog = await readCatalog(ctx, PYTHON!, '')
    expect(catalog.dataLake).toBeDefined()
    // 76 at Biomni 0.0.8. The count is what env_desc advertises; whether any of
    // it is on disk is a different question, asked below.
    expect(catalog.dataLake!.entries.length).toBeGreaterThan(0)
    expect(catalog.dataLake!.path).toMatch(/biomni_data\/data_lake$/)
  })

  it('keeps advertised and present as separate facts', async () => {
    const catalog = await readCatalog(ctx, PYTHON!, '')
    const advertised = catalog.dataLake!.entries.length
    const present = presentDatasets(catalog).length
    expect(present).toBeLessThanOrEqual(advertised)
    // Every entry reported present must carry a real size; a present file with
    // no size would mean the check did not actually stat anything.
    for (const entry of presentDatasets(catalog)) {
      expect(entry.bytes, `${entry.name} is present with no size`).not.toBeNull()
    }
  })

  it('tracks the commercial-use subset as its own axis', async () => {
    // A dataset can be downloaded, readable, and still restricted. Folding this
    // into "available" would be the same mistake as merging the import gates.
    const catalog = await readCatalog(ctx, PYTHON!, '')
    const entries = catalog.dataLake!.entries
    const restricted = entries.filter(entry => entry.commercial === false)
    const allowed = entries.filter(entry => entry.commercial === true)
    expect(restricted.length).toBeGreaterThan(0)
    expect(allowed.length).toBeGreaterThan(0)
    expect(restricted.length + allowed.length).toBe(entries.length)
  })

  it('honours an explicit data root', async () => {
    const catalog = await readCatalog(ctx, PYTHON!, '/tmp/dsh-biomni-nowhere')
    expect(catalog.dataLake!.path).toBe('/tmp/dsh-biomni-nowhere/biomni_data/data_lake')
    expect(catalog.dataLake!.exists).toBe(false)
    // Nothing is on disk there, so nothing may be advertised from it.
    expect(presentDatasets(catalog)).toEqual([])
  })

  it('classifies the software library by how each thing is invoked', async () => {
    const catalog = await readCatalog(ctx, PYTHON!, '')
    const libraries = catalog.libraries!
    expect(libraries.length).toBeGreaterThan(0)
    const kinds = new Set(libraries.map(entry => entry.kind))
    expect(kinds.has('cli')).toBe(true)
    expect(kinds.has('python')).toBe(true)
    // samtools is a binary, not an importable package — getting this backwards
    // is what makes a model try to `import samtools`.
    const samtools = libraries.find(entry => entry.name === 'samtools')
    expect(samtools?.kind).toBe('cli')
  })

  it('never advertises software it verified absent', async () => {
    const catalog = await readCatalog(ctx, PYTHON!, '')
    for (const entry of availableLibraries(catalog)) {
      expect(entry.available, `${entry.name} was advertised despite being absent`).not.toBe(false)
    }
  })

  it('renders both extra bodies without inventing anything', async () => {
    const catalog = await readCatalog(ctx, PYTHON!, '')
    const libraries = availableLibraries(catalog)
    if (libraries.length > 0) {
      const body = renderSoftwareBody(libraries, catalog.biomni!)
      for (const entry of catalog.libraries!.filter(candidate => candidate.available === false)) {
        expect(body, `${entry.name} is absent but was listed`).not.toContain(`\`${entry.name}\``)
      }
    }
    const datasets = presentDatasets(catalog)
    if (datasets.length > 0) {
      const body = renderDataLakeBody(catalog.dataLake!, datasets, catalog.biomni!)
      expect(body).toContain(catalog.dataLake!.path)
    }
  })

  it('agrees with the probe about the data lake and the software', async () => {
    // Both read python/_gates.py, so a disagreement would mean one of them
    // stopped using the shared analysis.
    const [report, catalog] = await Promise.all([
      probeEnvironment(ctx, PYTHON!, ''),
      readCatalog(ctx, PYTHON!, ''),
    ])
    expect(report.dataLake!.path).toBe(catalog.dataLake!.path)
    expect(report.dataLake!.advertised).toBe(catalog.dataLake!.entries.length)
    expect(report.dataLake!.present).toBe(presentDatasets(catalog).length)

    const tallied = Object.values(report.libraries!).reduce((sum, kind) => sum + kind.advertised, 0)
    expect(tallied).toBe(catalog.libraries!.length)
  })

  // Measured: `from biomni.tool import literature` pulls the langchain chain and
  // takes ~4s on a cold page cache against ~0.8s warm. The default 5s timeout
  // was therefore asserting something about the filesystem, not about the
  // plugin, and failed the first time the suite ran after a rebuild.
  it('reaches the tool library from the persistent interpreter', { timeout: 30_000 }, async () => {
    const tool = rec.tools[0]!
    const owner = stubOwner(rec)
    const result = await tool.execute(
      { code: 'from biomni.tool import literature\nlen([n for n in dir(literature) if not n.startswith("_")])' },
      { agent: owner, signal: new AbortController().signal } as never,
    ) as string
    expect(Number(result)).toBeGreaterThan(0)
  })
})
