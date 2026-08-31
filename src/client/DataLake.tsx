/**
 * The data lake browser: the Settings page's one WRITE surface beyond settings.
 *
 * Every other panel here reports. This one acts — it can pull up to 6.2 GB onto
 * the operator's disk — so it is built around making that decision legible
 * rather than easy:
 *
 * - **Size on every row, always.** The catalog spans four orders of magnitude,
 *   from a 4 KB assay table to a 6.2 GB binding database. A list of names with
 *   a Fetch button beside each would make those look like the same action.
 * - **On-disk first.** What is usable right now is the answer to most visits;
 *   the rest is a shopping list.
 * - **The licence is a separate gate, not a warning.** 35 of the 76 datasets
 *   sit outside Biomni's commercial-use subset. The plugin tracks that apart
 *   from availability everywhere else, and this is the point where it binds, so
 *   fetching one needs an explicit acknowledgement that cannot be missed by
 *   clicking through.
 *
 * Fetches run one at a time. Two concurrent multi-GB downloads into the same
 * directory is not a thing anyone means to start from a settings page.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, BiomniApiError } from './api.ts'
import type { DatasetCatalog, DatasetEntry } from './api.ts'
import { t } from './locales.ts'
import css from './BiomniSection.module.css'

/** How many absent datasets render before the list is capped. */
const FETCHABLE_SHOWN = 60

/** Per-dataset transient state, keyed by name. */
type Progress = Record<string, 'fetching' | 'done' | string>

/** One row: size, name, licence mark, and whatever action applies. */
function DatasetRow(props: {
  entry: DatasetEntry
  state: Progress[string] | undefined
  busy: boolean
  onFetch: (entry: DatasetEntry) => void
}): ReactNode {
  const { entry, state, busy } = props
  const restricted = entry.commercial === false

  return (
    <div className={css.listRow}>
      <span className={css.listName}>
        {entry.name}
        {restricted && <span className={css.factMuted}> · {t('nonCommercial')}</span>}
      </span>
      <span className={css.listDetail}>
        {entry.size}
        {entry.present
          ? <> · {t('onDisk')}</>
          : state === 'fetching'
            ? <> · {t('fetching')}</>
            : state === 'done'
              ? <> · {t('fetched')}</>
              : typeof state === 'string'
                ? <> · <span className={css.error}>{state}</span></>
                : (
                    <>
                      {' · '}
                      <button
                        type="button"
                        className={css.rowAction}
                        disabled={busy}
                        onClick={() => { props.onFetch(entry) }}
                      >
                        {t('fetch')}
                      </button>
                    </>
                  )}
      </span>
    </div>
  )
}

/** The data lake group. */
export function DataLake(): ReactNode {
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [progress, setProgress] = useState<Progress>({})
  const [accepted, setAccepted] = useState(false)
  // One fetch at a time; a ref so the guard is read at click time, not render.
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.datasetsList(signal)
      if (result.catalog === null) throw new BiomniApiError('helper', result.error ?? 'no catalog')
      setCatalog(result.catalog)
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

  const onFetch = useCallback(async (entry: DatasetEntry) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProgress(prior => ({ ...prior, [entry.name]: 'fetching' }))
    try {
      const report = await api.datasetsFetch([entry.name], entry.commercial === false)
      const result = report.results[0]
      setProgress(prior => ({
        ...prior,
        [entry.name]: result?.status === 'fetched' || result?.status === 'present'
          ? 'done'
          : result?.detail ?? result?.status ?? 'failed',
      }))
      // Re-read rather than patching locally: the helper is the authority on
      // what is on disk, and a fetch changes the totals as well as one row.
      if (result?.status === 'fetched') await load()
    } catch (cause) {
      setProgress(prior => ({
        ...prior,
        [entry.name]: cause instanceof Error ? cause.message : String(cause),
      }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [load])

  const { present, absent, totalBytes, restrictedAbsent } = useMemo(() => {
    const entries = catalog?.entries ?? []
    const needle = filter.trim().toLowerCase()
    const matches = needle === ''
      ? entries
      : entries.filter(entry =>
          entry.name.toLowerCase().includes(needle)
          || entry.description.toLowerCase().includes(needle))
    return {
      present: matches.filter(entry => entry.present),
      absent: matches.filter(entry => !entry.present),
      totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
      restrictedAbsent: matches.some(entry => !entry.present && entry.commercial === false),
    }
  }, [catalog, filter])

  if (error !== null) {
    return (
      <section className={css.group}>
        <div className={css.groupHeading}>{t('dataLakeHeading')}</div>
        <p className={css.error}>{`${t('dataLakeFailed')}: ${error}`}</p>
      </section>
    )
  }

  if (catalog === null) {
    return (
      <section className={css.group}>
        <div className={css.groupHeading}>{t('dataLakeHeading')}</div>
        <p className={css.hint}>{loading ? t('dataLakeLoading') : t('dataLakeEmpty')}</p>
      </section>
    )
  }

  return (
    <section className={css.group}>
      <div className={css.groupHeading}>{t('dataLakeHeading')}</div>

      <div className={css.stats}>
        <div className={css.stat}>
          <span className={css.statValue}>{`${catalog.present}/${catalog.total}`}</span>
          <span className={css.statLabel}>{t('onDiskLabel')}</span>
        </div>
        <div className={css.stat}>
          <span className={css.statValue}>{`${(totalBytes / 1e9).toFixed(1)} GB`}</span>
          <span className={css.statLabel}>{t('wholeLakeLabel')}</span>
        </div>
      </div>

      <p className={css.hint}>{t('dataLakePath', { path: catalog.path })}</p>

      <input
        type="text"
        className={css.filter}
        value={filter}
        spellCheck={false}
        placeholder={t('dataLakeFilter')}
        aria-label={t('dataLakeFilter')}
        onChange={event => { setFilter(event.currentTarget.value) }}
      />

      {present.length > 0 && (
        <>
          <div className={css.listHeading}>{t('onDiskHeading', { n: present.length })}</div>
          <div className={css.list}>
            {present.map(entry => (
              <DatasetRow key={entry.name} entry={entry} state={progress[entry.name]} busy={busy} onFetch={onFetch} />
            ))}
          </div>
        </>
      )}

      {absent.length > 0 && (
        <>
          <div className={css.listHeading}>{t('fetchableHeading', { n: absent.length })}</div>
          {restrictedAbsent && (
            <label className={css.accept}>
              <input
                type="checkbox"
                checked={accepted}
                onChange={event => { setAccepted(event.currentTarget.checked) }}
              />
              <span className={css.acceptText}>
                <span className={css.rowTitle}>{t('acceptNonCommercial')}</span>
                <span className={css.rowDesc}>{t('acceptNonCommercialDesc')}</span>
              </span>
            </label>
          )}
          <div className={`${css.list} ${css.datasetList}`}>
            {absent.slice(0, FETCHABLE_SHOWN).map(entry => (
              <DatasetRow
                key={entry.name}
                entry={entry}
                state={progress[entry.name]}
                // A restricted dataset stays unfetchable until the box is
                // ticked. Disabling the control is the gate the user sees; the
                // helper refuses independently, so this cannot be clicked past.
                busy={busy || (entry.commercial === false && !accepted)}
                onFetch={onFetch}
              />
            ))}
          </div>
          {absent.length > FETCHABLE_SHOWN && (
            <p className={css.hint}>{t('andMoreDatasets', { n: absent.length - FETCHABLE_SHOWN })}</p>
          )}
        </>
      )}
    </section>
  )
}
