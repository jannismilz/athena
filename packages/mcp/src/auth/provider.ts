/**
 * OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Two ways in, deliberately:
 *
 *   1. A static bearer token (MCP_TOKEN) for clients that send an
 *      Authorization header, such as Cursor.
 *   2. A full authorization-code flow with dynamic client registration and
 *      PKCE, which is what Claude.ai's custom connectors require. The human
 *      approves by entering the same MCP_TOKEN as a password in the browser.
 *
 * Wiki.js credentials never leave this process; a client only ever holds a
 * token minted here.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { BEARER_CLIENT_ID } from '@athena/core'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Response } from 'express'
import { type PersistedState, StateStore } from './state.ts'

/** Registered OAuth clients kept, oldest evicted once full. */
const MAX_CLIENTS = 50
/** Concurrent in-flight logins. */
const MAX_PENDING = 20
const PENDING_TTL_MS = 5 * 60_000
const AUTH_CODE_TTL_MS = 60_000
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
/** Password attempts allowed per login link before it is burned. */
const MAX_LOGIN_ATTEMPTS = 3
/** Failed attempts per IP before that IP is locked out for the window. */
const THROTTLE_WINDOW_MS = 60_000
const THROTTLE_MAX_FAILURES = 5

const SCOPES = ['wiki']

export type PendingLogin = {
  client: OAuthClientInformationFull
  params: AuthorizationParams
  expiresAt: number
  attempts: number
}

type AuthCode = {
  clientId: string
  codeChallenge: string
  redirectUri: string
  scopes: string[]
  resource?: string
  expiresAt: number
}

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

const token = () => `${randomUUID()}${randomUUID()}`.replace(/-/g, '')

export class AthenaOAuthProvider implements OAuthServerProvider {
  private state: PersistedState
  private readonly store: StateStore
  private readonly password: string
  private readonly issuer: string

  private readonly pending = new Map<string, PendingLogin>()
  private readonly codes = new Map<string, AuthCode>()
  private readonly failures = new Map<string, number[]>()

  private constructor(options: {
    password: string
    issuer: string
    store: StateStore
    state: PersistedState
  }) {
    this.password = options.password
    this.issuer = options.issuer.replace(/\/+$/, '')
    this.store = options.store
    this.state = options.state
  }

  static async create(options: {
    password: string
    issuer: string
    stateDir: string
    onStateError?: (error: unknown) => void
  }): Promise<AthenaOAuthProvider> {
    const store = new StateStore(options.stateDir, options.onStateError)
    return new AthenaOAuthProvider({ ...options, store, state: await store.load() })
  }

  /** Wait for pending state writes. Used at shutdown and in tests. */
  async flush(): Promise<void> {
    await this.store.flush()
  }

  private persist(): void {
    // Fire and forget: a failed persist costs a re-authorisation, not a request.
    void this.store.save(this.state)
  }

  // ── Clients ─────────────────────────────────────────────────────────────

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.state.clients[clientId],
      registerClient: (
        client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
      ) => {
        const full = client as OAuthClientInformationFull
        this.evictIfFull(full.client_id)
        this.state.clients[full.client_id] = full
        this.persist()
        return full
      },
    }
  }

  /**
   * Keep registration bounded. Anyone can call the DCR endpoint, so without a
   * cap the state file grows without limit. Clients holding a live token are
   * never evicted.
   */
  private evictIfFull(incomingId: string): void {
    if (this.state.clients[incomingId]) return
    if (Object.keys(this.state.clients).length < MAX_CLIENTS) return

    const inUse = new Set<string>()
    for (const t of Object.values(this.state.accessTokens)) inUse.add(t.clientId)
    for (const t of Object.values(this.state.refreshTokens)) inUse.add(t.clientId)

    const victim = Object.keys(this.state.clients).find(id => !inUse.has(id))
    if (!victim) throw new Error('client registration limit reached')
    delete this.state.clients[victim]
  }

  // ── Authorization ───────────────────────────────────────────────────────

  /**
   * Park the request and send the browser to the password page. The redirect
   * back to the client only happens once a human has authenticated.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.prunePending()
    while (this.pending.size >= MAX_PENDING) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]
      if (!oldest) break
      this.pending.delete(oldest[0])
    }

    const sid = token()
    this.pending.set(sid, {
      client,
      params,
      expiresAt: Date.now() + PENDING_TTL_MS,
      attempts: 0,
    })
    res.redirect(302, `${this.issuer}/login?sid=${encodeURIComponent(sid)}`)
  }

  private prunePending(): void {
    const now = Date.now()
    for (const [sid, entry] of this.pending) if (entry.expiresAt < now) this.pending.delete(sid)
    for (const [code, entry] of this.codes) if (entry.expiresAt < now) this.codes.delete(code)
  }

  getPending(sid: string): PendingLogin | undefined {
    this.prunePending()
    return this.pending.get(sid)
  }

  /** Record a wrong password and report whether this login link is now dead. */
  registerFailedAttempt(sid: string): { linkBurned: boolean } {
    const entry = this.pending.get(sid)
    if (!entry) return { linkBurned: true }
    entry.attempts += 1
    if (entry.attempts >= MAX_LOGIN_ATTEMPTS) {
      this.pending.delete(sid)
      return { linkBurned: true }
    }
    return { linkBurned: false }
  }

  /** Seconds remaining in the lockout for this IP, or null if not throttled. */
  throttledFor(ip: string): number | null {
    const now = Date.now()
    const recent = (this.failures.get(ip) ?? []).filter(t => now - t < THROTTLE_WINDOW_MS)
    if (recent.length) this.failures.set(ip, recent)
    else this.failures.delete(ip)

    if (recent.length < THROTTLE_MAX_FAILURES) return null
    return Math.ceil((THROTTLE_WINDOW_MS - (now - recent[0]!)) / 1000)
  }

  recordFailure(ip: string): void {
    const list = this.failures.get(ip) ?? []
    list.push(Date.now())
    this.failures.set(ip, list)
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip)
  }

  checkPassword(presented: string): boolean {
    return secretsEqual(presented, this.password)
  }

  /**
   * Complete a successful login: mint a one-time authorization code and build
   * the redirect back to the client.
   */
  completeLogin(sid: string): string {
    const entry = this.pending.get(sid)
    if (!entry) throw new Error('login session expired')
    this.pending.delete(sid)

    const code = token()
    this.codes.set(code, {
      clientId: entry.client.client_id,
      codeChallenge: entry.params.codeChallenge,
      redirectUri: entry.params.redirectUri,
      scopes: entry.params.scopes ?? SCOPES,
      resource: entry.params.resource?.href,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    })

    const target = new URL(entry.params.redirectUri)
    target.searchParams.set('code', code)
    if (entry.params.state) target.searchParams.set('state', entry.params.state)
    return target.href
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    this.prunePending()
    const entry = this.codes.get(authorizationCode)
    if (!entry || entry.clientId !== client.client_id) {
      throw new Error('invalid authorization code')
    }
    return entry.codeChallenge
  }

  // ── Tokens ──────────────────────────────────────────────────────────────

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = token()
    const refreshToken = token()
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS

    this.state.accessTokens[accessToken] = { clientId, scopes, expiresAt, resource }
    this.state.refreshTokens[refreshToken] = { clientId, scopes, resource }
    this.state.accessToRefresh[accessToken] = refreshToken
    this.state.refreshToAccess[refreshToken] = accessToken
    this.pruneExpiredTokens()
    this.persist()

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      scope: scopes.join(' '),
      refresh_token: refreshToken,
    }
  }

  /** Expired access tokens are dead weight in the state file; drop them on write. */
  private pruneExpiredTokens(): void {
    const now = Math.floor(Date.now() / 1000)
    for (const [value, stored] of Object.entries(this.state.accessTokens)) {
      if (stored.expiresAt && stored.expiresAt < now) {
        delete this.state.accessTokens[value]
        const refresh = this.state.accessToRefresh[value]
        delete this.state.accessToRefresh[value]
        // The refresh token stays valid; only its stale access pairing goes.
        if (refresh && this.state.refreshToAccess[refresh] === value) {
          delete this.state.refreshToAccess[refresh]
        }
      }
    }
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.prunePending()
    const entry = this.codes.get(authorizationCode)
    if (!entry || entry.clientId !== client.client_id) throw new Error('invalid authorization code')
    // Single use: a replayed code must not mint a second token.
    this.codes.delete(authorizationCode)

    if (redirectUri && redirectUri !== entry.redirectUri) throw new Error('redirect_uri mismatch')
    return this.issue(client.client_id, entry.scopes, resource?.href ?? entry.resource)
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const stored = this.state.refreshTokens[refreshToken]
    if (!stored || stored.clientId !== client.client_id) throw new Error('invalid refresh token')

    // Rotate: the presented refresh token and its access token are retired.
    const previousAccess = this.state.refreshToAccess[refreshToken]
    if (previousAccess) delete this.state.accessTokens[previousAccess]
    delete this.state.refreshTokens[refreshToken]
    delete this.state.refreshToAccess[refreshToken]
    if (previousAccess) delete this.state.accessToRefresh[previousAccess]

    return this.issue(
      client.client_id,
      scopes?.length ? scopes : stored.scopes,
      resource?.href ?? stored.resource,
    )
  }

  /**
   * Verify a presented token.
   *
   * Failures must be `InvalidTokenError`: the SDK's bearer middleware maps that
   * to a 401 with a WWW-Authenticate header, and turns anything else into a
   * 500, which would tell a client with a bad token to retry rather than to
   * re-authenticate.
   */
  async verifyAccessToken(presented: string): Promise<AuthInfo> {
    // Header-auth clients present the shared secret directly. It has no natural
    // expiry, but the middleware requires one, so it is reported as valid for
    // the next hour and re-checked on every request.
    if (secretsEqual(presented, this.password)) {
      return {
        token: presented,
        clientId: BEARER_CLIENT_ID,
        scopes: SCOPES,
        expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
      }
    }

    const stored = this.state.accessTokens[presented]
    if (!stored) throw new InvalidTokenError('invalid access token')
    if (stored.expiresAt && stored.expiresAt < Math.floor(Date.now() / 1000)) {
      delete this.state.accessTokens[presented]
      this.persist()
      throw new InvalidTokenError('access token expired')
    }
    return {
      token: presented,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt ?? Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
      ...(stored.resource ? { resource: new URL(stored.resource) } : {}),
    }
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const value = request.token
    const refresh = this.state.accessToRefresh[value]
    const access = this.state.refreshToAccess[value]

    delete this.state.accessTokens[value]
    delete this.state.refreshTokens[value]
    delete this.state.accessToRefresh[value]
    delete this.state.refreshToAccess[value]
    if (refresh) {
      delete this.state.refreshTokens[refresh]
      delete this.state.refreshToAccess[refresh]
    }
    if (access) {
      delete this.state.accessTokens[access]
      delete this.state.accessToRefresh[access]
    }
    this.persist()
  }

  /** Client metadata for the actor label, without exposing the whole store. */
  clientHints(clientId: string) {
    return this.state.clients[clientId] ?? null
  }
}
