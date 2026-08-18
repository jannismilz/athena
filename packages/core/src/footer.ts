/**
 * Provenance footer appended to every page the AI writes.
 *
 * Pages carry a small trailing block recording who created and last updated
 * them, so a human browsing the wiki can always tell what an AI touched:
 *
 *     ---
 *     created: Claude, 2026-08-18 14:03
 *     updated: ChatGPT, 2026-08-19 09:12
 */

export type FooterFields = { created?: string; updated?: string }

export function formatStamp(timeZone: string, now: Date = new Date()): string {
  // en-CA gives ISO-shaped dates (2026-08-18) which sort correctly as text.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/**
 * Split a trailing footer off page content.
 *
 * Only the very last block counts: a `---` line immediately followed by
 * `created:` / `updated:` lines. Horizontal rules elsewhere in the body are
 * left alone.
 */
export function splitFooter(content: string): { body: string; fields: FooterFields } {
  const text = (content ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (!text) return { body: '', fields: {} }

  const lines = text.split('\n')
  const fields: FooterFields = {}
  let i = lines.length - 1

  while (i >= 0) {
    const stripped = lines[i]!.trim()
    const key = (['created', 'updated'] as const).find(k => stripped.startsWith(`${k}:`))
    if (!key) break
    fields[key] = stripped.slice(key.length + 1).trim()
    i--
  }

  if (!fields.created && !fields.updated) return { body: text, fields: {} }
  if (i < 0 || lines[i]!.trim() !== '---') return { body: text, fields: {} }

  return { body: lines.slice(0, i).join('\n').replace(/\s+$/, ''), fields }
}

function joinFooter(body: string, fields: FooterFields): string {
  const trimmed = body.replace(/\s+$/, '')
  if (!fields.created && !fields.updated) return trimmed

  const lines = ['---']
  if (fields.created) lines.push(`created: ${fields.created}`)
  if (fields.updated) lines.push(`updated: ${fields.updated}`)
  const footer = lines.join('\n')

  return trimmed ? `${trimmed}\n\n${footer}\n` : `${footer}\n`
}

export function applyCreateFooter(
  content: string,
  actor: string,
  timeZone: string,
  now?: Date,
): string {
  const { body } = splitFooter(content)
  return joinFooter(body, { created: `${actor}, ${formatStamp(timeZone, now)}` })
}

/**
 * Stamp an update, preserving whatever `created:` the stored page already had.
 * A footer supplied by the caller is discarded, because provenance must not
 * be client-controlled.
 */
export function applyUpdateFooter(
  newContent: string,
  storedContent: string,
  actor: string,
  timeZone: string,
  now?: Date,
): string {
  const { body } = splitFooter(newContent)
  const { fields: stored } = splitFooter(storedContent)
  const fields: FooterFields = {}
  if (stored.created) fields.created = stored.created
  fields.updated = `${actor}, ${formatStamp(timeZone, now)}`
  return joinFooter(body, fields)
}
