import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentFingerprint, IndexState } from './state.ts'

let dir: string
let state: IndexState

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'athena-index-'))
  state = new IndexState(dir)
})

afterEach(async () => {
  state.close()
  await rm(dir, { recursive: true, force: true })
})

describe('contentFingerprint', () => {
  test('is stable for identical input', () => {
    expect(contentFingerprint('body', 'Title', 'a/b')).toBe(
      contentFingerprint('body', 'Title', 'a/b'),
    )
  })

  test('changes when the body changes', () => {
    expect(contentFingerprint('body', 'T', 'a/b')).not.toBe(contentFingerprint('body2', 'T', 'a/b'))
  })

  // Title and path are embedded alongside the text, so a rename must
  // invalidate the vectors even though the body is untouched.
  test('changes when only the title or path changes', () => {
    expect(contentFingerprint('body', 'T', 'a/b')).not.toBe(contentFingerprint('body', 'T2', 'a/b'))
    expect(contentFingerprint('body', 'T', 'a/b')).not.toBe(contentFingerprint('body', 'T', 'a/c'))
  })
})

describe('IndexState', () => {
  test('round-trips a record', () => {
    state.put({ pageId: 1, updatedAt: '2026-08-01T00:00:00Z', contentHash: 'h1', chunks: 3 })
    const record = state.get(1)!
    expect(record.pageId).toBe(1)
    expect(record.updatedAt).toBe('2026-08-01T00:00:00Z')
    expect(record.contentHash).toBe('h1')
    expect(record.chunks).toBe(3)
    expect(record.indexedAt).toBeTruthy()
  })

  test('put is an upsert', () => {
    state.put({ pageId: 1, updatedAt: 'a', contentHash: 'h1', chunks: 1 })
    state.put({ pageId: 1, updatedAt: 'b', contentHash: 'h2', chunks: 5 })
    expect(state.all()).toHaveLength(1)
    expect(state.get(1)!.chunks).toBe(5)
  })

  test('returns null for an unknown page', () => {
    expect(state.get(999)).toBeNull()
  })

  test('delete and clear remove records', () => {
    state.put({ pageId: 1, updatedAt: null, contentHash: 'h', chunks: 1 })
    state.put({ pageId: 2, updatedAt: null, contentHash: 'h', chunks: 1 })
    state.delete(1)
    expect(state.all()).toHaveLength(1)
    state.clear()
    expect(state.all()).toHaveLength(0)
  })

  test('aggregates stats across pages', () => {
    state.put({ pageId: 1, updatedAt: null, contentHash: 'h', chunks: 3 })
    state.put({ pageId: 2, updatedAt: null, contentHash: 'h', chunks: 4 })
    const stats = state.stats()
    expect(stats.pages).toBe(2)
    expect(stats.chunks).toBe(7)
    expect(stats.lastIndexedAt).toBeTruthy()
  })

  test('reports zeroes rather than nulls when empty', () => {
    expect(state.stats()).toEqual({ pages: 0, chunks: 0, lastIndexedAt: null })
  })

  test('meta values persist across reopen', () => {
    state.setMeta('embedding_model', 'model-a')
    state.setMeta('embedding_model', 'model-b')
    state.close()

    const reopened = new IndexState(dir)
    expect(reopened.getMeta('embedding_model')).toBe('model-b')
    expect(reopened.getMeta('missing')).toBeNull()
    reopened.close()
    state = new IndexState(dir)
  })

  test('records survive a reopen', () => {
    state.put({ pageId: 7, updatedAt: 'x', contentHash: 'h', chunks: 2 })
    state.close()
    state = new IndexState(dir)
    expect(state.get(7)!.chunks).toBe(2)
  })
})
