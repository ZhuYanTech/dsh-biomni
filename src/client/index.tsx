/**
 * Client half of dsh-biomni.
 *
 * It contributes exactly one thing: the Biomni section in the DSH Settings
 * shell. There is no panel, no portal, and no mounted React root of its own —
 * the plugin's user surface is a settings page, so the slot system carries it.
 *
 * Registration goes through `ctx.slots.inject('settings.section', …)`, which is
 * a no-op until the settings shell declares that slot, so ordering is not this
 * plugin's problem. The section reads and writes the `biomni` namespace through
 * the plugin's own fenced routes rather than DSH's settings RPC: that RPC
 * filters `settings.describe` through a hardcoded allowlist of seven built-in
 * namespaces, so a third-party card built on it can neither read nor write.
 * See src/api.ts.
 */
import type { Context } from '../context-types.ts'
import { BiomniSection } from './BiomniSection.tsx'
import { LOCALE_NS, attachLocale, t, zh, en } from './locales.ts'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, locale).
 */
export function apply(ctx: Context): void {
  // Follow the DSH i18n system: attach the locale service so `t()` resolves
  // the Host-backed language preference, and register the dictionaries into
  // the shared registry. The disposers run on fiber disposal, so re-activation
  // (HMR) re-registers cleanly.
  attachLocale(ctx.locale)
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    return () => { offZh(); offEn() }
  }, 'dsh-biomni: dictionaries')

  // The Biomni settings section: appears in the DSH Settings shell once the
  // shell's declaration is on the ledger (slots.inject waits for it).
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'biomni',
    order: 120,
    label: () => t('settingsNav'),
  }, BiomniSection))
}
