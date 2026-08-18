/**
 * A very small HTML templating helper.
 *
 * Interpolated values are escaped by default; anything deliberately trusted has
 * to be wrapped in `raw()`. That way page titles and search queries coming out
 * of the database cannot inject markup, without a template engine or a build
 * step in the way.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ESCAPES[c]!)
}

/** Marks a string as already-safe HTML. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

export function raw(value: string): Html {
  return new Html(value)
}

/** `boolean` is allowed so `cond && html`…`` works; `false` renders as nothing. */
export type Renderable = Html | string | number | boolean | null | undefined | Renderable[]

function render(value: Renderable): string {
  if (value === null || value === undefined || value === false) return ''
  if (value instanceof Html) return value.value
  if (Array.isArray(value)) return value.map(render).join('')
  return escapeHtml(String(value))
}

export function html(strings: TemplateStringsArray, ...values: Renderable[]): Html {
  let out = strings[0] ?? ''
  for (const [i, value] of values.entries()) {
    out += render(value) + (strings[i + 1] ?? '')
  }
  return new Html(out)
}
