/**
 * Path conventions for pages Athena creates on its own initiative.
 *
 * Captured notes and saved conversations need a home that a human can still
 * navigate a year later, so they get dated, slugged paths rather than
 * whatever the model felt like naming them.
 */

import { normalizePath } from '@athena/core'

/** Lowercase ASCII with hyphens: safe for a Wiki.js path segment. */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    // Transliterate German umlauts first: NFKD would split them into a bare
    // letter plus a combining mark, so "Größe" would become "grosse".
    .replace(/ä/gi, 'ae')
    .replace(/ö/gi, 'oe')
    .replace(/ü/gi, 'ue')
    .replace(/ß/g, 'ss')
    // Then fold any remaining accents (é → e).
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '')
  return slug || 'untitled'
}

/** Two-digit date parts in the configured timezone, not the server's. */
function datePartsIn(timeZone: string, now: Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return { year: get('year'), month: get('month'), day: get('day') }
}

export function conversationPath(title: string, timeZone: string, now?: Date): string {
  const { year, month, day } = datePartsIn(timeZone, now)
  return normalizePath(`conversations/${year}/${month}/${day}-${slugify(title)}`)
}

export function notePath(title: string, timeZone: string, now?: Date): string {
  const { year, month, day } = datePartsIn(timeZone, now)
  return normalizePath(`inbox/${year}-${month}-${day}-${slugify(title)}`)
}
