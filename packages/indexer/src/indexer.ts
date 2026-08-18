/**
 * Keeping the vector index in step with Wiki.js.
 *
 * Wiki.js is the source of truth; this is a derived index that can be thrown
 * away and rebuilt at any time, which is why losing it costs only the time to
 * re-embed.
 */

import {
  chunkMarkdown,
  EmbeddingsClient,
  type IndexerConfig,
  type Logger,
  type Sql,
  type StoredChunk,
  VectorStore,
  WikiClient,
} from '@athena/core'
import { contentFingerprint, IndexState } from './state.ts'

export type SyncSummary = {
  pages: number
  indexed: number
  skipped: number
  failed: number
  removed: number
  durationMs: number
}

const MODEL_META_KEY = 'embedding_model'

export class Indexer {
  private syncing: Promise<SyncSummary> | null = null
  private lastSync: SyncSummary | null = null
  private lastSyncError: string | null = null

  private constructor(
    private readonly config: IndexerConfig,
    private readonly wiki: WikiClient,
    private readonly embeddings: EmbeddingsClient,
    private readonly store: VectorStore,
    private readonly state: IndexState,
    private readonly log: Logger,
  ) {}

  /**
   * Wire everything up and make the vector collection match the current model.
   *
   * Switching embedding model changes the vector width, and vectors from two
   * models cannot be compared, so a change forces the collection to be rebuilt
   * rather than silently returning nonsense results.
   */
  static async create(config: IndexerConfig, sql: Sql, log: Logger): Promise<Indexer> {
    const wiki = new WikiClient({
      baseUrl: config.wikiUrl,
      token: config.wikiApiToken,
      locale: config.wikiLocale,
    })
    const embeddings = new EmbeddingsClient({
      baseUrl: config.embeddingsUrl,
      model: config.embeddingsModel,
      provider: config.embeddingsProvider,
      apiKey: config.embeddingsApiKey,
    })
    const store = new VectorStore(sql)
    const state = new IndexState(config.stateDir)

    const dimensions = await embeddings.getDimensions()
    log.info('embedding model ready', { model: config.embeddingsModel, dimensions })

    const previousModel = state.getMeta(MODEL_META_KEY)
    const { rebuilt } = await store.ensureSchema(dimensions)

    if (rebuilt || (previousModel && previousModel !== config.embeddingsModel)) {
      log.warn('embedding model changed, re-indexing every page', {
        from: previousModel,
        to: config.embeddingsModel,
        dimensions,
      })
      state.clear()
    }
    state.setMeta(MODEL_META_KEY, config.embeddingsModel)

    return new Indexer(config, wiki, embeddings, store, state, log)
  }

  /**
   * Reconcile the whole wiki.
   *
   * Only one sync runs at a time; a concurrent caller joins the one in flight
   * rather than starting a second full pass.
   */
  sync(): Promise<SyncSummary> {
    if (this.syncing) return this.syncing
    this.syncing = this.runSync().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async runSync(): Promise<SyncSummary> {
    const started = performance.now()
    const summary: SyncSummary = {
      pages: 0,
      indexed: 0,
      skipped: 0,
      failed: 0,
      removed: 0,
      durationMs: 0,
    }

    try {
      const pages = await this.wiki.listPages(true)
      summary.pages = pages.length
      const keep = new Set<number>()

      for (const meta of pages) {
        keep.add(meta.id)
        try {
          const result = await this.indexPage(meta.id, meta.updatedAt)
          if (result.skipped) summary.skipped++
          else summary.indexed++
        } catch (error) {
          summary.failed++
          this.log.error('failed to index page', {
            pageId: meta.id,
            path: meta.path,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // Pages deleted in Wiki.js while the indexer was down leave orphan chunks.
      summary.removed = await this.store.deleteMissingPages(keep)
      for (const record of this.state.all()) {
        if (!keep.has(record.pageId)) this.state.delete(record.pageId)
      }

      this.lastSyncError = null
    } catch (error) {
      this.lastSyncError = error instanceof Error ? error.message : String(error)
      this.log.error('sync failed', { error: this.lastSyncError })
      throw error
    } finally {
      summary.durationMs = Math.round(performance.now() - started)
      this.lastSync = summary
    }

    this.log.info('sync complete', summary)
    return summary
  }

  /**
   * Index one page, skipping the embedding call when nothing has changed.
   *
   * `updatedAt` is the cheap check; the content hash is the honest one, since
   * a Wiki.js save can bump the timestamp without changing a byte.
   */
  async indexPage(
    pageId: number,
    updatedAtHint?: string | null,
    force = false,
  ): Promise<{ chunks: number; skipped: boolean }> {
    const known = this.state.get(pageId)
    if (!force && known && updatedAtHint && known.updatedAt === updatedAtHint) {
      return { chunks: known.chunks, skipped: true }
    }

    const page = await this.wiki.getPageById(pageId)
    if (!page?.content.trim()) {
      await this.store.deletePage(pageId)
      this.state.delete(pageId)
      return { chunks: 0, skipped: false }
    }

    const hash = contentFingerprint(page.content, page.title, page.path)
    if (!force && known && known.contentHash === hash) {
      // Timestamp moved but the text did not: record the new timestamp so the
      // cheap check succeeds next time, and skip the expensive part.
      this.state.put({
        pageId,
        updatedAt: page.updatedAt,
        contentHash: hash,
        chunks: known.chunks,
      })
      return { chunks: known.chunks, skipped: true }
    }

    const chunks = chunkMarkdown(page.content, page.title, this.config.chunkMaxChars)
    if (!chunks.length) {
      await this.store.deletePage(pageId)
      this.state.delete(pageId)
      return { chunks: 0, skipped: false }
    }

    const vectors = await this.embeddings.embed(chunks.map(c => c.embedText))
    const written = await this.store.upsertPage({
      pageId: page.id,
      pagePath: page.path,
      pageTitle: page.title,
      locale: page.locale,
      chunks,
      vectors,
    })

    this.state.put({ pageId, updatedAt: page.updatedAt, contentHash: hash, chunks: written })
    return { chunks: written, skipped: false }
  }

  async indexPath(path: string): Promise<{ chunks: number; skipped: boolean }> {
    const meta = await this.wiki.findByPath(path)
    if (!meta) throw new Error(`page not found: ${path}`)
    return this.indexPage(meta.id, meta.updatedAt)
  }

  async unindexPage(pageId: number): Promise<void> {
    await this.store.deletePage(pageId)
    this.state.delete(pageId)
  }

  async search(query: string, limit = 8): Promise<StoredChunk[]> {
    const vector = await this.embeddings.embedOne(query)
    return this.store.search(vector, Math.max(1, Math.min(limit, 20)))
  }

  async stats() {
    const local = this.state.stats()
    const remote = await this.store.stats().catch(() => null)
    return {
      model: this.config.embeddingsModel,
      indexedPages: local.pages,
      indexedChunks: local.chunks,
      lastIndexedAt: local.lastIndexedAt,
      store: remote,
      lastSync: this.lastSync,
      lastSyncError: this.lastSyncError,
      syncInProgress: this.syncing !== null,
    }
  }

  close(): void {
    this.state.close()
  }
}
