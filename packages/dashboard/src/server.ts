/**
 * Dashboard HTTP server.
 *
 * Read-only, and protected by a single shared token: it exposes an overview of
 * a private wiki, so it is never open to the internet unauthenticated.
 */

import { timingSafeEqual } from 'node:crypto'
import type { DashboardConfig, Logger, Sql } from '@athena/core'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { activityMetrics, contentMetrics, indexMetrics } from './metrics.ts'
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
 * Accept the token from a bearer header or a `token` query parameter.
 *
 * The query parameter exists so the dashboard can be opened from a bookmark in
 * a browser, which cannot set headers; it is set as a cookie on first use so
 * the secret does not stay in the address bar.
 */
function auth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const fromQuery = typeof req.query.token === 'string' ? req.query.token : ''
    const fromCookie = /(?:^|;\s*)athena_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''

    for (const candidate of [bearer, fromQuery, decodeURIComponent(fromCookie)]) {
      if (candidate && secretsEqual(candidate, token)) {
        if (candidate === fromQuery) {
          res.cookie('athena_token', token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: req.protocol === 'https',
            maxAge: 30 * 86_400_000,
          })
          // Redirect so the token does not linger in history or referrers.
          const url = new URL(req.originalUrl, 'http://placeholder')
          url.searchParams.delete('token')
          res.redirect(302, `${url.pathname}${url.search}`)
          return
        }
        next()
        return
      }
    }

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
  app.set('trust proxy', true)

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'dashboard' })
  })

  app.use(auth(config.dashboardToken))

  app.get('/', async (req, res) => {
    const requested = Number(req.query.days)
    const days = ALLOWED_RANGES.has(requested) ? requested : 30

    try {
      const content = await contentMetrics(wikiSql, STALE_DAYS)
      const [activity, index] = await Promise.all([
        activityMetrics(athenaSql, days),
        indexMetrics(config.indexerUrl, content.pages),
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
      const [activity, index] = await Promise.all([
        activityMetrics(athenaSql, days),
        indexMetrics(config.indexerUrl, content.pages),
      ])
      res.json({ days, content, activity, index })
    } catch (error) {
      log.error('failed to gather metrics', { error: String(error) })
      res.status(500).json({ error: 'failed to gather metrics' })
    }
  })

  return app
}
