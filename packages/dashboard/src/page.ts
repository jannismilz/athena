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
  type BackupStatus,
  type ContentMetrics,
  formatBytes,
  formatCompact,
  formatCount,
  type IndexMetrics,
  type PageRow,
  type QueryRow,
  relativeAge,
} from './metrics.ts'
import { STYLES } from './styles.ts'

export type DashboardData = {
  instanceName: string
  days: number
  content: ContentMetrics
  activity: ActivityMetrics
  index: IndexMetrics
  backup: BackupStatus
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

function pageTable(rows: PageRow[], numeric?: string): Html {
  if (!rows.length) return html`<p class="empty">Nothing to show.</p>`
  return html`
    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th>Page</th>
            ${numeric ? html`<th class="num nowrap">${numeric}</th>` : null}
            <th class="num nowrap">Updated</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            row => html`
              <tr>
                <td class="clip">
                  ${row.title || row.path}
                  <span class="path">${row.path}</span>
                </td>
                ${
                  numeric
                    ? html`<td class="num nowrap">${formatCompact(row.words ?? 0)}</td>`
                    : null
                }
                <td class="num age nowrap">${relativeAge(row.updatedAt)}</td>
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
          <tr>
            <th>Query</th>
            <th class="num nowrap">Times</th>
            <th class="num nowrap">Last</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            row => html`
              <tr>
                <td class="clip">${row.query}</td>
                <td class="num nowrap">${row.count}</td>
                <td class="num age nowrap">${relativeAge(row.lastSeen)}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`
}

/** Backups run hourly, so two missed runs is a warning and half a day is a fault. */
function backupTone(backup: BackupStatus): 'good' | 'warning' | 'critical' {
  if (!backup.ok || backup.ageHours === null) return 'critical'
  if (backup.ageHours > 12) return 'critical'
  if (backup.ageHours > 2) return 'warning'
  return 'good'
}

export function renderDashboard(data: DashboardData): string {
  const { content, activity, index, backup } = data
  const backupState = backupTone(backup)

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
          <div class="sub">Generated ${relativeAge(data.generatedAt)}</div>
        </div>
        <nav class="range" aria-label="Time range">
          ${RANGES.map(
            days => html`<a href="?days=${days}" aria-current="${days === data.days ? 'true' : 'false'}"
                            >${days} days</a>`,
          )}
          <form method="post" action="logout" class="signout">
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </header>

      ${
        content.wikiReady
          ? null
          : html`<section class="card wide notice">
              <h2>Wiki.js has not been set up yet</h2>
              <p class="note">
                Open the wiki and complete the setup wizard, then create an API token under
                Administration, API and put it in <code>WIKI_API_TOKEN</code>. Page and search
                metrics appear here once that is done. Activity below is already being recorded.
              </p>
            </section>`
      }

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
        ${tile(
          'Last backup',
          backup.finishedAt ? relativeAge(backup.finishedAt) : 'never',
          backup.ok ? formatBytes(backup.bytes) : (backup.error ?? 'failed'),
          backupState,
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

        <div class="pair">
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
        </div>

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
            { label: 'Writes', value: activity.writeCalls, series: 2 },
            {
              label: 'Reads',
              value: Math.max(0, activity.totalCalls - activity.writeCalls),
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
          ${pageTable(content.stale)}
        </section>

        <section class="card">
          <h2>Largest pages</h2>
          <p class="note">Candidates for splitting into their own topics.</p>
          ${pageTable(content.largest, 'Words')}
        </section>

        <section class="card wide">
          <h2>Index health</h2>
          <p class="note">Search is derived from the wiki and can always be rebuilt.</p>
          <table class="kv">
            <tbody>
              <tr>
                <td>Status</td>
                <td class="v">
                  <span class="status ${indexTone}"
                    >${index.reachable ? 'reachable' : 'unreachable'}</span>
                </td>
              </tr>
              <tr><td>Model</td><td class="v">${index.model ?? 'n/a'}</td></tr>
              <tr><td>Indexed pages</td><td class="v">${index.indexedPages}</td></tr>
              <tr><td>Chunks</td><td class="v">${index.indexedChunks}</td></tr>
              <tr><td>Chunks stored</td><td class="v">${index.storedChunks ?? 'n/a'}</td></tr>
              <tr><td>Pages not yet indexed</td><td class="v">${index.drift}</td></tr>
              <tr><td>Last indexed</td><td class="v age">${relativeAge(index.lastIndexedAt)}</td></tr>
              ${
                index.lastSyncError
                  ? html`<tr><td>Last error</td><td class="v">${index.lastSyncError}</td></tr>`
                  : null
              }
            </tbody>
          </table>
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
