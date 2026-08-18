/**
 * Internal HTTP API.
 *
 * Not exposed publicly: only the MCP server and the dashboard talk to it, over
 * the compose network. Semantic search lives here because this is the process
 * that owns the embedding client.
 */

import type { Logger } from '@athena/core'
import express, { type Express } from 'express'
import { z } from 'zod'
import type { Indexer } from './indexer.ts'

const searchBody = z.object({
  query: z.string().min(1, 'query required'),
  limit: z.coerce.number().int().min(1).max(20).default(8),
})

const pageBody = z.object({
  page_id: z.coerce.number().int().positive().optional(),
  path: z.string().min(1).optional(),
})

export function buildApp(indexer: Indexer, log: Logger): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'indexer' })
  })

  app.get('/stats', async (_req, res) => {
    res.json(await indexer.stats())
  })

  app.post('/search', async (req, res) => {
    const parsed = searchBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid body' })
      return
    }
    try {
      res.json({ hits: await indexer.search(parsed.data.query, parsed.data.limit) })
    } catch (error) {
      log.error('search failed', { error: String(error) })
      res.status(500).json({ error: 'search failed' })
    }
  })

  app.post('/reindex', async (req, res) => {
    const parsed = pageBody.safeParse(req.body)
    if (!parsed.success || (!parsed.data.page_id && !parsed.data.path)) {
      res.status(400).json({ error: 'page_id or path required' })
      return
    }
    try {
      const result = parsed.data.page_id
        ? await indexer.indexPage(parsed.data.page_id, null, true)
        : await indexer.indexPath(parsed.data.path!)
      res.json({ chunks: result.chunks, skipped: result.skipped })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('page not found')) {
        res.status(404).json({ error: message })
        return
      }
      log.error('reindex failed', { error: message })
      res.status(500).json({ error: 'reindex failed' })
    }
  })

  app.post('/unindex', async (req, res) => {
    const parsed = pageBody.safeParse(req.body)
    if (!parsed.success || !parsed.data.page_id) {
      res.status(400).json({ error: 'page_id required' })
      return
    }
    try {
      await indexer.unindexPage(parsed.data.page_id)
      res.json({ ok: true })
    } catch (error) {
      log.error('unindex failed', { error: String(error) })
      res.status(500).json({ error: 'unindex failed' })
    }
  })

  /** Kick off a full reconciliation without waiting for the next tick. */
  app.post('/sync', async (_req, res) => {
    try {
      res.json(await indexer.sync())
    } catch (error) {
      res.status(500).json({ error: String(error) })
    }
  })

  return app
}
