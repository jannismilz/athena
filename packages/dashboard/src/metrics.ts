/**
 * Everything the dashboard shows.
 *
 * Three sources, each answering a different question:
 *   - the Wiki.js database:  what is in the wiki
 *   - Athena's events table: what the AI actually did
 *   - the indexer:           whether search reflects reality
 *
 * The Wiki.js database is read with plain SQL rather than through GraphQL,
 * because these are aggregate questions ("words per area", "who edits what")
 * that the API cannot answer without downloading every page.
 */

import type { Sql } from '@athena/core'

export type Bar = { label: string; value: number; hint?: string }
export type SeriesPoint = { date: string; value: number }

export type PageRow = {
  path: string
  title: string
  updatedAt: string | null
  words?: number
}

export type QueryRow = { query: string; count: number; lastSeen: string }

export type ContentMetrics = {
  pages: number
  words: number
  areas: Bar[]
  stale: PageRow[]
  largest: PageRow[]
}

export type ActivityMetrics = {
  totalCalls: number
  callsPerDay: SeriesPoint[]
  byTool: Bar[]
  byActor: Bar[]
  writeShare: { ai: number; human: number }
  topQueries: QueryRow[]
  zeroResultQueries: QueryRow[]
  failures: Array<{ tool: string; error: string; ts: string }>
}

export type IndexMetrics = {
  reachable: boolean
  model: string | null
  indexedPages: number
  indexedChunks: number
  qdrantPoints: number | null
  lastIndexedAt: string | null
  lastSync: Record<string, unknown> | null
  lastSyncError: string | null
  drift: number
}

const DAY_MS = 86_400_000

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

export function relativeAge(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return 'unknown'
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min ago`
  if (hours < 48) return `${Math.round(hours)} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** Top-level path segment, which is how the wiki is organised. */
function areaOf(path: string): string {
  return path.split('/').filter(Boolean)[0] ?? '(root)'
}

/**
 * Normalise a database timestamp to an ISO string.
 *
 * The Postgres driver hands back `Date` objects for `timestamptz`, and passing
 * one to `Date.parse` yields NaN, so every value from a timestamp column goes
 * through here before it is used or formatted.
 */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'string' && value) return value
  return null
}

export async function contentMetrics(wikiSql: Sql, staleDays: number): Promise<ContentMetrics> {
  const rows = (
    (await wikiSql`
    SELECT path, title, "updatedAt",
           array_length(regexp_split_to_array(trim(coalesce(content, '')), '\\s+'), 1) AS words
    FROM pages
    WHERE "isPublished" = true
  `) as unknown as Array<{
      path: string
      title: string
      updatedAt: unknown
      createdAt: unknown
      words: number | null
    }>
  ).map(row => ({
    ...row,
    updatedAt: toIso(row.updatedAt),
  }))

  const areaTotals = new Map<string, number>()
  let words = 0
  for (const row of rows) {
    words += row.words ?? 0
    const area = areaOf(row.path)
    areaTotals.set(area, (areaTotals.get(area) ?? 0) + 1)
  }

  const cutoff = Date.now() - staleDays * DAY_MS
  const at = (value: string | null) => (value ? Date.parse(value) : 0)
  const stale = rows
    .filter(r => r.updatedAt !== null && at(r.updatedAt) < cutoff)
    .sort((a, b) => at(a.updatedAt) - at(b.updatedAt))
    .slice(0, 10)
    .map(r => ({ path: r.path, title: r.title, updatedAt: r.updatedAt }))

  const largest = [...rows]
    .sort((a, b) => (b.words ?? 0) - (a.words ?? 0))
    .slice(0, 10)
    .map(r => ({ path: r.path, title: r.title, updatedAt: r.updatedAt, words: r.words ?? 0 }))

  return {
    pages: rows.length,
    words,
    areas: [...areaTotals.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    stale,
    largest,
  }
}

const WRITE_TOOLS = [
  'create_page',
  'update_page',
  'append_to_page',
  'save_conversation',
  'capture_note',
]

export async function activityMetrics(sql: Sql, days: number): Promise<ActivityMetrics> {
  const since = new Date(Date.now() - days * DAY_MS).toISOString()

  const [totals, perDay, byTool, byActor, topQueries, zeroResults, failures] = await Promise.all([
    sql`SELECT count(*)::int AS n FROM events WHERE ts >= ${since}`,
    sql`
      SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS date, count(*)::int AS n
      FROM events WHERE ts >= ${since}
      GROUP BY 1 ORDER BY 1
    `,
    sql`
      SELECT tool AS label, count(*)::int AS n
      FROM events WHERE ts >= ${since}
      GROUP BY 1 ORDER BY 2 DESC
    `,
    sql`
      SELECT actor AS label, count(*)::int AS n
      FROM events WHERE ts >= ${since}
      GROUP BY 1 ORDER BY 2 DESC
    `,
    sql`
      SELECT query, count(*)::int AS n, max(ts) AS last_seen
      FROM events
      WHERE ts >= ${since} AND query IS NOT NULL AND query <> ''
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10
    `,
    // Searches that returned nothing: what was asked for and not found.
    sql`
      SELECT query, count(*)::int AS n, max(ts) AS last_seen
      FROM events
      WHERE ts >= ${since} AND query IS NOT NULL AND query <> ''
        AND coalesce(result_count, 0) = 0 AND ok = true
      GROUP BY 1 ORDER BY 2 DESC LIMIT 10
    `,
    sql`
      SELECT tool, coalesce(error, 'unknown') AS error, ts
      FROM events WHERE ts >= ${since} AND ok = false
      ORDER BY ts DESC LIMIT 10
    `,
  ])

  const writes = (byTool as unknown as Array<{ label: string; n: number }>)
    .filter(r => WRITE_TOOLS.includes(r.label))
    .reduce((sum, r) => sum + r.n, 0)

  const asRows = (rows: unknown) => rows as Array<Record<string, unknown>>

  return {
    totalCalls: Number(asRows(totals)[0]?.n ?? 0),
    callsPerDay: fillGaps(
      asRows(perDay).map(r => ({ date: String(r.date), value: Number(r.n) })),
      days,
    ),
    byTool: asRows(byTool).map(r => ({ label: String(r.label), value: Number(r.n) })),
    byActor: asRows(byActor).map(r => ({ label: String(r.label), value: Number(r.n) })),
    writeShare: { ai: writes, human: 0 },
    topQueries: asRows(topQueries).map(r => ({
      query: String(r.query),
      count: Number(r.n),
      lastSeen: toIso(r.last_seen) ?? '',
    })),
    zeroResultQueries: asRows(zeroResults).map(r => ({
      query: String(r.query),
      count: Number(r.n),
      lastSeen: toIso(r.last_seen) ?? '',
    })),
    failures: asRows(failures).map(r => ({
      tool: String(r.tool),
      error: String(r.error),
      ts: toIso(r.ts) ?? '',
    })),
  }
}

/** A day with no activity is a real zero, not a missing point. */
export function fillGaps(points: SeriesPoint[], days: number): SeriesPoint[] {
  const known = new Map(points.map(p => [p.date, p.value]))
  const out: SeriesPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10)
    out.push({ date, value: known.get(date) ?? 0 })
  }
  return out
}

export async function indexMetrics(indexerUrl: string, wikiPages: number): Promise<IndexMetrics> {
  try {
    const response = await fetch(`${indexerUrl.replace(/\/+$/, '')}/stats`, {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const stats = (await response.json()) as Record<string, unknown>
    const qdrant = stats.qdrant as { points?: number } | null

    return {
      reachable: true,
      model: (stats.model as string) ?? null,
      indexedPages: Number(stats.indexedPages ?? 0),
      indexedChunks: Number(stats.indexedChunks ?? 0),
      qdrantPoints: qdrant?.points ?? null,
      lastIndexedAt: (stats.lastIndexedAt as string) ?? null,
      lastSync: (stats.lastSync as Record<string, unknown>) ?? null,
      lastSyncError: (stats.lastSyncError as string) ?? null,
      drift: Math.max(0, wikiPages - Number(stats.indexedPages ?? 0)),
    }
  } catch {
    return {
      reachable: false,
      model: null,
      indexedPages: 0,
      indexedChunks: 0,
      qdrantPoints: null,
      lastIndexedAt: null,
      lastSync: null,
      lastSyncError: null,
      drift: 0,
    }
  }
}
