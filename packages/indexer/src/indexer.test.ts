/**
 * Behaviour of the incremental sync.
 *
 * Skipping unchanged pages is not observable from the outside, so these tests
 * assert it directly by counting calls to the embedding client.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '@athena/core'
import { Indexer } from './indexer.ts'

type FakePage = {
  id: number
  path: string
  title: string
  content: string
  updatedAt: string | null
}

let dir: string
let embedCalls: string[][]
let upserts: number[]
let deletes: number[]
let pages: FakePage[]

const log = createLogger('test', 'error')

/**
 * Build an Indexer with fake collaborators. The class takes them via a private
 * constructor, so the test reaches in deliberately rather than standing up
 * Postgres, Wiki.js and an embedding server.
 */
function buildIndexer(): Indexer {
  const wiki = {
    listPages: async () => pages.map(p => ({ ...p, locale: 'en' })),
    getPageById: async (id: number) => {
      const page = pages.find(p => p.id === id)
      return page
        ? {
            ...page,
            locale: 'en',
            description: '',
            editor: 'markdown',
            isPublished: true,
            tags: [],
          }
        : null
    },
    findByPath: async (path: string) => pages.find(p => p.path === path) ?? null,
  }

  const embeddings = {
    embed: async (texts: string[]) => {
      embedCalls.push(texts)
      return texts.map(() => [0.1, 0.2, 0.3])
    },
    embedOne: async () => [0.1, 0.2, 0.3],
    getDimensions: async () => 3,
  }

  const store = {
    upsertPage: async (input: { pageId: number; chunks: unknown[] }) => {
      upserts.push(input.pageId)
      return input.chunks.length
    },
    deletePage: async (pageId: number) => {
      deletes.push(pageId)
    },
    deleteMissingPages: async () => 0,
    stats: async () => ({ chunks: 0, pages: 0 }),
    ensureSchema: async () => ({ rebuilt: false }),
  }

  const config = {
    embeddingsModel: 'test-model',
    chunkMaxChars: 1200,
    stateDir: dir,
  }

  const { IndexState } = require('./state.ts') as typeof import('./state.ts')
  const Ctor = Indexer as unknown as new (...args: unknown[]) => Indexer
  return new Ctor(config, wiki, embeddings, store, new IndexState(dir), log)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'athena-sync-'))
  embedCalls = []
  upserts = []
  deletes = []
  pages = [
    {
      id: 1,
      path: 'it/dns',
      title: 'DNS',
      content: '# DNS\n\nForwarder.',
      updatedAt: '2026-08-01T10:00:00Z',
    },
    {
      id: 2,
      path: 'sport/running',
      title: 'Running',
      content: '# Running\n\nTuesdays.',
      updatedAt: '2026-08-02T10:00:00Z',
    },
  ]
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('incremental sync', () => {
  test('the first pass indexes every page', async () => {
    const indexer = buildIndexer()
    const summary = await indexer.sync()
    expect(summary.pages).toBe(2)
    expect(summary.indexed).toBe(2)
    expect(summary.skipped).toBe(0)
    expect(embedCalls).toHaveLength(2)
    indexer.close()
  })

  // This is the regression the rewrite exists to prevent.
  test('a second pass with no changes embeds nothing', async () => {
    const indexer = buildIndexer()
    await indexer.sync()
    embedCalls = []
    upserts = []

    const summary = await indexer.sync()
    expect(summary.skipped).toBe(2)
    expect(summary.indexed).toBe(0)
    expect(embedCalls).toHaveLength(0)
    expect(upserts).toHaveLength(0)
    indexer.close()
  })

  test('only the changed page is re-embedded', async () => {
    const indexer = buildIndexer()
    await indexer.sync()
    embedCalls = []
    upserts = []

    pages[0]!.content = '# DNS\n\nA different forwarder.'
    pages[0]!.updatedAt = '2026-08-03T10:00:00Z'

    const summary = await indexer.sync()
    expect(summary.indexed).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(upserts).toEqual([1])
    indexer.close()
  })

  // Wiki.js bumps updatedAt on a save even when the text is identical.
  test('a touched timestamp with unchanged text does not re-embed', async () => {
    const indexer = buildIndexer()
    await indexer.sync()
    embedCalls = []

    pages[0]!.updatedAt = '2026-08-05T10:00:00Z'
    const summary = await indexer.sync()

    expect(embedCalls).toHaveLength(0)
    expect(summary.skipped).toBe(2)
    indexer.close()
  })

  test('after a no-op timestamp bump the cheap check succeeds again', async () => {
    const indexer = buildIndexer()
    await indexer.sync()
    pages[0]!.updatedAt = '2026-08-05T10:00:00Z'
    await indexer.sync()
    embedCalls = []

    // The new timestamp was recorded, so this pass short-circuits before
    // even fetching the page body.
    const summary = await indexer.sync()
    expect(summary.skipped).toBe(2)
    expect(embedCalls).toHaveLength(0)
    indexer.close()
  })

  test('a renamed page is re-embedded even with the same body', async () => {
    const indexer = buildIndexer()
    await indexer.sync()
    upserts = []

    pages[0]!.title = 'Domain Name System'
    pages[0]!.updatedAt = '2026-08-06T10:00:00Z'

    await indexer.sync()
    expect(upserts).toEqual([1])
    indexer.close()
  })

  test('force ignores the fingerprint, which is what a write-through reindex needs', async () => {
    const indexer = buildIndexer()
    await indexer.sync()
    embedCalls = []

    const result = await indexer.indexPage(1, null, true)
    expect(result.skipped).toBe(false)
    expect(embedCalls).toHaveLength(1)
    indexer.close()
  })

  test('an emptied page is removed from the index', async () => {
    const indexer = buildIndexer()
    await indexer.sync()

    pages[0]!.content = '   '
    pages[0]!.updatedAt = '2026-08-07T10:00:00Z'
    await indexer.sync()

    expect(deletes).toContain(1)
    indexer.close()
  })

  test('a page deleted in Wiki.js is forgotten', async () => {
    const indexer = buildIndexer()
    await indexer.sync()
    pages = pages.filter(p => p.id !== 2)

    await indexer.sync()
    const stats = await indexer.stats()
    expect(stats.indexedPages).toBe(1)
    indexer.close()
  })

  test('one failing page does not abort the pass', async () => {
    const indexer = buildIndexer()
    // A page whose body cannot be fetched.
    pages.push({ id: 3, path: 'broken', title: 'Broken', content: 'x', updatedAt: 'now' })
    const original = (indexer as unknown as { wiki: { getPageById: unknown } }).wiki.getPageById
    ;(indexer as unknown as { wiki: { getPageById: unknown } }).wiki.getPageById = async (
      id: number,
    ) => {
      if (id === 3) throw new Error('boom')
      return (original as (id: number) => Promise<unknown>)(id)
    }

    const summary = await indexer.sync()
    expect(summary.failed).toBe(1)
    expect(summary.indexed).toBe(2)
    indexer.close()
  })

  test('concurrent sync calls share one pass', async () => {
    const indexer = buildIndexer()
    const [a, b] = await Promise.all([indexer.sync(), indexer.sync()])
    expect(a).toBe(b)
    expect(embedCalls).toHaveLength(2)
    indexer.close()
  })
})
