/**
 * Activity log.
 *
 * Every MCP tool call writes one row. Without it the only record of what an
 * assistant did would be the pages it changed, which says nothing about what
 * it searched for and failed to find.
 *
 * Writes are best effort. Losing a metric must never fail a tool call.
 */

import type { Sql } from './db.ts'

export type EventInput = {
  actor: string
  tool: string
  pagePath?: string | null
  query?: string | null
  resultCount?: number | null
  durationMs?: number | null
  ok?: boolean
  error?: string | null
}

export class EventLog {
  constructor(
    private readonly sql: Sql,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  async record(event: EventInput): Promise<void> {
    try {
      await this.sql`
        INSERT INTO events (actor, tool, page_path, query, result_count, duration_ms, ok, error)
        VALUES (
          ${event.actor}, ${event.tool}, ${event.pagePath ?? null}, ${event.query ?? null},
          ${event.resultCount ?? null}, ${event.durationMs ?? null},
          ${event.ok ?? true}, ${event.error ?? null}
        )
      `
    } catch (error) {
      this.onError(error)
    }
  }
}
