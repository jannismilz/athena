import { bootstrapDatabase, connect, createLogger, loadConfig, mcpSchema } from '@athena/core'
import { buildApp } from './server.ts'

const config = loadConfig(mcpSchema)
const log = createLogger('mcp', config.logLevel)

const dbOptions = {
  host: config.postgresHost,
  port: config.postgresPort,
  user: config.postgresUser,
  password: config.postgresPassword,
  database: config.athenaDb,
}

// Every service with admin credentials prepares the database at boot. An
// advisory lock inside makes that safe to do concurrently, so start order does
// not matter and no service has to wait for another.
await bootstrapDatabase({
  db: dbOptions,
  wikiDatabase: config.postgresDb,
  readonlyPassword: config.dashboardDbPassword,
  log,
})

const sql = connect(dbOptions)

const app = await buildApp(config, sql)
const server = app.listen(config.port, config.host, () => {
  log.info('listening', { host: config.host, port: config.port, publicUrl: config.mcpPublicUrl })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal })
    server.close(() => {
      void sql.end({ timeout: 5 }).then(() => process.exit(0))
    })
  })
}
