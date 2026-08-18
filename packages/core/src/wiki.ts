/**
 * Wiki.js GraphQL client.
 *
 * Wiki.js is the source of truth for every page. This client is the only place
 * that talks to it, and both the MCP server and the indexer share it.
 */

import { normalizePath } from './markdown.ts'

export type PageMeta = {
  id: number
  path: string
  title: string
  locale: string
  updatedAt: string | null
}

export type WikiPage = {
  id: number
  path: string
  title: string
  locale: string
  content: string
  description: string
  editor: string
  isPublished: boolean
  tags: string[]
  updatedAt: string | null
}

export type PageRef = { id: number; path: string; title: string }

export type SearchResult = {
  path: string
  title: string
  description: string
  locale: string
}

/** A page path that does not exist. Callers turn this into a 404. */
export class PageNotFoundError extends Error {
  constructor(path: string) {
    super(`page not found: ${path}`)
    this.name = 'PageNotFoundError'
  }
}

/** Wiki.js accepted the request but refused the operation. */
export class WikiOperationError extends Error {
  constructor(action: string, message: string) {
    super(`${action} failed: ${message}`)
    this.name = 'WikiOperationError'
  }
}

const LIST_QUERY = `query {
  pages { list { id path title locale updatedAt } }
}`

const SINGLE_QUERY = `query ($id: Int!) {
  pages {
    single(id: $id) {
      id path title content description contentType locale editor isPublished updatedAt
      tags { tag }
    }
  }
}`

const SEARCH_QUERY = `query ($query: String!, $locale: String) {
  pages { search(query: $query, locale: $locale) { results { title description path locale } } }
}`

const RESPONSE_RESULT = 'responseResult { succeeded errorCode slug message }'

const CREATE_MUTATION = `mutation (
  $content: String!, $description: String!, $editor: String!, $isPublished: Boolean!,
  $isPrivate: Boolean!, $locale: String!, $path: String!, $tags: [String]!, $title: String!
) {
  pages {
    create(
      content: $content, description: $description, editor: $editor, isPublished: $isPublished,
      isPrivate: $isPrivate, locale: $locale, path: $path, tags: $tags, title: $title
    ) { ${RESPONSE_RESULT} page { id path title } }
  }
}`

const UPDATE_MUTATION = `mutation (
  $id: Int!, $content: String!, $description: String!, $editor: String!,
  $isPublished: Boolean!, $tags: [String]!, $title: String!
) {
  pages {
    update(
      id: $id, content: $content, description: $description, editor: $editor,
      isPublished: $isPublished, tags: $tags, title: $title
    ) { ${RESPONSE_RESULT} page { id path title } }
  }
}`

const DELETE_MUTATION = `mutation ($id: Int!) {
  pages { delete(id: $id) { ${RESPONSE_RESULT} } }
}`

const MOVE_MUTATION = `mutation ($id: Int!, $destinationPath: String!, $destinationLocale: String!) {
  pages {
    move(id: $id, destinationPath: $destinationPath, destinationLocale: $destinationLocale) {
      ${RESPONSE_RESULT}
    }
  }
}`

const RENDER_MUTATION = `mutation ($id: Int!) {
  pages { render(id: $id) { ${RESPONSE_RESULT} } }
}`

type ResponseResult = { succeeded?: boolean; errorCode?: number; slug?: string; message?: string }

export type WikiClientOptions = {
  baseUrl: string
  token: string
  locale?: string
  timeoutMs?: number
  /**
   * How long the page list may be reused. Resolving a path requires the full
   * list, so without this every read costs an extra round trip. Writes flush
   * the cache, so a stale entry can only ever delay visibility of a page
   * created outside Athena.
   */
  listCacheMs?: number
  fetch?: typeof globalThis.fetch
}

export class WikiClient {
  private readonly url: string
  private readonly token: string
  private readonly locale: string
  private readonly timeoutMs: number
  private readonly listCacheMs: number
  private readonly doFetch: typeof globalThis.fetch
  private listCache: { at: number; pages: PageMeta[] } | null = null

  constructor(options: WikiClientOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/graphql`
    this.token = options.token
    this.locale = options.locale ?? 'en'
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.listCacheMs = options.listCacheMs ?? 5_000
    this.doFetch = options.fetch ?? globalThis.fetch
  }

  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await this.doFetch(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      // A bare fetch failure does not say which host was unreachable.
      throw new Error(
        `Wiki.js at ${this.url} is not reachable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Wiki.js HTTP ${response.status}: ${body.slice(0, 400)}`)
    }

    const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> }
    if (payload.errors?.length) {
      throw new Error(`Wiki.js GraphQL: ${payload.errors.map(e => e.message).join('; ')}`)
    }
    if (!payload.data) throw new Error('Wiki.js returned no data')
    return payload.data
  }

  private assertOk(result: { responseResult?: ResponseResult } | null, action: string): void {
    const rr = result?.responseResult
    if (!rr?.succeeded) {
      throw new WikiOperationError(action, rr?.message || JSON.stringify(rr ?? {}))
    }
  }

  /** Drop the page-list cache after any write, so the next read sees the change. */
  invalidate(): void {
    this.listCache = null
  }

  async listPages(force = false): Promise<PageMeta[]> {
    if (!force && this.listCache && Date.now() - this.listCache.at < this.listCacheMs) {
      return this.listCache.pages
    }
    const data = await this.request<{ pages: { list: PageMeta[] | null } }>(LIST_QUERY)
    const pages = data.pages.list ?? []
    this.listCache = { at: Date.now(), pages }
    return pages
  }

  async searchPages(query: string, limit = 8): Promise<SearchResult[]> {
    const data = await this.request<{
      pages: { search: { results: SearchResult[] | null } | null } | null
    }>(SEARCH_QUERY, { query, locale: this.locale })
    const results = data.pages?.search?.results ?? []
    return results.slice(0, Math.max(1, limit))
  }

  /** Resolve a path to page metadata, preferring the configured locale. */
  async findByPath(path: string): Promise<PageMeta | null> {
    const needle = normalizePath(path)
    if (!needle) return null
    const matches = (await this.listPages()).filter(p => normalizePath(p.path ?? '') === needle)
    return matches.find(p => p.locale === this.locale) ?? matches[0] ?? null
  }

  async getPageById(id: number): Promise<WikiPage | null> {
    const data = await this.request<{
      pages: {
        single: (Omit<WikiPage, 'tags'> & { tags?: Array<{ tag?: string }> | null }) | null
      }
    }>(SINGLE_QUERY, { id })
    const raw = data.pages.single
    if (!raw) return null
    return {
      id: raw.id,
      path: raw.path ?? '',
      title: raw.title ?? '',
      locale: raw.locale || this.locale,
      content: raw.content ?? '',
      description: raw.description ?? '',
      editor: raw.editor || 'markdown',
      isPublished: raw.isPublished !== false,
      updatedAt: raw.updatedAt ?? null,
      tags: (raw.tags ?? []).map(t => t?.tag).filter((t): t is string => Boolean(t)),
    }
  }

  async getPage(path: string): Promise<WikiPage> {
    const meta = await this.findByPath(path)
    if (!meta) throw new PageNotFoundError(path)
    const page = await this.getPageById(meta.id)
    if (!page) throw new PageNotFoundError(path)
    return page
  }

  async createPage(input: {
    path: string
    title: string
    content: string
    description?: string
    tags?: string[]
  }): Promise<PageRef> {
    const path = normalizePath(input.path)
    if (!path) throw new Error('path is empty')
    if (await this.findByPath(path)) throw new Error(`page already exists: ${path}`)

    const data = await this.request<{
      pages: { create: { responseResult: ResponseResult; page: PageRef | null } }
    }>(CREATE_MUTATION, {
      content: input.content,
      description: input.description ?? '',
      editor: 'markdown',
      isPublished: true,
      isPrivate: false,
      locale: this.locale,
      path,
      tags: input.tags ?? [],
      title: input.title,
    })

    const result = data.pages.create
    this.assertOk(result, 'pages.create')
    this.invalidate()
    if (!result.page) throw new WikiOperationError('pages.create', 'no page returned')
    return result.page
  }

  /**
   * Ask Wiki.js to re-render a page's HTML.
   *
   * Often admin-only, and an update already triggers the render pipeline, so a
   * failure here is not fatal.
   */
  private async renderPage(id: number): Promise<void> {
    try {
      const data = await this.request<{ pages: { render: { responseResult: ResponseResult } } }>(
        RENDER_MUTATION,
        { id },
      )
      this.assertOk(data.pages.render, 'pages.render')
    } catch {
      // Non-fatal by design.
    }
  }

  async updatePage(input: { path: string; content: string; title?: string }): Promise<PageRef> {
    const page = await this.getPage(input.path)
    const data = await this.request<{
      pages: { update: { responseResult: ResponseResult; page: PageRef | null } }
    }>(UPDATE_MUTATION, {
      id: page.id,
      content: input.content,
      description: page.description,
      editor: page.editor || 'markdown',
      isPublished: true,
      tags: page.tags,
      title: input.title || page.title,
    })

    const result = data.pages.update
    this.assertOk(result, 'pages.update')
    this.invalidate()
    await this.renderPage(page.id)
    return result.page ?? { id: page.id, path: page.path, title: input.title || page.title }
  }

  async deletePage(path: string): Promise<PageRef> {
    const page = await this.getPage(path)
    const data = await this.request<{ pages: { delete: { responseResult: ResponseResult } } }>(
      DELETE_MUTATION,
      { id: page.id },
    )
    this.assertOk(data.pages.delete, 'pages.delete')
    this.invalidate()
    return { id: page.id, path: page.path, title: page.title }
  }

  async movePage(input: { path: string; newPath: string; title?: string }): Promise<PageRef> {
    const page = await this.getPage(input.path)
    const dest = normalizePath(input.newPath)
    if (!dest) throw new Error('new_path is empty')
    if (dest === normalizePath(page.path))
      throw new Error('new_path is the same as the current path')

    const existing = await this.findByPath(dest)
    if (existing && existing.id !== page.id) throw new Error(`target path already exists: ${dest}`)

    const data = await this.request<{ pages: { move: { responseResult: ResponseResult } } }>(
      MOVE_MUTATION,
      { id: page.id, destinationPath: dest, destinationLocale: page.locale || this.locale },
    )
    this.assertOk(data.pages.move, 'pages.move')
    this.invalidate()

    // Wiki.js has no combined move+rename, so a title change is a second call.
    if (input.title && input.title !== page.title) {
      return this.updatePage({ path: dest, content: page.content, title: input.title })
    }
    return { id: page.id, path: dest, title: page.title }
  }
}
