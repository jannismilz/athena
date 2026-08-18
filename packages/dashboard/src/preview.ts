/** Renders the dashboard with sample data so the layout can be eyeballed. */
import { fillGaps } from './metrics.ts'
import { renderDashboard } from './page.ts'

const days = 30
const daily = fillGaps(
  Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
    value: [0, 0, 3, 12, 7, 21, 45, 18, 2, 9, 33, 5][i % 12]!,
  })),
  days,
)
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

console.log(
  renderDashboard({
    instanceName: 'Athena',
    wikiUrl: 'https://wiki.example.com',
    days,
    generatedAt: new Date().toISOString(),
    content: {
      pages: 284,
      words: 152_940,
      areas: [
        { label: 'infra', value: 96 },
        { label: 'projects', value: 54 },
        { label: 'runbooks', value: 38 },
        { label: 'dev', value: 31 },
        { label: 'reference', value: 24 },
        { label: 'meetings', value: 17 },
        { label: 'inbox', value: 12 },
        { label: 'archive', value: 8 },
        { label: 'meta', value: 4 },
      ],
      stale: [
        { path: 'infra/legacy-vpn', title: 'Legacy VPN', updatedAt: ago(24 * 400) },
        { path: 'projects/apollo/release', title: 'Release process', updatedAt: ago(24 * 320) },
        { path: 'runbooks/on-call', title: 'On-call rotation', updatedAt: ago(24 * 210) },
      ],
      largest: [
        { path: 'infra/kubernetes', title: 'Kubernetes', updatedAt: ago(30), words: 4820 },
        { path: 'dev/api-conventions', title: 'API conventions', updatedAt: ago(90), words: 3110 },
        { path: 'reference/networking', title: 'Networking', updatedAt: ago(400), words: 2740 },
      ],
    },
    activity: {
      totalCalls: 1284,
      callsPerDay: daily,
      byTool: [
        { label: 'search_knowledge', value: 612 },
        { label: 'get_page', value: 341 },
        { label: 'append_to_page', value: 121 },
        { label: 'update_page', value: 84 },
        { label: 'get_page_structure', value: 61 },
        { label: 'create_page', value: 38 },
        { label: 'save_conversation', value: 17 },
        { label: 'capture_note', value: 10 },
      ],
      byActor: [
        { label: 'Claude', value: 903 },
        { label: 'Cursor', value: 284 },
        { label: 'ChatGPT', value: 97 },
      ],
      writeShare: { ai: 270, human: 0 },
      topQueries: [
        { query: 'dns forwarder', count: 14, lastSeen: ago(3) },
        { query: 'how do I restart the stack', count: 9, lastSeen: ago(20) },
      ],
      zeroResultQueries: [
        { query: 'mqtt broker credentials', count: 6, lastSeen: ago(5) },
        { query: 'restore procedure', count: 4, lastSeen: ago(28) },
        { query: 'certificate renewal', count: 2, lastSeen: ago(70) },
      ],
      failures: [{ tool: 'create_page', error: 'page already exists: infra/dns', ts: ago(11) }],
    },
    index: {
      reachable: true,
      model: 'intfloat/multilingual-e5-small',
      indexedPages: 281,
      indexedChunks: 1943,
      storedChunks: 1943,
      lastIndexedAt: ago(0.2),
      lastSync: null,
      lastSyncError: null,
      drift: 3,
    },
    backup: {
      ok: true,
      finishedAt: ago(0.6),
      bytes: 48_234_496,
      durationSeconds: 12,
      destination: 'crypt:athena-backups',
      error: null,
      ageHours: 0.6,
    },
  }),
)
