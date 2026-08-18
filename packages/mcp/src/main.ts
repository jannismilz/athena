import { connect, createLogger, ensureDatabase, loadConfig, mcpSchema, migrate } from '@athena/core'
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

// Every service migrates at boot under an advisory lock, so whichever starts
// first wins and none can begin writing events into a schema that is not there.
await ensureDatabase(dbOptions)
const sql = connect(dbOptions)
const applied = await migrate(sql)
if (applied.length) log.info('migrations applied', { applied })

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
