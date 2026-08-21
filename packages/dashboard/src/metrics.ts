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
  /** False until the Wiki.js setup wizard has created its schema. */
  wikiReady: boolean
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
  /** Calls that changed the wiki, as opposed to only reading it. */
  writeCalls: number
  topQueries: QueryRow[]
  zeroResultQueries: QueryRow[]
  failures: Array<{ tool: string; error: string; ts: string }>
}

export type BackupStatus = {
  ok: boolean
  finishedAt: string | null
  bytes: number | null
  durationSeconds: number | null
  destination: string | null
  error: string | null
  ageHours: number | null
}

export type IndexMetrics = {
  reachable: boolean
  model: string | null
  indexedPages: number
  indexedChunks: number
  storedChunks: number | null
  lastIndexedAt: string | null
  lastSync: Record<string, unknown> | null
  lastSyncError: string | null
  drift: number
}

const DAY_MS = 86_400_000

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'n/a'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/**
 * Compact form for a table cell, where one decimal always survives.
 *
 * `formatCount` rounds hard above ten thousand because it feeds the big tiles,
 * where "319k" reads better than "318.5k". In a column of page sizes the
 * decimal is the whole point, so 14,220 words is 14.2k.
 */
export function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** Ages are read at a glance and share a column with numbers, so they stay tight. */
export function relativeAge(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return 'unknown'
  const hours = ms / 3_600_000
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
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

const EMPTY_CONTENT: ContentMetrics = {
  wikiReady: false,
  pages: 0,
  words: 0,
  areas: [],
  stale: [],
  largest: [],
}

/**
 * Size and shape of the wiki.
 *
 * Every figure is aggregated in Postgres and only the rows actually displayed
 * come back. The earlier version fetched one row per page and counted words in
 * JavaScript, which meant reading the full text of the entire wiki on every
 * dashboard load.
 */
export async function contentMetrics(wikiSql: Sql, staleDays: number): Promise<ContentMetrics> {
  const cutoff = new Date(Date.now() - staleDays * DAY_MS).toISOString()

  try {
    // Ask once whether Wiki.js has created its schema. Letting the four queries
    // below fail instead would work, but each logs a server-side ERROR in
    // Postgres on every dashboard load until the setup wizard has been run.
    const [probe] = await wikiSql`SELECT to_regclass('public.pages') AS tbl`
    if (!probe?.tbl) return EMPTY_CONTENT

    const [totals, areas, stale, largest] = await Promise.all([
      wikiSql`
        SELECT count(*)::int AS pages,
               coalesce(sum(
                 array_length(regexp_split_to_array(trim(coalesce(content, '')), '\\s+'), 1)
               ), 0)::bigint AS words
        FROM pages WHERE "isPublished" = true
      `,
      wikiSql`
        SELECT split_part(path, '/', 1) AS label, count(*)::int AS value
        FROM pages WHERE "isPublished" = true
        GROUP BY 1 ORDER BY 2 DESC
      `,
      wikiSql`
        SELECT path, title, "updatedAt"
        FROM pages
        WHERE "isPublished" = true AND "updatedAt" < ${cutoff}
        ORDER BY "updatedAt" ASC
        LIMIT 10
      `,
      wikiSql`
        SELECT path, title, "updatedAt",
               array_length(regexp_split_to_array(trim(coalesce(content, '')), '\\s+'), 1) AS words
        FROM pages WHERE "isPublished" = true
        ORDER BY length(coalesce(content, '')) DESC
        LIMIT 10
      `,
    ])

    const row = (totals as unknown as Array<Record<string, unknown>>)[0]
    const page = (r: Record<string, unknown>): PageRow => ({
      path: String(r.path ?? ''),
      title: String(r.title ?? ''),
      updatedAt: toIso(r.updatedAt),
    })

    return {
      wikiReady: true,
      pages: Number(row?.pages ?? 0),
      words: Number(row?.words ?? 0),
      areas: (areas as unknown as Array<Record<string, unknown>>).map(r => ({
        label: String(r.label || '(root)'),
        value: Number(r.value),
      })),
      stale: (stale as unknown as Array<Record<string, unknown>>).map(page),
      largest: (largest as unknown as Array<Record<string, unknown>>).map(r => ({
        ...page(r),
        words: Number(r.words ?? 0),
      })),
    }
  } catch (error) {
    // 42P01: the table does not exist, so Wiki.js has not run its setup wizard
    // yet. On a fresh install that is expected, not a fault.
    if ((error as { code?: string })?.code === '42P01') return EMPTY_CONTENT
    throw error
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
    writeCalls: writes,
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
    const store = stats.store as { chunks?: number } | null

    return {
      reachable: true,
      model: (stats.model as string) ?? null,
      indexedPages: Number(stats.indexedPages ?? 0),
      indexedChunks: Number(stats.indexedChunks ?? 0),
      storedChunks: store?.chunks ?? null,
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
      storedChunks: null,
      lastIndexedAt: null,
      lastSync: null,
      lastSyncError: null,
      drift: 0,
    }
  }
}

/**
 * Read the status file the backup container writes after each run.
 *
 * A backup nobody can see the state of is not a backup, which is why this is on
 * the dashboard rather than only in a log.
 */
export async function backupStatus(path: string): Promise<BackupStatus> {
  try {
    const data = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>
    const finishedAt = (data.finished_at as string) ?? null
    return {
      ok: data.ok === true,
      finishedAt,
      bytes: data.bytes === undefined ? null : Number(data.bytes),
      durationSeconds: data.duration_seconds === undefined ? null : Number(data.duration_seconds),
      destination: (data.destination as string) ?? null,
      error: (data.error as string) ?? null,
      ageHours: finishedAt ? (Date.now() - Date.parse(finishedAt)) / 3_600_000 : null,
    }
  } catch {
    return {
      ok: false,
      finishedAt: null,
      bytes: null,
      durationSeconds: null,
      destination: null,
      error: 'no backup has reported yet',
      ageHours: null,
    }
  }
}
