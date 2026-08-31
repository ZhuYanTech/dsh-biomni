/**
 * Where the shipped Python assets live, resolved from this module rather than
 * from `process.cwd()`.
 *
 * The published package puts `lib/index.js` one level under the package root
 * and `python/*.py` directly under it, so the built bundle resolves `../python`.
 * Running from source (`src/python/paths.ts`) needs `../../python`. Probing for
 * the file keeps both layouts working without a build-time define.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Resolve one shipped python asset by file name. */
function assetPath(fileName: string): string {
  const candidates = [
    resolve(HERE, '..', 'python', fileName), // built: lib/index.js → <pkg>/python
    resolve(HERE, '..', '..', 'python', fileName), // source: src/python/ → <repo>/python
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? join(HERE, '..', 'python', fileName)
}

/** The persistent interpreter worker driven over stdio. */
export const WORKER_PATH = assetPath('worker.py')

/** The one-shot environment survey. */
export const PROBE_PATH = assetPath('probe.py')

/** The one-shot skill-catalog generator. */
export const SKILLS_PATH = assetPath('skills.py')

/** The data lake catalog reader and per-dataset fetcher. */
export const FETCH_PATH = assetPath('fetch.py')

/**
 * The per-workspace directory the interpreter writes results into, relative to
 * the sandbox workspace root.
 *
 * Visible rather than dot-prefixed: these are the user's outputs, and a plot
 * they cannot find in a file browser may as well not exist.
 */
export const OUTPUT_DIR_NAME = 'biomni-out'
