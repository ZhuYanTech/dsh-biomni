/**
 * Skills shipped as markdown with the package.
 *
 * These are the complement to the generated per-module catalog. A generated
 * skill answers "what functions exist and how do I call them"; it cannot answer
 * "how should this work be organized", because that knowledge is not in
 * Biomni's metadata — it comes from Biomni's own agent protocol and from
 * failures measured in this deployment.
 *
 * They are served through the same provider as the generated ones rather than
 * installed into `~/.dsh/skills` by a script, so they arrive with the plugin,
 * need no second install step, and work identically in both install channels.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The shipped `skills/` directory. Resolves for both the published layout
 * (`lib/index.js` → `<pkg>/skills`) and running from source
 * (`src/skills/static.ts` → `<repo>/skills`).
 */
function skillsDir(): string | undefined {
  const candidates = [
    resolve(HERE, '..', 'skills'), // built: lib/index.js → <pkg>/skills
    resolve(HERE, '..', '..', 'skills'), // source: src/skills/ → <repo>/skills
  ]
  return candidates.find(candidate => existsSync(join(candidate, 'biomni-workflow', 'SKILL.md')))
}

/** One shipped skill: its routing metadata plus the body. */
export interface StaticSkill {
  name: string
  description: string
  whenToUse?: string
  content: string
  /** Absolute path of the SKILL.md, so the loader can report where it came from. */
  path: string
}

/**
 * Split YAML frontmatter from a markdown body.
 *
 * Deliberately minimal: only `key: value` on one line, which is all these
 * files use. A real YAML parser would be a dependency for no gain, and a
 * half-parser that silently mishandles block scalars would be worse than one
 * that only accepts what it understands.
 */
function parseFrontmatter(source: string): { fields: Record<string, string>; body: string } {
  if (!source.startsWith('---\n')) return { fields: {}, body: source }
  const end = source.indexOf('\n---', 4)
  if (end < 0) return { fields: {}, body: source }
  const fields: Record<string, string> = {}
  for (const line of source.slice(4, end).split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key !== '' && value !== '') fields[key] = value
  }
  // Skip past the closing delimiter's own line.
  const bodyStart = source.indexOf('\n', end + 1)
  return { fields, body: bodyStart < 0 ? '' : source.slice(bodyStart + 1) }
}

/**
 * Load every shipped skill.
 *
 * A malformed or unreadable bundle is skipped rather than thrown: one bad file
 * must not cost the whole catalog, including the generated half.
 */
export function loadStaticSkills(): StaticSkill[] {
  const directory = skillsDir()
  if (directory === undefined) return []

  const skills: StaticSkill[] = []
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }

  for (const entry of entries.sort()) {
    const path = join(directory, entry, 'SKILL.md')
    if (!existsSync(path)) continue
    let source: string
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const { fields, body } = parseFrontmatter(source)
    // The registry keys on the name and routes on the description; without
    // both, the entry is not usable and a silent partial is worse than absence.
    const name = fields.name ?? entry
    const description = fields.description
    if (description === undefined || body.trim() === '') continue
    skills.push({
      name,
      description,
      ...(fields.whenToUse === undefined ? {} : { whenToUse: fields.whenToUse }),
      content: body,
      path,
    })
  }
  return skills
}
