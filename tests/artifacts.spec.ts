/**
 * The output directory: listing it, and the containment check that guards
 * reading from it.
 *
 * `resolveArtifact` is the only place in this plugin where a name arriving over
 * HTTP is turned into a filesystem path, so it gets the most attention here.
 * Everything else is reporting.
 */
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  contentTypeOf,
  listArtifacts,
  readArtifact,
  renderArtifacts,
  resolveArtifact,
  MAX_DOWNLOAD_BYTES,
} from '../src/artifacts.ts'

const workspace = mkdtempSync(join(tmpdir(), 'dsh-biomni-artifacts-'))
const root = join(workspace, 'biomni-out')
/** A file outside the root, which nothing served from it may reach. */
const secret = join(workspace, 'secret.txt')

beforeAll(() => {
  mkdirSync(join(root, 'figures'), { recursive: true })
  writeFileSync(join(root, 'hits.csv'), 'gene,lfc\nTP53,2.1\n')
  writeFileSync(join(root, 'figures', 'volcano.png'), Buffer.alloc(2048))
  writeFileSync(secret, 'not yours')
  // Deterministic ordering for the newest-first assertion.
  utimesSync(join(root, 'hits.csv'), new Date(1_000_000), new Date(1_000_000))
  utimesSync(join(root, 'figures', 'volcano.png'), new Date(2_000_000), new Date(2_000_000))
})

describe('listArtifacts', () => {
  it('walks subdirectories and reports POSIX-style names', () => {
    // A figure saved into figures/ is still a result; a listing that only sees
    // the top level would report the work as missing.
    return listArtifacts(root).then((listing) => {
      expect(listing.exists).toBe(true)
      expect(listing.entries.map(e => e.name).sort()).toEqual(['figures/volcano.png', 'hits.csv'])
      expect(listing.totalBytes).toBe(2048 + 'gene,lfc\nTP53,2.1\n'.length)
    })
  })

  it('puts the newest first', async () => {
    const listing = await listArtifacts(root)
    expect(listing.entries[0]!.name).toBe('figures/volcano.png')
  })

  it('treats an absent directory as empty rather than an error', async () => {
    // The normal state of a session that has not written anything. A stack
    // trace here would read as a broken plugin.
    const listing = await listArtifacts(join(workspace, 'never-created'))
    expect(listing.exists).toBe(false)
    expect(listing.entries).toEqual([])
  })
})

describe('resolveArtifact', () => {
  it('resolves a name from the listing', async () => {
    await expect(resolveArtifact(root, 'hits.csv')).resolves.toBe(join(root, 'hits.csv'))
    await expect(resolveArtifact(root, 'figures/volcano.png'))
      .resolves.toBe(join(root, 'figures', 'volcano.png'))
  })

  it.each([
    ['parent traversal', '../secret.txt'],
    ['deep traversal', '../../etc/passwd'],
    ['traversal through a real subdirectory', 'figures/../../secret.txt'],
    ['an absolute path', '/etc/passwd'],
    ['an absolute path inside the workspace', join(tmpdir(), 'secret.txt')],
    ['an empty name', ''],
    ['a NUL byte', 'hits.csv\0.png'],
  ])('refuses %s', async (_label, name) => {
    // The check compares resolved paths rather than inspecting the string:
    // there are more ways to write an escaping path than to spot one.
    await expect(resolveArtifact(root, name)).resolves.toBeUndefined()
  })

  it('refuses a sibling directory that merely shares the prefix', async () => {
    // `startsWith(root)` without the separator would accept this.
    const sibling = `${root}-evil`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'x.txt'), 'no')
    await expect(resolveArtifact(root, '../biomni-out-evil/x.txt')).resolves.toBeUndefined()
  })

  it('refuses a directory, and a name that does not exist', async () => {
    await expect(resolveArtifact(root, 'figures')).resolves.toBeUndefined()
    await expect(resolveArtifact(root, 'nope.csv')).resolves.toBeUndefined()
  })

  it('refuses a symlink pointing outside the root', async () => {
    // The resolve() containment check follows the link, so the escape is
    // caught by path comparison rather than by refusing symlinks wholesale.
    const link = join(root, 'escape.txt')
    try {
      symlinkSync(secret, link)
    } catch {
      return // no symlink permission here; the check above still covers the path forms
    }
    await expect(resolveArtifact(root, 'escape.txt')).resolves.toBeUndefined()
  })
})

describe('readArtifact', () => {
  it('reads a file inside the cap', async () => {
    const path = (await resolveArtifact(root, 'hits.csv'))!
    const result = await readArtifact(path)
    expect('body' in result && Buffer.from(result.body).toString()).toContain('TP53')
  })

  it('has a cap at all, because the response seam takes a whole body', () => {
    // No streaming means a download is an allocation, and an agent can write a
    // multi-GB parquet. The route names the path instead beyond this.
    expect(MAX_DOWNLOAD_BYTES).toBeGreaterThan(1024 * 1024)
    expect(MAX_DOWNLOAD_BYTES).toBeLessThanOrEqual(512 * 1024 * 1024)
  })
})

describe('contentTypeOf', () => {
  it('serves images and data with useful types', () => {
    expect(contentTypeOf('volcano.png')).toBe('image/png')
    expect(contentTypeOf('hits.csv')).toBe('text/csv')
  })

  it('never says text/html', () => {
    // These are model-written files served from the harness's own origin.
    // Rendering one there would make writing a file a way to run script.
    expect(contentTypeOf('report.html')).not.toContain('html')
    expect(contentTypeOf('anything.unknown')).toBe('application/octet-stream')
  })
})

describe('renderArtifacts', () => {
  it('explains how the directory fills when it is empty', async () => {
    const text = renderArtifacts(await listArtifacts(join(workspace, 'never-created')))
    expect(text).toContain('Nothing written yet')
    expect(text).toContain('BIOMNI_OUT')
  })

  it('lists names with sizes', async () => {
    const text = renderArtifacts(await listArtifacts(root))
    expect(text).toContain('hits.csv')
    expect(text).toContain('figures/volcano.png')
    expect(text).toMatch(/2\.0 KB/)
  })
})
