import { describe, expect, test } from 'bun:test'
import { clientKey, FailureThrottle } from './throttle.ts'

describe('FailureThrottle', () => {
  test('allows attempts up to the limit, then locks out', () => {
    const t = new FailureThrottle({ maxFailures: 3, windowMs: 60_000 })
    expect(t.retryAfter('a')).toBeNull()
    t.record('a')
    t.record('a')
    expect(t.retryAfter('a')).toBeNull()
    t.record('a')
    expect(t.retryAfter('a')).toBeGreaterThan(0)
  })

  test('locks out one address without affecting others', () => {
    const t = new FailureThrottle({ maxFailures: 2 })
    t.record('a')
    t.record('a')
    expect(t.retryAfter('a')).toBeGreaterThan(0)
    expect(t.retryAfter('b')).toBeNull()
  })

  test('the window expires', () => {
    const t = new FailureThrottle({ maxFailures: 2, windowMs: 1000 })
    const start = 1_000_000
    t.record('a', start)
    t.record('a', start)
    expect(t.retryAfter('a', start)).toBeGreaterThan(0)
    expect(t.retryAfter('a', start + 1001)).toBeNull()
  })

  test('a success clears the record', () => {
    const t = new FailureThrottle({ maxFailures: 2 })
    t.record('a')
    t.record('a')
    t.clear('a')
    expect(t.retryAfter('a')).toBeNull()
  })

  // Without a cap, an attacker spraying random source addresses grows the map
  // without bound.
  test('tracked addresses are capped', () => {
    const t = new FailureThrottle({ maxFailures: 2, maxTracked: 50 })
    for (let i = 0; i < 500; i++) t.record(`addr-${i}`)
    const internal = (t as unknown as { failures: Map<string, number[]> }).failures
    expect(internal.size).toBeLessThanOrEqual(50)
  })

  test('retryAfter never reports zero while locked', () => {
    const t = new FailureThrottle({ maxFailures: 1, windowMs: 1000 })
    const start = 1_000_000
    t.record('a', start)
    expect(t.retryAfter('a', start + 999)).toBe(1)
  })
})

describe('clientKey', () => {
  test('falls back when the address is missing', () => {
    expect(clientKey(undefined)).toBe('unknown')
    expect(clientKey('  ')).toBe('unknown')
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7')
  })
})
