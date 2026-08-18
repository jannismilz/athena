import { describe, expect, test } from 'bun:test'
import { appendToSection } from './markdown.ts'

const PAGE = `# DNS

## Resolvers

Forwarder is 192.0.2.1.

## Caching

Nothing yet.
`

describe('appendToSection', () => {
  test('appends inside the named section, not at the end of the page', () => {
    const out = appendToSection(PAGE, 'Resolvers', 'Fallback is 192.0.2.2.')
    const added = out.indexOf('Fallback is')
    expect(added).toBeGreaterThan(-1)
    expect(added).toBeLessThan(out.indexOf('## Caching'))
  })

  test('matches the heading case-insensitively at any level', () => {
    expect(appendToSection(PAGE, 'resolvers', 'x')).toContain('x')
    expect(appendToSection('# T\n\n### Deep\n\nbody\n', 'deep', 'y')).toMatch(
      /### Deep\n\nbody\n\ny/,
    )
  })

  test('creates the heading when it does not exist', () => {
    const out = appendToSection(PAGE, 'Zones', 'New zone.', 2)
    expect(out).toContain('## Zones')
    expect(out.indexOf('## Zones')).toBeGreaterThan(out.indexOf('## Caching'))
    expect(out).toContain('New zone.')
  })

  test('a deeper subsection is kept inside its parent section', () => {
    const page = '# T\n\n## A\n\ntext\n\n### A1\n\nsub\n\n## B\n\nother\n'
    const out = appendToSection(page, 'A', 'added')
    expect(out.indexOf('added')).toBeGreaterThan(out.indexOf('sub'))
    expect(out.indexOf('added')).toBeLessThan(out.indexOf('## B'))
  })

  test('appending to the last section works', () => {
    const out = appendToSection(PAGE, 'Caching', 'Now something.')
    expect(out.trimEnd().endsWith('Now something.')).toBe(true)
  })

  test('empty additions are ignored', () => {
    expect(appendToSection(PAGE, 'Resolvers', '   ')).toBe(PAGE)
  })

  test('creating a section on an empty page does not leave leading blank lines', () => {
    expect(appendToSection('', 'Notes', 'first')).toBe('## Notes\n\nfirst\n')
  })

  test('does not collapse content into a run of blank lines', () => {
    const out = appendToSection(PAGE, 'Resolvers', 'more')
    expect(out).not.toMatch(/\n{3,}/)
  })
})
