/**
 * The client's prefs validation. Every malformed field must fall back to its
 * default rather than reaching a control: the settings surface has to keep
 * working when the settings document is absent, stale, or hand-edited.
 */
import { describe, expect, it } from 'vitest'
import {
  BIOMNI_PREFS_DEFAULTS,
  clampIdleTimeoutMs,
  clampTimeoutMs,
  IDLE_TIMEOUT_MS_MAX,
  IDLE_TIMEOUT_MS_MIN,
  TIMEOUT_MS_MAX,
  TIMEOUT_MS_MIN,
} from '../src/prefs-shared.ts'
import { parsePrefs } from '../src/client/prefs.ts'

describe('parsePrefs', () => {
  it('returns the defaults for a missing or non-object value', () => {
    expect(parsePrefs(undefined)).toEqual(BIOMNI_PREFS_DEFAULTS)
    expect(parsePrefs(null)).toEqual(BIOMNI_PREFS_DEFAULTS)
    expect(parsePrefs('nope')).toEqual(BIOMNI_PREFS_DEFAULTS)
  })

  it('adopts well-formed values', () => {
    expect(parsePrefs({
      python: '/venv/bin/python',
      timeoutMs: 30_000,
      guardShellPython: false,
      dataPath: '/data/bio',
      idleTimeoutMs: 900_000,
    })).toEqual({
      python: '/venv/bin/python',
      timeoutMs: 30_000,
      guardShellPython: false,
      dataPath: '/data/bio',
      idleTimeoutMs: 900_000,
    })
  })

  it('falls back per field, not wholesale', () => {
    // A single bad field must not discard the good ones next to it.
    expect(parsePrefs({ python: '/venv/bin/python', timeoutMs: 'soon', guardShellPython: 'yes' }))
      .toEqual({
        python: '/venv/bin/python',
        timeoutMs: BIOMNI_PREFS_DEFAULTS.timeoutMs,
        guardShellPython: BIOMNI_PREFS_DEFAULTS.guardShellPython,
        dataPath: BIOMNI_PREFS_DEFAULTS.dataPath,
        idleTimeoutMs: BIOMNI_PREFS_DEFAULTS.idleTimeoutMs,
      })
  })

  it('rejects an empty interpreter path', () => {
    // An empty string would spawn nothing and fail per call with no clue why.
    expect(parsePrefs({ python: '   ' }).python).toBe(BIOMNI_PREFS_DEFAULTS.python)
  })

  it('keeps an empty data root, which is a meaningful value', () => {
    // Unlike `python`, empty here is not absence: it means resolve the way
    // Biomni does ($BIOMNI_PATH, $BIOMNI_DATA_PATH, ./data). Replacing it with
    // a default would silently pin the lake to one root.
    expect(parsePrefs({ dataPath: '' }).dataPath).toBe('')
    expect(parsePrefs({ dataPath: '/data/bio' }).dataPath).toBe('/data/bio')
    expect(parsePrefs({ dataPath: 42 }).dataPath).toBe(BIOMNI_PREFS_DEFAULTS.dataPath)
  })

  it('clamps a timeout outside the contract range', () => {
    expect(parsePrefs({ timeoutMs: 1 }).timeoutMs).toBe(TIMEOUT_MS_MIN)
    expect(parsePrefs({ timeoutMs: 999_999_999 }).timeoutMs).toBe(TIMEOUT_MS_MAX)
    expect(parsePrefs({ timeoutMs: Number.NaN }).timeoutMs).toBe(BIOMNI_PREFS_DEFAULTS.timeoutMs)
  })

  it('keeps a zero idle timeout, which means never retire', () => {
    // Clamping 0 up to the five-minute floor would turn "leave my interpreters
    // alone" into the single most aggressive setting on the page.
    expect(parsePrefs({ idleTimeoutMs: 0 }).idleTimeoutMs).toBe(0)
    expect(parsePrefs({ idleTimeoutMs: 60_000 }).idleTimeoutMs).toBe(IDLE_TIMEOUT_MS_MIN)
    expect(parsePrefs({ idleTimeoutMs: 'never' }).idleTimeoutMs)
      .toBe(BIOMNI_PREFS_DEFAULTS.idleTimeoutMs)
  })
})

describe('clampIdleTimeoutMs', () => {
  it('bounds a real timeout but passes zero through', () => {
    expect(clampIdleTimeoutMs(1)).toBe(IDLE_TIMEOUT_MS_MIN)
    expect(clampIdleTimeoutMs(0)).toBe(0)
    expect(clampIdleTimeoutMs(-5)).toBe(0)
    expect(clampIdleTimeoutMs(Number.POSITIVE_INFINITY)).toBe(IDLE_TIMEOUT_MS_MAX)
  })
})

describe('clampTimeoutMs', () => {
  it('rounds and bounds', () => {
    expect(clampTimeoutMs(60_000.4)).toBe(60_000)
    expect(clampTimeoutMs(0)).toBe(TIMEOUT_MS_MIN)
    expect(clampTimeoutMs(Number.POSITIVE_INFINITY)).toBe(TIMEOUT_MS_MAX)
  })
})
