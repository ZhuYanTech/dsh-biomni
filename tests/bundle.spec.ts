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
