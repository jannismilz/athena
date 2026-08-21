/**
 * Dashboard stylesheet.
 *
 * Shares the identity of the project's website: cool archival neutrals, a
 * verdigris accent, monospace for anything numeric or label-like. A dashboard
 * is scanned rather than read, so the type does the sorting: mono for data and
 * labels, a plain sans for the few lines of prose.
 *
 * Light is the base; dark redefines only the tokens, under both the OS media
 * query and an explicit theme attribute, so a future toggle wins either way.
 * The three categorical hues are validated against these exact surfaces.
 */

export const STYLES = `
:root {
  color-scheme: light;

  --bg: #f3f4f1;
  --surface: #fbfbfa;
  --surface-2: #eaece7;
  --border: #d9dcd6;
  --border-strong: #c2c7bf;

  --text: #141715;
  --text-2: #565d58;
  --text-3: #858c86;

  --accent: #146b5c;
  --accent-ink: #0e5348;

  --s1: #2a78d6;
  --s2: #eb6834;
  --s3: #1baf7a;

  --good: #146b5c;
  --warning: #a86a00;
  --critical: #b3261e;

  --track: #e4e7e1;
  --radius: 4px;
  --shadow: 0 1px 2px rgb(20 23 21 / 0.04);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;

    --bg: #101210;
    --surface: #181b19;
    --surface-2: #0a0c0a;
    --border: #262a27;
    --border-strong: #363c38;

    --text: #e9ece8;
    --text-2: #a3ada6;
    --text-3: #6f7a73;

    --accent: #45a894;
    --accent-ink: #63c0ad;

    --s1: #3987e5;
    --s2: #d95926;
    --s3: #199e70;

    --good: #45a894;
    --warning: #e0b341;
    --critical: #f2b8b5;

    --track: #222623;
    --shadow: 0 1px 2px rgb(0 0 0 / 0.4);
  }
}

:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #101210;
  --surface: #181b19;
  --surface-2: #0a0c0a;
  --border: #262a27;
  --border-strong: #363c38;
  --text: #e9ece8;
  --text-2: #a3ada6;
  --text-3: #6f7a73;
  --accent: #45a894;
  --accent-ink: #63c0ad;
  --s1: #3987e5;
  --s2: #d95926;
  --s3: #199e70;
  --good: #45a894;
  --warning: #e0b341;
  --critical: #f2b8b5;
  --track: #222623;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.4);
}

:root {
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono",
          "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}

/* --- Masthead ------------------------------------------------------------- */
.wrap { max-width: 1100px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }

header.top {
  display: flex; flex-wrap: wrap; gap: 1rem;
  align-items: center; justify-content: space-between;
  padding-bottom: 1.25rem; margin-bottom: 1.75rem;
  border-bottom: 1px solid var(--border);
}
header.top h1 {
  margin: 0;
  font-family: var(--mono);
  font-size: .9375rem; font-weight: 600;
  letter-spacing: .14em; text-transform: uppercase;
}
header.top .sub {
  color: var(--text-3); font-size: .75rem; font-family: var(--mono); margin-top: .2rem;
}

.range { display: flex; gap: .25rem; align-items: center; font-family: var(--mono); }
.range a {
  padding: .3rem .6rem; border-radius: 999px; font-size: .75rem;
  color: var(--text-2); text-decoration: none; border: 1px solid transparent;
}
.range a:hover { background: var(--surface); color: var(--text); }
.range a[aria-current='true'] {
  background: var(--surface); border-color: var(--border-strong); color: var(--text);
  font-weight: 600;
}
.range .signout { margin: 0 0 0 .5rem; display: flex; }
.range .signout button {
  font: inherit; font-size: .75rem; padding: .3rem .6rem;
  border-radius: 999px; border: 1px solid transparent;
  background: none; color: var(--text-3); cursor: pointer;
}
.range .signout button:hover { background: var(--surface); color: var(--text); }

/* --- Tiles ---------------------------------------------------------------- */
.tiles {
  display: grid; gap: .75rem; margin-bottom: .75rem;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}
.tile {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: .875rem 1rem 1rem;
  box-shadow: var(--shadow);
}
.tile .label {
  font-family: var(--mono);
  font-size: .625rem; text-transform: uppercase; letter-spacing: .12em;
  color: var(--text-3); font-weight: 600;
}
.tile .value {
  font-family: var(--mono);
  font-size: 1.75rem; font-weight: 600; letter-spacing: -0.03em;
  line-height: 1.2; margin-top: .35rem;
  font-variant-numeric: tabular-nums;
}
.tile .hint { font-size: .75rem; color: var(--text-2); margin-top: .15rem; }
.tile.good .value { color: var(--good); }
.tile.warning .value { color: var(--warning); }
.tile.critical .value { color: var(--critical); }

/* --- Cards ---------------------------------------------------------------- */
.grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); }

section.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.125rem 1.25rem 1.25rem;
  min-width: 0; box-shadow: var(--shadow);
}
section.card.wide { grid-column: 1 / -1; }

/* Two cards that belong together, each taking half the full width. The grid
   itself auto-fits, so a pair cannot be expressed as a column span; a row of
   its own can. */
.pair {
  grid-column: 1 / -1;
  display: grid; gap: .75rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
section.card.notice { border-color: var(--warning); }
section.card.notice h2 { color: var(--warning); }
section.card h2 {
  margin: 0 0 .25rem;
  font-family: var(--mono);
  font-size: .6875rem; font-weight: 600;
  letter-spacing: .12em; text-transform: uppercase;
  color: var(--text-3);
}
section.card .note {
  margin: 0 0 1.125rem; font-size: .8125rem; color: var(--text-2); max-width: 62ch;
}

/* --- Charts --------------------------------------------------------------- */
.chart { width: 100%; height: auto; display: block; overflow: visible; }
.chart .track { fill: var(--track); }
.chart .hit { fill: transparent; }
.chart .axis { stroke: var(--border-strong); stroke-width: 1; }
.chart .grid { stroke: var(--border); stroke-width: 1; stroke-dasharray: 2 3; }
.chart .mark.s1 { fill: var(--s1); }
.chart .mark.s2 { fill: var(--s2); }
.chart .mark.s3 { fill: var(--s3); }
.chart .cat { fill: var(--text-2); font: 12px var(--sans); }
.chart .val {
  fill: var(--text); font: 600 12px var(--mono); font-variant-numeric: tabular-nums;
}
.chart-scroll { overflow-x: auto; }
.chart .col-val {
  fill: var(--text-2); font-family: var(--mono); font-variant-numeric: tabular-nums;
}
.chart .tick { fill: var(--text-3); font: 11px var(--mono); font-variant-numeric: tabular-nums; }
.chart g:hover .mark { filter: brightness(1.1); }

.legend { display: flex; flex-wrap: wrap; gap: .875rem; margin-top: .75rem; }
.key {
  display: inline-flex; align-items: center; gap: .4rem;
  font-size: .75rem; color: var(--text-2); font-family: var(--mono);
}
.key b { color: var(--text); font-variant-numeric: tabular-nums; }
.swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.swatch.s1 { background: var(--s1); }
.swatch.s2 { background: var(--s2); }
.swatch.s3 { background: var(--s3); }

/* --- Tables --------------------------------------------------------------- */
.scroll { overflow-x: auto; }
table {
  width: 100%; border-collapse: collapse; font-size: .8125rem;
  /* Fixed layout, plus an explicit width on the numeric columns, stops the
     browser giving them less room than their content needs. That is what let
     "7 min ago" run into the value beside it. */
  table-layout: fixed;
}
th {
  font-family: var(--mono);
  text-align: left; font-size: .625rem; text-transform: uppercase; letter-spacing: .1em;
  color: var(--text-3); font-weight: 600; padding: 0 .75rem .5rem 0;
  border-bottom: 1px solid var(--border-strong);
}
td {
  padding: .5rem .75rem .5rem 0; border-bottom: 1px solid var(--border);
  color: var(--text-2); vertical-align: top;
}
tr:last-child td { border-bottom: 0; }
td.num, th.num {
  text-align: right; font-family: var(--mono);
  font-variant-numeric: tabular-nums; padding-right: 0; width: 5.5rem;
}
.nowrap { white-space: nowrap; }

/* The text column yields when space is tight; the numbers never do. */
td.clip { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.clip .path { overflow: hidden; text-overflow: ellipsis; }
td .path {
  display: block; color: var(--text-3);
  font-family: var(--mono); font-size: .6875rem; margin-top: .1rem;
}
.age { color: var(--text-3); }

.empty { color: var(--text-3); font-size: .8125rem; margin: .25rem 0 0; }

.status { display: inline-flex; align-items: center; gap: .4rem; font-weight: 600; }
.status::before {
  content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor;
}
.status.good { color: var(--good); }
.status.warning { color: var(--warning); }
.status.critical { color: var(--critical); }

footer.foot {
  margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border);
  color: var(--text-3); font-size: .75rem; font-family: var(--mono);
  display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between;
}

@media (max-width: 640px) {
  .wrap { padding: 1.25rem .875rem 3rem; }
  .grid, .pair { grid-template-columns: 1fr; }
  td.num, th.num { width: 4.5rem; }
}
`
