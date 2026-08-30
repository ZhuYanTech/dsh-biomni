/**
 * The skill catalog: what gets advertised, what gets rendered, and what the
 * provider does when the interpreter changes underneath it.
 *
 * The assertions here are mostly about HONESTY. A skill body that lists a
 * function this interpreter cannot call is the exact failure the project was
 * built to prevent — an agent that meets a missing lazy import quietly
 * hand-rolls a substitute and passes it off as the validated tool's output. So
 * the tests care less about formatting than about which functions reach the
 * model and how the unavailable ones are framed.
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  SkillCandidate,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import {
  advertisableModules,
  availableLibraries,
  isCallable,
  presentDatasets,
  skillNameOf,
  type CatalogFunction,
  type SkillCatalog,
} from '../src/skills/catalog.ts'
import {
  describeDataLake,
  describeModule,
  describeSoftware,
  renderDataLakeBody,
  renderSkillBody,
  renderSoftwareBody,
} from '../src/skills/render.ts'
import { createBiomniSkillProvider, PROVIDER_NAME } from '../src/skills/provider.ts'
import { loadStaticSkills } from '../src/skills/static.ts'

/** One function, with only the fields a test cares about spelled out. */
function fn(name: string, over: Partial<CatalogFunction> = {}): CatalogFunction {
  return {
    name,
    description: `Does ${name}.`,
    required: [],
    optional: [],
    blockedBy: [],
    known: true,
    ...over,
  }
}

/** A catalog covering every case the renderer has to distinguish. */
const CATALOG: SkillCatalog = {
  biomni: '0.0.8',
  modules: [
    {
      name: 'literature',
      importable: true,
      blockers: [],
      functions: [
        fn('query_pubmed', {
          description: 'Query PubMed for papers based on the provided search query.',
          required: [{ name: 'query', type: 'str', description: 'The search query string.' }],
          optional: [{ name: 'max_papers', type: 'int', description: 'How many to retrieve.', default: '10' }],
        }),
        fn('query_arxiv'),
        // Gate 2: imports its dependency inside the body.
        fn('fetch_supplementary_info_from_doi', { blockedBy: ['pymed'] }),
        // Advertised by Biomni, absent from its own module source.
        fn('ghost_function', { known: false }),
      ],
    },
    {
      // Gate 1: no function under it can run, so it must not be advertised.
      name: 'genomics',
      importable: false,
      blockers: ['esm', 'torch'],
      functions: [fn('predict_structure')],
    },
    {
      // Importable, but every function is blocked — nothing to offer.
      name: 'bioimaging',
      importable: true,
      blockers: [],
      functions: [fn('segment_cells', { blockedBy: ['SimpleITK'] })],
    },
    {
      name: 'molecular_biology',
      importable: true,
      blockers: [],
      functions: [fn('annotate_plasmid')],
    },
  ],
}

describe('skill names', () => {
  it('are kebab-case and package-prefixed', () => {
    // The registry requires ^[a-z0-9]+(?:-[a-z0-9]+)*$, and Biomni's stems are
    // snake_case.
    const pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    expect(skillNameOf('molecular_biology')).toBe('biomni-molecular-biology')
    expect(pattern.test(skillNameOf('molecular_biology'))).toBe(true)
    expect(pattern.test(skillNameOf('literature'))).toBe(true)
  })
})

describe('what gets advertised', () => {
  it('drops modules that cannot import', () => {
    // Gate 1 is all-or-nothing: not one function under genomics can run, so a
    // catalog row for it would be pure cost.
    const names = advertisableModules(CATALOG).map(module => module.name)
    expect(names).not.toContain('genomics')
  })

  it('drops modules whose every function is blocked', () => {
    expect(advertisableModules(CATALOG).map(module => module.name)).not.toContain('bioimaging')
  })

  it('keeps modules with at least one callable function', () => {
    expect(advertisableModules(CATALOG).map(module => module.name))
      .toEqual(['literature', 'molecular_biology'])
  })

  it('treats an advertised-but-undefined function as not callable', () => {
    expect(isCallable(fn('ghost', { known: false }))).toBe(false)
    expect(isCallable(fn('blocked', { blockedBy: ['pymed'] }))).toBe(false)
    expect(isCallable(fn('fine'))).toBe(true)
  })
})

describe('the routing description', () => {
  const description = describeModule(CATALOG.modules[0]!)

  it('counts only callable functions', () => {
    // literature has 4 entries; 2 are callable.
    expect(description).toContain('2 functions')
  })

  it('names actual functions, since that is what routing turns on', () => {
    expect(description).toContain('query_pubmed')
  })

  it('never advertises a function that would raise', () => {
    expect(description).not.toContain('fetch_supplementary_info_from_doi')
    expect(description).not.toContain('ghost_function')
  })
})

describe('the rendered body', () => {
  const body = renderSkillBody(CATALOG.modules[0]!, '0.0.8')

  it('says how to reach the interpreter', () => {
    // A body can be loaded into a turn where nothing else established that
    // Biomni lives behind run_python.
    expect(body).toContain('run_python')
    expect(body).toContain('from biomni.tool import literature')
  })

  it('renders signatures with types, defaults, and parameter prose', () => {
    expect(body).toContain('`query_pubmed(query, max_papers=10)`')
    expect(body).toContain('`query` (str) — The search query string.')
    expect(body).toContain('`max_papers` (int, default 10)')
  })

  it('separates blocked functions from callable ones', () => {
    const functions = body.indexOf('## Functions')
    const unavailable = body.indexOf('## Not available in this environment')
    expect(functions).toBeGreaterThan(-1)
    expect(unavailable).toBeGreaterThan(functions)
    // The blocked one appears only after the boundary.
    expect(body.indexOf('fetch_supplementary_info_from_doi')).toBeGreaterThan(unavailable)
  })

  it('names the missing package and forbids substituting for it', () => {
    // This is the anti-fabrication instruction; losing it is how the original
    // hand-rolled-PubMed-client failure happened.
    expect(body).toContain('needs `pymed`')
    expect(body).toMatch(/do NOT reimplement/i)
  })

  it('flags functions Biomni advertises but does not define', () => {
    expect(body).toContain('Advertised but not found in the module source')
    expect(body).toContain('ghost_function')
  })

  it('names the biomni version it was generated from', () => {
    expect(body).toContain('0.0.8')
  })
})

/** A control whose invalidate() is observable. */
function stubControl(): SkillProviderControl & { invalidated: number } {
  const control = {
    signal: new AbortController().signal,
    invalidated: 0,
    invalidate: () => { control.invalidated += 1 },
  }
  return control
}

/** A subprocess stub that answers with a fixed catalog, counting spawns. */
function stubSubprocess(payload: unknown, exitCode = 0) {
  const spawns: string[][] = []
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return {
    spawns,
    service: {
      spawn: (spec: { argv: string[] }) => {
        spawns.push(spec.argv)
        return {
          stdin: { write: () => {} },
          stdout: { setEncoding: () => {}, on: () => {} },
          collected: {
            stdout: { readFrom: () => ({ text }) },
            stderr: { readFrom: () => ({ text: 'boom' }) },
          },
          done: Promise.resolve({ exitCode }),
          terminate: () => {},
          waitForExit: async () => ({ exitCode }),
        }
      },
    } as never,
  }
}

/**
 * The candidates from one discovery, normalizing the provider contract's two
 * accepted shapes (a bare array is complete-discovery shorthand).
 */
async function candidatesOf(provider: SkillProvider): Promise<readonly SkillCandidate[]> {
  const listed = await provider.list({})
  return Array.isArray(listed) ? listed : (listed as SkillProviderObservation).candidates
}

describe('the shipped skills', () => {
  it('loads the workflow skill with its frontmatter and body', () => {
    const shipped = loadStaticSkills()
    const workflow = shipped.find(skill => skill.name === 'biomni-workflow')
    expect(workflow).toBeDefined()
    expect(workflow!.description).toContain('persistent Python interpreter')
    // The frontmatter must not survive into the body the model reads.
    expect(workflow!.content.startsWith('---')).toBe(false)
    expect(workflow!.content).toContain('# Working with Biomni here')
  })

  it('carries the rule that loses the most work', () => {
    // A snippet ending in an assignment returns nothing, so the result is
    // invisible even though the call succeeded. Biomni's own protocol states
    // this; losing it from the skill is losing the point of the skill.
    const workflow = loadStaticSkills().find(skill => skill.name === 'biomni-workflow')!
    expect(workflow.content).toMatch(/print/)
    expect(workflow.content).toMatch(/ends in an assignment returns nothing/i)
  })
})

describe('the provider', () => {
  it('lists the shipped skills before the generated ones', async () => {
    const { service } = stubSubprocess(CATALOG)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => '' },
      stubControl(),
    )
    const candidates = await candidatesOf(provider)
    expect(candidates.map(candidate => candidate.name))
      .toEqual(['biomni-workflow', 'biomni-literature', 'biomni-molecular-biology'])
    expect(candidates[0]!.provider).toBe(PROVIDER_NAME)
    expect(candidates[0]!.invocation).toEqual({ modelInvocable: true, userInvocable: true })
  })

  it('serves the shipped skills even when the catalog build fails', async () => {
    // How to organize the work does not depend on the interpreter.
    const { service } = stubSubprocess('', 1)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/no/such/python', dataPath: () => '', onError: () => {} },
      stubControl(),
    )
    const listed = await provider.list({})
    const observation = listed as SkillProviderObservation
    expect(observation.complete).toBe(false)
    expect(observation.candidates.map(candidate => candidate.name)).toEqual(['biomni-workflow'])
  })

  it('loads a shipped skill body verbatim', async () => {
    const { service } = stubSubprocess(CATALOG)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => '' },
      stubControl(),
    )
    const candidates = await candidatesOf(provider)
    const workflow = candidates.find(candidate => candidate.name === 'biomni-workflow')!
    const definition = await provider.get(workflow, {})
    expect(definition?.content).toContain('# Working with Biomni here')
  })

  it('loads the body for a listed candidate', async () => {
    const { service } = stubSubprocess(CATALOG)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => '' },
      stubControl(),
    )
    const candidates = await candidatesOf(provider)
    const literature = candidates.find(candidate => candidate.name === 'biomni-literature')!
    const definition = await provider.get(literature, {})
    expect(definition?.name).toBe('biomni-literature')
    expect(definition?.content).toContain('query_pubmed')
  })

  it('spawns once and serves the rest from cache', async () => {
    const { service, spawns } = stubSubprocess(CATALOG)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => '' },
      stubControl(),
    )
    await provider.list({})
    await provider.list({})
    expect(spawns).toHaveLength(1)
  })

  it('rebuilds after the interpreter changes', async () => {
    // A catalog generated from a different interpreter is not stale, it is
    // wrong — it describes functions this session cannot call.
    const { service, spawns } = stubSubprocess(CATALOG)
    let python = '/venv-a/bin/python'
    const control = stubControl()
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => python, dataPath: () => '' },
      control,
    )
    await provider.list({})
    python = '/venv-b/bin/python'
    provider.invalidate()
    await provider.list({})
    expect(spawns).toHaveLength(2)
    expect(spawns[1]![0]).toBe('/venv-b/bin/python')
    expect(control.invalidated).toBe(1)
  })

  it('reports no MODULE skills, completely, when the interpreter has no biomni', async () => {
    // Authoritative absence, not failure: caching it is correct. The shipped
    // skills stay, because they do not depend on the interpreter.
    const { service } = stubSubprocess({ biomni: null, modules: [] })
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => 'python3', dataPath: () => '' },
      stubControl(),
    )
    const listed = await provider.list({})
    expect(Array.isArray(listed)).toBe(true)
    expect((listed as readonly SkillCandidate[]).map(candidate => candidate.name))
      .toEqual(['biomni-workflow'])
  })

  it('degrades to an incomplete observation when the build fails', async () => {
    // Other providers' skills must stay usable, and the registry must be told
    // not to cache this, so the next lookup retries.
    const onError = vi.fn()
    const { service } = stubSubprocess('', 1)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/no/such/python', dataPath: () => '', onError },
      stubControl(),
    )
    const listed = await provider.list({}) as SkillProviderObservation
    expect(listed.complete).toBe(false)
    expect(listed.candidates.every(candidate => candidate.name === 'biomni-workflow')).toBe(true)
    expect(onError).toHaveBeenCalledOnce()
  })

  it('degrades when the generator itself reported an error', async () => {
    const onError = vi.fn()
    const { service } = stubSubprocess({ error: 'ValueError: nope' })
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => 'python3', dataPath: () => '', onError },
      stubControl(),
    )
    const listed = await provider.list({}) as SkillProviderObservation
    expect(listed.complete).toBe(false)
    expect(onError).toHaveBeenCalledOnce()
  })
})

// ── The data lake and the software library ──────────────────────────────────
// Biomni's other two assets. The assertions here are the same honesty
// assertions as above, aimed at a worse failure: a model told about a dataset
// that is not on disk does not report the gap, it invents a path and then
// invents a result to go with it.

/** A catalog with both extra assets populated. */
const RICH: SkillCatalog = {
  ...CATALOG,
  dataLake: {
    path: '/data/biomni_data/data_lake',
    exists: true,
    present: 2,
    entries: [
      {
        name: 'DepMap_Model.csv',
        description: 'Metadata describing all cancer models/cell lines.',
        present: true,
        bytes: 4_194_304,
        commercial: true,
      },
      {
        name: 'gtex_tissue_gene_tpm.parquet',
        description: 'Gene expression across GTEx tissues.',
        present: true,
        bytes: 1_073_741_824,
        commercial: false,
      },
      {
        name: 'txgnn_prediction.pkl',
        description: 'Prediction data for TXGNN.',
        present: false,
        bytes: null,
        commercial: true,
      },
    ],
  },
  libraries: [
    { name: 'samtools', kind: 'cli', found: 'cli', description: 'Sequencing data tools.', available: true },
    { name: 'scanpy', kind: 'python', found: 'python', description: 'Single-cell analysis.', available: true },
    { name: 'bowtie2', kind: 'cli', found: null, description: 'Read aligner.', available: false },
    { name: 'DESeq2', kind: 'r', found: null, description: 'Differential expression.', available: null },
  ],
}

describe('the data lake skill', () => {
  it('advertises only datasets that are actually on disk', () => {
    const datasets = presentDatasets(RICH)
    expect(datasets.map(entry => entry.name))
      .toEqual(['DepMap_Model.csv', 'gtex_tissue_gene_tpm.parquet'])
  })

  it('offers nothing when the lake is absent', () => {
    // A definite answer, not a failure — and the alternative, a body listing 76
    // datasets none of which exist, is precisely the failure being prevented.
    expect(presentDatasets(CATALOG)).toEqual([])
    expect(presentDatasets({ ...RICH, dataLake: { ...RICH.dataLake!, entries: [] } })).toEqual([])
  })

  it('states the absolute root once and never a guessable path', () => {
    const body = renderDataLakeBody(RICH.dataLake!, presentDatasets(RICH), '0.0.8')
    expect(body).toContain('/data/biomni_data/data_lake')
    expect(body).toContain('DepMap_Model.csv')
    // The one file that is NOT downloaded must not appear as available.
    const listing = body.slice(body.indexOf('## Datasets'))
    expect(listing).not.toContain('txgnn_prediction.pkl')
  })

  it('names the licence restriction instead of folding it into availability', () => {
    // Presence and licence are independent axes: this dataset is downloaded,
    // readable, and still not usable commercially.
    const body = renderDataLakeBody(RICH.dataLake!, presentDatasets(RICH), '0.0.8')
    expect(body).toContain('non-commercial')
    expect(body).toContain('gtex_tissue_gene_tpm.parquet')
  })

  it('tells the model to report a missing dataset rather than substitute one', () => {
    const body = renderDataLakeBody(RICH.dataLake!, presentDatasets(RICH), '0.0.8')
    expect(body).toMatch(/do NOT guess a path/i)
  })

  it('states the software composition rather than assuming it', () => {
    // A machine with no CLI tools must not advertise "command-line tools", or
    // the description routes the model to a skill that cannot answer.
    expect(describeSoftware(availableLibraries(RICH))).toMatch(/1 command-line tool and 2 packages/)
    const noCli = availableLibraries(RICH).filter(entry => entry.kind !== 'cli')
    const description = describeSoftware(noCli)
    expect(description).not.toMatch(/command-line/)
    expect(description).toMatch(/2 packages/)
  })

  it('names datasets in the routing description, not just a subject', () => {
    // The description is the only text that decides whether the skill is ever
    // loaded, so it has to be distinguishable from every other row.
    const description = describeDataLake(presentDatasets(RICH))
    expect(description).toContain('DepMap_Model')
    expect(description).toMatch(/2 biomedical datasets/)
  })
})

describe('the software skill', () => {
  it('drops what was verified absent and keeps what could not be verified', () => {
    const available = availableLibraries(RICH)
    expect(available.map(entry => entry.name)).toEqual(['samtools', 'scanpy', 'DESeq2'])
  })

  it('splits by how each thing is actually invoked', () => {
    // The distinction the model gets wrong: a CLI tool is not importable, and
    // a Python package is not runnable from the shell.
    const body = renderSoftwareBody(availableLibraries(RICH), '0.0.8')
    expect(body).toContain('Command-line tools')
    expect(body).toContain('Python packages')
    expect(body).toMatch(/bash/)
    expect(body).not.toContain('bowtie2')
  })

  it('marks an unverified entry as unverified', () => {
    const body = renderSoftwareBody(availableLibraries(RICH), '0.0.8')
    expect(body).toMatch(/DESeq2.*unverified/)
  })

  it('says the guard does not apply to the CLI tools', () => {
    // They run through bash, and a model that believes bash is off-limits will
    // hand-roll an aligner instead of calling one.
    const body = renderSoftwareBody(availableLibraries(RICH), '0.0.8')
    expect(body).toMatch(/only blocks `python` and `pip`/)
  })
})

describe('the provider, with both extra assets', () => {
  it('advertises one row each, not one per entry', async () => {
    // 76 datasets and 113 packages as separate catalog rows would cost more
    // resident context than the module catalog they sit beside.
    const { service } = stubSubprocess(RICH)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => '' },
      stubControl(),
    )
    const candidates = await candidatesOf(provider)
    expect(candidates.map(candidate => candidate.name)).toEqual([
      'biomni-workflow',
      'biomni-literature',
      'biomni-molecular-biology',
      'biomni-data-lake',
      'biomni-software',
    ])
  })

  it('omits the data lake row when nothing is downloaded', async () => {
    const { service } = stubSubprocess({ ...RICH, dataLake: { ...RICH.dataLake!, present: 0, entries: [] } })
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => '' },
      stubControl(),
    )
    const names = (await candidatesOf(provider)).map(candidate => candidate.name)
    expect(names).not.toContain('biomni-data-lake')
    expect(names).toContain('biomni-software')
  })

  it('serves the rendered bodies through get()', async () => {
    const { service } = stubSubprocess(RICH)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => '' },
      stubControl(),
    )
    const candidates = await candidatesOf(provider)
    const lake = await provider.get(candidates.find(c => c.name === 'biomni-data-lake')!, {})
    const software = await provider.get(candidates.find(c => c.name === 'biomni-software')!, {})
    expect(lake!.content).toContain('/data/biomni_data/data_lake')
    expect(software!.content).toContain('samtools')
  })

  it('rebuilds after the data root changes', async () => {
    // Same reasoning as the interpreter: a dataset listing generated against
    // another root is not stale, it is wrong.
    const { service, spawns } = stubSubprocess(RICH)
    let dataPath = '/data-a'
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => dataPath },
      stubControl(),
    )
    await provider.list({})
    dataPath = '/data-b'
    provider.invalidate()
    await provider.list({})
    expect(spawns).toHaveLength(2)
    expect(spawns[1]!).toContain('/data-b')
  })

  it('passes no data-root argument when the setting is empty', async () => {
    // Empty must reach Biomni's own resolution, not be passed as the path ''.
    const { service, spawns } = stubSubprocess(RICH)
    const provider = createBiomniSkillProvider(
      { subprocess: service, python: () => '/venv/bin/python', dataPath: () => '' },
      stubControl(),
    )
    await provider.list({})
    expect(spawns[0]!).toHaveLength(2)
  })
})
