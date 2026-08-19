/**
 * Environment configuration.
 *
 * Every service validates its own slice of the environment at boot and exits
 * loudly on anything missing, rather than failing on the first request hours
 * later. Placeholder values from .env.example are rejected explicitly.
 */

import { z } from 'zod'

const PLACEHOLDER = 'CHANGE_ME'

const secret = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine(v => v !== PLACEHOLDER, `${label} is still set to ${PLACEHOLDER}`)

/**
 * A bare https origin: no path, no query, no fragment.
 *
 * OAuth issuer identifiers must be exact, and a trailing `/mcp` here silently
 * breaks client discovery, so this is worth failing fast on.
 */
export const httpsOrigin = z.string().superRefine((raw, ctx) => {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be a URL, e.g. https://athena-mcp.example.com' })
    return
  }
  if (url.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', message: 'must use https' })
  }
  if (url.search || url.hash) {
    ctx.addIssue({ code: 'custom', message: 'must not include a query or fragment' })
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    ctx.addIssue({ code: 'custom', message: 'must not include a path (not /mcp)' })
  }
})

/** Normalise a validated origin to `https://host` with no trailing slash. */
export function toOrigin(raw: string): string {
  return new URL(raw.trim()).origin
}

const base = {
  // How many reverse proxies sit in front. Express uses this to decide whether
  // to believe X-Forwarded-For and X-Forwarded-Proto, which decide the address
  // the throttles count against and whether the session cookie is marked
  // Secure. One is right for the documented setups, where a single proxy is
  // the only thing that can reach these containers. "loopback" only works when
  // the proxy runs on the host rather than in a container.
  trustProxy: z.string().default('1'),
  tz: z.string().default('UTC'),
  instanceName: z.string().default('Athena'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}

const wiki = {
  wikiUrl: z.string().url().default('http://wikijs:3000'),
  wikiApiToken: secret('WIKI_API_TOKEN'),
  wikiLocale: z.string().default('en'),
}

/** Where the database is. Needed by everything, secret to nothing. */
const postgresLocation = {
  postgresHost: z.string().default('postgres'),
  postgresPort: z.coerce.number().int().positive().default(5432),
  postgresDb: z.string().default('wiki'),
  athenaDb: z.string().default('athena'),
}

/** Credentials that can write. Only services that need to write receive these. */
const postgresAdmin = {
  postgresUser: z.string().default('athena'),
  postgresPassword: secret('POSTGRES_PASSWORD'),
}

const embeddings = {
  embeddingsUrl: z.string().url().default('http://embeddings:80'),
  embeddingsModel: z.string().default('intfloat/multilingual-e5-small'),
  // 'tei' is the bundled Text Embeddings Inference container. 'openai' targets
  // any OpenAI-compatible endpoint, including Ollama and LM Studio.
  embeddingsProvider: z.enum(['tei', 'openai']).default('tei'),
  embeddingsApiKey: z.string().default(''),
}

export const mcpSchema = z.object({
  ...base,
  ...wiki,
  ...postgresLocation,
  ...postgresAdmin,
  dashboardDbPassword: secret('DASHBOARD_DB_PASSWORD'),
  mcpToken: secret('MCP_TOKEN'),
  mcpPublicUrl: httpsOrigin,
  indexerUrl: z.string().url().default('http://indexer:8081'),
  oauthStateDir: z.string().default('/app/state'),
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().positive().default(8080),
})

export const indexerSchema = z.object({
  ...base,
  ...wiki,
  ...postgresLocation,
  ...postgresAdmin,
  dashboardDbPassword: secret('DASHBOARD_DB_PASSWORD'),
  ...embeddings,
  stateDir: z.string().default('/app/state'),
  indexIntervalSeconds: z.coerce.number().int().nonnegative().default(300),
  chunkMaxChars: z.coerce.number().int().positive().default(1200),
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().positive().default(8081),
})

export const dashboardSchema = z.object({
  ...base,
  ...postgresLocation,
  dashboardToken: secret('DASHBOARD_TOKEN'),
  dashboardDbPassword: secret('DASHBOARD_DB_PASSWORD'),
  backupStatusPath: z.string().default('/app/backups/status.json'),
  metricsCacheSeconds: z.coerce.number().int().nonnegative().default(60),
  indexerUrl: z.string().url().default('http://indexer:8081'),
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().positive().default(8082),
})

export type McpConfig = z.infer<typeof mcpSchema>
export type IndexerConfig = z.infer<typeof indexerSchema>
export type DashboardConfig = z.infer<typeof dashboardSchema>

/**
 * Schema keys map onto SCREAMING_SNAKE environment variables by convention, so
 * only the ones that break the pattern are listed.
 */
const ENV_OVERRIDES: Record<string, string> = {
  instanceName: 'ATHENA_INSTANCE_NAME',
  logLevel: 'ATHENA_LOG_LEVEL',
}

function envKey(schemaKey: string): string {
  return ENV_OVERRIDES[schemaKey] ?? schemaKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

/**
 * Validate the process environment against a schema, or exit with a readable
 * list of what is wrong.
 */
export function loadConfig<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const raw: Record<string, unknown> = {}
  for (const key of Object.keys(schema.shape)) {
    const value = env[envKey(key)]
    if (value !== undefined && value !== '') raw[key] = value
  }

  const result = schema.safeParse(raw)
  if (result.success) return result.data

  const lines = result.error.issues.map(
    issue => `  ${envKey(String(issue.path[0] ?? '?'))}: ${issue.message}`,
  )
  console.error(`Invalid configuration:\n${lines.join('\n')}`)
  process.exit(1)
}
