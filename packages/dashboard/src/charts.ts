/**
 * Charts, as inline SVG.
 *
 * No charting library: these are four shapes drawn from numbers, and a
 * dependency would cost more than it saves. Colours come from CSS custom
 * properties so light and dark are two validated palettes rather than an
 * automatic inversion.
 *
 * Conventions kept deliberately throughout:
 *   - thin marks, 4px rounded data-ends, 2px gaps between fills
 *   - every bar carries a visible value label, so identity is never colour alone
 *   - a single series gets no legend; the heading names it
 */

import { type Html, html } from './html.ts'
import type { Bar, SeriesPoint } from './metrics.ts'

const BAR_HEIGHT = 22
const BAR_GAP = 8
const LABEL_WIDTH = 132
const VALUE_WIDTH = 52

/**
 * Horizontal bars, for ranked categories.
 *
 * Horizontal rather than vertical, because the labels are words of varying
 * length and would otherwise have to be rotated to fit.
 */
export function barChart(bars: Bar[], options: { series?: number; width?: number } = {}): Html {
  if (!bars.length) return html`<p class="empty">Nothing recorded yet.</p>`

  const width = options.width ?? 560
  const series = options.series ?? 1
  const max = Math.max(...bars.map(b => b.value), 1)
  const trackWidth = width - LABEL_WIDTH - VALUE_WIDTH
  const height = bars.length * (BAR_HEIGHT + BAR_GAP) - BAR_GAP

  const rows = bars.map((bar, i) => {
    const y = i * (BAR_HEIGHT + BAR_GAP)
    // Keep a sliver visible for non-zero values so "small" never reads as "none".
    const w = bar.value === 0 ? 0 : Math.max(3, (bar.value / max) * trackWidth)
    return html`
      <g>
        <title>${bar.label}: ${bar.value.toLocaleString('en-US')}${bar.hint ? `, ${bar.hint}` : ''}</title>
        <text class="cat" x="${LABEL_WIDTH - 10}" y="${y + BAR_HEIGHT / 2}"
              text-anchor="end" dominant-baseline="central">${bar.label}</text>
        <rect class="track" x="${LABEL_WIDTH}" y="${y}" width="${trackWidth}"
              height="${BAR_HEIGHT}" rx="4" />
        <rect class="mark s${series}" x="${LABEL_WIDTH}" y="${y}" width="${w}"
              height="${BAR_HEIGHT}" rx="4" />
        <text class="val" x="${LABEL_WIDTH + trackWidth + 10}" y="${y + BAR_HEIGHT / 2}"
              dominant-baseline="central">${bar.value.toLocaleString('en-US')}</text>
      </g>`
  })

  return html`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img"
       aria-label="Bar chart" preserveAspectRatio="xMinYMin meet">${rows}</svg>`
}

/**
 * Daily counts as a column chart.
 *
 * Time on x, one column per day, gaps drawn as real zeroes. Only the first, last
 * and peak days are labelled, because a number on every column is noise.
 */
export function columnChart(points: SeriesPoint[], options: { series?: number } = {}): Html {
  if (!points.length) return html`<p class="empty">Nothing recorded yet.</p>`

  const series = options.series ?? 1
  const width = 560
  const height = 140
  const padBottom = 22
  const padTop = 16
  const plot = height - padBottom - padTop
  const max = Math.max(...points.map(p => p.value), 1)
  const step = width / points.length
  // 2px of surface between columns.
  const barWidth = Math.max(2, step - 2)
  const peakIndex = points.reduce((best, p, i) => (p.value > points[best]!.value ? i : best), 0)

  const columns = points.map((point, i) => {
    const h = point.value === 0 ? 0 : Math.max(2, (point.value / max) * plot)
    const x = i * step
    const y = padTop + plot - h
    return html`
      <g>
        <title>${point.date}: ${point.value.toLocaleString('en-US')}</title>
        <rect class="hit" x="${x}" y="${padTop}" width="${step}" height="${plot}" />
        <rect class="mark s${series}" x="${x}" y="${y}" width="${barWidth}"
              height="${h}" rx="${Math.min(4, h / 2)}" />
      </g>`
  })

  const ticks = new Set([0, points.length - 1, peakIndex])
  const labels = [...ticks]
    .filter(i => points[i])
    .map(i => {
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'
      const x = i === 0 ? 0 : i === points.length - 1 ? width : i * step + barWidth / 2
      return html`<text class="tick" x="${x}" y="${height - 6}"
                        text-anchor="${anchor}">${points[i]!.date.slice(5)}</text>`
    })

  const peak = points[peakIndex]!
  const peakLabel =
    peak.value > 0
      ? html`<text class="val" x="${Math.min(width - 4, peakIndex * step + barWidth / 2)}"
                   y="${padTop + plot - Math.max(2, (peak.value / max) * plot) - 5}"
                   text-anchor="middle">${peak.value}</text>`
      : null

  return html`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img"
       aria-label="Daily activity" preserveAspectRatio="xMinYMin meet">
    <line class="axis" x1="0" y1="${padTop + plot}" x2="${width}" y2="${padTop + plot}" />
    ${columns}${peakLabel}${labels}
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

  const width = 560
  const height = 26
  let x = 0
  const segments = parts
    .filter(p => p.value > 0)
    .map(part => {
      // 2px of surface between segments.
      const w = Math.max(0, (part.value / total) * width - 2)
      const seg = html`
        <g>
          <title>${part.label}: ${part.value.toLocaleString('en-US')}</title>
          <rect class="mark s${part.series}" x="${x}" y="0" width="${w}" height="${height}" rx="4" />
        </g>`
      x += w + 2
      return seg
    })

  const legend = parts
    .filter(p => p.value > 0)
    .map(
      part => html`<span class="key"><i class="swatch s${part.series}"></i>${part.label}
        <b>${Math.round((part.value / total) * 100)}%</b></span>`,
    )

  return html`
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img"
         aria-label="Split" preserveAspectRatio="none" style="height:26px">${segments}</svg>
    <div class="legend">${legend}</div>`
}
