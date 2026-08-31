/**
 * What the work produced.
 *
 * The data lake panel answers "what can I analyse". This one answers "what came
 * out", which until 0.2.0 had no answer anywhere: `run_python` returns text
 * capped at 16k characters, so a plot could not come back at all and a real
 * table came back truncated. The interpreter now writes into a known directory
 * and this is the window onto it.
 *
 * Read-only, deliberately. The agent writes; the operator looks and downloads.
 * A delete button here would be the one control on this page that destroys
 * work, and `rm` is right there in a directory the operator already owns.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from './api.ts'
import type { Artifact, ArtifactListing } from './api.ts'
import { t } from './locales.ts'
import css from './BiomniSection.module.css'

/** How many rows render before the list is capped. */
const SHOWN = 80

/** Bytes as a short human string. */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Coarse relative time; the exact clock is rarely the question here. */
function formatAge(modified: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - modified) / 1000))
  if (seconds < 90) return t('justNow')
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return t('minutesAgo', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 36) return t('hoursAgo', { n: hours })
  return t('daysAgo', { n: Math.round(hours / 24) })
}

function ArtifactRow(props: { entry: Artifact }): ReactNode {
  const { entry } = props
  return (
    <div className={css.listRow}>
      <span className={css.listName}>{entry.name}</span>
      <span className={css.listDetail}>
        {formatBytes(entry.bytes)}
        {' · '}
        {formatAge(entry.modified)}
        {' · '}
        {/* A plain link, not a fetch: the browser's own download handling is
            better than anything reimplemented here, and the route sends the
            file as an attachment. */}
        <a className={css.rowAction} href={api.artifactUrl(entry.name)} download>
          {t('download')}
        </a>
      </span>
    </div>
  )
}

/** The artifacts group. */
export function Artifacts(): ReactNode {
  const [listing, setListing] = useState<ArtifactListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      setListing(await api.artifactsList(signal))
    } catch (cause) {
      if ((cause as Error).name === 'AbortError') return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => { controller.abort() }
  }, [load])

  const body = (): ReactNode => {
    if (error !== null) return <p className={css.error}>{`${t('artifactsFailed')}: ${error}`}</p>
    if (listing === null) return <p className={css.hint}>{loading ? t('artifactsLoading') : t('artifactsEmpty')}</p>

    // An empty directory is the normal state of a fresh session, so it gets an
    // explanation of how it fills rather than a bare "0 files".
    if (listing.entries.length === 0) {
      return (
        <>
          <p className={css.hint}>{t('artifactsNone')}</p>
          <p className={css.hint}>{t('artifactsPath', { path: listing.path })}</p>
        </>
      )
    }

    const shown = listing.entries.slice(0, SHOWN)
    return (
      <>
        <div className={css.stats}>
          <div className={css.stat}>
            <span className={css.statValue}>{String(listing.entries.length)}</span>
            <span className={css.statLabel}>{t('filesLabel')}</span>
          </div>
          <div className={css.stat}>
            <span className={css.statValue}>{formatBytes(listing.totalBytes)}</span>
            <span className={css.statLabel}>{t('totalLabel')}</span>
          </div>
        </div>
        <p className={css.hint}>{t('artifactsPath', { path: listing.path })}</p>
        <div className={`${css.list} ${css.datasetList}`}>
          {shown.map(entry => <ArtifactRow key={entry.name} entry={entry} />)}
        </div>
        {listing.entries.length > SHOWN && (
          <p className={css.hint}>{t('andMoreFiles', { n: listing.entries.length - SHOWN })}</p>
        )}
      </>
    )
  }

  return (
    <section className={css.group}>
      <div className={css.groupHeading}>
        <span>{t('artifactsHeading')}</span>
        <button type="button" className={css.button} disabled={loading} onClick={() => { void load() }}>
          {loading ? t('artifactsLoading') : t('refresh')}
        </button>
      </div>
      {body()}
    </section>
  )
}
