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
  previewArtifact,
  readArtifact,
  renderArtifacts,
  resolveArtifact,
  splitDelimited,
  MAX_DOWNLOAD_BYTES,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MAX_TEXT_PREVIEW_BYTES,
} from '../src/artifacts.ts'
import { previewKindFor } from '../src/artifacts-shared.ts'

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

describe('splitDelimited', () => {
  it('splits a plain line', () => {
    expect(splitDelimited('gene,lfc,padj', ',')).toEqual(['gene', 'lfc', 'padj'])
    expect(splitDelimited('a\tb', '\t')).toEqual(['a', 'b'])
  })

  it('keeps a delimiter inside a quoted field', () => {
    // The reason this function exists rather than a .split(). Gene descriptions
    // are full of commas, and a preview that shifts every column after one is
    // worse than no preview: it invites a conclusion from a misread table.
    expect(splitDelimited('TP53,"tumor protein p53, isoform a",2.1', ','))
      .toEqual(['TP53', 'tumor protein p53, isoform a', '2.1'])
  })

  it('reads a doubled quote as one literal quote', () => {
    expect(splitDelimited('a,"say ""hi""",b', ',')).toEqual(['a', 'say "hi"', 'b'])
  })

  it('keeps empty fields, including a trailing one', () => {
    expect(splitDelimited('a,,c,', ',')).toEqual(['a', '', 'c', ''])
  })
})

describe('previewKindFor', () => {
  it.each([
    ['volcano.png', 'image'],
    ['hits.csv', 'table'],
    ['counts.tsv', 'table'],
    ['notes.md', 'text'],
    ['run.log', 'text'],
    ['model.pkl', 'none'],
    ['noextension', 'none'],
  ])('classifies %s as %s', (name, kind) => {
    expect(previewKindFor(name)).toBe(kind)
  })

  it('does not render svg or html as an image', () => {
    // Both are documents that can carry script, and an agent writes these. An
    // inline render would hand it the harness's own origin; source is safe.
    expect(previewKindFor('figure.svg')).toBe('text')
    expect(previewKindFor('report.html')).toBe('text')
  })
})

describe('previewArtifact', () => {
  const previewOf = async (name: string) => {
    const path = (await resolveArtifact(root, name))!
    expect(path).toBeDefined()
    return previewArtifact(path, name)
  }

  it('parses a delimited file into a header and rows', async () => {
    const preview = await previewOf('hits.csv')
    expect(preview.kind).toBe('table')
    expect(preview.rows).toEqual([['gene', 'lfc'], ['TP53', '2.1']])
    expect(preview.truncated).toBeUndefined()
  })

  it('inlines a small raster as a data URL with its real type', async () => {
    const preview = await previewOf('figures/volcano.png')
    expect(preview.kind).toBe('image')
    expect(preview.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('shows a text file as its head', async () => {
    writeFileSync(join(root, 'notes.md'), '# results\nnothing surprising\n')
    const preview = await previewOf('notes.md')
    expect(preview.kind).toBe('text')
    expect(preview.text).toContain('nothing surprising')
  })

  it('caps a table at MAX_TABLE_ROWS and says it did', async () => {
    const rows = ['gene,lfc', ...Array.from({ length: 200 }, (_, i) => `G${i},1.0`)]
    writeFileSync(join(root, 'many.csv'), `${rows.join('\n')}\n`)
    const preview = await previewOf('many.csv')
    expect(preview.rows).toHaveLength(MAX_TABLE_ROWS)
    // Silent truncation is the failure mode worth avoiding: 50 rows that look
    // like the whole file is how someone concludes a gene is absent.
    expect(preview.truncated).toBe(true)
  })

  it('caps the width too', async () => {
    const header = Array.from({ length: 100 }, (_, i) => `c${i}`).join(',')
    writeFileSync(join(root, 'wide.csv'), `${header}\n`)
    const preview = await previewOf('wide.csv')
    expect(preview.rows![0]).toHaveLength(MAX_TABLE_COLUMNS)
  })

  it('drops the partial last line when the read was cut short', async () => {
    // A row half-read from a 64 KB boundary is a row the file does not contain.
    const row = `${'x'.repeat(200)},1`
    const count = Math.ceil(MAX_TEXT_PREVIEW_BYTES / (row.length + 1)) + 10
    writeFileSync(join(root, 'long.csv'), `a,b\n${Array.from({ length: count }, () => row).join('\n')}\n`)
    const preview = await previewOf('long.csv')
    expect(preview.truncated).toBe(true)
    for (const parsed of preview.rows!) expect(parsed).toHaveLength(2)
  })

  it('refuses an image past the inline limit rather than sending it', async () => {
    writeFileSync(join(root, 'huge.png'), Buffer.alloc(MAX_IMAGE_PREVIEW_BYTES + 1))
    const preview = await previewOf('huge.png')
    expect(preview.kind).toBe('none')
    expect(preview.dataUrl).toBeUndefined()
    expect(preview.reason).toContain('limit')
  })

  it('has no preview for an unknown type, and says so', async () => {
    writeFileSync(join(root, 'model.pkl'), Buffer.alloc(64))
    const preview = await previewOf('model.pkl')
    expect(preview.kind).toBe('none')
    expect(preview.reason).toBeTruthy()
  })

  it('reports an empty file as empty rather than as a blank table', async () => {
    writeFileSync(join(root, 'empty.csv'), '')
    const preview = await previewOf('empty.csv')
    expect(preview.kind).toBe('none')
    expect(preview.reason).toContain('empty')
  })

  it('always reports the real size, whatever it shows', async () => {
    const preview = await previewOf('hits.csv')
    expect(preview.bytes).toBe('gene,lfc\nTP53,2.1\n'.length)
  })
})
