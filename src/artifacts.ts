/**
 * The output directory, as something the operator can see and take away.
 *
 * `run_python` returns text, and text has a ceiling — 16k characters, because
 * whatever comes back is pasted into the model's next request. That ceiling is
 * right for a transcript and useless for a result: a plot cannot be printed at
 * all, and a real table printed is a real table truncated.
 *
 * So the interpreter writes into a known directory, each call reports what it
 * wrote, and this module is the other end: what is in there, and a way to get
 * it out. It is reporting plus reading — nothing here creates or deletes, and
 * the agent's own writes stay the only thing that fills it.
 *
 * The read path is the security-relevant one. Names come back from a listing
 * of one directory and go out through `resolveArtifact`, which re-derives the
 * absolute path and refuses anything that escapes the root. A name is a
 * lookup key, never a path fragment to be trusted.
 */
import type { Stats } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { DELIMITED, RASTER, TEXTUAL, extensionOf, type PreviewKind } from './artifacts-shared.ts'

/** One file the interpreter produced. */
export interface Artifact {
  /** Path relative to the output directory, POSIX-style. */
  name: string
  bytes: number
  /** Last-modified time, epoch milliseconds. */
  modified: number
}

/** The output directory as it currently stands. */
export interface ArtifactListing {
  /** Absolute directory, whether or not it exists yet. */
  path: string
  /** False until the interpreter first writes something. */
  exists: boolean
  totalBytes: number
  entries: Artifact[]
}

/** How many files a listing returns before it stops walking. */
const MAX_ENTRIES = 500

/**
 * List the output directory, newest first.
 *
 * An absent directory is a normal answer, not an error: a session that has not
 * written anything yet has an empty outbox, and saying so beats a stack trace.
 */
export async function listArtifacts(root: string): Promise<ArtifactListing> {
  const path = resolve(root)
  const entries: Artifact[] = []
  let totalBytes = 0

  const walk = async (directory: string): Promise<void> => {
    if (entries.length >= MAX_ENTRIES) return
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      if (entries.length >= MAX_ENTRIES) return
      const full = join(directory, child.name)
      if (child.isDirectory()) {
        await walk(full)
        continue
      }
      if (!child.isFile()) continue
      let info: Stats
      try {
        info = await stat(full)
      } catch {
        continue
      }
      entries.push({
        name: relative(path, full).split(sep).join('/'),
        bytes: info.size,
        modified: Math.round(info.mtimeMs),
      })
      totalBytes += info.size
    }
  }

  let exists = false
  try {
    exists = (await stat(path)).isDirectory()
  } catch {
    exists = false
  }
  if (exists) await walk(path)

  entries.sort((a, b) => b.modified - a.modified)
  return { path, exists, totalBytes, entries }
}

/**
 * Resolve one artifact name to an absolute path inside the root.
 *
 * The containment check is the point. A name arrives over HTTP, and
 * `../../etc/passwd` resolves to something real; comparing against the root is
 * what makes that a 404 rather than a file read. Checked after resolution
 * rather than by inspecting the string, because the ways to write an escaping
 * path outnumber the ways to spot one.
 *
 * The comparison is on REAL paths, not lexical ones. `path.resolve` folds away
 * `..` but does not follow symlinks, and the thing filling this directory is
 * an agent that can call `os.symlink`: a link at `BIOMNI_OUT/notes.txt`
 * pointing at `/etc/passwd` passes every lexical test and reads the target.
 * Resolving both sides through the filesystem is what closes that, and it is
 * why this function is async.
 *
 * @returns the real absolute path, or undefined when the name escapes, is
 * absent, or is not a regular file.
 */
export async function resolveArtifact(root: string, name: string): Promise<string | undefined> {
  if (name === '' || name.includes('\0')) return undefined

  let base: string
  try {
    base = await realpath(resolve(root))
  } catch {
    // No output directory yet means nothing can be served from it.
    return undefined
  }

  let candidate: string
  try {
    candidate = await realpath(resolve(base, name))
  } catch {
    return undefined
  }

  // `startsWith(base)` alone would accept a sibling named `biomni-out-evil`.
  if (candidate !== base && !candidate.startsWith(base + sep)) return undefined
  try {
    if (!(await stat(candidate)).isFile()) return undefined
  } catch {
    return undefined
  }
  return candidate
}

/**
 * Largest artifact the download route will serve.
 *
 * The webserver seam this plugin can reach takes a whole body, not a stream,
 * so a download is a read into memory — and an agent that writes a 2 GB
 * parquet should not be able to make the harness allocate it. Beyond this the
 * route refuses and names the path instead, which costs the operator nothing:
 * the file is in their own workspace, and the browser was only ever a
 * convenience over opening it.
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** Read one artifact, or report that it is too large to serve. */
export async function readArtifact(
  path: string,
): Promise<{ body: Uint8Array } | { tooLarge: number }> {
  const info = await stat(path)
  if (info.size > MAX_DOWNLOAD_BYTES) return { tooLarge: info.size }
  return { body: await readFile(path) }
}

/** A conservative content type, by extension. */
export function contentTypeOf(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    gif: 'image/gif',
    pdf: 'application/pdf',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/plain',
  }
  // Deliberately not text/html: an artifact is model-generated content served
  // from the harness's own origin, and rendering it there would make a written
  // file a scripting surface. Anything unrecognised downloads rather than
  // renders, for the same reason.
  return known[extension] ?? 'application/octet-stream'
}

/** Render the listing for a terminal (`/biomni-out`). */
export function renderArtifacts(listing: ArtifactListing): string {
  if (!listing.exists || listing.entries.length === 0) {
    return [
      `Output directory  ${listing.path}`,
      '',
      'Nothing written yet. The interpreter has this bound as `BIOMNI_OUT`; anything',
      'it saves there is listed here and downloadable from Settings → Biomni.',
    ].join('\n')
  }

  const size = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit += 1
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
  }

  const lines = [
    `Output directory  ${listing.path}`,
    `Files             ${listing.entries.length}, ${size(listing.totalBytes)} total`,
    '',
  ]
  for (const entry of listing.entries) {
    lines.push(`  ${size(entry.bytes).padStart(8)}  ${entry.name}`)
  }
  if (listing.entries.length >= MAX_ENTRIES) {
    lines.push('', `Listing stopped at ${MAX_ENTRIES} files.`)
  }
  return lines.join('\n')
}

// ── Previews ────────────────────────────────────────────────────────────────
// Downloading answers "give me the file". The question people actually arrive
// with is "did this run produce the right thing", and that one is answered by
// looking, not by saving to disk and opening another application.
//
// Everything here is bounded before it is read. A preview of a 2 GB parquet is
// not a preview, and the response seam takes a whole body rather than a
// stream, so the caps are what keep a preview from becoming an allocation.

/** Largest image inlined as a data URL. Base64 inflates by about a third. */
export const MAX_IMAGE_PREVIEW_BYTES = 2 * 1024 * 1024

/** Bytes of a text file read for the head preview. */
export const MAX_TEXT_PREVIEW_BYTES = 64 * 1024

/** Rows and columns a table preview renders before stopping. */
export const MAX_TABLE_ROWS = 50
export const MAX_TABLE_COLUMNS = 30

export type { PreviewKind }

/** One artifact, as much of it as is safe and useful to show. */
export interface ArtifactPreview {
  name: string
  kind: PreviewKind
  bytes: number
  /** Data URL, for `kind: 'image'`. */
  dataUrl?: string
  /** Header plus rows, for `kind: 'table'`. */
  rows?: string[][]
  /** Decoded head, for `kind: 'text'`. */
  text?: string
  /** Whether what is shown is less than what is there. */
  truncated?: boolean
  /** Why there is nothing to show, for `kind: 'none'`. */
  reason?: string
}

/**
 * Split one delimited line, honouring RFC 4180 quoting.
 *
 * Worth doing properly rather than splitting on the delimiter: a quoted field
 * containing a comma is ordinary in biological data (gene descriptions are
 * full of them), and a preview that silently shifts every column after it is
 * worse than no preview — it invites a conclusion from a misread table.
 */
export function splitDelimited(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (quoted) {
      if (char !== '"') { field += char; continue }
      // A doubled quote inside a quoted field is one literal quote.
      if (line[index + 1] === '"') { field += '"'; index += 1; continue }
      quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === delimiter) { fields.push(field); field = ''; continue }
    field += char
  }
  fields.push(field)
  return fields
}

/**
 * Read as much of one artifact as is worth showing.
 *
 * @param path - already through `resolveArtifact`; this does no containment
 *   checking of its own and must never be called with an unchecked path.
 * @param name - the display name, which decides how the bytes are read.
 */
export async function previewArtifact(path: string, name: string): Promise<ArtifactPreview> {
  const info = await stat(path)
  const bytes = info.size
  const extension = extensionOf(name)
  const base: ArtifactPreview = { name, kind: 'none', bytes }

  if (bytes === 0) return { ...base, reason: 'empty file' }

  if (RASTER.has(extension)) {
    if (bytes > MAX_IMAGE_PREVIEW_BYTES) {
      return { ...base, reason: `image is ${bytes} bytes, over the inline preview limit` }
    }
    const body = await readFile(path)
    const mime = contentTypeOf(name)
    return { ...base, kind: 'image', dataUrl: `data:${mime};base64,${body.toString('base64')}` }
  }

  // SVG and HTML fall through to the text branch rather than being rendered;
  // artifacts-shared.ts says why.
  const delimiter = DELIMITED[extension]
  if (delimiter !== undefined || TEXTUAL.has(extension)) {
    const handle = await readFile(path)
    const slice = handle.subarray(0, MAX_TEXT_PREVIEW_BYTES)
    const truncated = bytes > slice.byteLength
    const text = new TextDecoder('utf-8', { fatal: false }).decode(slice)

    if (delimiter === undefined) {
      return { ...base, kind: 'text', text, ...(truncated ? { truncated } : {}) }
    }

    // Drop a trailing partial line when the read was cut short, so the table
    // never shows a row that does not exist in the file.
    const lines = text.split(/\r?\n/)
    if (truncated && lines.length > 1) lines.pop()
    const rows = lines
      .filter(line => line !== '')
      .slice(0, MAX_TABLE_ROWS)
      .map(line => splitDelimited(line, delimiter).slice(0, MAX_TABLE_COLUMNS))
    if (rows.length === 0) return { ...base, reason: 'no rows' }
    return {
      ...base,
      kind: 'table',
      rows,
      ...(truncated || lines.filter(l => l !== '').length > MAX_TABLE_ROWS ? { truncated: true } : {}),
    }
  }

  return { ...base, reason: 'no preview for this file type' }
}
