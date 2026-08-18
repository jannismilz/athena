import { describe, expect, test } from 'bun:test'
import { html, raw } from './html.ts'

describe('html templating', () => {
  // Page titles and search queries come from the database and from whatever a
  // model typed. They must never be able to inject markup.
  test('escapes interpolated values', () => {
    const evil = '<script>alert(1)</script>'
    expect(html`<td>${evil}</td>`.value).toBe('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>')
  })

  test('escapes quotes so attribute injection fails', () => {
    expect(html`<a href="${'" onmouseover="steal()'}">x</a>`.value).toBe(
      '<a href="&quot; onmouseover=&quot;steal()">x</a>',
    )
  })

  test('does not escape values explicitly marked raw', () => {
    expect(html`<div>${raw('<b>bold</b>')}</div>`.value).toBe('<div><b>bold</b></div>')
  })

  test('nested templates stay escaped exactly once', () => {
    const inner = html`<td>${'a & b'}</td>`
    expect(html`<tr>${inner}</tr>`.value).toBe('<tr><td>a &amp; b</td></tr>')
  })

  test('renders arrays and skips empty values', () => {
    expect(html`${[1, 2, 3]}`.value).toBe('123')
    expect(html`a${null}b${undefined}c${false}d`.value).toBe('abcd')
  })

  test('renders numbers without escaping them', () => {
    expect(html`<td>${42}</td>`.value).toBe('<td>42</td>')
  })
})
