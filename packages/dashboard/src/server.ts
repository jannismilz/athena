/**
 * Dashboard HTTP server.
 *
 * Read-only, and never unauthenticated: it summarises a private wiki.
 *
 * Sign-in is a password form that sets a signed session cookie. The token is
 * never put in a URL, because URLs end up in browser history, in the reverse
 * proxy's access log, and in the Referer header of anything the page links to.
 * Scripts can still authenticate with a bearer header.
 */

import {
  clientKey,
  type DashboardConfig,
  FailureThrottle,
  type Logger,
  mintSession,
  noStore,
  readCookie,
  renderLoginPage,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type Sql,
  sameOriginOnly,
  secretsEqual,
  securityHeaders,
  verifySession,
} from '@athena/core'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { activityMetrics, backupStatus, contentMetrics, indexMetrics } from './metrics.ts'
import { renderDashboard } from './page.ts'

const ALLOWED_RANGES = new Set([7, 30, 90])
const STALE_DAYS = 180

/** The dashboard renders its own markup and loads nothing from anywhere else. */
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

const PURPOSE = 'Sign in to see what your assistant did, and what the wiki is missing.'

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    // Behind the documented reverse proxy this is https, and Express reports it
    // correctly because only loopback proxies are trusted.
    secure: req.protocol === 'https',
    path: '/',
    maxAge: SESSION_TTL_MS,
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

  const throttle = new FailureThrottle({ maxFailures: 5 })

  app.use(securityHeaders({ contentSecurityPolicy: CSP }))
  app.use(sameOriginOnly())
  app.use(express.urlencoded({ extended: false, limit: '4kb' }))

  // Liveness, before auth, so the container healthcheck needs no secret.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'dashboard' })
  })

  const sendLogin = (res: Response, error?: string, status = 200) => {
    noStore(res)
    res
      .status(status)
      .type('html')
      .send(
        renderLoginPage({
          instanceName: config.instanceName,
          // Relative, so the page works under any reverse-proxy path prefix.
          action: 'login',
          purpose: PURPOSE,
          ...(error ? { error } : {}),
          footer: `<a href="${config.wikiUrl}">Open the wiki</a>`,
        }),
      )
  }

  const signedIn = (req: Request) =>
    verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), config.dashboardToken)

  app.get('/login', (req, res) => {
    if (signedIn(req)) {
      res.redirect(302, './')
      return
    }
    sendLogin(res)
  })

  app.post('/login', (req, res) => {
    const key = clientKey(req.ip)
    const retryAfter = throttle.retryAfter(key)
    if (retryAfter !== null) {
      res.set('retry-after', String(retryAfter))
      sendLogin(res, `Too many attempts. Try again in ${retryAfter} seconds.`, 429)
      return
    }

    const password = String((req.body as { password?: unknown })?.password ?? '')
    if (!password || !secretsEqual(password, config.dashboardToken)) {
      throttle.record(key)
      log.warn('failed dashboard sign-in', { ip: key })
      sendLogin(res, 'Wrong password.', 401)
      return
    }

    throttle.clear(key)
    res.cookie(SESSION_COOKIE, mintSession(config.dashboardToken), cookieOptions(req))
    noStore(res)
    // 303, not 302: only See Other requires the client to follow up with GET.
    // A 302 leaves the method to the client, and some repeat the POST.
    //
    // Relative on purpose: the dashboard is usually mounted under a path
    // prefix by the reverse proxy, and an absolute "/" would leave it.
    res.redirect(303, './')
  })

  app.post('/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' })
    noStore(res)
    res.redirect(303, './login')
  })

  /**
   * Everything below needs a session cookie, or a bearer token for scripts.
   *
   * A browser is sent to the login form; anything else gets a plain 401 so a
   * curl or a monitor does not have to parse HTML to discover it failed.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (signedIn(req)) {
      next()
      return
    }

    const header = req.headers.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (bearer) {
      const key = clientKey(req.ip)
      if (throttle.retryAfter(key) !== null) {
        res.status(429).type('text/plain').send('Too many attempts. Try again shortly.')
        return
      }
      if (secretsEqual(bearer, config.dashboardToken)) {
        throttle.clear(key)
        next()
        return
      }
      throttle.record(key)
    }

    noStore(res)
    if (req.method === 'GET' && (req.get('accept') ?? '').includes('text/html')) {
      res.redirect(302, './login')
      return
    }
    res.status(401).type('text/plain').send('Unauthorized')
  })

  /**
   * Metrics change on the scale of minutes, so a short cache keeps a refresh,
   * a range switch, or a monitor polling /api/metrics from re-running every
   * aggregate. One entry per range.
   */
  const cache = new Map<number, { at: number; data: Awaited<ReturnType<typeof query>> }>()

  const query = async (days: number) => {
    const content = await contentMetrics(wikiSql, STALE_DAYS)
    const [activity, index, backup] = await Promise.all([
      activityMetrics(athenaSql, days),
      indexMetrics(config.indexerUrl, content.pages),
      backupStatus(config.backupStatusPath),
    ])
    return { content, activity, index, backup }
  }

  const gather = async (days: number) => {
    const hit = cache.get(days)
    if (hit && Date.now() - hit.at < config.metricsCacheSeconds * 1000) return hit.data
    const data = await query(days)
    cache.set(days, { at: Date.now(), data })
    return data
  }

  const rangeOf = (req: Request) => {
    const requested = Number(req.query.days)
    return ALLOWED_RANGES.has(requested) ? requested : 30
  }

  app.get('/', async (req, res) => {
    const days = rangeOf(req)
    try {
      const data = await gather(days)
      noStore(res)
      res
        .status(200)
        .type('html')
        .send(
          renderDashboard({
            instanceName: config.instanceName,
            wikiUrl: config.wikiUrl,
            days,
            ...data,
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
    const days = rangeOf(req)
    try {
      noStore(res)
      res.json({ days, ...(await gather(days)) })
    } catch (error) {
      log.error('failed to gather metrics', { error: String(error) })
      res.status(500).json({ error: 'failed to gather metrics' })
    }
  })

  return app
}
