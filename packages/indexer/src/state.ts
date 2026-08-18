/**
 * What has already been indexed.
 *
 * The original indexer re-embedded every page on every pass, so cost grew with
 * the size of the wiki forever, whether or not anything had changed. This
 * records a fingerprint per page so a sync pass only touches what actually
 * moved.
 *
 * SQLite because it is a single file, needs no server, and survives restarts.
 * Losing it is harmless: everything is re-indexed once and the file rebuilds.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type IndexRecord = {
  pageId: number
  updatedAt: string | null
  contentHash: string
  chunks: number
  indexedAt: string
}

export function contentFingerprint(content: string, title: string, path: string): string {
  // Title and path are part of the embedded text, so a rename must invalidate.
  return new Bun.CryptoHasher('sha256').update(`${path} ${title} ${content}`).digest('hex')
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS indexed_pages (
    page_id      INTEGER PRIMARY KEY,
    updated_at   TEXT,
    content_hash TEXT NOT NULL,
    chunks       INTEGER NOT NULL DEFAULT 0,
    indexed_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

function toRecord(row: Record<string, unknown>): IndexRecord {
  return {
    pageId: Number(row.page_id),
    updatedAt: (row.updated_at as string | null) ?? null,
    contentHash: String(row.content_hash),
    chunks: Number(row.chunks),
    indexedAt: String(row.indexed_at),
  }
}

export class IndexState {
  private readonly db: Database

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.db = new Database(join(directory, 'index-state.sqlite'), { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  get(pageId: number): IndexRecord | null {
    const row = this.db
      .query('SELECT * FROM indexed_pages WHERE page_id = ?')
      .get(pageId) as Record<string, unknown> | null
    return row ? toRecord(row) : null
  }

  put(record: Omit<IndexRecord, 'indexedAt'>): void {
    this.db
      .query(
        `INSERT INTO indexed_pages (page_id, updated_at, content_hash, chunks, indexed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET
           updated_at   = excluded.updated_at,
           content_hash = excluded.content_hash,
           chunks       = excluded.chunks,
           indexed_at   = excluded.indexed_at`,
      )
      .run(
        record.pageId,
        record.updatedAt,
        record.contentHash,
        record.chunks,
        new Date().toISOString(),
      )
  }

  delete(pageId: number): void {
    this.db.query('DELETE FROM indexed_pages WHERE page_id = ?').run(pageId)
  }

  /** Forget everything, forcing a full re-embed. Used when the model changes. */
  clear(): void {
    this.db.exec('DELETE FROM indexed_pages')
  }

  all(): IndexRecord[] {
    const rows = this.db.query('SELECT * FROM indexed_pages').all() as Array<
      Record<string, unknown>
    >
    return rows.map(toRecord)
  }

  stats(): { pages: number; chunks: number; lastIndexedAt: string | null } {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS pages, COALESCE(SUM(chunks), 0) AS chunks, MAX(indexed_at) AS last
         FROM indexed_pages`,
      )
      .get() as Record<string, unknown>
    return {
      pages: Number(row.pages ?? 0),
      chunks: Number(row.chunks ?? 0),
      lastIndexedAt: (row.last as string | null) ?? null,
    }
  }

  /**
   * The embedding model is recorded so that changing it forces a rebuild.
   * Vectors from two different models are not comparable.
   */
  getMeta(key: string): string | null {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as {
      value: string
    } | null
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }
}
