/**
 * The environment report, and the requirements tiers it reports against.
 *
 * The report's job is to make a decision cheap: what works, what does not, and
 * what it would cost to change that. The assertions here are mostly about the
 * last part — a missing package named without its price reads as a free
 * suggestion, and four of them are 485 MB between them.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderReport } from '../src/probe.ts'
import { BIOMNI_PREFS_DEFAULTS, type ProbeReport } from '../src/prefs-shared.ts'

const repoFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')

/** Package names in a requirements file, comments and blanks dropped. */
function packages(source: string): string[] {
  return source
    .split('\n')
    .map(line => line.split('#')[0]!.trim())
    .filter(line => line !== '')
    .map(line => line.split(/[<>=!~;[]/)[0]!.trim().toLowerCase())
}

const CORE = packages(repoFile('python/requirements-biomni.txt'))
const EXTRAS = packages(repoFile('python/requirements-biomni-extras.txt'))

describe('the requirements tiers', () => {
  it('keeps the two tiers disjoint', () => {
    // A package in both means installing the core silently drags in something
    // the extras file claims is opt-in, and the measured size stops being true.
    for (const name of EXTRAS) {
      expect(CORE, `${name} is in both tiers`).not.toContain(name)
    }
  })

  it('prices every extra, in the file and in the gate table', () => {
    // The extras file is the human-facing justification and _gates.py's
    // OPTIONAL_COST_MB is the machine-facing one. If they drift, the report
    // quotes a price the documentation does not explain.
    const extrasDoc = repoFile('python/requirements-biomni-extras.txt')
    const gates = repoFile('python/_gates.py')
    const table = gates.slice(gates.indexOf('OPTIONAL_COST_MB'))
    for (const name of EXTRAS) {
      expect(extrasDoc, `${name} has no MB figure`).toMatch(new RegExp(`\\d+ MB[^\\n]*\\n(#[^\\n]*\\n)*${name}`, 's'))
      expect(table, `${name} is not priced in _gates.py`).toContain(`"${name}"`)
    }
  })

  it('still carries the packages that gate the most functions', () => {
    // The split is about cost per function, not about being small. scipy alone
    // gates 43 functions and belongs in core however big it is.
    for (const name of ['numpy', 'pandas', 'scipy', 'biopython', 'tqdm']) {
      expect(CORE).toContain(name)
    }
  })
})

/** A report with one cheap and one priced missing package. */
const REPORT: ProbeReport = {
  executable: '/venv/bin/python',
  python: '3.11.9',
  biomni: '0.0.8',
  modules: [{ name: 'literature', importable: true, blockers: [], functions: 8, blocked: 1 }],
  totalFunctions: 8,
  blockedFunctions: 3,
  missing: { pymed: 1, rdkit: 1, cobra: 2 },
  optionalCostMb: { rdkit: 151, cobra: 147 },
}

describe('renderReport', () => {
  it('puts the price beside the package it belongs to', () => {
    const text = renderReport(REPORT, BIOMNI_PREFS_DEFAULTS)
    expect(text).toMatch(/rdkit\s+1 function\s+— 151 MB/)
    expect(text).toMatch(/cobra\s+2 functions\s+— 147 MB/)
  })

  it('suggests a pip line for the cheap ones only', () => {
    // Pasting a suggested command should never cost 300 MB by surprise.
    const text = renderReport(REPORT, BIOMNI_PREFS_DEFAULTS)
    const suggestion = text.split('\n').find(line => line.trim().startsWith('pip install'))
    expect(suggestion).toBeDefined()
    expect(suggestion).toContain('pymed')
    expect(suggestion).not.toContain('rdkit')
    expect(suggestion).not.toContain('cobra')
  })

  it('names the priced ones separately, with where to read about them', () => {
    const text = renderReport(REPORT, BIOMNI_PREFS_DEFAULTS)
    expect(text).toContain('Deliberately outside the core tier')
    expect(text).toContain('requirements-biomni-extras.txt')
  })

  it('reports the manifest-backed halves when Biomni is absent', () => {
    // 0.0.2 made these work without the library; the report has to say so
    // rather than stopping at "Biomni is NOT installed".
    const text = renderReport({
      ...REPORT,
      biomni: null,
      modules: [],
      missing: {},
      manifest: { source: 'vendored', biomni: '0.0.8' },
      dataLake: { path: '/data/biomni_data/data_lake', exists: true, advertised: 76, present: 5, restricted: 1 },
    }, BIOMNI_PREFS_DEFAULTS)
    expect(text).toContain('Biomni is NOT installed')
    expect(text).toContain('still hold')
    expect(text).toContain('5/76')
    expect(text).toContain('shipped manifest')
    // No module survey to show, so it must not print an empty 0/0 line.
    expect(text).not.toMatch(/Modules\s+0\/0/)
  })
})
