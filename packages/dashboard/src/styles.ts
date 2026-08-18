/**
 * Dashboard stylesheet.
 *
 * Light is the base; dark redefines only the tokens, under both the OS media
 * query and an explicit theme attribute so a future toggle wins either way.
 * The categorical hues are a validated three-slot set. Each mode was checked
 * against its own surface rather than derived by inverting the other.
 */

export const STYLES = `
:root {
  color-scheme: light;

  --bg: #fbfaf8;
  --surface: #ffffff;
  --surface-2: #f5f4f1;
  --border: #e7e5e4;
  --border-strong: #d6d3d1;

  --text: #1c1917;
  --text-2: #57534e;
  --text-3: #8a827c;

  --accent: #7c6f5a;

  /* Categorical slots 1 to 3, validated against the light surface. */
  --s1: #2a78d6;
  --s2: #eb6834;
  --s3: #1baf7a;

  --good: #1a7f4b;
  --warning: #a86a00;
  --critical: #b3261e;

  --track: #efedea;
  --radius: 12px;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;

    --bg: #171615;
    --surface: #1f1e1c;
    --surface-2: #262422;
    --border: #34312e;
    --border-strong: #45413d;

    --text: #f5f5f4;
    --text-2: #b8b2ac;
    --text-3: #8a837c;

    --accent: #c9bda6;

    --s1: #3987e5;
    --s2: #d95926;
    --s3: #199e70;

    --good: #4ade80;
    --warning: #e0b341;
    --critical: #f2b8b5;

    --track: #2b2926;
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #171615;
  --surface: #1f1e1c;
  --surface-2: #262422;
  --border: #34312e;
  --border-strong: #45413d;
  --text: #f5f5f4;
  --text-2: #b8b2ac;
  --text-3: #8a837c;
  --accent: #c9bda6;
  --s1: #3987e5;
  --s2: #d95926;
  --s3: #199e70;
  --good: #4ade80;
  --warning: #e0b341;
  --critical: #f2b8b5;
  --track: #2b2926;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 1180px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }

header.top {
  display: flex; flex-wrap: wrap; gap: 1rem;
  align-items: baseline; justify-content: space-between;
  margin-bottom: 1.75rem;
}
header.top h1 {
  margin: 0; font-size: 1.375rem; font-weight: 650; letter-spacing: -0.02em;
}
header.top .sub { color: var(--text-3); font-size: .8125rem; }

.range { display: flex; gap: .375rem; }
.range a {
  padding: .3125rem .625rem; border-radius: 999px; font-size: .8125rem;
  color: var(--text-2); text-decoration: none; border: 1px solid transparent;
}
.range a:hover { background: var(--surface-2); }
.range a[aria-current='true'] {
  background: var(--surface); border-color: var(--border-strong); color: var(--text);
  font-weight: 600;
}

.tiles {
  display: grid; gap: .875rem; margin-bottom: 1.75rem;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
}
.tile {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: .9375rem 1rem;
}
.tile .label {
  font-size: .75rem; text-transform: uppercase; letter-spacing: .06em;
  color: var(--text-3); font-weight: 600;
}
.tile .value {
  font-size: 1.875rem; font-weight: 650; letter-spacing: -0.03em;
  line-height: 1.15; margin-top: .25rem;
  font-variant-numeric: tabular-nums;
}
.tile .hint { font-size: .8125rem; color: var(--text-2); margin-top: .125rem; }
.tile.good .value { color: var(--good); }
.tile.warning .value { color: var(--warning); }
.tile.critical .value { color: var(--critical); }

.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }

section.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.125rem 1.25rem 1.25rem;
  min-width: 0;
}
section.card.wide { grid-column: 1 / -1; }
section.card h2 {
  margin: 0 0 .25rem; font-size: .9375rem; font-weight: 650; letter-spacing: -0.01em;
}
section.card .note { margin: 0 0 1rem; font-size: .8125rem; color: var(--text-3); }

.chart { width: 100%; height: auto; display: block; overflow: visible; }
.chart .track { fill: var(--track); }
.chart .hit { fill: transparent; }
.chart .axis { stroke: var(--border-strong); stroke-width: 1; }
.chart .mark.s1 { fill: var(--s1); }
.chart .mark.s2 { fill: var(--s2); }
.chart .mark.s3 { fill: var(--s3); }
.chart .cat { fill: var(--text-2); font-size: 12px; }
.chart .val { fill: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.chart .tick { fill: var(--text-3); font-size: 11px; }
.chart g:hover .mark { filter: brightness(1.12); }

.legend { display: flex; flex-wrap: wrap; gap: .875rem; margin-top: .625rem; }
.key { display: inline-flex; align-items: center; gap: .375rem; font-size: .8125rem; color: var(--text-2); }
.key b { color: var(--text); font-variant-numeric: tabular-nums; }
.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.swatch.s1 { background: var(--s1); }
.swatch.s2 { background: var(--s2); }
.swatch.s3 { background: var(--s3); }

.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; }
th {
  text-align: left; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em;
  color: var(--text-3); font-weight: 600; padding: 0 .625rem .5rem 0;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
td { padding: .5rem .625rem .5rem 0; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
td a { color: var(--text); text-decoration: none; border-bottom: 1px solid var(--border-strong); }
td a:hover { color: var(--accent); }
td .path { display: block; color: var(--text-3); font-size: .75rem; }
.age { color: var(--text-3); white-space: nowrap; }

.empty { color: var(--text-3); font-size: .875rem; margin: .5rem 0 0; }

.status { display: inline-flex; align-items: center; gap: .375rem; font-weight: 600; }
.status::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.status.good { color: var(--good); }
.status.warning { color: var(--warning); }
.status.critical { color: var(--critical); }

footer.foot {
  margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border);
  color: var(--text-3); font-size: .8125rem;
  display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between;
}
footer.foot a { color: var(--text-2); }

@media (max-width: 640px) {
  .wrap { padding: 1.25rem .875rem 3rem; }
  .grid { grid-template-columns: 1fr; }
}
`
