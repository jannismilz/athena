import { describe, expect, test } from 'bun:test'
import { PageNotFoundError, WikiClient, WikiOperationError } from './wiki.ts'

type Call = { query: string; variables: Record<string, unknown> }

/** A fake GraphQL transport that records calls and replays canned responses. */
function fakeWiki(handlers: Record<string, (v: Record<string, unknown>) => unknown>) {
  const calls: Call[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      query: string
      variables?: Record<string, unknown>
    }
    const variables = body.variables ?? {}
    calls.push({ query: body.query, variables })

    const key = Object.keys(handlers).find(k => body.query.includes(k))
    if (!key) throw new Error(`unexpected query: ${body.query.slice(0, 60)}`)
    const data = handlers[key]!(variables)
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch

  const client = new WikiClient({
    baseUrl: 'http://wiki.test',
    token: 't',
    locale: 'en',
    listCacheMs: 0,
    fetch: fetchImpl,
  })
  return { client, calls }
}

const PAGES = [
  { id: 1, path: 'it/dns', title: 'DNS', locale: 'en', updatedAt: '2026-08-01T10:00:00Z' },
  { id: 2, path: 'it/dns', title: 'DNS (de)', locale: 'de', updatedAt: '2026-08-01T10:00:00Z' },
  {
    id: 3,
    path: 'sport/running',
    title: 'Running',
    locale: 'en',
    updatedAt: '2026-08-02T10:00:00Z',
  },
]

const ok = { succeeded: true, errorCode: 0, slug: 'ok', message: null }

describe('findByPath', () => {
  test('prefers the configured locale when a path exists twice', async () => {
    const { client } = fakeWiki({ 'pages { list': () => ({ pages: { list: PAGES } }) })
    expect((await client.findByPath('it/dns'))!.id).toBe(1)
  })

  test('ignores surrounding slashes', async () => {
    const { client } = fakeWiki({ 'pages { list': () => ({ pages: { list: PAGES } }) })
    expect((await client.findByPath('/it/dns/'))!.id).toBe(1)
  })

  test('returns null for an unknown path', async () => {
    const { client } = fakeWiki({ 'pages { list': () => ({ pages: { list: PAGES } }) })
    expect(await client.findByPath('nope/missing')).toBeNull()
  })
})

describe('getPage', () => {
  test('throws PageNotFoundError rather than a generic error', async () => {
    const { client } = fakeWiki({ 'pages { list': () => ({ pages: { list: PAGES } }) })
    expect(client.getPage('nope/missing')).rejects.toThrow(PageNotFoundError)
  })

  test('normalises nulls and flattens tags', async () => {
    const { client } = fakeWiki({
      'pages { list': () => ({ pages: { list: PAGES } }),
      'single(id:': () => ({
        pages: {
          single: {
            id: 1,
            path: 'it/dns',
            title: 'DNS',
            content: '# DNS',
            description: null,
            locale: 'en',
            editor: null,
            isPublished: true,
            updatedAt: '2026-08-01T10:00:00Z',
            tags: [{ tag: 'infra' }, { tag: null }, {}],
          },
        },
      }),
    })
    const page = await client.getPage('it/dns')
    expect(page.description).toBe('')
    expect(page.editor).toBe('markdown')
    expect(page.tags).toEqual(['infra'])
  })
})

describe('createPage', () => {
  test('refuses to overwrite an existing path', async () => {
    const { client } = fakeWiki({ 'pages { list': () => ({ pages: { list: PAGES } }) })
    expect(client.createPage({ path: 'it/dns', title: 'x', content: 'y' })).rejects.toThrow(
      'page already exists',
    )
  })

  test('normalises the path and defaults editor to markdown', async () => {
    const { client, calls } = fakeWiki({
      'pages { list': () => ({ pages: { list: PAGES } }),
      'create(': () => ({
        pages: { create: { responseResult: ok, page: { id: 9, path: 'a/b', title: 'T' } } },
      }),
    })
    await client.createPage({ path: '/a/b/', title: 'T', content: 'body' })
    const create = calls.find(c => c.query.includes('create('))!
    expect(create.variables.path).toBe('a/b')
    expect(create.variables.editor).toBe('markdown')
    expect(create.variables.locale).toBe('en')
  })

  test('surfaces a Wiki.js refusal as WikiOperationError', async () => {
    const { client } = fakeWiki({
      'pages { list': () => ({ pages: { list: PAGES } }),
      'create(': () => ({
        pages: {
          create: {
            responseResult: { succeeded: false, message: 'Path is invalid' },
            page: null,
          },
        },
      }),
    })
    const attempt = client.createPage({ path: 'a/b', title: 'T', content: 'c' })
    expect(attempt).rejects.toThrow(WikiOperationError)
    expect(attempt).rejects.toThrow(/pages\.create failed: Path is invalid/)
  })
})

describe('updatePage', () => {
  test('preserves description and tags that the caller never sent', async () => {
    const { client, calls } = fakeWiki({
      'pages { list': () => ({ pages: { list: PAGES } }),
      'single(id:': () => ({
        pages: {
          single: {
            id: 1,
            path: 'it/dns',
            title: 'DNS',
            content: 'old',
            description: 'the dns page',
            locale: 'en',
            editor: 'markdown',
            isPublished: true,
            updatedAt: null,
            tags: [{ tag: 'infra' }],
          },
        },
      }),
      'update(': () => ({
        pages: { update: { responseResult: ok, page: { id: 1, path: 'it/dns', title: 'DNS' } } },
      }),
      'render(': () => ({ pages: { render: { responseResult: ok } } }),
    })
    await client.updatePage({ path: 'it/dns', content: 'new' })
    const update = calls.find(c => c.query.includes('update('))!
    expect(update.variables.description).toBe('the dns page')
    expect(update.variables.tags).toEqual(['infra'])
    expect(update.variables.content).toBe('new')
  })
})

describe('movePage', () => {
  test('refuses a move onto an occupied path', async () => {
    const { client } = fakeWiki({
      'pages { list': () => ({ pages: { list: PAGES } }),
      'single(id:': () => ({
        pages: {
          single: {
            id: 1,
            path: 'it/dns',
            title: 'DNS',
            content: 'c',
            description: '',
            locale: 'en',
            editor: 'markdown',
            isPublished: true,
            updatedAt: null,
            tags: [],
          },
        },
      }),
    })
    expect(client.movePage({ path: 'it/dns', newPath: 'sport/running' })).rejects.toThrow(
      'target path already exists',
    )
  })

  test('refuses a no-op move', async () => {
    const { client } = fakeWiki({
      'pages { list': () => ({ pages: { list: PAGES } }),
      'single(id:': () => ({
        pages: {
          single: {
            id: 1,
            path: 'it/dns',
            title: 'DNS',
            content: 'c',
            description: '',
            locale: 'en',
            editor: 'markdown',
            isPublished: true,
            updatedAt: null,
            tags: [],
          },
        },
      }),
    })
    expect(client.movePage({ path: 'it/dns', newPath: '/it/dns/' })).rejects.toThrow(
      'same as the current path',
    )
  })
})

describe('transport', () => {
  test('turns a GraphQL errors array into a readable message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Unauthorized' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch
    const client = new WikiClient({ baseUrl: 'http://wiki.test', token: 'bad', fetch: fetchImpl })
    expect(client.listPages()).rejects.toThrow(/Wiki\.js GraphQL: Unauthorized/)
  })

  test('reports a non-200 with its status', async () => {
    const fetchImpl = (async () =>
      new Response('nginx 502', { status: 502 })) as unknown as typeof globalThis.fetch
    const client = new WikiClient({ baseUrl: 'http://wiki.test', token: 't', fetch: fetchImpl })
    expect(client.listPages()).rejects.toThrow(/HTTP 502/)
  })
})

describe('list cache', () => {
  test('reuses the page list within its window and flushes it on write', async () => {
    let listCalls = 0
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string }
      if (body.query.includes('pages { list')) listCalls++
      const data = body.query.includes('pages { list')
        ? { pages: { list: PAGES } }
        : { pages: { create: { responseResult: ok, page: { id: 9, path: 'a/b', title: 'T' } } } }
      return new Response(JSON.stringify({ data }), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const client = new WikiClient({
      baseUrl: 'http://wiki.test',
      token: 't',
      locale: 'en',
      listCacheMs: 60_000,
      fetch: fetchImpl,
    })

    await client.findByPath('it/dns')
    await client.findByPath('sport/running')
    expect(listCalls).toBe(1)

    await client.createPage({ path: 'a/b', title: 'T', content: 'c' })
    await client.findByPath('it/dns')
    expect(listCalls).toBeGreaterThan(1)
  })
})
