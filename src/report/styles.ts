/**
 * Print-first report styling.
 *
 * Bundled report fonts are injected as data-URI @font-face declarations by
 * render.tsx, preserving a single self-contained document with no runtime
 * font fetch. System families remain as glyph fallbacks.
 */
export const REPORT_CSS = `
:root {
  color-scheme: light;
  --ink: #24302a;
  --muted: #6d766f;
  --faint: #f3f5f0;
  --paper: #fff;
  --rule: #dce1da;
  --sage: #778561;
  --sage-soft: #e8ebe1;
  --sans: "IBM Plex Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --serif: "Source Serif 4", ui-serif, Georgia, Cambria, "Times New Roman", serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-family: var(--sans);
  color: var(--ink);
  background: #e9ece7;
}

* { box-sizing: border-box; }
html { font-size: 16px; }
body { margin: 0; background: #e9ece7; color: var(--ink); line-height: 1.42; }
a { color: inherit; text-underline-offset: 0.16em; }
.report {
  width: min(920px, calc(100% - 32px));
  margin: 32px auto;
  padding: 56px 64px 44px;
  background: var(--paper);
  box-shadow: 0 18px 60px rgba(36, 48, 42, 0.12);
}
.report-header { border-top: 4px solid var(--sage); padding-top: 28px; margin-bottom: 36px; }
.eyebrow {
  margin: 0 0 10px;
  color: var(--sage);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
h1, h2, h3 { break-after: avoid; color: var(--ink); }
h1 {
  max-width: 22ch;
  margin: 0;
  font: 600 clamp(2.3rem, 6vw, 4.15rem) / 0.98 var(--serif);
  letter-spacing: -0.035em;
}
.report-subject {
  max-width: 72ch;
  margin: 18px 0 0;
  color: var(--ink);
  font-size: 0.92rem;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.report-subject > span {
  display: block;
  margin-bottom: 5px;
  color: var(--muted);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h2 { margin: 0 0 14px; font: 600 1.55rem / 1.15 var(--serif); }
h3 { margin: 0 0 8px; font-size: 0.98rem; }
.lede {
  max-width: 68ch;
  margin: 18px 0 0;
  color: var(--muted);
  font-family: var(--serif);
  font-size: 1.04rem;
  font-weight: 600;
}
.meta-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin: 22px 0 0;
  padding: 0;
  color: var(--muted);
  font-size: 0.78rem;
  list-style: none;
}
.meta-list code { font-family: var(--mono); font-size: 0.74rem; }
.section { margin-top: 38px; }
.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.stat {
  min-height: 92px;
  padding: 15px 16px;
  background: var(--faint);
  border-top: 2px solid var(--sage);
  break-inside: avoid;
}
.stat-label {
  color: var(--muted);
  font-size: 0.69rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.stat-value {
  display: block;
  margin-top: 8px;
  font-size: 1.38rem;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}
.figure-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
figure {
  margin: 0;
  padding: 14px 12px 10px;
  border: 1px solid var(--rule);
  break-inside: avoid;
}
figcaption { margin: 0 0 8px; font-size: 0.78rem; font-weight: 700; }
.chart { width: 100%; overflow: hidden; }
.chart svg { display: block; width: 100%; height: auto; }
.activity-note {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 0;
}
.activity-note > div { padding: 13px 14px; background: var(--faint); break-inside: avoid; }
.activity-note dt { color: var(--muted); font-size: 0.72rem; }
.activity-note dd { margin: 5px 0 0; font-weight: 650; }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}
thead { display: table-header-group; }
th {
  padding: 8px 8px 8px 0;
  border-bottom: 1.5px solid var(--ink);
  color: var(--muted);
  font-size: 0.65rem;
  letter-spacing: 0.05em;
  text-align: left;
  text-transform: uppercase;
}
td { padding: 8px 8px 8px 0; vertical-align: top; }
th:last-child, td:last-child { padding-right: 0; }
.number { text-align: right; white-space: nowrap; }
.path { max-width: 42ch; overflow-wrap: anywhere; font-family: var(--mono); font-size: 0.72rem; }
.insight-list { display: grid; gap: 10px; padding: 0; list-style: none; }
.insight {
  padding: 14px 16px;
  border-left: 3px solid var(--sage);
  background: var(--faint);
  break-inside: avoid;
}
.insight-head { display: flex; justify-content: space-between; gap: 20px; }
.impact { color: var(--sage); font-size: 0.74rem; font-weight: 700; white-space: nowrap; }
.insight p { margin: 6px 0 0; color: var(--muted); font-size: 0.82rem; }
.empty { color: var(--muted); font-style: italic; }
.report-footer {
  margin-top: 48px;
  padding-top: 15px;
  border-top: 1px solid var(--rule);
  color: var(--muted);
  font-size: 0.68rem;
}
.footer-line { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.dosu-optimized {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ink);
  font-weight: 700;
  text-decoration: none;
}
.dosu-logo { width: 12px; height: 13px; flex: 0 0 auto; }
.report-cta { margin: 8px 0 0; }
.report-cta a { color: var(--sage); font-weight: 700; }

@page {
  size: letter;
  margin: 16mm 14mm;
  @bottom-left { content: "Decant report"; color: #6d766f; font-size: 8pt; }
  @bottom-right { content: counter(page) " / " counter(pages); color: #6d766f; font-size: 8pt; }
}

@media print {
  :root, body { background: #fff; }
  html { font-size: 10.5pt; }
  .report {
    width: auto;
    margin: 0;
    padding: 0;
    box-shadow: none;
  }
  .chart, .stat, .impact { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .section { margin-top: 8mm; }
  figure, .stat, .insight, .activity-note > div { break-inside: avoid; }
  table.compact { break-inside: avoid; }
}

@media screen and (max-width: 720px) {
  .report { width: 100%; margin: 0; padding: 32px 22px; box-shadow: none; }
  .stat-grid, .figure-grid { grid-template-columns: 1fr; }
  table.compact { table-layout: fixed; font-size: 0.68rem; }
  table.compact th, table.compact td { padding-right: 4px; overflow-wrap: anywhere; }
  table.compact .number { white-space: normal; }
}
`;
