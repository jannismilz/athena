/**
 * Chunk storage and semantic search, in Postgres via pgvector.
 *
 * Keeping vectors in Postgres rather than a dedicated vector database removes
 * a container, and means a single pg_dump captures the index along with
 * everything else.
 *
 * The contents are still derived data: every row can be rebuilt from Wiki.js by
 * re-indexing, so losing this table costs time and nothing else.
 */

import type { Sql } from './db.ts'
import type { Chunk } from './markdown.ts'

export type StoredChunk = {
  page_id: number
  page_path: string
  page_title: string
  locale: string
  chunk_index: number
  content: string
  score?: number
} & Record<string, unknown>

/** pgvector wants `[1,2,3]`, not JSON with spaces. */
function toVector(values: number[]): string {
  return `[${values.join(',')}]`
}

export class VectorStore {
  constructor(private readonly sql: Sql) {}

  /**
   * Create the extension and the chunks table for a given vector width.
   *
   * pgvector fixes the dimension in the column type, so switching embedding
   * model means the table has to be rebuilt. That is detected here rather than
   * left to fail later with vectors that cannot be compared.
   */
  async ensureSchema(dimensions: number): Promise<{ rebuilt: boolean }> {
    await this.sql`CREATE EXTENSION IF NOT EXISTS vector`

    const [existing] = await this.sql`
      SELECT a.atttypmod AS dims
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'chunks' AND a.attname = 'embedding' AND a.attnum > 0
    `
    const currentDims = existing ? Number(existing.dims) : null
    const rebuilt = currentDims !== null && currentDims !== dimensions

    if (rebuilt) await this.sql`DROP TABLE IF EXISTS chunks`

    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chunks (
        page_id     integer     NOT NULL,
        chunk_index integer     NOT NULL,
        page_path   text        NOT NULL,
        page_title  text        NOT NULL,
        locale      text        NOT NULL DEFAULT 'en',
        content     text        NOT NULL,
        headings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
        embedding   vector(${dimensions}) NOT NULL,
        PRIMARY KEY (page_id, chunk_index)
      )
    `)
    await this.sql`CREATE INDEX IF NOT EXISTS chunks_page_path_idx ON chunks (page_path)`

    // HNSW gives good recall without needing to be rebuilt as rows change,
    // which matters when pages are edited one at a time.
    await this.sql
      .unsafe(
        `CREATE INDEX IF NOT EXISTS chunks_embedding_idx
           ON chunks USING hnsw (embedding vector_cosine_ops)`,
      )
      .catch(() => {
        // Older pgvector builds lack HNSW. Exact search still works, just slower.
      })

    return { rebuilt }
  }

  async deletePage(pageId: number): Promise<void> {
    await this.sql`DELETE FROM chunks WHERE page_id = ${pageId}`
  }

  /** Replace every chunk of a page in one transaction. */
  async upsertPage(input: {
    pageId: number
    pagePath: string
    pageTitle: string
    locale: string
    chunks: Chunk[]
    vectors: number[][]
  }): Promise<number> {
    const rows = input.chunks.map((chunk, i) => {
      const vector = input.vectors[i]
      if (!vector) throw new Error(`missing vector for chunk ${i} of page ${input.pageId}`)
      return {
        page_id: input.pageId,
        chunk_index: chunk.chunkIndex,
        page_path: input.pagePath,
        page_title: input.pageTitle,
        locale: input.locale,
        content: chunk.text,
        headings: chunk.headings,
        embedding: toVector(vector),
      }
    })

    await this.sql.begin(async tx => {
      await tx`DELETE FROM chunks WHERE page_id = ${input.pageId}`
      if (rows.length) await tx`INSERT INTO chunks ${tx(rows)}`
    })
    return rows.length
  }

  /**
   * Nearest chunks by cosine distance.
   *
   * `<=>` is pgvector's cosine distance, where 0 is identical, so the score is
   * reported as similarity to match what the merge step expects.
   */
  async search(vector: number[], limit = 8): Promise<StoredChunk[]> {
    const rows = await this.sql`
      SELECT page_id, page_path, page_title, locale, chunk_index, content, headings,
             1 - (embedding <=> ${toVector(vector)}::vector) AS score
      FROM chunks
      ORDER BY embedding <=> ${toVector(vector)}::vector
      LIMIT ${Math.max(1, Math.min(limit, 50))}
    `
    return rows.map(row => {
      const headings = (row.headings ?? {}) as Record<string, string>
      return {
        page_id: Number(row.page_id),
        page_path: String(row.page_path),
        page_title: String(row.page_title),
        locale: String(row.locale),
        chunk_index: Number(row.chunk_index),
        content: String(row.content),
        score: Number(row.score),
        ...headings,
      }
    })
  }

  /** Drop chunks for pages that no longer exist in the wiki. */
  async deleteMissingPages(keepIds: Set<number>): Promise<number> {
    if (!keepIds.size) return 0
    const ids = [...keepIds]
    const rows = await this.sql`
      DELETE FROM chunks WHERE page_id <> ALL(${ids}::int[]) RETURNING page_id
    `
    return new Set(rows.map(r => Number(r.page_id))).size
  }

  async stats(): Promise<{ chunks: number; pages: number }> {
    const [row] = await this.sql`
      SELECT count(*)::int AS chunks, count(DISTINCT page_id)::int AS pages FROM chunks
    `
    return { chunks: Number(row?.chunks ?? 0), pages: Number(row?.pages ?? 0) }
  }
}
