/**
 * Dashboard HTTP server.
 *
 * Read-only, and protected by a single shared token: it exposes an overview of
 * a private wiki, so it is never open to the internet unauthenticated.
 */

import { timingSafeEqual } from 'node:crypto'
import {
  clientKey,
  type DashboardConfig,
  FailureThrottle,
  type Logger,
  type Sql,
} from '@athena/core'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { activityMetrics, backupStatus, contentMetrics, indexMetrics } from './metrics.ts'
import { renderDashboard } from './page.ts'

const ALLOWED_RANGES = new Set([7, 30, 90])
const STALE_DAYS = 180

function secretsEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/**
 * Token check.
 *
 * Three ways to present it, in order of preference:
 *   Authorization header  for scripts
 *   athena_token cookie   set after the first successful visit
 *   ?token= query         so the dashboard can be opened from a bookmark
 *
 * The query form is exchanged for a cookie by an immediate redirect, because a
 * token in a URL ends up in browser history and in the reverse proxy's access
 * log. Prefer the cookie or the header; the query form is a convenience with a
 * real cost.
 *
 * Every wrong token counts against a per-address throttle. Without it the token
 * can be guessed as fast as the network allows.
 */
function auth(token: string, throttle: FailureThrottle, log: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = clientKey(req.ip)
    const retryAfter = throttle.retryAfter(key)
    if (retryAfter !== null) {
      res
        .status(429)
        .set('retry-after', String(retryAfter))
        .type('text/plain')
        .send('Too many attempts. Try again shortly.')
      return
    }

    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const fromCookie = /(?:^|;\s*)athena_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
    const fromQuery = typeof req.query.token === 'string' ? req.query.token : ''

    let cookieValue = ''
    try {
      cookieValue = decodeURIComponent(fromCookie)
    } catch {
      cookieValue = ''
    }

    if (bearer && secretsEqual(bearer, token)) {
      throttle.clear(key)
      next()
      return
    }
    if (cookieValue && secretsEqual(cookieValue, token)) {
      throttle.clear(key)
      next()
      return
    }
    if (fromQuery && secretsEqual(fromQuery, token)) {
      throttle.clear(key)
      log.warn('dashboard token was passed in the URL, which the access log records', {
        hint: 'the cookie is now set, so future visits need no token in the URL',
      })
      res.cookie('athena_token', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: req.protocol === 'https',
        path: '/',
        maxAge: 30 * 86_400_000,
      })
      const url = new URL(req.originalUrl, 'http://placeholder')
      url.searchParams.delete('token')
      res.redirect(302, `${url.pathname}${url.search}`)
      return
    }

    // Anything presented and wrong counts. A bare request with no credentials
    // at all does not, so a missing bookmark cannot lock you out.
    if (bearer || cookieValue || fromQuery) throttle.record(key)
    res.status(401).type('text/plain').send('Unauthorized')
  }
}

export function buildApp(
  config: DashboardConfig,
  athenaSql: Sql,
  wikiSql: Sql,
  log: Logger,
): Express {
  const app = express()
  app.disable('x-powered-by')
  // Trust only a proxy on loopback, so a remote client cannot forge its address
  // and slip past the throttle.
  app.set('trust proxy', 'loopback')

  app.use((_req, res, next) => {
    res.set({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    })
    next()
  })

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'dashboard' })
  })

  // The dashboard summarises a private wiki, so it is never unauthenticated.
  app.use(auth(config.dashboardToken, new FailureThrottle({ maxFailures: 5 }), log))

  app.get('/', async (req, res) => {
    const requested = Number(req.query.days)
    const days = ALLOWED_RANGES.has(requested) ? requested : 30

    try {
      const content = await contentMetrics(wikiSql, STALE_DAYS)
      const [activity, index, backup] = await Promise.all([
        activityMetrics(athenaSql, days),
        indexMetrics(config.indexerUrl, content.pages),
        backupStatus(config.backupStatusPath),
      ])

      res
        .status(200)
        .set({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .send(
          renderDashboard({
            instanceName: config.instanceName,
            wikiUrl: config.wikiUrl,
            days,
            content,
            activity,
            index,
            backup,
            generatedAt: new Date().toISOString(),
          }),
        )
    } catch (error) {
      log.error('failed to render dashboard', { error: String(error) })
      res.status(500).type('text/plain').send('Failed to gather metrics. Check the logs.')
    }
  })

  /** The same numbers as JSON, for scripting or an external monitor. */
  app.get('/api/metrics', async (req, res) => {
    const requested = Number(req.query.days)
    const days = ALLOWED_RANGES.has(requested) ? requested : 30
    try {
      const content = await contentMetrics(wikiSql, STALE_DAYS)
      const [activity, index, backup] = await Promise.all([
        activityMetrics(athenaSql, days),
        indexMetrics(config.indexerUrl, content.pages),
        backupStatus(config.backupStatusPath),
      ])
      res.json({ days, content, activity, index, backup })
    } catch (error) {
      log.error('failed to gather metrics', { error: String(error) })
      res.status(500).json({ error: 'failed to gather metrics' })
    }
  })

  return app
}
