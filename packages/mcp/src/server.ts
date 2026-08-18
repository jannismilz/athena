/**
 * HTTP surface of the MCP server.
 *
 * Routes:
 *   /.well-known/oauth-*  discovery, so Claude.ai can find the auth endpoints
 *   /authorize /token /register /revoke   OAuth 2.1, from the MCP SDK
 *   /login                the human password step
 *   /mcp                  the MCP endpoint itself, bearer-protected
 *   /health               liveness for compose
 */

import {
  actorFromClient,
  createLogger,
  EventLog,
  type McpConfig,
  type Sql,
  WikiClient,
} from '@athena/core'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type Express } from 'express'
import { AthenaOAuthProvider } from './auth/provider.ts'
import { loginRouter } from './auth/routes.ts'
import { IndexerClient } from './indexer-client.ts'
import { registerTools } from './tools.ts'

export async function buildApp(config: McpConfig, sql: Sql): Promise<Express> {
  const log = createLogger('mcp', config.logLevel)
  const wiki = new WikiClient({
    baseUrl: config.wikiUrl,
    token: config.wikiApiToken,
    locale: config.wikiLocale,
  })
  const indexer = new IndexerClient(config.indexerUrl)
  const events = new EventLog(sql, error =>
    log.warn('event log write failed', { error: String(error) }),
  )

  const provider = await AthenaOAuthProvider.create({
    password: config.mcpToken,
    issuer: config.mcpPublicUrl,
    stateDir: config.oauthStateDir,
    onStateError: error => log.error('oauth state write failed', { error: String(error) }),
  })

  const app = express()
  app.disable('x-powered-by')
  // Trust only a proxy on loopback. With `true`, any client that reached the
  // app directly could set X-Forwarded-For and evade the login throttle.
  app.set('trust proxy', 'loopback')

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'mcp' })
  })

  const issuerUrl = new URL(config.mcpPublicUrl)
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: new URL('/mcp', issuerUrl),
      resourceName: config.instanceName,
      scopesSupported: ['wiki'],
    }),
  )
  app.use(loginRouter(provider, config.instanceName))

  const requireAuth = requireBearerAuth({ verifier: provider, requiredScopes: ['wiki'] })

  app.all('/mcp', requireAuth, express.json({ limit: '4mb' }), async (req, res) => {
    // A fresh server and transport per request keeps sessions stateless, so a
    // container restart never strands a client mid-conversation.
    const server = new McpServer(
      { name: 'athena', version: '0.1.0' },
      { instructions: INSTRUCTIONS },
    )

    const clientId = req.auth?.clientId ?? ''
    const actor = actorFromClient(clientId, provider.clientHints(clientId))

    registerTools(server, {
      wiki,
      indexer,
      events,
      log,
      timeZone: config.tz,
      currentActor: () => actor,
    })

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      log.error('mcp request failed', { error: String(error) })
      if (!res.headersSent) res.status(500).json({ error: 'internal error' })
    }
  })

  return app
}

const INSTRUCTIONS = `Athena is a Wiki.js wiki you can read and write.

Wiki.js is the source of truth. Search is only for finding pages; always load the
page with get_page before quoting or editing it.

Working order:
  1. search_knowledge to find candidates
  2. get_page_structure on a long page, or get_page for the full text
  3. answer, or write with append_to_page / update_page / create_page

Prefer append_to_page over update_page when adding to a page: it leaves the rest
of the document untouched. Use update_page only when genuinely rewriting.

Paths are lowercase ASCII with hyphens, no leading or trailing slash, and shallow
(area/topic). Titles may contain any characters. Put location, variant and detail
in headings inside the page rather than in the path.

You do not need to write provenance into pages; every page you touch is stamped
automatically with your name and the time.`
