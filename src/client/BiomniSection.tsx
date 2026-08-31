/**
 * The Biomni settings section, rendered natively in the DSH Settings shell
 * (nav label "Biomni").
 *
 * Two groups:
 *
 * - **解释器 / Interpreter** — the three user-editable settings (`python`,
 *   `timeoutMs`, `guardShellPython`) as DSH settings rows. Writes ride the
 *   plugin's OWN fenced settings route: the host calls the settings seam
 *   in-process, because DSH's settings RPC domain filters `settings.describe`
 *   through a hardcoded allowlist that no third-party namespace can join. Any
 *   failure reverts the optimistic UI and shows the wire error inline — a
 *   broken settings surface never crashes the shell.
 *
 * - **环境 / Environment** — the probe report. This is the part that earns the
 *   panel. Biomni hides its real dependencies behind two independent gates,
 *   and the difference between them is invisible from the outside: a module
 *   that imports cleanly can still have functions that raise
 *   `ModuleNotFoundError` when called, because they import lazily in the body.
 *   So the report shows importable and callable as two SEPARATE numbers, lists
 *   what blocks each, and hands over a `pip install` line for the packages that
 *   would buy back the most functions.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
// Type-only: pulls the settings shell's SlotMap merges ('settings.section').
// Erased at compile time, so it never reaches the bundle's purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  clampTimeoutMs,
  TIMEOUT_MS_MAX,
  TIMEOUT_MS_MIN,
  type BiomniPrefs,
  type ProbeReport,
} from '../prefs-shared.ts'
import { api, BiomniApiError, type ProbeResult } from './api.ts'
import { DataLake } from './DataLake.tsx'
import { BIOMNI_PREFS_DEFAULTS, parsePrefs } from './prefs.ts'
import { t } from './locales.ts'
import css from './BiomniSection.module.css'

/** How many blocking packages the missing-list shows before summarizing. */
const MISSING_SHOWN = 10

export type BiomniSectionProps = PropsRuntime<'settings.section'>

/** A labelled settings row: title/desc on the left, one control on the right. */
function Row(props: { title: string; desc?: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <span className={css.rowTitle}>{props.title}</span>
        {props.desc !== undefined && <span className={css.rowDesc}>{props.desc}</span>}
      </div>
      <div className={css.control}>{props.children}</div>
    </div>
  )
}

/** A real checkbox (native semantics and focus) behind a styled track/thumb. */
function Switch(props: { checked: boolean; onChange: (next: boolean) => void; label: string }): ReactNode {
  return (
    <label className={css.switch}>
      <input
        type="checkbox"
        className={css.switchInput}
        checked={props.checked}
        aria-label={props.label}
        onChange={event => { props.onChange(event.currentTarget.checked) }}
      />
      <span className={css.switchTrack}><span className={css.switchThumb} /></span>
    </label>
  )
}

/** One `label  value` fact line of the report header. */
function Fact(props: { label: string; value: string; muted?: boolean }): ReactNode {
  return (
    <div className={css.fact}>
      <span className={css.factLabel}>{props.label}</span>
      <span className={props.muted === true ? `${css.factValue} ${css.factMuted}` : css.factValue}>
        {props.value}
      </span>
    </div>
  )
}

export function BiomniSection(_props: BiomniSectionProps): ReactNode {
  const [prefs, setPrefs] = useState<BiomniPrefs>(() => ({ ...BIOMNI_PREFS_DEFAULTS }))
  // Text drafts for the two typed fields: committed on blur/Enter, not on every
  // keystroke — a path is half-invalid while it is being typed, and a settings
  // write per character would fight the revision guard.
  const [pythonDraft, setPythonDraft] = useState<string>(BIOMNI_PREFS_DEFAULTS.python)
  const [dataPathDraft, setDataPathDraft] = useState<string>(BIOMNI_PREFS_DEFAULTS.dataPath)
  const [timeoutDraft, setTimeoutDraft] = useState<string>(String(BIOMNI_PREFS_DEFAULTS.timeoutMs / 1000))
  const [error, setError] = useState<string | null>(null)

  const [probing, setProbing] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [copied, setCopied] = useState(false)

  // The settings document revision (guards concurrent writes). A ref: commits
  // read the freshest value at execution time, no re-render needed.
  const revisionRef = useRef<number | undefined>(undefined)
  // Whether the user already wrote since mount: the mount read must not clobber
  // a newer optimistic edit. The window is milliseconds, but a slow route must
  // never silently revert a just-made change.
  const dirtyRef = useRef(false)
  // Serialize commits: a queued write must observe the previous write's
  // revision; a failed write must not poison the queue for later ones.
  const inFlightRef = useRef<Promise<unknown>>(Promise.resolve())

  /** Adopt one resolved view (mount read, or a write's response). */
  const adopt = useCallback((value: unknown, revision?: number): BiomniPrefs => {
    const next = parsePrefs(value)
    revisionRef.current = revision
    setPrefs(next)
    setPythonDraft(next.python)
    setDataPathDraft(next.dataPath)
    setTimeoutDraft(String(Math.round(next.timeoutMs / 1000)))
    return next
  }, [])

  // Sync the persisted document once on mount: the revision and the current
  // values (another tab may have changed them since the page loaded).
  useEffect(() => {
    let cancelled = false
    void api.settingsGet().then((view) => {
      if (cancelled || dirtyRef.current) {
        // Still take the revision: the next write needs the fresh one even
        // when the values are stale relative to the local edit.
        if (!cancelled) revisionRef.current = view.revision
        return
      }
      adopt(view.value, view.revision)
    }).catch(() => { /* the schema defaults stay authoritative */ })
    return () => { cancelled = true }
  }, [adopt])

  /** Persist one patch through the settings route (serialized, revision-guarded). */
  const commit = useCallback((patch: Partial<BiomniPrefs>): void => {
    dirtyRef.current = true
    const previous = prefs
    // Optimistic: the control must not lag a round trip behind the pointer.
    setPrefs(current => ({ ...current, ...patch }))
    setError(null)
    inFlightRef.current = inFlightRef.current
      .catch(() => undefined)
      .then(async () => {
        try {
          const view = await api.settingsUpdate(patch as Record<string, unknown>, revisionRef.current)
          adopt(view.value, view.revision)
        } catch (cause) {
          // Revert the optimistic edit, then say what happened. A conflict is a
          // normal outcome (someone else wrote first), so it re-reads rather
          // than presenting itself as a failure of this edit.
          setPrefs(previous)
          setPythonDraft(previous.python)
          setTimeoutDraft(String(Math.round(previous.timeoutMs / 1000)))
          if (cause instanceof BiomniApiError && cause.code === 'settings-conflict') {
            setError(t('conflict'))
            const view = await api.settingsGet().catch(() => null)
            if (view !== null) adopt(view.value, view.revision)
            return
          }
          setError(`${t('saveFailed')}: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })
  }, [adopt, prefs])

  /** Run the probe. Slow by nature — it starts a Python process. */
  const runProbe = useCallback((): void => {
    setProbing(true)
    setCopied(false)
    void api.envProbe()
      .then((result) => { setProbe(result) })
      .catch((cause: unknown) => {
        setProbe({
          python: prefs.python,
          report: null,
          error: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .finally(() => { setProbing(false) })
  }, [prefs.python])

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('intro')}</p>

      <section className={css.group}>
        <div className={css.groupHeading}>{t('interpreterHeading')}</div>

        {/* A path is long and monospaced, so it takes the row's full width
            underneath its own label rather than being squeezed to the right. */}
        <div className={`${css.row} ${css.pathRow}`}>
          <div className={css.rowText}>
            <span className={css.rowTitle}>{t('pythonLabel')}</span>
            <span className={css.rowDesc}>{t('pythonDesc')}</span>
          </div>
          <input
            type="text"
            className={css.pathInput}
            value={pythonDraft}
            spellCheck={false}
            placeholder={t('pythonPlaceholder')}
            aria-label={t('pythonLabel')}
            onChange={event => { setPythonDraft(event.currentTarget.value) }}
            onBlur={() => {
              const next = pythonDraft.trim()
              if (next === '' || next === prefs.python) {
                setPythonDraft(prefs.python)
                return
              }
              commit({ python: next })
            }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </div>

        {/* Same full-width treatment as the interpreter, and for the same
            reason. Empty is a valid value here — it means "resolve as Biomni
            does" — so blur commits it rather than reverting to the last path. */}
        <div className={`${css.row} ${css.pathRow}`}>
          <div className={css.rowText}>
            <span className={css.rowTitle}>{t('dataPathLabel')}</span>
            <span className={css.rowDesc}>{t('dataPathDesc')}</span>
          </div>
          <input
            type="text"
            className={css.pathInput}
            value={dataPathDraft}
            spellCheck={false}
            placeholder={t('dataPathPlaceholder')}
            aria-label={t('dataPathLabel')}
            onChange={event => { setDataPathDraft(event.currentTarget.value) }}
            onBlur={() => {
              const next = dataPathDraft.trim()
              setDataPathDraft(next)
              if (next !== prefs.dataPath) commit({ dataPath: next })
            }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </div>

        <Row title={t('timeoutLabel')} desc={t('timeoutDesc')}>
          <input
            type="number"
            className={css.numberInput}
            value={timeoutDraft}
            min={Math.ceil(TIMEOUT_MS_MIN / 1000)}
            max={Math.floor(TIMEOUT_MS_MAX / 1000)}
            aria-label={t('timeoutLabel')}
            onChange={event => { setTimeoutDraft(event.currentTarget.value) }}
            onBlur={() => {
              const seconds = Number(timeoutDraft)
              if (!Number.isFinite(seconds)) {
                setTimeoutDraft(String(Math.round(prefs.timeoutMs / 1000)))
                return
              }
              const timeoutMs = clampTimeoutMs(seconds * 1000)
              setTimeoutDraft(String(Math.round(timeoutMs / 1000)))
              if (timeoutMs !== prefs.timeoutMs) commit({ timeoutMs })
            }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
          <span className={css.unit}>{t('timeoutUnit')}</span>
        </Row>

        <Row title={t('guardLabel')} desc={t('guardDesc')}>
          <Switch
            checked={prefs.guardShellPython}
            label={t('guardLabel')}
            onChange={next => { commit({ guardShellPython: next }) }}
          />
        </Row>

        {error !== null && <p className={css.error}>{error}</p>}
      </section>

      <section className={css.group}>
        <div className={css.groupHeading}>
          <span>{t('environmentHeading')}</span>
          <button
            type="button"
            className={css.button}
            disabled={probing}
            onClick={runProbe}
          >
            {probing ? t('probing') : t('probe')}
          </button>
        </div>
        <ProbeView result={probe} copied={copied} onCopied={setCopied} />
      </section>

      {/* Last, and deliberately so: the two groups above report on the
          environment, and this one changes it. */}
      <DataLake />
    </div>
  )
}

/** The probe report, or the reason there isn't one. */
function ProbeView(props: {
  result: ProbeResult | null
  copied: boolean
  onCopied: (copied: boolean) => void
}): ReactNode {
  const { result } = props
  if (result === null) return <p className={css.hint}>{t('neverProbed')}</p>

  if (result.error !== undefined || result.report === null) {
    return (
      <>
        <div className={css.facts}>
          <Fact label={t('interpreterField')} value={result.python} />
        </div>
        <p className={css.error}>{`${t('probeFailed')}: ${result.error ?? 'no report'}`}</p>
      </>
    )
  }

  const report = result.report
  if (report.error !== undefined) {
    return (
      <>
        <div className={css.facts}>
          <Fact label={t('interpreterField')} value={report.executable} />
          <Fact label={t('pythonVersionField')} value={report.python} />
        </div>
        <p className={css.error}>{`${t('probeFailed')}: ${report.error}`}</p>
      </>
    )
  }

  const header = (
    <div className={css.facts}>
      <Fact label={t('interpreterField')} value={report.executable} />
      <Fact label={t('pythonVersionField')} value={report.python} />
      <Fact
        label={t('biomniVersionField')}
        value={report.biomni ?? t('notInstalled')}
        muted={report.biomni === null}
      />
    </div>
  )

  if (report.biomni === null) {
    return (
      <>
        {header}
        <p className={css.hint}>{t('notInstalledHint')}</p>
      </>
    )
  }

  return (
    <>
      {header}
      <BiomniInventory report={report} copied={props.copied} onCopied={props.onCopied} />
    </>
  )
}

/** The two-gate inventory: what imports, what is callable, and what blocks each. */
function BiomniInventory(props: {
  report: ProbeReport
  copied: boolean
  onCopied: (copied: boolean) => void
}): ReactNode {
  const { report } = props
  const importable = report.modules.filter(module => module.importable)
  const broken = report.modules.filter(module => !module.importable)
  const callable = report.totalFunctions - report.blockedFunctions
  const missing = Object.entries(report.missing ?? {})
  const shown = missing.slice(0, MISSING_SHOWN)
  const pipCommand = `pip install ${shown.map(([pkg]) => pkg).join(' ')}`

  return (
    <>
      {/* tqdm/pandas gate EVERY module at once, through biomni.tool.__init__ →
          biomni.utils, and the resulting import error names neither. */}
      {report.gate !== undefined && report.gate.length > 0 && (
        <p className={css.gateWarning}>
          {t('gateWarning', { packages: report.gate.join(' + '), total: report.modules.length })}
        </p>
      )}

      <div className={css.stats}>
        <div className={css.stat}>
          <span className={css.statValue}>{`${importable.length} / ${report.modules.length}`}</span>
          <span className={css.statLabel}>{t('modulesLabel')}</span>
        </div>
        <div className={css.stat}>
          <span className={css.statValue}>{`${callable} / ${report.totalFunctions}`}</span>
          <span className={css.statLabel}>{t('functionsLabel')}</span>
        </div>
      </div>

      {broken.length > 0 && (
        <>
          <div className={css.listHeading}>{t('blockedHeading')}</div>
          <p className={css.hint}>{t('blockedHint')}</p>
          <ul className={css.list}>
            {broken.map(module => (
              <li key={module.name} className={css.listRow}>
                <span className={css.listName}>{module.name}</span>
                <span className={css.listDetail}>{`${t('needs')} ${module.blockers.join(', ')}`}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {missing.length > 0 && (
        <>
          <div className={css.listHeading}>{t('missingHeading')}</div>
          <p className={css.hint}>{t('missingHint')}</p>
          <ul className={css.list}>
            {shown.map(([pkg, count]) => (
              <li key={pkg} className={css.listRow}>
                <span className={css.listName}>{pkg}</span>
                <span className={css.listDetail}>{t('functionsCount', { n: count })}</span>
              </li>
            ))}
            {missing.length > MISSING_SHOWN && (
              <li className={css.listRow}>
                <span className={css.listDetail}>{t('andMore', { n: missing.length - MISSING_SHOWN })}</span>
              </li>
            )}
          </ul>
          <div className={css.pip}>
            <code className={css.pipCommand}>{pipCommand}</code>
            <button
              type="button"
              className={css.button}
              onClick={() => {
                void navigator.clipboard?.writeText(pipCommand)
                  .then(() => { props.onCopied(true) })
                  .catch(() => { /* no clipboard permission: the text is selectable anyway */ })
              }}
            >
              {props.copied ? t('copied') : t('copyPip')}
            </button>
          </div>
        </>
      )}
    </>
  )
}
