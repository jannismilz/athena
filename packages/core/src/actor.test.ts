import { describe, expect, test } from 'bun:test'
import { actorFromClient, BEARER_CLIENT_ID, UNKNOWN_ACTOR } from './actor.ts'

describe('actorFromClient', () => {
  test('a bearer-token client is Cursor', () => {
    expect(actorFromClient(BEARER_CLIENT_ID)).toBe('Cursor')
  })

  test('recognises Claude from its redirect URI', () => {
    expect(
      actorFromClient('uuid-1', {
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      }),
    ).toBe('Claude')
  })

  test('recognises ChatGPT from its redirect URI', () => {
    expect(
      actorFromClient('uuid-2', {
        client_name: 'ChatGPT',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      }),
    ).toBe('ChatGPT')
  })

  // The Python version returned "Claude" here, which wrote a false name into
  // the provenance footer of every page an unrecognised client touched.
  test('an unrecognised client keeps its own name instead of being called Claude', () => {
    expect(
      actorFromClient('uuid-3', {
        client_name: 'other-app',
        redirect_uris: ['https://example.com/callback'],
      }),
    ).toBe('other-app')
  })

  test('a completely anonymous client falls back to a generic label', () => {
    expect(actorFromClient('uuid-4')).toBe(UNKNOWN_ACTOR)
    expect(actorFromClient('uuid-4', { client_name: '   ' })).toBe(UNKNOWN_ACTOR)
  })

  test('a hostile client name cannot impersonate by length', () => {
    expect(actorFromClient('uuid-5', { client_name: 'x'.repeat(500) })).toHaveLength(60)
  })
})
