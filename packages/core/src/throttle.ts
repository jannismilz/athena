/**
 * Per-address failure throttle.
 *
 * Anything that checks a secret against an attacker-controlled value needs one
 * of these, otherwise the secret can be guessed at network speed. Shared so the
 * MCP login page and the dashboard behave identically.
 */

export type ThrottleOptions = {
  /** Failures allowed inside the window before the address is locked out. */
  maxFailures?: number
  windowMs?: number
  /** Cap on tracked addresses, so a spray attack cannot exhaust memory. */
  maxTracked?: number
}

export class FailureThrottle {
  private readonly failures = new Map<string, number[]>()
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly maxTracked: number

  constructor(options: ThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5
    this.windowMs = options.windowMs ?? 60_000
    this.maxTracked = options.maxTracked ?? 10_000
  }

  /** Seconds left in the lockout for this address, or null if not throttled. */
  retryAfter(key: string, now = Date.now()): number | null {
    const recent = (this.failures.get(key) ?? []).filter(t => now - t < this.windowMs)
    if (recent.length) this.failures.set(key, recent)
    else this.failures.delete(key)

    if (recent.length < this.maxFailures) return null
    return Math.max(1, Math.ceil((this.windowMs - (now - recent[0]!)) / 1000))
  }

  record(key: string, now = Date.now()): void {
    if (!this.failures.has(key) && this.failures.size >= this.maxTracked) {
      this.evictOldest(now)
    }
    const list = (this.failures.get(key) ?? []).filter(t => now - t < this.windowMs)
    list.push(now)
    this.failures.set(key, list)
  }

  clear(key: string): void {
    this.failures.delete(key)
  }

  private evictOldest(now: number): void {
    for (const [key, times] of this.failures) {
      if (!times.length || now - times[times.length - 1]! >= this.windowMs) {
        this.failures.delete(key)
      }
    }
    // Still full after dropping stale entries: drop the least recently used.
    if (this.failures.size >= this.maxTracked) {
      const oldest = [...this.failures.entries()].sort(
        (a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0),
      )[0]
      if (oldest) this.failures.delete(oldest[0])
    }
  }
}

/**
 * Client address for throttling purposes.
 *
 * Express is configured to trust only loopback, so `req.ip` already reflects
 * the reverse proxy's forwarded address and cannot be set by a remote client.
 */
export function clientKey(ip: string | undefined): string {
  return (ip ?? 'unknown').trim() || 'unknown'
}
