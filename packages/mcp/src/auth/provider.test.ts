import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BEARER_CLIENT_ID } from '@athena/core'
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { AthenaOAuthProvider, secretsEqual } from './provider.ts'

const PASSWORD = 'correct-horse-battery-staple'

let dir: string
let provider: AthenaOAuthProvider

const client = (id: string): OAuthClientInformationFull =>
  ({
    client_id: id,
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  }) as OAuthClientInformationFull

const params = (): AuthorizationParams => ({
  codeChallenge: 'challenge-value',
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  state: 'state-123',
  scopes: ['wiki'],
})

/** Captures the redirect an Express handler would have sent. */
function fakeRes() {
  const captured: { status?: number; location?: string } = {}
  return {
    res: {
      redirect: (status: number, location: string) => {
        captured.status = status
        captured.location = location
      },
    } as never,
    captured,
  }
}

async function authorizedCode(): Promise<{ code: string; c: OAuthClientInformationFull }> {
  const c = client('client-1')
  await provider.clientsStore.registerClient!(c)
  const { res, captured } = fakeRes()
  await provider.authorize(c, params(), res)
  const sid = new URL(captured.location!).searchParams.get('sid')!
  const redirect = provider.completeLogin(sid)
  return { code: new URL(redirect).searchParams.get('code')!, c }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'athena-oauth-'))
  provider = await AthenaOAuthProvider.create({
    password: PASSWORD,
    issuer: 'https://athena-mcp.example.com',
    stateDir: dir,
  })
})

afterEach(async () => {
  // Let background persistence finish before the directory disappears.
  await provider.flush()
  await rm(dir, { recursive: true, force: true })
})

describe('secretsEqual', () => {
  test('accepts an exact match and rejects everything else', () => {
    expect(secretsEqual(PASSWORD, PASSWORD)).toBe(true)
    expect(secretsEqual('wrong', PASSWORD)).toBe(false)
    expect(secretsEqual('', PASSWORD)).toBe(false)
    // A prefix must not pass just because it is shorter.
    expect(secretsEqual(PASSWORD.slice(0, 5), PASSWORD)).toBe(false)
  })
})

describe('bearer token', () => {
  test('the shared secret authenticates directly', async () => {
    const info = await provider.verifyAccessToken(PASSWORD)
    expect(info.clientId).toBe(BEARER_CLIENT_ID)
    expect(info.scopes).toContain('wiki')
  })

  test('a wrong secret is rejected', () => {
    expect(provider.verifyAccessToken('nope')).rejects.toThrow('invalid access token')
  })
})

describe('authorization code flow', () => {
  test('authorize redirects to the login page rather than issuing a code', async () => {
    const c = client('client-1')
    await provider.clientsStore.registerClient!(c)
    const { res, captured } = fakeRes()
    await provider.authorize(c, params(), res)

    const url = new URL(captured.location!)
    expect(url.origin).toBe('https://athena-mcp.example.com')
    expect(url.pathname).toBe('/login')
    expect(url.searchParams.get('sid')).toBeTruthy()
    expect(url.searchParams.get('code')).toBeNull()
  })

  test('a completed login returns the client state alongside the code', async () => {
    const c = client('client-1')
    await provider.clientsStore.registerClient!(c)
    const { res, captured } = fakeRes()
    await provider.authorize(c, params(), res)
    const sid = new URL(captured.location!).searchParams.get('sid')!

    const redirect = new URL(provider.completeLogin(sid))
    expect(redirect.origin + redirect.pathname).toBe('https://claude.ai/api/mcp/auth_callback')
    expect(redirect.searchParams.get('state')).toBe('state-123')
    expect(redirect.searchParams.get('code')).toBeTruthy()
  })

  test('the PKCE challenge survives to the token exchange', async () => {
    const { code, c } = await authorizedCode()
    expect(await provider.challengeForAuthorizationCode(c, code)).toBe('challenge-value')
  })

  test('an authorization code works exactly once', async () => {
    const { code, c } = await authorizedCode()
    const tokens = await provider.exchangeAuthorizationCode(c, code)
    expect(tokens.access_token).toBeTruthy()
    expect(provider.exchangeAuthorizationCode(c, code)).rejects.toThrow(
      'invalid authorization code',
    )
  })

  test('another client cannot redeem someone else’s code', async () => {
    const { code } = await authorizedCode()
    const other = client('client-2')
    await provider.clientsStore.registerClient!(other)
    expect(provider.exchangeAuthorizationCode(other, code)).rejects.toThrow(
      'invalid authorization code',
    )
  })

  test('a mismatched redirect_uri is refused', async () => {
    const { code, c } = await authorizedCode()
    expect(
      provider.exchangeAuthorizationCode(c, code, undefined, 'https://evil.example.com/cb'),
    ).rejects.toThrow('redirect_uri mismatch')
  })

  test('a login link cannot be replayed after use', async () => {
    const c = client('client-1')
    await provider.clientsStore.registerClient!(c)
    const { res, captured } = fakeRes()
    await provider.authorize(c, params(), res)
    const sid = new URL(captured.location!).searchParams.get('sid')!
    provider.completeLogin(sid)
    expect(() => provider.completeLogin(sid)).toThrow('login session expired')
  })
})

describe('issued tokens', () => {
  test('an access token verifies and carries its client', async () => {
    const { code, c } = await authorizedCode()
    const tokens = await provider.exchangeAuthorizationCode(c, code)
    const info = await provider.verifyAccessToken(tokens.access_token)
    expect(info.clientId).toBe('client-1')
    expect(info.scopes).toEqual(['wiki'])
  })

  test('refreshing rotates both tokens and retires the old pair', async () => {
    const { code, c } = await authorizedCode()
    const first = await provider.exchangeAuthorizationCode(c, code)
    const second = await provider.exchangeRefreshToken(c, first.refresh_token!)

    expect(second.access_token).not.toBe(first.access_token)
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(provider.verifyAccessToken(first.access_token)).rejects.toThrow()
    expect(provider.exchangeRefreshToken(c, first.refresh_token!)).rejects.toThrow(
      'invalid refresh token',
    )
    expect((await provider.verifyAccessToken(second.access_token)).clientId).toBe('client-1')
  })

  test('revoking an access token also kills its refresh token', async () => {
    const { code, c } = await authorizedCode()
    const tokens = await provider.exchangeAuthorizationCode(c, code)
    await provider.revokeToken(c, { token: tokens.access_token })

    expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow()
    expect(provider.exchangeRefreshToken(c, tokens.refresh_token!)).rejects.toThrow()
  })

  test('tokens survive a restart', async () => {
    const { code, c } = await authorizedCode()
    const tokens = await provider.exchangeAuthorizationCode(c, code)
    await provider.flush()

    const restarted = await AthenaOAuthProvider.create({
      password: PASSWORD,
      issuer: 'https://athena-mcp.example.com',
      stateDir: dir,
    })
    expect((await restarted.verifyAccessToken(tokens.access_token)).clientId).toBe('client-1')
  })
})

describe('brute-force defences', () => {
  test('an IP is locked out after repeated failures', () => {
    expect(provider.throttledFor('10.0.0.1')).toBeNull()
    for (let i = 0; i < 5; i++) provider.recordFailure('10.0.0.1')
    expect(provider.throttledFor('10.0.0.1')).toBeGreaterThan(0)
    // Lockout is per address.
    expect(provider.throttledFor('10.0.0.2')).toBeNull()
  })

  test('a successful login clears the failure record', () => {
    for (let i = 0; i < 5; i++) provider.recordFailure('10.0.0.3')
    provider.clearFailures('10.0.0.3')
    expect(provider.throttledFor('10.0.0.3')).toBeNull()
  })

  test('a login link burns after three wrong passwords', async () => {
    const c = client('client-1')
    await provider.clientsStore.registerClient!(c)
    const { res, captured } = fakeRes()
    await provider.authorize(c, params(), res)
    const sid = new URL(captured.location!).searchParams.get('sid')!

    expect(provider.registerFailedAttempt(sid).linkBurned).toBe(false)
    expect(provider.registerFailedAttempt(sid).linkBurned).toBe(false)
    expect(provider.registerFailedAttempt(sid).linkBurned).toBe(true)
    expect(provider.getPending(sid)).toBeUndefined()
  })
})

describe('client registration limits', () => {
  test('registration is capped and evicts only clients without tokens', async () => {
    const { code, c } = await authorizedCode()
    await provider.exchangeAuthorizationCode(c, code)

    for (let i = 2; i <= 60; i++) {
      await provider.clientsStore.registerClient!(client(`client-${i}`))
    }
    // The client holding a live token is never evicted.
    expect(await provider.clientsStore.getClient('client-1')).toBeDefined()
  })
})

describe('scopes', () => {
  // A client that requests no scope must still get a usable token. The SDK
  // passes an empty array rather than undefined, and a token with no scopes is
  // rejected by the MCP endpoint as "insufficient_scope", which the client
  // reports as "no MCP server was found at the provided URL".
  test('a request with no scope is granted the default one', async () => {
    const c = client('client-1')
    await provider.clientsStore.registerClient!(c)
    const { res, captured } = fakeRes()
    await provider.authorize(c, { ...params(), scopes: [] }, res)
    const sid = new URL(captured.location!).searchParams.get('sid')!
    const code = new URL(provider.completeLogin(sid)).searchParams.get('code')!

    const tokens = await provider.exchangeAuthorizationCode(c, code)
    expect(tokens.scope).toBe('wiki')
    expect((await provider.verifyAccessToken(tokens.access_token)).scopes).toEqual(['wiki'])
  })

  test('an explicitly requested scope is preserved', async () => {
    const c = client('client-2')
    await provider.clientsStore.registerClient!(c)
    const { res, captured } = fakeRes()
    await provider.authorize(c, { ...params(), scopes: ['wiki'] }, res)
    const sid = new URL(captured.location!).searchParams.get('sid')!
    const code = new URL(provider.completeLogin(sid)).searchParams.get('code')!
    expect((await provider.exchangeAuthorizationCode(c, code)).scope).toBe('wiki')
  })
})
