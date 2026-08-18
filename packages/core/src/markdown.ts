/**
 * Markdown utilities shared by the MCP server and the indexer.
 *
 * These are pure functions over strings, so they can be tested without any
 * external services.
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/

/** Wiki.js paths are lowercase, slash-separated and never start or end with a slash. */
export function normalizePath(path: string): string {
  return path.trim().split('/').filter(Boolean).join('/')
}

export type Heading = { level: number; text: string }

/**
 * Heading outline of a page, so an AI can see its shape without loading the body.
 *
 * The page title is emitted as the first h1. A literal `# Title` at the top of
 * the body that repeats the title is dropped, so the outline has one root.
 */
export function headingTree(content: string, pageTitle: string): Heading[] {
  const headings: Heading[] = []
  const title = pageTitle.trim()
  if (title) headings.push({ level: 1, text: title })

  for (const line of content.split('\n')) {
    const match = HEADING_RE.exec(line)
    if (!match) continue
    const level = match[1]!.length
    const text = match[2]!.trim()
    if (level === 1 && headings[0]?.text === text) continue
    headings.push({ level, text })
  }
  return headings
}

export type Chunk = {
  text: string
  /** Enclosing headings at the time of the chunk, keyed h1..h6. */
  headings: Record<string, string>
  chunkIndex: number
  /** What actually gets embedded: heading breadcrumb + body. */
  embedText: string
}

function breadcrumb(headings: Record<string, string>): string {
  return Object.keys(headings)
    .sort()
    .map(k => headings[k])
    .filter((v): v is string => Boolean(v))
    .join(' > ')
}

function makeChunk(headings: Record<string, string>, text: string, chunkIndex: number): Chunk {
  const path = breadcrumb(headings)
  const body = text.trim()
  return {
    text: body,
    headings,
    chunkIndex,
    embedText: path ? `${path}\n\n${body}` : body,
  }
}

/** Split an over-long section on paragraph boundaries, hard-cutting only as a last resort. */
function splitLong(text: string, maxChars: number): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChars) return [trimmed]

  const parts: string[] = []
  let buf: string[] = []
  let size = 0
  for (const para of trimmed.split(/\n{2,}/)) {
    const extra = para.length + (buf.length ? 2 : 0)
    if (buf.length && size + extra > maxChars) {
      parts.push(buf.join('\n\n'))
      buf = [para]
      size = para.length
    } else {
      buf.push(para)
      size += extra
    }
  }
  if (buf.length) parts.push(buf.join('\n\n'))

  const out: string[] = []
  for (const part of parts) {
    if (part.length <= maxChars) {
      out.push(part)
      continue
    }
    for (let i = 0; i < part.length; i += maxChars) {
      out.push(part.slice(i, i + maxChars).trim())
    }
  }
  return out.filter(Boolean)
}

/**
 * Split Markdown into chunks that keep their heading context.
 *
 * Sections are cut at headings rather than at a fixed token count, so a chunk
 * always knows where it sits in the page: `Kubernetes > Network > DNS`.
 */
export function chunkMarkdown(content: string, pageTitle: string, maxChars = 1200): Chunk[] {
  const headings: Record<string, string> = { h1: pageTitle }
  let buffer: string[] = []
  const sections: Array<[Record<string, string>, string]> = []

  const flush = () => {
    const body = buffer.join('\n').trim()
    buffer = []
    if (body) sections.push([{ ...headings }, body])
  }

  for (const line of content.split('\n')) {
    const match = HEADING_RE.exec(line)
    if (match) {
      flush()
      const level = match[1]!.length
      headings[`h${level}`] = match[2]!.trim()
      // A heading closes every deeper level that came before it.
      for (let deeper = level + 1; deeper <= 6; deeper++) delete headings[`h${deeper}`]
      continue
    }
    buffer.push(line)
  }
  flush()

  if (!sections.length && content.trim()) {
    sections.push([{ h1: pageTitle }, content.trim()])
  }

  const chunks: Chunk[] = []
  let index = 0
  for (const [state, body] of sections) {
    for (const piece of splitLong(body, maxChars)) {
      chunks.push(makeChunk(state, piece, index))
      index++
    }
  }
  return chunks
}

/**
 * Append text under a named heading, creating the heading if it is absent.
 *
 * This exists so adding a line to a page does not mean a model regenerating
 * the whole document: it can send only what is new. Matching is
 * case-insensitive on the heading text at any level; a new heading is added at
 * the end at `level`.
 */
export function appendToSection(
  content: string,
  heading: string,
  addition: string,
  level = 2,
): string {
  const text = (content ?? '').replace(/\r\n?/g, '\n')
  const body = addition.trim()
  if (!body) return text

  const wanted = heading.trim().toLowerCase()
  const lines = text.split('\n')

  let start = -1
  let startLevel = 0
  for (const [i, line] of lines.entries()) {
    const match = HEADING_RE.exec(line)
    if (match && match[2]!.trim().toLowerCase() === wanted) {
      start = i
      startLevel = match[1]!.length
      break
    }
  }

  if (start === -1) {
    const hashes = '#'.repeat(Math.min(Math.max(level, 1), 6))
    const prefix = text.trim() ? `${text.replace(/\s+$/, '')}\n\n` : ''
    return `${prefix}${hashes} ${heading.trim()}\n\n${body}\n`
  }

  // The section ends at the next heading of the same or shallower level.
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const match = HEADING_RE.exec(lines[i]!)
    if (match && match[1]!.length <= startLevel) {
      end = i
      break
    }
  }

  const section = lines.slice(start, end).join('\n').replace(/\s+$/, '')
  const rest = lines.slice(end)
  const merged = `${section}\n\n${body}`
  return [...lines.slice(0, start), ...merged.split('\n'), ...(rest.length ? ['', ...rest] : [])]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')
    .concat('\n')
}
