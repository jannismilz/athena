import {
  connect,
  createLogger,
  ensureDatabase,
  indexerSchema,
  loadConfig,
  migrate,
} from '@athena/core'
import { Indexer } from './indexer.ts'
import { buildApp } from './server.ts'

const config = loadConfig(indexerSchema)
const log = createLogger('indexer', config.logLevel)

// Migrations run under an advisory lock, so it is safe for every service to
// call this concurrently at boot.
const dbOptions = {
  host: process.env.POSTGRES_HOST ?? 'postgres',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'athena',
  password: process.env.POSTGRES_PASSWORD ?? '',
  database: process.env.ATHENA_DB ?? 'athena',
}

if (dbOptions.password) {
  await ensureDatabase(dbOptions)
  const sql = connect(dbOptions)
  const applied = await migrate(sql)
  if (applied.length) log.info('migrations applied', { applied })
  await sql.end({ timeout: 5 })
}

/**
 * Wiki.js, Qdrant and the embedding container all start alongside this one, so
 * the first few attempts are expected to fail. Retry rather than crash-loop.
 */
async function startIndexer(): Promise<Indexer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Indexer.create(config, log)
    } catch (error) {
      const wait = Math.min(attempt * 5, 30)
      log.warn('startup failed, retrying', {
        attempt,
        retryInSeconds: wait,
        error: error instanceof Error ? error.message : String(error),
      })
      await Bun.sleep(wait * 1000)
    }
  }
}

const indexer = await startIndexer()

const server = buildApp(indexer, log).listen(config.port, config.host, () => {
  log.info('listening', { host: config.host, port: config.port })
})

let stopping = false

// Reconcile on boot, then on a timer. Writes trigger their own targeted
// reindex through /reindex, so this loop only catches edits made in the
// Wiki.js UI and anything missed while the process was down.
void (async () => {
  while (!stopping) {
    try {
      await indexer.sync()
    } catch {
      // Already logged; the next tick retries.
    }
    if (config.indexIntervalSeconds <= 0) break
    await Bun.sleep(config.indexIntervalSeconds * 1000)
  }
})()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
    log.info('shutting down', { signal })
    server.close(() => {
      indexer.close()
      process.exit(0)
    })
  })
}
