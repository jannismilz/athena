/**
 * Everything that has to be true about the database before a service starts.
 *
 * Creating the database, applying migrations and provisioning the dashboard's
 * read-only role are one job, not three, and none of them belong to any
 * particular service. Every service that holds admin credentials calls this at
 * boot; the advisory lock inside `migrate` makes concurrent calls safe, so
 * whichever container starts first does the work and the rest find it done.
 *
 * That removes any ordering requirement between services. Nothing has to wait
 * for the indexer, and nothing breaks if you run a subset of the stack.
 */

import { connect, type DbOptions, ensureDatabase, migrate } from './db.ts'
import { ensureReadOnlyRole } from './roles.ts'

export type BootstrapOptions = {
  /** Admin connection details for Athena's own database. */
  db: DbOptions
  /** The Wiki.js database, which the dashboard also reads. */
  wikiDatabase: string
  /** Password for the read-only role the dashboard logs in with. */
  readonlyPassword: string
  log: {
    info: (message: string, fields?: Record<string, unknown>) => void
    warn: (message: string, fields?: Record<string, unknown>) => void
  }
}

export async function bootstrapDatabase(options: BootstrapOptions): Promise<void> {
  const { db, log } = options

  await ensureDatabase(db)
  const sql = connect(db)

  try {
    const applied = await migrate(sql)
    if (applied.length) log.info('migrations applied', { applied })

    await ensureReadOnlyRole(sql, {
      password: options.readonlyPassword,
      database: db.database,
      owner: db.user,
    })

    // The Wiki.js database needs the same grants. Its tables are created later
    // by Wiki.js itself, which is why the default privileges set here matter
    // more than the grants on what exists today.
    const wikiSql = connect({ ...db, database: options.wikiDatabase, max: 1 })
    try {
      await ensureReadOnlyRole(wikiSql, {
        password: options.readonlyPassword,
        database: options.wikiDatabase,
        owner: db.user,
      })
    } finally {
      await wikiSql.end({ timeout: 5 })
    }

    log.info('database ready', { databases: [db.database, options.wikiDatabase] })
  } catch (error) {
    // A failure here is not fatal for the calling service: another one may have
    // already done the work, or will shortly. The dashboard retries its login
    // until the role exists.
    log.warn('database bootstrap incomplete, another service may finish it', {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await sql.end({ timeout: 5 })
  }
}
