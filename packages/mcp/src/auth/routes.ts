/** The `/login` page that turns MCP_TOKEN into an approved OAuth session. */

import express, { type Request, type Response, type Router } from 'express'
import { renderLoginPage } from './login-page.ts'
import type { AthenaOAuthProvider } from './provider.ts'

/**
 * Client address, trusting only the reverse proxy header we set ourselves.
 * Used solely for throttling, never for authorisation.
 */
function clientIp(req: Request): string {
  const header = req.headers['x-real-ip']
  const value = Array.isArray(header) ? header[0] : header
  return (value || req.ip || 'unknown').trim()
}

function sendPage(res: Response, html: string, status = 200): void {
  res
    .status(status)
    .set({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    })
    .send(html)
}

export function loginRouter(provider: AthenaOAuthProvider, instanceName: string): Router {
  const router = express.Router()
  router.use(express.urlencoded({ extended: false, limit: '8kb' }))

  router.get('/login', (req, res) => {
    const sid = String(req.query.sid ?? '')
    const pending = provider.getPending(sid)
    sendPage(
      res,
      renderLoginPage({
        instanceName,
        sid,
        redirectUri: pending?.params.redirectUri ?? null,
        ...(pending
          ? {}
          : { error: 'This login link has expired. Reconnect from your AI client.' }),
      }),
      pending ? 200 : 401,
    )
  })

  router.post('/login', (req, res) => {
    const ip = clientIp(req)
    const retryAfter = provider.throttledFor(ip)
    if (retryAfter !== null) {
      res
        .status(429)
        .set('retry-after', String(retryAfter))
        .type('text/plain')
        .send('Too many attempts. Try again later.')
      return
    }

    const body = req.body as { sid?: string; password?: string }
    const sid = String(body.sid ?? '')
    const password = String(body.password ?? '')

    if (!provider.getPending(sid)) {
      sendPage(
        res,
        renderLoginPage({
          instanceName,
          sid: '',
          error: 'This login link has expired. Reconnect from your AI client.',
        }),
        401,
      )
      return
    }

    if (!provider.checkPassword(password)) {
      provider.recordFailure(ip)
      const { linkBurned } = provider.registerFailedAttempt(sid)
      const pending = linkBurned ? undefined : provider.getPending(sid)
      sendPage(
        res,
        renderLoginPage({
          instanceName,
          sid: linkBurned ? '' : sid,
          redirectUri: pending?.params.redirectUri ?? null,
          error: linkBurned
            ? 'Too many failed attempts. Reconnect from your AI client.'
            : 'Wrong password.',
        }),
        401,
      )
      return
    }

    provider.clearFailures(ip)
    res.redirect(302, provider.completeLogin(sid))
  })

  return router
}
