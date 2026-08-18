/**
 * Signed session cookies.
 *
 * The cookie never carries the password. It carries an expiry and a nonce,
 * signed with an HMAC keyed on the shared token, so a stolen cookie cannot be
 * turned back into the token and a forged one cannot be signed.
 *
 * Stateless on purpose: there is no session table to persist, and a restart
 * does not log anyone out because the key is derived from configuration rather
 * than from memory. Rotating the token invalidates every session, which is what
 * you want from a rotation.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'athena_session'

/** How long a login lasts before the password is asked for again. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(right, right)
    return false
  }
  return timingSafeEqual(left, right)
}

export function mintSession(secret: string, ttlMs = SESSION_TTL_MS, now = Date.now()): string {
  // The nonce makes two sessions minted in the same millisecond distinct, so a
  // cookie cannot be correlated with another user's by value alone.
  const payload = `${now + ttlMs}.${randomBytes(9).toString('base64url')}`
  return `${payload}.${sign(payload, secret)}`
}

export function verifySession(value: string, secret: string, now = Date.now()): boolean {
  const parts = value.split('.')
  if (parts.length !== 3) return false

  const [expires, nonce, mac] = parts as [string, string, string]
  // Check the signature before trusting any part of the payload.
  if (!safeEqual(mac, sign(`${expires}.${nonce}`, secret))) return false

  const expiresAt = Number(expires)
  return Number.isFinite(expiresAt) && expiresAt > now
}

/** Read one cookie out of a request header without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}
