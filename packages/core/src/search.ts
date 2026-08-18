/**
 * Merging keyword search from Wiki.js with semantic search over the chunk index.
 *
 * The two searches answer different questions and neither is allowed to
 * suppress the other, so results are fused with Reciprocal Rank Fusion rather
 * than by comparing incomparable scores.
 */

import { normalizePath } from './markdown.ts'

/** RRF damping constant. 60 is the value from the original Cormack et al. paper. */
const RRF_K = 60

export type ClassicHit = {
  path?: string | null
  title?: string | null
  description?: string | null
}

export type SemanticHit = {
  page_id?: number | null
  page_path?: string | null
  page_title?: string | null
  content?: string | null
  score?: number
  [heading: string]: unknown
}

export type MergedHit = {
  score: number
  match: 'classic' | 'semantic' | 'both'
  pageId: number | null
  pagePath: string
  pageTitle: string | null
  headings: Record<string, string>
  content: string
}

export function snippet(text: string, limit = 400): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(' ')
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`
}

type Bucket = {
  classic: ClassicHit | null
  classicRank: number | null
  semantic: SemanticHit[]
  semanticRank: number | null
}

/**
 * Fuse both result lists into one ranked list, keyed by page path.
 *
 * A page found by only one source keeps its place; a page found by both rises.
 * Every hit carries a path, because the caller's next step is always to load
 * the real page from Wiki.js. The index is discovery, never the source of truth.
 */
export function mergeSearchHits(
  classic: ClassicHit[],
  semantic: SemanticHit[],
  limit: number,
): MergedHit[] {
  const pages = new Map<string, Bucket>()
  const bucket = (key: string): Bucket => {
    let rec = pages.get(key)
    if (!rec) {
      rec = { classic: null, classicRank: null, semantic: [], semanticRank: null }
      pages.set(key, rec)
    }
    return rec
  }

  classic.forEach((hit, i) => {
    const key = normalizePath(String(hit.path ?? ''))
    if (!key) return
    const rec = bucket(key)
    if (rec.classic === null) {
      rec.classic = hit
      rec.classicRank = i + 1
    }
  })

  semantic.forEach((hit, i) => {
    const key = normalizePath(String(hit.page_path ?? ''))
    if (!key) return
    const rec = bucket(key)
    rec.semantic.push(hit)
    if (rec.semanticRank === null) rec.semanticRank = i + 1
  })

  const ranked = [...pages.entries()]
    .map(([key, rec]) => {
      let score = 0
      if (rec.classicRank !== null) score += 1 / (RRF_K + rec.classicRank)
      if (rec.semanticRank !== null) score += 1 / (RRF_K + rec.semanticRank)
      return { score, key, rec }
    })
    .sort((a, b) => b.score - a.score)

  const results: MergedHit[] = []
  for (const { score, key, rec } of ranked) {
    if (results.length >= limit) break

    const match: MergedHit['match'] =
      rec.classicRank !== null && rec.semanticRank !== null
        ? 'both'
        : rec.classicRank !== null
          ? 'classic'
          : 'semantic'

    const best = rec.semantic[0]
    if (best) {
      const headings: Record<string, string> = {}
      for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
        const value = best[level]
        if (typeof value === 'string' && value) headings[level] = value
      }
      results.push({
        score,
        match,
        pageId: best.page_id ?? null,
        pagePath: best.page_path || key,
        pageTitle: best.page_title || rec.classic?.title || null,
        headings,
        content: snippet(String(best.content ?? '')),
      })
    } else {
      results.push({
        score,
        match,
        pageId: null,
        pagePath: rec.classic?.path || key,
        pageTitle: rec.classic?.title ?? null,
        headings: {},
        content: snippet(String(rec.classic?.description ?? '')),
      })
    }
  }
  return results
}
