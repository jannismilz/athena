/** The `/login` page that turns MCP_TOKEN into an approved OAuth session. */

import { clientKey, escapeHtml, renderLoginPage } from '@athena/core'
import express, { type Request, type Response, type Router } from 'express'
import type { AthenaOAuthProvider } from './provider.ts'

/**
 * Client address, used only for throttling and never for authorisation.
 *
 * Express resolves this from X-Forwarded-For, but only for proxies it trusts,
 * which is loopback alone. A remote client cannot forge it.
 */
function clientIp(req: Request): string {
  return clientKey(req.ip)
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
        action: '/login',
        purpose: 'Approve this AI client so it can read and write your wiki.',
        hidden: { sid },
        ...(pending?.params.redirectUri
          ? {
              notice: `The client returns to <code>${escapeHtml(
                String(pending.params.redirectUri),
              )}</code>.`,
            }
          : {}),
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
          action: '/login',
          purpose: 'Approve this AI client so it can read and write your wiki.',
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
          action: '/login',
          purpose: 'Approve this AI client so it can read and write your wiki.',
          ...(linkBurned ? {} : { hidden: { sid } }),
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
