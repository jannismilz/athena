import { connect, createLogger, dashboardSchema, loadConfig } from '@athena/core'
import { buildApp } from './server.ts'

const config = loadConfig(dashboardSchema)
const log = createLogger('dashboard', config.logLevel)

const shared = {
  host: config.postgresHost,
  port: config.postgresPort,
  user: config.postgresUser,
  password: config.postgresPassword,
}

// Two connections: Athena's own database for the activity log, and the Wiki.js
// database read-only for content metrics that its API cannot aggregate.
const athenaSql = connect({ ...shared, database: config.athenaDb, max: 3 })
const wikiSql = connect({ ...shared, database: process.env.POSTGRES_DB ?? 'wiki', max: 3 })

const server = buildApp(config, athenaSql, wikiSql, log).listen(config.port, config.host, () => {
  log.info('listening', { host: config.host, port: config.port })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal })
    server.close(async () => {
      await Promise.allSettled([athenaSql.end({ timeout: 5 }), wikiSql.end({ timeout: 5 })])
      process.exit(0)
    })
  })
}
