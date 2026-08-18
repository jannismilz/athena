/**
 * Embedding client.
 *
 * The model runs in its own container rather than inside the indexer, so the
 * indexer stays a small process, the model can be swapped in compose without a
 * rebuild, and moving to a GPU later is a configuration change.
 */

export type EmbeddingsProvider = 'tei' | 'openai'

export type EmbeddingsOptions = {
  baseUrl: string
  model?: string
  provider?: EmbeddingsProvider
  apiKey?: string
  /** Texts per HTTP request. TEI rejects oversized batches. */
  batchSize?: number
  timeoutMs?: number
  maxRetries?: number
  fetch?: typeof globalThis.fetch
}

export class EmbeddingsClient {
  private readonly baseUrl: string
  private readonly model: string
  private readonly provider: EmbeddingsProvider
  private readonly apiKey: string | undefined
  private readonly batchSize: number
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly doFetch: typeof globalThis.fetch
  private dimensions: number | null = null

  constructor(options: EmbeddingsOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.model = options.model ?? ''
    this.provider = options.provider ?? 'tei'
    this.apiKey = options.apiKey
    this.batchSize = options.batchSize ?? 32
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxRetries = options.maxRetries ?? 3
    this.doFetch = options.fetch ?? globalThis.fetch
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

        const response = await this.doFetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new Error(`embeddings HTTP ${response.status}: ${text.slice(0, 300)}`)
        }
        return await response.json()
      } catch (error) {
        lastError = error
        if (attempt === this.maxRetries) break
        // The model container is often still loading on first boot.
        await Bun.sleep(2 ** attempt * 500)
      }
    }
    throw lastError
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.provider === 'openai') {
      const payload = (await this.post('/v1/embeddings', {
        model: this.model,
        input: texts,
      })) as { data?: Array<{ embedding: number[]; index?: number }> }
      const data = payload.data ?? []
      // The spec allows results out of order; index is authoritative when present.
      const out: number[][] = new Array(texts.length)
      data.forEach((item, i) => {
        out[item.index ?? i] = item.embedding
      })
      return out
    }

    const payload = (await this.post('/embed', { inputs: texts, truncate: true })) as number[][]
    return payload
  }

  /** Embed many texts, batched. Order matches the input. */
  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return []
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.embedBatch(texts.slice(i, i + this.batchSize))))
    }
    if (out.length !== texts.length) {
      throw new Error(`embeddings returned ${out.length} vectors for ${texts.length} texts`)
    }
    if (out[0]) this.dimensions = out[0].length
    return out
  }

  async embedOne(text: string): Promise<number[]> {
    const [vector] = await this.embed([text])
    if (!vector) throw new Error('embeddings returned no vector')
    return vector
  }

  /** Vector width, discovered by embedding a probe string once. */
  async getDimensions(): Promise<number> {
    if (this.dimensions === null) {
      this.dimensions = (await this.embedOne('dimension probe')).length
    }
    return this.dimensions
  }

  async health(): Promise<boolean> {
    try {
      await this.embedOne('ok')
      return true
    } catch {
      return false
    }
  }
}
