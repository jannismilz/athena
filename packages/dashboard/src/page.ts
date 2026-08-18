/**
 * The dashboard page.
 *
 * Server-rendered in one pass. Alongside the usual counts it surfaces the
 * searches that returned nothing, which is the list that tells you what is
 * worth writing next.
 */

import { barChart, columnChart, splitBar } from './charts.ts'
import { type Html, html } from './html.ts'
import {
  type ActivityMetrics,
  type ContentMetrics,
  formatCount,
  type IndexMetrics,
  type PageRow,
  type QueryRow,
  relativeAge,
} from './metrics.ts'
import { STYLES } from './styles.ts'

export type DashboardData = {
  instanceName: string
  wikiUrl: string
  days: number
  content: ContentMetrics
  activity: ActivityMetrics
  index: IndexMetrics
  generatedAt: string
}

const RANGES = [7, 30, 90]

function tile(label: string, value: string, hint?: string, tone = 'neutral'): Html {
  return html`
    <div class="tile ${tone}">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      ${hint ? html`<div class="hint">${hint}</div>` : null}
    </div>`
}

function pageLink(wikiUrl: string, row: PageRow): Html {
  const href = `${wikiUrl.replace(/\/+$/, '')}/${row.path}`
  return html`<a href="${href}" target="_blank" rel="noreferrer noopener">${row.title || row.path}</a>
    <span class="path">${row.path}</span>`
}

function pageTable(wikiUrl: string, rows: PageRow[], numeric?: string): Html {
  if (!rows.length) return html`<p class="empty">Nothing to show.</p>`
  return html`
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Page</th>
            ${numeric ? html`<th class="num">${numeric}</th>` : null}
            <th class="num">Updated</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            row => html`
              <tr>
                <td>${pageLink(wikiUrl, row)}</td>
                ${numeric ? html`<td class="num">${(row.words ?? 0).toLocaleString('en-US')}</td>` : null}
                <td class="num age">${relativeAge(row.updatedAt)}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`
}

function queryTable(rows: QueryRow[], emptyMessage: string): Html {
  if (!rows.length) return html`<p class="empty">${emptyMessage}</p>`
  return html`
    <div class="scroll">
      <table>
        <thead>
          <tr><th>Query</th><th class="num">Times</th><th class="num">Last</th></tr>
        </thead>
        <tbody>
          ${rows.map(
            row => html`
              <tr>
                <td>${row.query}</td>
                <td class="num">${row.count}</td>
                <td class="num age">${relativeAge(row.lastSeen)}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`
}

export function renderDashboard(data: DashboardData): string {
  const { content, activity, index } = data

  const indexTone = !index.reachable
    ? 'critical'
    : index.drift > 0 || index.lastSyncError
      ? 'warning'
      : 'good'

  const body = html`
    <div class="wrap">
      <header class="top">
        <div>
          <h1>${data.instanceName}</h1>
          <div class="sub">
            Generated ${relativeAge(data.generatedAt)} ·
            <a href="${data.wikiUrl}" target="_blank" rel="noreferrer noopener">open the wiki</a>
          </div>
        </div>
        <nav class="range" aria-label="Time range">
          ${RANGES.map(
            days => html`<a href="?days=${days}" aria-current="${days === data.days ? 'true' : 'false'}"
                            >${days} days</a>`,
          )}
        </nav>
      </header>

      <div class="tiles">
        ${tile('Pages', formatCount(content.pages), `${content.areas.length} areas`)}
        ${tile('Words', formatCount(content.words), 'across published pages')}
        ${tile('Tool calls', formatCount(activity.totalCalls), `last ${data.days} days`)}
        ${tile(
          'Indexed',
          index.reachable ? formatCount(index.indexedChunks) : 'n/a',
          index.reachable
            ? index.drift > 0
              ? `${index.drift} pages behind`
              : 'in step with the wiki'
            : 'indexer unreachable',
          indexTone,
        )}
      </div>

      <div class="grid">
        <section class="card wide">
          <h2>Tool calls per day</h2>
          <p class="note">
            Every call an AI client made, including reads. Gaps are real zeroes.
          </p>
          ${columnChart(activity.callsPerDay)}
        </section>

        <section class="card">
          <h2>Which tools get used</h2>
          <p class="note">Reading and writing are both first-class; this is the actual mix.</p>
          ${barChart(activity.byTool.slice(0, 10))}
        </section>

        <section class="card">
          <h2>Which assistant</h2>
          <p class="note">Taken from the authenticated client, not from what the model claims.</p>
          ${barChart(activity.byActor.slice(0, 8), { series: 2 })}
        </section>

        <section class="card wide">
          <h2>Searches that found nothing</h2>
          <p class="note">
            Questions the wiki could not answer. Each one is a candidate for a new page.
          </p>
          ${queryTable(activity.zeroResultQueries, 'Every search so far has returned something.')}
        </section>

        <section class="card">
          <h2>Pages per area</h2>
          <p class="note">Top-level path segments, which is how the wiki is shaped.</p>
          ${barChart(content.areas.slice(0, 12), { series: 3 })}
        </section>

        <section class="card">
          <h2>Read versus write</h2>
          <p class="note">How much the AI adds to the wiki, rather than only consulting it.</p>
          ${splitBar([
            { label: 'Writes', value: activity.writeShare.ai, series: 2 },
            {
              label: 'Reads',
              value: Math.max(0, activity.totalCalls - activity.writeShare.ai),
              series: 1,
            },
          ])}
        </section>

        <section class="card">
          <h2>Most searched</h2>
          <p class="note">What people keep coming back to.</p>
          ${queryTable(activity.topQueries, 'No searches recorded yet.')}
        </section>

        <section class="card">
          <h2>Going stale</h2>
          <p class="note">Longest without an edit. Old is not always wrong, but it is worth a look.</p>
          ${pageTable(data.wikiUrl, content.stale)}
        </section>

        <section class="card">
          <h2>Largest pages</h2>
          <p class="note">Candidates for splitting into their own topics.</p>
          ${pageTable(data.wikiUrl, content.largest, 'Words')}
        </section>

        <section class="card">
          <h2>Index health</h2>
          <p class="note">Search is derived from the wiki and can always be rebuilt.</p>
          <div class="scroll">
            <table>
              <tbody>
                <tr>
                  <td>Status</td>
                  <td class="num">
                    <span class="status ${indexTone}"
                      >${index.reachable ? 'reachable' : 'unreachable'}</span>
                  </td>
                </tr>
                <tr><td>Model</td><td class="num">${index.model ?? 'n/a'}</td></tr>
                <tr><td>Indexed pages</td><td class="num">${index.indexedPages}</td></tr>
                <tr><td>Chunks</td><td class="num">${index.indexedChunks}</td></tr>
                <tr><td>Vectors in Qdrant</td><td class="num">${index.qdrantPoints ?? 'n/a'}</td></tr>
                <tr><td>Pages not yet indexed</td><td class="num">${index.drift}</td></tr>
                <tr>
                  <td>Last indexed</td>
                  <td class="num age">${relativeAge(index.lastIndexedAt)}</td>
                </tr>
                ${
                  index.lastSyncError
                    ? html`<tr><td>Last error</td><td class="num">${index.lastSyncError}</td></tr>`
                    : null
                }
              </tbody>
            </table>
          </div>
        </section>

        ${
          activity.failures.length
            ? html`
            <section class="card wide">
              <h2>Recent failures</h2>
              <p class="note">Tool calls that returned an error.</p>
              <div class="scroll">
                <table>
                  <thead>
                    <tr><th>Tool</th><th>Error</th><th class="num">When</th></tr>
                  </thead>
                  <tbody>
                    ${activity.failures.map(
                      row => html`
                        <tr>
                          <td>${row.tool}</td>
                          <td>${row.error}</td>
                          <td class="num age">${relativeAge(row.ts)}</td>
                        </tr>`,
                    )}
                  </tbody>
                </table>
              </div>
            </section>`
            : null
        }
      </div>

      <footer class="foot">
        <span>${data.instanceName} · pages live in Wiki.js, which stays the source of truth</span>
        <span>Range: last ${data.days} days</span>
      </footer>
    </div>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${data.instanceName} dashboard</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>
`
}
