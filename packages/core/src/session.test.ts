import { describe, expect, test } from 'bun:test'
import { mintSession, readCookie, SESSION_TTL_MS, verifySession } from './session.ts'

const SECRET = 'a-dashboard-token-value'

describe('session cookies', () => {
  test('a freshly minted session verifies', () => {
    expect(verifySession(mintSession(SECRET), SECRET)).toBe(true)
  })

  // The whole point of signing: the cookie must not be the password.
  test('the cookie never contains the secret', () => {
    expect(mintSession(SECRET)).not.toContain(SECRET)
  })

  test('two sessions minted at the same instant differ', () => {
    const now = 1_700_000_000_000
    expect(mintSession(SECRET, SESSION_TTL_MS, now)).not.toBe(
      mintSession(SECRET, SESSION_TTL_MS, now),
    )
  })

  test('a different secret does not verify', () => {
    expect(verifySession(mintSession(SECRET), 'some-other-token')).toBe(false)
  })

  test('an expired session is refused', () => {
    const now = 1_700_000_000_000
    const cookie = mintSession(SECRET, 1000, now)
    expect(verifySession(cookie, SECRET, now + 999)).toBe(true)
    expect(verifySession(cookie, SECRET, now + 1001)).toBe(false)
  })

  test('tampering with the expiry is caught by the signature', () => {
    const cookie = mintSession(SECRET, 1000, 1_700_000_000_000)
    const [, nonce, mac] = cookie.split('.')
    const forged = `${9_999_999_999_999}.${nonce}.${mac}`
    expect(verifySession(forged, SECRET)).toBe(false)
  })

  test('garbage and empty values are refused rather than throwing', () => {
    for (const bad of ['', 'x', 'a.b', 'a.b.c', 'a.b.c.d', '...']) {
      expect(verifySession(bad, SECRET)).toBe(false)
    }
  })

  test('a signature from a different payload does not transfer', () => {
    const a = mintSession(SECRET, SESSION_TTL_MS, 1_700_000_000_000)
    const b = mintSession(SECRET, SESSION_TTL_MS, 1_700_000_000_000)
    const [expA, nonceA] = a.split('.')
    const macB = b.split('.')[2]
    expect(verifySession(`${expA}.${nonceA}.${macB}`, SECRET)).toBe(false)
  })
})

describe('readCookie', () => {
  test('finds a cookie among others', () => {
    expect(readCookie('a=1; athena_session=abc; b=2', 'athena_session')).toBe('abc')
  })

  test('returns empty when absent, malformed or missing', () => {
    expect(readCookie('a=1', 'athena_session')).toBe('')
    expect(readCookie(undefined, 'athena_session')).toBe('')
    expect(readCookie('athena_session', 'athena_session')).toBe('')
  })

  test('does not match a cookie whose name merely ends with the target', () => {
    expect(readCookie('not_athena_session=nope', 'athena_session')).toBe('')
  })

  test('decodes percent-encoding and survives bad encoding', () => {
    expect(readCookie('athena_session=a%20b', 'athena_session')).toBe('a b')
    expect(readCookie('athena_session=%E0%A4%A', 'athena_session')).toBe('')
  })
})
