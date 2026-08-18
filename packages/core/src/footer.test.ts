import { describe, expect, test } from 'bun:test'
import { applyCreateFooter, applyUpdateFooter, formatStamp, splitFooter } from './footer.ts'

const TZ = 'Europe/Berlin'
const utc = (...a: [number, number, number, number, number]) =>
  new Date(Date.UTC(a[0], a[1] - 1, a[2], a[3], a[4]))

describe('splitFooter', () => {
  test('ignores horizontal rules elsewhere in the body', () => {
    const { body, fields } = splitFooter('# DNS\n\n---\n\nInterim.\n\n---\n\nMore text.\n')
    expect(fields).toEqual({})
    expect(body).toContain('Interim')
  })

  test('takes only the trailing footer', () => {
    const { body, fields } = splitFooter(
      '# DNS\n\n---\n\nContent.\n\n---\ncreated: Claude, 2026-08-12 12:03\nupdated: Cursor, 2026-08-15 16:04\n',
    )
    expect(body).toContain('Content.')
    expect(body).not.toContain('created:')
    expect(fields.created).toBe('Claude, 2026-08-12 12:03')
    expect(fields.updated).toBe('Cursor, 2026-08-15 16:04')
  })
})

describe('applyCreateFooter', () => {
  test('writes only created', () => {
    const out = applyCreateFooter('# New page\n\nText.\n', 'Cursor', TZ, utc(2026, 8, 16, 10, 3))
    expect(out.endsWith('created: Cursor, 2026-08-16 12:03\n')).toBe(true)
    expect(out).not.toContain('updated:')
    expect(out.split('---').length - 1).toBe(1)
  })

  test('discards a model-supplied footer', () => {
    const incoming =
      '# Page\n\n---\ncreated: ChatGPT, 1999-01-01 00:00\nupdated: ChatGPT, 1999-01-01 00:00\n'
    const out = applyCreateFooter(incoming, 'Claude', TZ, utc(2026, 8, 16, 10, 3))
    expect(out).not.toContain('1999')
    expect(out).toContain('created: Claude, 2026-08-16 12:03')
    expect(out).not.toContain('updated:')
  })
})

describe('applyUpdateFooter', () => {
  test('keeps created, replaces updated', () => {
    const stored =
      '# Page\n\nOld.\n\n---\ncreated: Claude, 2026-08-12 12:03\nupdated: Cursor, 2026-08-15 16:04\n'
    const next =
      '# Page\n\nNew.\n\n---\ncreated: Claude, 2026-08-12 12:03\nupdated: Cursor, 2026-08-15 16:04\n'
    const out = applyUpdateFooter(next, stored, 'Cursor', TZ, utc(2026, 8, 16, 14, 4))
    expect(out).toContain('created: Claude, 2026-08-12 12:03')
    expect(out).toContain('updated: Cursor, 2026-08-16 16:04')
    expect(out).not.toContain('2026-08-15 16:04')
    expect(out.split('updated:').length - 1).toBe(1)
  })

  test('a second update still leaves one updated line', () => {
    const stored =
      '# Page\n\n---\ncreated: Claude, 2026-08-12 12:03\nupdated: Cursor, 2026-08-16 16:04\n'
    const out = applyUpdateFooter(
      '# Page\n\nNewer still.\n',
      stored,
      'ChatGPT',
      TZ,
      utc(2026, 8, 16, 15, 10),
    )
    expect(out).toContain('created: Claude, 2026-08-12 12:03')
    expect(out).toContain('updated: ChatGPT, 2026-08-16 17:10')
    expect(out.split('updated:').length - 1).toBe(1)
    expect(out.split('created:').length - 1).toBe(1)
  })

  test('a page written by a human gets only updated', () => {
    const stored = '# Manual\n\nWritten in the Wiki.js editor.\n'
    const out = applyUpdateFooter(
      '# Manual\n\nChanged.\n',
      stored,
      'Cursor',
      TZ,
      utc(2026, 8, 16, 10, 0),
    )
    expect(out).not.toContain('created:')
    expect(out).toContain('updated: Cursor, 2026-08-16 12:00')
    expect(out.split('---').length - 1).toBe(1)
  })
})

describe('formatStamp', () => {
  test('honours winter time', () => {
    expect(formatStamp(TZ, utc(2026, 1, 15, 10, 0))).toBe('2026-01-15 11:00')
  })

  test('honours summer time', () => {
    expect(formatStamp(TZ, utc(2026, 8, 16, 10, 3))).toBe('2026-08-16 12:03')
  })

  test('is configurable, not hardcoded to one zone', () => {
    expect(formatStamp('UTC', utc(2026, 1, 15, 10, 0))).toBe('2026-01-15 10:00')
    expect(formatStamp('Asia/Tokyo', utc(2026, 1, 15, 10, 0))).toBe('2026-01-15 19:00')
  })
})
