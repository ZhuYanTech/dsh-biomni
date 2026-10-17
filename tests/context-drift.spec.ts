/**
 * Does `src/context-types.ts` still describe the DSH this plugin is built
 * against?
 *
 * WHY THIS FILE EXISTS. The host service faces in `context-types.ts` are
 * hand-written mirrors, and they have to be: the client half must stay free of
 * `node:*`, and the tests have to run with no harness booted. The cost is that
 * `pnpm typecheck` validates our COPY of the API, not the API — so an upstream
 * change lands as a green build and a runtime failure. That is exactly the
 * hazard AGENTS.md §8 records for test stubs ("the stub invented an async
 * `read()`; tests all green, it exploded on real dsh"), one level up, where
 * nothing was watching.
 *
 * The DSH 0.2 migration was found this way: `ctx.settings.register()` had been
 * gone from upstream for a month and the build never noticed.
 *
 * HOW IT WORKS. Type-only imports of the REAL packages, erased at build time,
 * so this adds nothing to any bundle. Each assertion says: *the real thing must
 * be usable where our mirror is expected*. Upstream adding a member is fine;
 * upstream removing or changing one we declare is a compile error, here, at the
 * moment of the upgrade.
 *
 * WHEN THIS FILE FAILS, FIX THE MIRROR — never the assertion. Relaxing an
 * assertion to get green restores the exact blindness it was written to end.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition as RealToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SettingsForms as RealSettings, SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Events as OurEvents } from 'cordis'
import type {
  BiomniSettingsService,
  BiomniToolsService,
} from '../src/context-types.ts'
// Side-effect import: brings this plugin's `declare module 'cordis'`
// augmentation into scope so `OurEvents` carries it.
import '../src/context-types.ts'

/**
 * `Real` must be usable where `Ours` is expected.
 *
 * Resolves to `true` when it holds and to a descriptive object otherwise, so
 * the failure names the pair rather than printing a wall of structural diff.
 */
type Satisfies<Real, Ours> = [Real] extends [Ours] ? true
  : { MIRROR_IS_STALE: 'src/context-types.ts no longer describes the installed DSH'; expected: Ours; actual: Real }

/** Compile-time only; the runtime test below exists so the file reports in CI. */
const assert = <T extends true>(_ok: T): void => {}

// ── The tool service ────────────────────────────────────────────────────────
// `run_python` is the whole plugin. If `register` stops taking what
// `defineTool` produces, nothing model-facing works.
assert<Satisfies<
  (definition: RealToolDefinition) => () => void,
  BiomniToolsService['register']
>>(true)

// ── The settings service ────────────────────────────────────────────────────
// Deliberately asserted, and deliberately the one that broke. DSH 0.2 replaced
// the per-namespace `SettingsProvider` (register → scope with get/watch) with
// `SettingsForms`, which projects a plugin's own Config schema into a form and
// has no `register` at all.
assert<Satisfies<RealSettings, BiomniSettingsService>>(true)

// ── The settings-changed event ──────────────────────────────────────────────
// `scope.watch()` is gone; this event is how the plugin learns that the
// interpreter path changed and that live workers must be retired. A drift here
// would leave `python` edits applying to new sessions only, with old ones
// silently still on the previous interpreter — a wrong answer, not an error.
//
// Declared on `@deepseek-ai/cordis`'s Events upstream and on `cordis`'s here,
// because this plugin's Context comes from the latter; the two never meet, so
// this is the only thing holding the signatures together.
type RealDocumentUpdated = (ns: SettingsNamespace, revision: number) => void
assert<Satisfies<RealDocumentUpdated, OurEvents['settings/document-updated']>>(true)

describe('context-types mirrors the installed DSH', () => {
  it('compiles, which is the entire assertion', () => {
    // The checks above are type-level: `pnpm typecheck` is what runs them.
    // This case exists so a reader scanning the suite sees the guard listed,
    // and so `pnpm test` fails loudly if the file is ever emptied.
    expect(true).toBe(true)
  })
})
