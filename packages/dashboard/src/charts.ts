/**
 * Charts, as inline SVG.
 *
 * No charting library: these are three shapes drawn from numbers, and a
 * dependency would cost more than it saves. Colours come from CSS custom
 * properties so light and dark are two validated palettes rather than an
 * automatic inversion.
 */

import { type Html, html } from './html.ts'
import type { Bar, SeriesPoint } from './metrics.ts'

const WIDTH = 560
const count = (n: number) => n.toLocaleString('en-US')

/** Rough width of a string, used to decide what fits before drawing it. */
const textWidth = (text: string, fontSize: number, mono = false) =>
  text.length * fontSize * (mono ? 0.6 : 0.58)

// --- Ranked bars -----------------------------------------------------------
const LABEL_W = 176
const VALUE_W = 48
const BAR_H = 10
const ROW_GAP = 8
const ROW = BAR_H + ROW_GAP
const LABEL_FS = 11

/**
 * Ranked categories, one thin row each.
 *
 * The label sits beside the bar in a fixed column, and anything too long for
 * that column is truncated rather than allowed to run into the track. Rows are
 * deliberately short: this is a ranked list, and tall bars across a full-width
 * card read as slabs rather than data.
 */
export function barChart(bars: Bar[], options: { series?: number } = {}): Html {
  if (!bars.length) return html`<p class="empty">Nothing recorded yet.</p>`

  const series = options.series ?? 1
  const max = Math.max(...bars.map(b => b.value), 1)
  const track = WIDTH - LABEL_W - VALUE_W
  const height = bars.length * ROW - ROW_GAP
  const maxChars = Math.floor((LABEL_W - 12) / (LABEL_FS * 0.58))

  const rows = bars.map((bar, i) => {
    const y = i * ROW
    const label = bar.label.length > maxChars ? `${bar.label.slice(0, maxChars - 1)}…` : bar.label
    // Keep a sliver visible for non-zero values so "small" never reads as "none".
    const w = bar.value === 0 ? 0 : Math.max(3, (bar.value / max) * track)
    return html`
      <g>
        <title>${bar.label}: ${count(bar.value)}${bar.hint ? `, ${bar.hint}` : ''}</title>
        <text class="cat" x="${LABEL_W - 12}" y="${y + BAR_H / 2}"
              text-anchor="end" dominant-baseline="central">${label}</text>
        <rect class="track" x="${LABEL_W}" y="${y}" width="${track}" height="${BAR_H}" rx="3" />
        <rect class="mark s${series}" x="${LABEL_W}" y="${y}" width="${w}"
              height="${BAR_H}" rx="3" />
        <text class="val" x="${WIDTH}" y="${y + BAR_H / 2}"
              text-anchor="end" dominant-baseline="central">${count(bar.value)}</text>
      </g>`
  })

  return html`<svg class="chart" viewBox="0 0 ${WIDTH} ${height}" role="img"
       aria-label="Ranked bar chart" preserveAspectRatio="xMinYMin meet">${rows}</svg>`
}

// --- Daily columns ---------------------------------------------------------
/** Enough room per column for a value above it. Narrower ranges get more. */
const MIN_STEP = 19

/**
 * Daily counts, with the value printed above every column.
 *
 * Long ranges cannot fit ninety numbers into the width of a card, so the chart
 * grows instead of dropping labels and scrolls inside its container. The
 * gridline at the peak still gives a scale to read against.
 */
export function columnChart(points: SeriesPoint[], options: { series?: number } = {}): Html {
  if (!points.length) return html`<p class="empty">Nothing recorded yet.</p>`

  const series = options.series ?? 1
  const gutter = 32
  const width = Math.max(WIDTH, gutter + points.length * MIN_STEP)
  const height = 132
  const padTop = 22
  const padBottom = 22
  const plot = height - padTop - padBottom
  const max = Math.max(...points.map(p => p.value), 1)
  const step = (width - gutter) / points.length
  const barWidth = Math.max(2, step - 3)

  // Shrink the value text until it fits between columns, within reason.
  const widest = count(max)
  let valueFs = 11
  while (valueFs > 8 && textWidth(widest, valueFs, true) > step - 1) valueFs--

  const columns = points.map((point, i) => {
    const h = point.value === 0 ? 0 : Math.max(2, (point.value / max) * plot)
    const x = gutter + i * step
    const mid = x + barWidth / 2
    return html`
      <g>
        <title>${point.date}: ${count(point.value)}</title>
        <rect class="hit" x="${x}" y="${padTop}" width="${step}" height="${plot}" />
        <rect class="mark s${series}" x="${x}" y="${padTop + plot - h}" width="${barWidth}"
              height="${h}" rx="${Math.min(3, h / 2)}" />
        <text class="col-val" x="${mid}" y="${padTop + plot - h - 5}" text-anchor="middle"
              style="font-size:${valueFs}px">${point.value === 0 ? '' : count(point.value)}</text>
      </g>`
  })

  const dateAt = (index: number, anchor: string, x: number) =>
    html`<text class="tick" x="${x}" y="${height - 6}" text-anchor="${anchor}"
          >${points[index]!.date.slice(5)}</text>`

  return html`
    <div class="chart-scroll">
      <svg class="chart" viewBox="0 0 ${width} ${height}" role="img"
           aria-label="Daily activity" preserveAspectRatio="xMinYMin meet"
           style="min-width:${width}px">
        <line class="grid" x1="${gutter}" y1="${padTop}" x2="${width}" y2="${padTop}" />
        <text class="tick" x="${gutter - 8}" y="${padTop + 4}" text-anchor="end">${count(max)}</text>
        <line class="axis" x1="${gutter}" y1="${padTop + plot}" x2="${width}" y2="${padTop + plot}" />
        <text class="tick" x="${gutter - 8}" y="${padTop + plot + 4}" text-anchor="end">0</text>
        ${columns}
        ${dateAt(0, 'start', gutter)}
        ${dateAt(points.length - 1, 'end', width)}
      </svg>
    </div>`
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
        <rect class="mark s${part.series}" x="${x}" y="0" width="${w}" height="${height}" rx="3" />
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
