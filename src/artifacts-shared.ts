/**
 * How an artifact's name decides what a preview of it looks like — shared by
 * BOTH halves, and shared deliberately.
 *
 * The host reads the bytes; the client decides whether to offer a Preview
 * control at all. Those two have to agree, and the failure when they drift is
 * quiet: a button that always answers "no preview for this file type", or a
 * previewable file with no way to ask. One table, imported by both, is what
 * keeps them honest.
 *
 * Kept free of `node:` imports so the browser bundle can take it.
 */

/** What a preview turned out to be. */
export type PreviewKind = 'image' | 'table' | 'text' | 'none'

/** Extensions rendered as an inline raster. */
export const RASTER = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

/** Extensions parsed into a table, mapped to their delimiter. */
export const DELIMITED: Record<string, string> = { csv: ',', tsv: '\t' }

/**
 * Extensions shown as a text head.
 *
 * `svg` and `html` are in here rather than among the rasters on purpose: both
 * are documents that can carry script, and these files are written by an
 * agent. Rendering one inside the settings page would hand it the harness's
 * own origin, so they are shown as source.
 */
export const TEXTUAL = new Set([
  'txt', 'md', 'json', 'log', 'yaml', 'yml',
  'fasta', 'fa', 'fastq', 'bed', 'gff', 'gtf', 'vcf', 'sam', 'nwk',
  'py', 'r', 'sh', 'xml', 'svg', 'html',
])

/** Lower-cased extension, or '' when the name carries none. */
export function extensionOf(name: string): string {
  const cut = name.lastIndexOf('.')
  return cut < 0 ? '' : name.slice(cut + 1).toLowerCase()
}

/**
 * What a preview of this name would be, from the name alone.
 *
 * Cheap and side-effect free, so the client can ask it per row. The host still
 * returns `none` for a file that is too large or turns out to be empty — the
 * name promises a shape, not a result.
 */
export function previewKindFor(name: string): PreviewKind {
  const extension = extensionOf(name)
  if (RASTER.has(extension)) return 'image'
  if (DELIMITED[extension] !== undefined) return 'table'
  if (TEXTUAL.has(extension)) return 'text'
  return 'none'
}
