/**
 * Built-artifact assertions for the two client bundles.
 *
 * Both install channels are compiled from the same source, and the only things
 * that differ are the registered id and the file name — so the failure mode is
 * silent: a bundle whose id does not match its channel simply never activates,
 * with no error anywhere. These checks are what catch that.
 *
 * Skipped when `lib/` has not been built (a bare `vitest run` on a fresh clone);
 * `pnpm build && pnpm test` runs them.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import manifest from '../dsh.plugin.json' with { type: 'json' }
import pkg from '../package.json' with { type: 'json' }

const libPath = (file: string): string => fileURLToPath(new URL(`../lib/${file}`, import.meta.url))
const built = existsSync(libPath('client.js'))

describe.skipIf(!built)('client bundles', () => {
  it.each([
    // The official profile channel keys on the PACKAGE NAME (client-modules
    // compose on it).
    ['client.js', pkg.name],
    // The plugin-registry channel keys on the MANIFEST ID (the browser-side
    // arrive() check requires bundle id === plugin id).
    ['client-registry.js', manifest.id],
  ])('%s registers as %s', (file, id) => {
    // The banner/footer are pretty-printed by the bundler, so match the shape
    // rather than the whitespace.
    const source = readFileSync(libPath(file), 'utf8')
    expect(source.startsWith('window.__ModuleLoader__.load(')).toBe(true)
    expect(source).toMatch(new RegExp(`id:\\s*${JSON.stringify(id).replace(/[/\\]/g, '\\$&')}`))
    expect(source).toMatch(/factory:\s*\(require\)\s*=>/)
    expect(source).toMatch(/return module\.exports;\s*\}\s*\}\);/)
  })

  it('contributes a settings section rather than a plugin settings item', () => {
    // `settings.plugin.item` is the seam DSH's apiproxy allowlist makes
    // unusable for a third-party namespace; `settings.section` is the one that
    // works. A regression here renders an empty card with no error.
    const source = readFileSync(libPath('client.js'), 'utf8')
    expect(source).toContain('settings.section')
  })

  it('talks to the plugin\'s own route, not the settings RPC', () => {
    const source = readFileSync(libPath('client.js'), 'utf8')
    expect(source).toContain('/biomni/api/')
  })

  it('keeps Node builtins out of the browser artifact', () => {
    const source = readFileSync(libPath('client.js'), 'utf8')
    expect(source).not.toMatch(/require\(["']node:/)
  })
})

describe('manifest consistency', () => {
  it('keeps dsh.plugin.json in sync with package.json', () => {
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.id).toBe(`dsh-external/${pkg.name}`)
    expect(manifest.main).toBe(`./${pkg.main}`)
    expect(manifest.client.main).toBe('./lib/client-registry.js')
  })

  it('ships the python assets the host resolves at runtime', () => {
    for (const asset of ['python/worker.py', 'python/probe.py']) {
      expect(pkg.files).toContain(asset)
      expect(existsSync(fileURLToPath(new URL(`../${asset}`, import.meta.url)))).toBe(true)
    }
  })
})

/**
 * Publish metadata. These are cheap to get wrong and expensive to notice: a
 * stale version or a wrong repository URL is only visible once the package is
 * on a registry, where it cannot be edited in place.
 */
describe('publish metadata', () => {
  it('keeps the manifest version in step with the package version', () => {
    // Two files carry the version, so they drift. The manifest one is what a
    // DSH profile records when it installs the plugin, and a mismatch means the
    // recorded version is not the one that shipped.
    expect(manifest.version).toBe(pkg.version)
  })

  it('points at the repository it is actually published from', () => {
    // npm renders this as the Repository link and uses it for provenance, so a
    // wrong owner sends every visitor to a 404.
    expect(pkg.repository.url).toContain('ZhuYanTech/dsh-biomni')
    expect(pkg.homepage).toContain('ZhuYanTech/dsh-biomni')
  })

  it('ships every runtime file the plugin loads', () => {
    // `files` is an allowlist: anything absent from it is simply not in the
    // tarball, and the failure only shows up on a consumer's machine. The
    // Python scripts and the shipped skills are loaded at runtime by path, so
    // they are the easiest ones to leave behind.
    const files = pkg.files
    for (const required of [
      'lib/index.js',
      'lib/client.js',
      'lib/client-registry.js',
      'python/worker.py',
      'python/probe.py',
      'python/skills.py',
      'python/_gates.py',
      'skills',
      'preset',
    ]) {
      expect(files, `${required} is missing from package.json "files"`).toContain(required)
    }
  })
})

/**
 * The vendored asset manifest.
 *
 * It is data captured from Biomni, shipped so the data lake and software
 * catalogs work without a 1.3 GB install. Being data, nothing type-checks it —
 * these assertions are the only thing standing between a bad capture and a
 * catalog that confidently describes nothing.
 */
describe('the vendored manifest', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../data/biomni-manifest.json', import.meta.url)), 'utf8'),
  ) as {
    biomni: string
    datasets: Record<string, string>
    commercialDatasets: string[] | null
    libraries: Record<string, string>
  }

  it('carries both catalogs and the version they came from', () => {
    expect(manifest.biomni).toMatch(/^\d+\.\d+\.\d+/)
    expect(Object.keys(manifest.datasets).length).toBeGreaterThan(50)
    expect(Object.keys(manifest.libraries).length).toBeGreaterThan(100)
  })

  it('describes every entry it lists', () => {
    // An entry with no description is worse than an absent one: it reaches the
    // model as a name with nothing to judge relevance by.
    for (const [name, description] of Object.entries(manifest.datasets)) {
      expect(description.length, `dataset ${name} has no description`).toBeGreaterThan(10)
    }
    for (const [name, description] of Object.entries(manifest.libraries)) {
      expect(description.length, `library ${name} has no description`).toBeGreaterThan(10)
    }
  })

  it('keeps the commercial subset inside the full set', () => {
    // A licence allowlist naming a dataset that is not advertised means the two
    // halves were captured from different versions.
    expect(manifest.commercialDatasets).not.toBeNull()
    for (const name of manifest.commercialDatasets!) {
      expect(manifest.datasets, `${name} is cleared but not advertised`).toHaveProperty(name)
    }
    expect(manifest.commercialDatasets!.length).toBeLessThan(Object.keys(manifest.datasets).length)
  })

  it('ships in the package', () => {
    // The fallback is worthless if it is not in the tarball, and that failure
    // only shows up on a machine without Biomni — the exact case it exists for.
    expect(pkg.files).toContain('data/biomni-manifest.json')
  })
})
