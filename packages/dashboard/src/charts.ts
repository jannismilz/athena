/**
 * Charts, as inline SVG.
 *
 * No charting library: these are three shapes drawn from numbers, and a
 * dependency would cost more than it saves. Colours come from CSS custom
 * properties so light and dark are two validated palettes rather than an
 * automatic inversion.
 *
 * Conventions kept throughout:
 *   - labels sit above their bar, never beside it, so a long name can never
 *     collide with the data
 *   - every bar carries a visible value, so identity is never colour alone
 *   - a single series gets no legend; the heading names it
 */

import { type Html, html } from './html.ts'
import type { Bar, SeriesPoint } from './metrics.ts'

const ROW_LABEL = 15
const ROW_BAR = 9
const ROW_GAP = 15
const ROW = ROW_LABEL + ROW_BAR + ROW_GAP
const WIDTH = 560

const count = (n: number) => n.toLocaleString('en-US')

/**
 * Ranked categories, one row each.
 *
 * The label and its value share a line above the bar, which then spans the
 * full width. Putting the label beside the bar means reserving a column for
 * it, and any name longer than that column overlaps the data.
 */
export function barChart(bars: Bar[], options: { series?: number } = {}): Html {
  if (!bars.length) return html`<p class="empty">Nothing recorded yet.</p>`

  const series = options.series ?? 1
  const max = Math.max(...bars.map(b => b.value), 1)
  const height = bars.length * ROW - ROW_GAP

  const rows = bars.map((bar, i) => {
    const top = i * ROW
    const barY = top + ROW_LABEL
    // Keep a sliver visible for non-zero values so "small" never reads as "none".
    const w = bar.value === 0 ? 0 : Math.max(3, (bar.value / max) * WIDTH)
    return html`
      <g>
        <title>${bar.label}: ${count(bar.value)}${bar.hint ? `, ${bar.hint}` : ''}</title>
        <text class="cat" x="0" y="${top + 10}">${bar.label}</text>
        <text class="val" x="${WIDTH}" y="${top + 10}" text-anchor="end">${count(bar.value)}</text>
        <rect class="track" x="0" y="${barY}" width="${WIDTH}" height="${ROW_BAR}" rx="4" />
        <rect class="mark s${series}" x="0" y="${barY}" width="${w}" height="${ROW_BAR}" rx="4" />
      </g>`
  })

  return html`<svg class="chart" viewBox="0 0 ${WIDTH} ${height}" role="img"
       aria-label="Ranked bar chart" preserveAspectRatio="xMinYMin meet">${rows}</svg>`
}

/**
 * Daily counts as a column chart.
 *
 * A labelled gridline at the peak gives every column a scale to read against,
 * so the chart does not depend on one printed number. Dates are labelled at
 * both ends and the busiest day is called out.
 */
export function columnChart(points: SeriesPoint[], options: { series?: number } = {}): Html {
  if (!points.length) return html`<p class="empty">Nothing recorded yet.</p>`

  const series = options.series ?? 1
  const height = 150
  const padTop = 18
  const padBottom = 24
  const gutter = 36 // room for the scale labels
  const plotWidth = WIDTH - gutter
  const plot = height - padTop - padBottom
  const max = Math.max(...points.map(p => p.value), 1)
  const step = plotWidth / points.length
  const barWidth = Math.max(2, step - 2) // 2px of surface between columns
  const peakIndex = points.reduce((best, p, i) => (p.value > points[best]!.value ? i : best), 0)
  const peak = points[peakIndex]!
  const peakHeight = Math.max(2, (peak.value / max) * plot)

  const columns = points.map((point, i) => {
    const h = point.value === 0 ? 0 : Math.max(2, (point.value / max) * plot)
    const x = gutter + i * step
    return html`
      <g>
        <title>${point.date}: ${count(point.value)}</title>
        <rect class="hit" x="${x}" y="${padTop}" width="${step}" height="${plot}" />
        <rect class="mark s${series}" x="${x}" y="${padTop + plot - h}" width="${barWidth}"
              height="${h}" rx="${Math.min(4, h / 2)}" />
      </g>`
  })

  const dateAt = (index: number, anchor: string, x: number) =>
    html`<text class="tick" x="${x}" y="${height - 7}" text-anchor="${anchor}"
          >${points[index]!.date.slice(5)}</text>`

  return html`<svg class="chart" viewBox="0 0 ${WIDTH} ${height}" role="img"
       aria-label="Daily activity" preserveAspectRatio="xMinYMin meet">
    <line class="grid" x1="${gutter}" y1="${padTop}" x2="${WIDTH}" y2="${padTop}" />
    <text class="tick" x="${gutter - 8}" y="${padTop + 4}" text-anchor="end">${count(max)}</text>
    <line class="axis" x1="${gutter}" y1="${padTop + plot}" x2="${WIDTH}" y2="${padTop + plot}" />
    <text class="tick" x="${gutter - 8}" y="${padTop + plot + 4}" text-anchor="end">0</text>
    ${columns}
    ${
      peak.value > 0
        ? html`<text class="val" x="${gutter + peakIndex * step + barWidth / 2}"
                   y="${padTop + plot - peakHeight - 6}" text-anchor="middle"
              >${count(peak.value)}</text>`
        : null
    }
    ${dateAt(0, 'start', gutter)}
    ${dateAt(points.length - 1, 'end', WIDTH)}
  </svg>`
}

/**
 * A one-row stacked bar for a two-part split.
 *
 * Easier to read than a pie chart. Both segments carry a label and a
 * percentage, so colour is not the only encoding.
 */
export function splitBar(parts: Array<{ label: string; value: number; series: number }>): Html {
  const total = parts.reduce((sum, p) => sum + p.value, 0)
  if (!total) return html`<p class="empty">Nothing recorded yet.</p>`

  const height = 10
  let x = 0
  const visible = parts.filter(p => p.value > 0)

  const segments = visible.map(part => {
    const w = Math.max(0, (part.value / total) * WIDTH - 2) // 2px surface gap
    const seg = html`
      <g>
        <title>${part.label}: ${count(part.value)}</title>
        <rect class="mark s${part.series}" x="${x}" y="0" width="${w}" height="${height}" rx="4" />
      </g>`
    x += w + 2
    return seg
  })

  const legend = visible.map(
    part => html`<span class="key"><i class="swatch s${part.series}"></i>${part.label}
      <b>${Math.round((part.value / total) * 100)}%</b></span>`,
  )

  return html`
    <svg class="chart" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="Split"
         preserveAspectRatio="none" style="height:10px">${segments}</svg>
    <div class="legend">${legend}</div>`
}
