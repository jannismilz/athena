/**
 * Deciding which AI is on the other end of a tool call.
 *
 * The answer is taken from the authenticated OAuth client, never from a tool
 * argument, because it ends up in the page footer as provenance and a model
 * must not be able to sign someone else's name to a page.
 */

/** Client id used by header-auth (bearer token) clients such as Cursor. */
export const BEARER_CLIENT_ID = 'athena-bearer-client'

/** Fallback when a registered client tells us nothing recognisable about itself. */
export const UNKNOWN_ACTOR = 'AI'

export type ClientHints = {
  client_name?: string | null
  client_uri?: string | null
  software_id?: string | null
  redirect_uris?: Array<string | URL> | null
}

const SIGNATURES: Array<{ name: string; needles: string[] }> = [
  { name: 'Claude', needles: ['claude', 'anthropic'] },
  { name: 'ChatGPT', needles: ['chatgpt', 'openai'] },
  { name: 'Cursor', needles: ['cursor'] },
  { name: 'VS Code', needles: ['vscode', 'visual studio code'] },
  { name: 'Zed', needles: ['zed.dev'] },
]

function haystack(clientId: string, client: ClientHints | null | undefined): string {
  const parts: string[] = [clientId || '']
  if (client) {
    for (const value of [client.client_name, client.client_uri, client.software_id]) {
      if (value) parts.push(String(value))
    }
    for (const uri of client.redirect_uris ?? []) parts.push(String(uri))
  }
  return parts.join(' ').toLowerCase()
}

/**
 * Map an authenticated client to a display name for the footer.
 *
 * An unrecognised client keeps its own registered name rather than being
 * mislabelled as a known assistant; only a completely anonymous client falls
 * back to a generic label.
 */
export function actorFromClient(clientId: string, client?: ClientHints | null): string {
  if (clientId === BEARER_CLIENT_ID) return 'Cursor'

  const blob = haystack(clientId, client)
  for (const { name, needles } of SIGNATURES) {
    if (needles.some(needle => blob.includes(needle))) return name
  }

  const declared = client?.client_name?.trim()
  if (declared) return declared.slice(0, 60)
  return UNKNOWN_ACTOR
}
