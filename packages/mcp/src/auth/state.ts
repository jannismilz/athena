/**
 * Durable OAuth state.
 *
 * Registered clients and issued tokens outlive a restart, so a connected
 * Claude.ai or Cursor session does not have to be re-authorised every time the
 * container is redeployed. Written atomically via rename so a crash mid-write
 * cannot truncate the file.
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

export type StoredToken = {
  clientId: string
  scopes: string[]
  expiresAt?: number
  resource?: string
}

export type PersistedState = {
  clients: Record<string, OAuthClientInformationFull>
  accessTokens: Record<string, StoredToken>
  refreshTokens: Record<string, StoredToken>
  accessToRefresh: Record<string, string>
  refreshToAccess: Record<string, string>
}

function emptyState(): PersistedState {
  return {
    clients: {},
    accessTokens: {},
    refreshTokens: {},
    accessToRefresh: {},
    refreshToAccess: {},
  }
}

export class StateStore {
  private readonly file: string
  private writing: Promise<void> = Promise.resolve()

  constructor(
    directory: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.file = join(directory, 'oauth-state.json')
  }

  async load(): Promise<PersistedState> {
    try {
      const raw = await Bun.file(this.file).text()
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      return { ...emptyState(), ...parsed }
    } catch {
      // Missing or corrupt state is not fatal: clients simply re-authorise.
      return emptyState()
    }
  }

  /**
   * Persist state. Calls are serialised so two concurrent token exchanges
   * cannot interleave and lose one another's writes.
   *
   * Never rejects. Callers persist in the background, so a rejection here
   * would surface as an unhandled rejection and could take the process down;
   * the cost of a failed write is only that a client must re-authorise.
   */
  save(state: PersistedState): Promise<void> {
    const snapshot = JSON.stringify(state)
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        await writeFile(tmp, snapshot, { mode: 0o600 })
        await rename(tmp, this.file)
      } catch (error) {
        this.onError(error)
      }
    })
    return this.writing
  }

  /** Resolve once every queued write has finished. For tests and shutdown. */
  async flush(): Promise<void> {
    await this.writing
  }
}
