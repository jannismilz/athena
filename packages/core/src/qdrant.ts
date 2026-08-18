/**
 * Qdrant chunk store.
 *
 * Qdrant holds embeddings for discovery only. Everything in here is
 * reconstructible from Wiki.js by reindexing, which is why backups skip it.
 */

import { QdrantClient } from '@qdrant/js-client-rest'
import type { Chunk } from './markdown.ts'

export type StoredChunk = {
  source: 'wikijs'
  page_id: number
  page_path: string
  page_title: string
  locale: string
  chunk_index: number
  content: string
  score?: number
} & Record<string, unknown>

/** Chunks a single page may have before ids would collide with the next page. */
const MAX_CHUNKS_PER_PAGE = 100_000

/**
 * Deterministic point id, so re-indexing a page overwrites its chunks in place
 * instead of accumulating duplicates.
 *
 * Qdrant accepts unsigned integers, and packing the page id with the chunk
 * index keeps ids readable: point 4200003 is page 42, chunk 3.
 */
export function pointId(pageId: number, chunkIndex: number): number {
  if (chunkIndex >= MAX_CHUNKS_PER_PAGE) {
    throw new Error(`page ${pageId} has more than ${MAX_CHUNKS_PER_PAGE} chunks`)
  }
  return pageId * MAX_CHUNKS_PER_PAGE + chunkIndex
}

export class ChunkStore {
  private readonly client: QdrantClient
  private readonly collection: string

  constructor(url: string, collection: string) {
    this.client = new QdrantClient({ url, checkCompatibility: false })
    this.collection = collection
  }

  /**
   * Create the collection if absent.
   *
   * Reports a mismatch when the collection exists with a different vector
   * width. The caller must recreate it: switching embedding model changes the
   * dimensions, and vectors of different widths cannot be compared.
   */
  async ensureCollection(
    vectorSize: number,
  ): Promise<{ created: boolean; dimensionMismatch: boolean }> {
    const { collections } = await this.client.getCollections()
    const exists = collections.some(c => c.name === this.collection)

    if (exists) {
      const info = await this.client.getCollection(this.collection)
      const params = info.config?.params?.vectors
      const size =
        typeof params === 'object' && params && 'size' in params ? Number(params.size) : null
      if (size !== null && size !== vectorSize) return { created: false, dimensionMismatch: true }
    } else {
      await this.client.createCollection(this.collection, {
        vectors: { size: vectorSize, distance: 'Cosine' },
      })
    }

    for (const [field, schema] of [
      ['page_id', 'integer'],
      ['page_path', 'keyword'],
      ['source', 'keyword'],
    ] as const) {
      // Idempotent: an existing index makes this a no-op error we can ignore.
      await this.client
        .createPayloadIndex(this.collection, {
          field_name: field,
          field_schema: schema,
          wait: true,
        })
        .catch(() => {})
    }
    return { created: !exists, dimensionMismatch: false }
  }

  async recreateCollection(vectorSize: number): Promise<void> {
    await this.client.deleteCollection(this.collection).catch(() => {})
    await this.ensureCollection(vectorSize)
  }

  async deletePage(pageId: number): Promise<void> {
    await this.client.delete(this.collection, {
      filter: { must: [{ key: 'page_id', match: { value: pageId } }] },
      wait: true,
    })
  }

  async upsertPage(input: {
    pageId: number
    pagePath: string
    pageTitle: string
    locale: string
    chunks: Chunk[]
    vectors: number[][]
  }): Promise<number> {
    await this.deletePage(input.pageId)
    if (!input.chunks.length) return 0

    const points = input.chunks.map((chunk, i) => {
      const vector = input.vectors[i]
      if (!vector) throw new Error(`missing vector for chunk ${i} of page ${input.pageId}`)
      return {
        id: pointId(input.pageId, chunk.chunkIndex),
        vector,
        payload: {
          source: 'wikijs',
          page_id: input.pageId,
          page_path: input.pagePath,
          page_title: input.pageTitle,
          locale: input.locale,
          chunk_index: chunk.chunkIndex,
          content: chunk.text,
          ...chunk.headings,
        },
      }
    })

    await this.client.upsert(this.collection, { points, wait: true })
    return points.length
  }

  async search(vector: number[], limit = 8): Promise<StoredChunk[]> {
    const result = await this.client.query(this.collection, {
      query: vector,
      limit,
      with_payload: true,
    })
    return result.points.map(p => ({ ...(p.payload as StoredChunk), score: p.score }))
  }

  /**
   * Drop chunks for pages that no longer exist.
   *
   * Deleting by "not in this list" would put every page id into one filter, so
   * instead we page through the stored ids and delete the orphans we find.
   */
  async deleteMissingPages(keepIds: Set<number>): Promise<number> {
    if (!keepIds.size) return 0

    const orphans = new Set<number>()
    let offset: string | number | undefined | null

    do {
      const page = await this.client.scroll(this.collection, {
        limit: 1000,
        with_payload: ['page_id'],
        with_vector: false,
        ...(offset != null ? { offset } : {}),
      })
      for (const point of page.points) {
        const id = Number((point.payload as { page_id?: number } | null)?.page_id)
        if (Number.isFinite(id) && !keepIds.has(id)) orphans.add(id)
      }
      offset = page.next_page_offset as typeof offset
    } while (offset != null)

    for (const id of orphans) await this.deletePage(id)
    return orphans.size
  }

  /**
   * Collection size. The number of indexed pages is tracked by the indexer
   * itself, so there is no reason to scroll every point here to recount it.
   */
  async stats(): Promise<{ points: number; vectorSize: number | null }> {
    const info = await this.client.getCollection(this.collection)
    const params = info.config?.params?.vectors
    return {
      points: info.points_count ?? 0,
      vectorSize:
        typeof params === 'object' && params && 'size' in params ? Number(params.size) : null,
    }
  }
}
