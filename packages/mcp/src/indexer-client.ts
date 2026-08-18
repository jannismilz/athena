/** HTTP client for the indexer sidecar (semantic search and reindexing). */

export type SemanticHit = {
  page_id?: number
  page_path?: string
  page_title?: string
  content?: string
  score?: number
  [key: string]: unknown
}

export class IndexerClient {
  private readonly base: string

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`indexer ${path} returned HTTP ${response.status}`)
    }
    return (await response.json()) as T
  }

  async search(query: string, limit = 8): Promise<SemanticHit[]> {
    const data = await this.post<{ hits?: SemanticHit[] }>('/search', { query, limit }, 60_000)
    return data.hits ?? []
  }

  async reindex(pageId: number): Promise<number> {
    const data = await this.post<{ chunks?: number }>('/reindex', { page_id: pageId }, 180_000)
    return Number(data.chunks ?? 0)
  }

  async unindex(pageId: number): Promise<void> {
    await this.post('/unindex', { page_id: pageId }, 60_000)
  }

  async stats(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.base}/stats`, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`indexer /stats returned HTTP ${response.status}`)
    return (await response.json()) as Record<string, unknown>
  }
}
