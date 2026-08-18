/** Minimal structured logger. One JSON object per line, so `docker logs` stays greppable. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type Logger = Record<LogLevel, (message: string, fields?: Record<string, unknown>) => void>

export function createLogger(service: string, level: LogLevel = 'info'): Logger {
  const threshold = ORDER[level]
  const emit = (lvl: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      service,
      message,
      ...fields,
    })
    if (lvl === 'error' || lvl === 'warn') console.error(line)
    else console.log(line)
  }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}
