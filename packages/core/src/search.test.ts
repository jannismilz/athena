import { describe, expect, test } from 'bun:test'
import { mergeSearchHits, snippet } from './search.ts'

describe('mergeSearchHits', () => {
  test('a page found only by classic search survives', () => {
    const merged = mergeSearchHits(
      [{ path: 'it/ssh-key-gitlab', title: 'SSH key', description: 'ed25519' }],
      [
        {
          page_path: 'it/overview',
          page_title: 'Overview',
          page_id: 4,
          content: 'SSH in general',
          h1: 'Overview',
        },
      ],
      8,
    )
    const paths = merged.map(h => h.pagePath)
    expect(paths).toContain('it/ssh-key-gitlab')
    expect(paths).toContain('it/overview')
    expect(merged.find(h => h.pagePath === 'it/ssh-key-gitlab')!.match).toBe('classic')
  })

  test('a page found only by semantic search survives, with its headings', () => {
    const merged = mergeSearchHits(
      [],
      [
        {
          page_path: 'it/ssh-key-gitlab',
          page_title: 'SSH key',
          page_id: 12,
          content: 'ssh-keygen -t ed25519',
          h2: 'Key',
        },
      ],
      8,
    )
    expect(merged[0]!.match).toBe('semantic')
    expect(merged[0]!.headings.h2).toBe('Key')
  })

  test('a page in both sources ranks first and keeps its semantic chunk', () => {
    const merged = mergeSearchHits(
      [
        { path: 'it/upstream', title: 'Upstream', description: 'VPN' },
        { path: 'it/ssh-key-gitlab', title: 'SSH key', description: 'ed25519' },
      ],
      [
        {
          page_path: 'it/ssh-key-gitlab',
          page_title: 'SSH key',
          page_id: 12,
          content: 'IdentityFile ~/.ssh/id_ed25519_gitlab',
          h1: 'SSH key',
        },
        { page_path: 'sport/running', page_title: 'Running', page_id: 2, content: 'Tuesdays' },
      ],
      8,
    )
    expect(merged[0]!.pagePath).toBe('it/ssh-key-gitlab')
    expect(merged[0]!.match).toBe('both')
    expect(merged[0]!.content).toContain('id_ed25519_gitlab')
    expect(new Set(merged.map(h => h.match))).toEqual(new Set(['both', 'classic', 'semantic']))
  })

  test('respects the limit and emits one hit per page', () => {
    const merged = mergeSearchHits(
      [{ path: 'a/one', title: 'One', description: 'x' }],
      [
        { page_path: 'a/one', page_title: 'One', page_id: 1, content: 'first' },
        { page_path: 'a/one', page_title: 'One', page_id: 1, content: 'second' },
        { page_path: 'b/two', page_title: 'Two', page_id: 2, content: 'other' },
      ],
      1,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.pagePath).toBe('a/one')
    expect(merged[0]!.content).toBe('first')
  })

  test('paths differing only in slashes are treated as the same page', () => {
    const merged = mergeSearchHits(
      [{ path: '/a/one/', title: 'One', description: 'x' }],
      [{ page_path: 'a/one', page_title: 'One', page_id: 1, content: 'chunk' }],
      8,
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]!.match).toBe('both')
  })

  test('hits without a usable path are dropped', () => {
    expect(mergeSearchHits([{ path: '' }], [{ page_path: null, content: 'x' }], 8)).toEqual([])
  })

  test('empty input yields empty output', () => {
    expect(mergeSearchHits([], [], 8)).toEqual([])
  })
})

describe('snippet', () => {
  test('collapses whitespace', () => {
    expect(snippet('a   b\n\nc\t d')).toBe('a b c d')
  })

  test('truncates with an ellipsis', () => {
    const out = snippet('z'.repeat(500), 10)
    expect(out).toHaveLength(10)
    expect(out.endsWith('…')).toBe(true)
  })
})
