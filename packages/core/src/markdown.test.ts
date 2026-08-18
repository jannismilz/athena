import { describe, expect, test } from 'bun:test'
import { chunkMarkdown, headingTree, normalizePath } from './markdown.ts'

describe('normalizePath', () => {
  test('strips leading and trailing slashes', () => {
    expect(normalizePath('/meta/documentation-rules/')).toBe('meta/documentation-rules')
    expect(normalizePath('house/heating')).toBe('house/heating')
  })

  test('collapses empty segments', () => {
    expect(normalizePath('//a///b//')).toBe('a/b')
    expect(normalizePath('')).toBe('')
  })
})

describe('headingTree', () => {
  test('does not repeat the title as a second h1', () => {
    const tree = headingTree('# DNS\n\n## Primary\n\n### Configuration\n', 'DNS')
    expect(tree[0]).toEqual({ level: 1, text: 'DNS' })
    expect(tree).toContainEqual({ level: 2, text: 'Primary' })
    expect(tree).toContainEqual({ level: 3, text: 'Configuration' })
    expect(tree.filter(h => h.text === 'DNS')).toHaveLength(1)
  })
})

describe('chunkMarkdown', () => {
  const md = `# Kubernetes
## Network
### DNS
#### Primary
##### Configuration

The forwarder is 192.0.2.1.

## Overlay

More text about the overlay.
`

  test('keeps the full heading path on a chunk', () => {
    const chunks = chunkMarkdown(md, 'Kubernetes', 1200)
    const forwarder = chunks.find(c => c.text.includes('forwarder'))!
    expect(forwarder).toBeDefined()
    expect(forwarder.headings).toMatchObject({
      h1: 'Kubernetes',
      h2: 'Network',
      h3: 'DNS',
      h4: 'Primary',
      h5: 'Configuration',
    })
    expect(forwarder.embedText).toContain('Kubernetes > Network > DNS > Primary > Configuration')
  })

  test('a sibling heading clears the deeper levels', () => {
    const chunks = chunkMarkdown(md, 'Kubernetes', 1200)
    const overlay = chunks.find(c => c.headings.h2 === 'Overlay')!
    expect(overlay).toBeDefined()
    expect(overlay.headings.h3).toBeUndefined()
    expect(overlay.headings.h4).toBeUndefined()
    expect(overlay.text).toContain('More text')
  })

  test('chunk indices are contiguous from zero', () => {
    const chunks = chunkMarkdown(md, 'Kubernetes', 1200)
    expect(chunks.map(c => c.chunkIndex)).toEqual(chunks.map((_, i) => i))
  })

  test('splits over-long sections on paragraph boundaries', () => {
    const para = `${'x'.repeat(200)}`
    const body = Array.from({ length: 10 }, () => para).join('\n\n')
    const chunks = chunkMarkdown(`# T\n\n${body}\n`, 'T', 500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(500)
  })

  test('hard-splits a single paragraph that exceeds the limit', () => {
    const chunks = chunkMarkdown(`# T\n\n${'y'.repeat(1000)}\n`, 'T', 300)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300)
  })

  test('a page with no headings still yields one chunk', () => {
    const chunks = chunkMarkdown('Just a sentence.', 'Title', 1200)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.headings.h1).toBe('Title')
    expect(chunks[0]!.embedText.startsWith('Title\n\n')).toBe(true)
  })

  test('empty content yields no chunks', () => {
    expect(chunkMarkdown('', 'Title', 1200)).toEqual([])
    expect(chunkMarkdown('   \n\n  ', 'Title', 1200)).toEqual([])
  })
})
