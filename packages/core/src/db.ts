/**
 * Postgres access for Athena's own data.
 *
 * Athena keeps its tables in a separate database from Wiki.js, so a Wiki.js
 * upgrade can never collide with them and a wiki restore never rolls back the
 * activity log.
 */

import postgres from 'postgres'

export type Sql = postgres.Sql

export type DbOptions = {
  host: string
  port: number
  user: string
  password: string
  database: string
  max?: number
}

export function connect(options: DbOptions): Sql {
  return postgres({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    max: options.max ?? 5,
    onnotice: () => {},
  })
}

/**
 * Connect to the `postgres` maintenance database and create Athena's database
 * if it is missing, so a fresh stack needs no manual setup step.
 */
export async function ensureDatabase(options: DbOptions): Promise<void> {
  const admin = postgres({
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: 'postgres',
    max: 1,
    onnotice: () => {},
  })
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${options.database}`
    if (!rows.length) {
      // CREATE DATABASE cannot be parameterised or run inside a transaction.
      await admin.unsafe(`CREATE DATABASE "${options.database.replace(/"/g, '""')}"`)
    }
  } finally {
    await admin.end({ timeout: 5 })
  }
}

/**
 * Ordered schema migrations.
 *
 * Plain SQL applied in order and recorded in `schema_migrations`. One table
 * does not justify a migration framework.
 */
const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '001_events',
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id            bigserial PRIMARY KEY,
        ts            timestamptz NOT NULL DEFAULT now(),
        actor         text        NOT NULL,
        tool          text        NOT NULL,
        page_path     text,
        query         text,
        result_count  integer,
        duration_ms   integer,
        ok            boolean     NOT NULL DEFAULT true,
        error         text
      );
      CREATE INDEX IF NOT EXISTS events_ts_idx        ON events (ts DESC);
      CREATE INDEX IF NOT EXISTS events_tool_ts_idx   ON events (tool, ts DESC);
      CREATE INDEX IF NOT EXISTS events_actor_ts_idx  ON events (actor, ts DESC);
      CREATE INDEX IF NOT EXISTS events_query_idx     ON events (query) WHERE query IS NOT NULL;
    `,
  },
]

/** Arbitrary but fixed: identifies Athena's migration lock within Postgres. */
const MIGRATION_LOCK_ID = 8_274_119

/**
 * Apply pending migrations.
 *
 * Every service calls this at boot rather than electing one migrator, so no
 * service can start against a schema that does not exist yet and quietly drop
 * writes. A session-level advisory lock makes concurrent callers safe: the
 * first wins, the rest wait and then find nothing left to do.
 */
export async function migrate(sql: Sql): Promise<string[]> {
  return sql.begin(async tx => {
    // Released automatically when this transaction ends, including on error.
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`

    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `
    const applied = new Set(
      (await tx`SELECT name FROM schema_migrations`).map(r => r.name as string),
    )
    const ran: string[] = []

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) continue
      await tx.unsafe(migration.sql)
      await tx`INSERT INTO schema_migrations (name) VALUES (${migration.name})`
      ran.push(migration.name)
    }
    return ran
  }) as Promise<string[]>
}
