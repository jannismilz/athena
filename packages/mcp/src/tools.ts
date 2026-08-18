/**
 * The tools an AI client can call.
 *
 * Reading and writing are both first-class operations, so the wiki can grow
 * through use.
 *
 * Every write goes to Wiki.js first and is reindexed afterwards. Wiki.js is
 * correct immediately; search can lag by the length of one reindex.
 */

import {
  appendToSection,
  applyCreateFooter,
  applyUpdateFooter,
  type EventLog,
  headingTree,
  type Logger,
  mergeSearchHits,
  normalizePath,
  PageNotFoundError,
  type WikiClient,
} from '@athena/core'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { IndexerClient } from './indexer-client.ts'
import { conversationPath, notePath } from './paths.ts'

export type ToolContext = {
  wiki: WikiClient
  indexer: IndexerClient
  events: EventLog
  log: Logger
  timeZone: string
  /** Resolves the calling client to a display name for the provenance footer. */
  currentActor: () => string
}

const pathArg = z.string().min(1).describe('Wiki page path, for example it/dns')

/** What a tool wants recorded in the activity log beyond its own name. */
type EventDetail = { pagePath?: string | null; query?: string | null }

function text(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { wiki, indexer, events, log } = ctx

  /**
   * Register one tool.
   *
   * Handlers return plain data and may throw. This wrapper serialises the
   * result, turns a thrown error into a tool error rather than a transport
   * failure, and records exactly one activity-log row per call.
   */
  function tool<S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    detail: (args: z.infer<z.ZodObject<S>>) => EventDetail = () => ({}),
  ): void {
    server.registerTool(name, config, (async (args: z.infer<z.ZodObject<S>>) => {
      const started = performance.now()
      const base = { actor: ctx.currentActor(), tool: name, ...detail(args) }
      try {
        const result = await run(args)
        void events.record({
          ...base,
          durationMs: Math.round(performance.now() - started),
          ok: true,
          resultCount: Array.isArray(result) ? result.length : null,
        })
        return text(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        void events.record({
          ...base,
          durationMs: Math.round(performance.now() - started),
          ok: false,
          error: message,
        })
        return text({ error: message }, true)
      }
    }) as never)
  }

  /** Reindex after a write. A stale index must never fail the write itself. */
  async function reindex(pageId: number): Promise<number | null> {
    try {
      return await indexer.reindex(pageId)
    } catch (error) {
      log.warn('reindex failed, search will catch up on the next sync', {
        pageId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /** Write a page and immediately reindex it, the shape every write tool returns. */
  async function written(page: { id: number; path: string; title: string }) {
    return { ...page, chunks: await reindex(page.id) }
  }

  tool(
    'search_knowledge',
    {
      title: 'Search the wiki',
      description:
        'Search the wiki both by keyword and by meaning, merged into one ranked list. ' +
        'Every hit carries a page path; load the page with get_page before answering.',
      inputSchema: {
        query: z.string().min(1).describe('What to look for'),
        limit: z.number().int().min(1).max(20).default(8).describe('Maximum hits'),
      },
    },
    async ({ query, limit }) => {
      const trimmed = query.trim()
      if (!trimmed) return []
      const cap = Math.max(1, Math.min(limit ?? 8, 20))
      const fetchCount = Math.min(cap * 2, 20)

      // One source failing must still return the other's results.
      const [classic, semantic] = await Promise.all([
        wiki.searchPages(trimmed, fetchCount).catch(error => {
          log.warn('keyword search failed', { error: String(error) })
          return []
        }),
        indexer.search(trimmed, fetchCount).catch(error => {
          log.warn('semantic search failed', { error: String(error) })
          return []
        }),
      ])
      return mergeSearchHits(classic, semantic, cap)
    },
    ({ query }) => ({ query }),
  )

  tool(
    'list_pages',
    {
      title: 'List pages',
      description: 'Every page in the wiki with its id, path, title and last update time.',
      inputSchema: {},
    },
    async () => {
      const pages = await wiki.listPages(true)
      return pages.map(p => ({ id: p.id, path: p.path, title: p.title, updatedAt: p.updatedAt }))
    },
  )

  tool(
    'get_page',
    {
      title: 'Read a page',
      description: 'Full Markdown of one page. This is the authoritative text.',
      inputSchema: { path: pathArg },
    },
    async ({ path }) => {
      const page = await wiki.getPage(path)
      return { id: page.id, path: page.path, title: page.title, content: page.content }
    },
    ({ path }) => ({ pagePath: path }),
  )

  tool(
    'get_page_structure',
    {
      title: 'Outline a page',
      description:
        'Heading tree of a page without its body. Use this to decide where new content belongs ' +
        'before loading or rewriting a long page.',
      inputSchema: { path: pathArg },
    },
    async ({ path }) => {
      const page = await wiki.getPage(path)
      return {
        id: page.id,
        path: page.path,
        title: page.title,
        headings: headingTree(page.content, page.title),
      }
    },
    ({ path }) => ({ pagePath: path }),
  )

  tool(
    'create_page',
    {
      title: 'Create a page',
      description:
        'Create a new Markdown page. Paths are lowercase, hyphenated and shallow, such as it/dns.',
      inputSchema: {
        path: pathArg,
        title: z.string().min(1).describe('Human-readable title; may contain any characters'),
        content: z.string().describe('Markdown body'),
        description: z.string().optional().describe('One-line summary shown in search results'),
        tags: z.array(z.string()).optional().describe('Use sparingly, only across the tree'),
      },
    },
    async ({ path, title, content, description, tags }) =>
      written(
        await wiki.createPage({
          path,
          title,
          content: applyCreateFooter(content, ctx.currentActor(), ctx.timeZone),
          ...(description ? { description } : {}),
          ...(tags ? { tags } : {}),
        }),
      ),
    ({ path }) => ({ pagePath: path }),
  )

  tool(
    'update_page',
    {
      title: 'Replace a page',
      description:
        'Replace the entire Markdown body of a page. To add to a page without resending it, ' +
        'use append_to_page instead.',
      inputSchema: {
        path: pathArg,
        content: z.string().describe('The complete new Markdown body'),
        title: z.string().optional().describe('New title, if it should change'),
      },
    },
    async ({ path, content, title }) => {
      const stored = await wiki.getPage(path)
      return written(
        await wiki.updatePage({
          path,
          content: applyUpdateFooter(content, stored.content, ctx.currentActor(), ctx.timeZone),
          ...(title ? { title } : {}),
        }),
      )
    },
    ({ path }) => ({ pagePath: path }),
  )

  tool(
    'append_to_page',
    {
      title: 'Append to a page',
      description:
        'Add text under a heading on an existing page, creating the heading if needed. ' +
        'Preferred over update_page for adding a fact, since the rest of the page is untouched.',
      inputSchema: {
        path: pathArg,
        heading: z.string().min(1).describe('Heading to append under, such as Configuration'),
        content: z.string().min(1).describe('Markdown to add'),
        level: z.number().int().min(1).max(6).default(2).describe('Level if the heading is new'),
      },
    },
    async ({ path, heading, content, level }) => {
      const stored = await wiki.getPage(path)
      // Append to the body only, so the footer stays at the bottom.
      const merged = appendToSection(stored.content, heading, content, level ?? 2)
      return written(
        await wiki.updatePage({
          path,
          content: applyUpdateFooter(merged, stored.content, ctx.currentActor(), ctx.timeZone),
        }),
      )
    },
    ({ path }) => ({ pagePath: path }),
  )

  tool(
    'move_page',
    {
      title: 'Move or rename a page',
      description: 'Move a page to a new path, optionally changing its title.',
      inputSchema: {
        path: pathArg,
        new_path: z.string().min(1).describe('Destination path'),
        title: z.string().optional().describe('New title, if it should change'),
      },
    },
    async ({ path, new_path, title }) =>
      written(await wiki.movePage({ path, newPath: new_path, ...(title ? { title } : {}) })),
    ({ path }) => ({ pagePath: path }),
  )

  tool(
    'delete_page',
    {
      title: 'Delete a page',
      description: 'Delete a page and remove it from the search index. This cannot be undone.',
      inputSchema: { path: pathArg },
    },
    async ({ path }) => {
      const page = await wiki.deletePage(path)
      try {
        await indexer.unindex(page.id)
      } catch (error) {
        log.warn('unindex failed, the sync loop will remove the orphan', {
          pageId: page.id,
          error: String(error),
        })
      }
      return { ...page, deleted: true }
    },
    ({ path }) => ({ pagePath: path }),
  )

  tool(
    'save_conversation',
    {
      title: 'Save this conversation',
      description:
        'File the current conversation in the wiki under conversations/YYYY/MM/. ' +
        'Write a summary worth reading later, not a raw transcript.',
      inputSchema: {
        title: z.string().min(1).describe('What this conversation was about'),
        content: z.string().min(1).describe('Markdown summary or transcript'),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ title, content, tags }) => {
      const path = conversationPath(title, ctx.timeZone)
      return written(
        await wiki.createPage({
          path,
          title,
          content: applyCreateFooter(content, ctx.currentActor(), ctx.timeZone),
          description: `Conversation with ${ctx.currentActor()}`,
          ...(tags ? { tags } : {}),
        }),
      )
    },
  )

  tool(
    'capture_note',
    {
      title: 'Capture a note',
      description:
        'Drop an unsorted note into inbox/ for filing later. Use when the right home for a ' +
        'piece of information is not obvious yet.',
      inputSchema: {
        title: z.string().min(1).describe('Short title'),
        content: z.string().min(1).describe('Markdown body'),
      },
    },
    async ({ title, content }) =>
      written(
        await wiki.createPage({
          path: notePath(title, ctx.timeZone),
          title,
          content: applyCreateFooter(content, ctx.currentActor(), ctx.timeZone),
        }),
      ),
  )

  tool(
    'get_wiki_stats',
    {
      title: 'Wiki statistics',
      description:
        'Size and shape of the wiki: page counts per area, index health, and the pages that ' +
        'have gone longest without an update. Useful for answering what is missing.',
      inputSchema: {
        stale_days: z.number().int().min(1).default(180).describe('Age threshold for stale pages'),
      },
    },
    async ({ stale_days }) => {
      const pages = await wiki.listPages(true)
      const cutoff = Date.now() - (stale_days ?? 180) * 86_400_000

      const areas: Record<string, number> = {}
      for (const page of pages) {
        const area = normalizePath(page.path).split('/')[0] || '(root)'
        areas[area] = (areas[area] ?? 0) + 1
      }

      const stale = pages
        .filter(p => p.updatedAt && Date.parse(p.updatedAt) < cutoff)
        .sort((a, b) => Date.parse(a.updatedAt!) - Date.parse(b.updatedAt!))
        .slice(0, 20)
        .map(p => ({ path: p.path, title: p.title, updatedAt: p.updatedAt }))

      return {
        pages: pages.length,
        areas: Object.fromEntries(Object.entries(areas).sort((a, b) => b[1] - a[1])),
        staleThresholdDays: stale_days ?? 180,
        stalePages: stale,
        index: await indexer.stats().catch(() => null),
      }
    },
  )
}

/** Re-exported so the server can map a missing page to a 404 if it wants to. */
export { PageNotFoundError }
