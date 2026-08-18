import { describe, expect, test } from 'bun:test'
import { fillGaps, formatCount, relativeAge, toIso } from './metrics.ts'

describe('formatCount', () => {
  test('abbreviates large numbers only', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(1500)).toBe('1.5k')
    expect(formatCount(15_000)).toBe('15k')
    expect(formatCount(2_500_000)).toBe('2.5M')
  })
})

describe('relativeAge', () => {
  test('describes recent and distant times', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    expect(relativeAge(ago(120_000))).toBe('2 min ago')
    expect(relativeAge(ago(5 * 3_600_000))).toBe('5 h ago')
    expect(relativeAge(ago(3 * 86_400_000))).toBe('3 d ago')
  })

  test('handles missing and unparseable values', () => {
    expect(relativeAge(null)).toBe('never')
    expect(relativeAge('not-a-date')).toBe('unknown')
  })
})

describe('fillGaps', () => {
  // A day with no activity is a real zero. Dropping it would make the chart lie
  // by compressing quiet periods out of existence.
  test('produces one point per day including silent ones', () => {
    const today = new Date().toISOString().slice(0, 10)
    const filled = fillGaps([{ date: today, value: 5 }], 7)
    expect(filled).toHaveLength(7)
    expect(filled.at(-1)).toEqual({ date: today, value: 5 })
    expect(filled.slice(0, 6).every(p => p.value === 0)).toBe(true)
  })

  test('is chronological', () => {
    const dates = fillGaps([], 5).map(p => p.date)
    expect([...dates].sort()).toEqual(dates)
  })
})

describe('toIso', () => {
  // The Postgres driver returns Date objects for timestamptz columns. Treating
  // one as a string produced NaN timestamps and a 500 on every dashboard load,
  // so this conversion is load-bearing.
  test('converts a Date to an ISO string', () => {
    const date = new Date('2026-08-18T10:00:00.000Z')
    expect(toIso(date)).toBe('2026-08-18T10:00:00.000Z')
  })

  test('passes an existing string through', () => {
    expect(toIso('2026-08-18T10:00:00Z')).toBe('2026-08-18T10:00:00Z')
  })

  test('returns null for empty, invalid and missing values', () => {
    expect(toIso(null)).toBeNull()
    expect(toIso(undefined)).toBeNull()
    expect(toIso('')).toBeNull()
    expect(toIso(new Date('nonsense'))).toBeNull()
    expect(toIso(12345)).toBeNull()
  })

  test('its output is always parseable, which is what callers rely on', () => {
    const iso = toIso(new Date('2026-01-01T00:00:00Z'))!
    expect(Number.isNaN(Date.parse(iso))).toBe(false)
  })
})
