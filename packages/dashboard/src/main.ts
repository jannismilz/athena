import { connect, createLogger, dashboardSchema, loadConfig, READONLY_ROLE } from '@athena/core'
import { buildApp } from './server.ts'

const config = loadConfig(dashboardSchema)
const log = createLogger('dashboard', config.logLevel)

/**
 * The dashboard holds no credential that can change anything.
 *
 * It logs in as a role with SELECT and nothing else, using its own password.
 * The Postgres admin password and the Wiki.js API token are never passed to
 * this container, so compromising it yields read access to the wiki and no
 * more.
 *
 * The role is created during database bootstrap by whichever service holds
 * admin credentials. If the dashboard starts first the login fails, so it waits
 * rather than falling back to anything weaker.
 */
const shared = {
  host: config.postgresHost,
  port: config.postgresPort,
  user: READONLY_ROLE,
  password: config.dashboardDbPassword,
}

const athenaSql = connect({ ...shared, database: config.athenaDb, max: 3 })
const wikiSql = connect({ ...shared, database: config.postgresDb, max: 3 })

for (let attempt = 1; ; attempt++) {
  try {
    await athenaSql`SELECT 1`
    log.info('connected as the read-only role', { role: READONLY_ROLE })
    break
  } catch (error) {
    const wait = Math.min(attempt * 3, 15)
    log.warn('waiting for the read-only role, which another service provisions', {
      attempt,
      retryInSeconds: wait,
      error: error instanceof Error ? error.message : String(error),
    })
    await Bun.sleep(wait * 1000)
  }
}

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
