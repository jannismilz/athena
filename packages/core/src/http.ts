/**
 * Shared HTTP hardening.
 *
 * Small, explicit middlewares rather than a framework: each one is here because
 * of a specific attack, and the comment says which.
 */

import { timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

/** Constant-time comparison that does not leak the expected length. */
export function secretsEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

export type SecurityHeaderOptions = {
  /** Set when the page is HTML that should never be framed or sniffed. */
  contentSecurityPolicy?: string
}

/**
 * Baseline response headers.
 *
 * These cost nothing and close off whole classes of problem: MIME sniffing,
 * clickjacking, and referrer leakage of authenticated URLs to third parties.
 */
export function securityHeaders(options: SecurityHeaderOptions = {}) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.set({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'geolocation=(), microphone=(), camera=()',
    })
    if (options.contentSecurityPolicy) {
      res.set('content-security-policy', options.contentSecurityPolicy)
    }
    next()
  }
}

/**
 * Reject cross-site form posts.
 *
 * The session cookie is SameSite=Strict, which already stops a third-party page
 * from posting with your credentials on every current browser. This is the
 * belt to that pair of braces, and it costs one header comparison: a form post
 * must come from this same host.
 */
export function sameOriginOnly() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next()
      return
    }

    const origin = req.get('origin')
    const host = req.get('host')

    // A same-origin form post from a browser sends Origin. Anything that sends
    // one from somewhere else is cross-site and refused. Requests with no
    // Origin at all are command-line clients, which carry no ambient cookies.
    if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        originHost = ''
      }
      if (!originHost || !host || originHost !== host) {
        res.status(403).type('text/plain').send('Cross-site request refused.')
        return
      }
    }
    next()
  }
}

/** Authenticated pages must never be cached by a proxy or written to disk. */
export function noStore(res: Response): void {
  res.set('cache-control', 'no-store, no-cache, must-revalidate, private')
}
