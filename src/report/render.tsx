import { renderToStaticMarkup } from "react-dom/server";
import { mcpServerLabel, mcpServerLabels } from "../mcp-names.ts";
import { sessionSourceLabel } from "../source-filter.ts";
import type { TokenEconomics, TokenEconomicsBucket } from "../token-economics.ts";
import { DECANT_VERSION } from "../version.ts";
import {
  renderContextWindowChart,
  renderCostByDayChart,
  renderSessionsByDayChart,
} from "./charts.ts";
import type { AnalyticsReportData, SessionReportData, SessionToolReportRow } from "./data.ts";
import { DosuOptimizedMark, reportDosuLink } from "./dosu.tsx";
import { REPORT_FONT_CSS } from "./fonts.ts";
import { REPORT_CSS } from "./styles.ts";

export interface ReportRenderOptions {
  generatedAt?: Date;
  version?: string;
  /**
   * Trusted, inline-only @font-face CSS. The current fallback is system fonts;
   * route integration can pass bundled WOFF2 data URIs without a network fetch.
   */
  fontCss?: string;
}

interface NormalizedRenderOptions {
  generatedAt: Date;
  version: string;
  fontCss: string;
}

export function renderAnalyticsReport(
  data: AnalyticsReportData,
  options: ReportRenderOptions = {},
): string {
  const normalized = normalizeOptions(options);
  const scoped = data.range.from != null || data.range.to != null || data.source != null;
  const range = formatRange(data.range.from, data.range.to);
  const source = data.source == null ? null : sessionSourceLabel(data.source);
  const sessionsSvg = renderSessionsByDayChart(data.sessionsByDay, { width: 380, height: 220 });
  const costSvg = renderCostByDayChart(data.sessionsByDay, { width: 380, height: 220 });
  const body = (
    <main className="report">
      <ReportHeader
        eyebrow="Session analytics"
        lede="A local-first view of how coding-agent time, context, tools, and cost were allocated."
        meta={[range, ...(source == null ? [] : [source]), `${data.activity.timezone} timezone`]}
        title="Agent activity report"
      />

      <section className="section">
        <h2>At a glance</h2>
        <div className="stat-grid">
          <Stat label="Sessions" value={formatInteger(data.totals.sessions)} />
          <Stat label="Messages" value={formatInteger(data.totals.messages)} />
          <Stat label="Tool calls" value={formatInteger(data.totals.tool_calls)} />
          <Stat label="Input tokens" value={formatCompact(data.totals.input_tokens)} />
          <Stat label="Output tokens" value={formatCompact(data.totals.output_tokens)} />
          <Stat label="Estimated cost" value={formatCurrency(data.totals.estimated_cost_usd)} />
        </div>
      </section>

      <section className="section">
        <h2>Working rhythm</h2>
        <dl className="activity-note">
          <div>
            <dt>Busiest hour</dt>
            <dd>{formatPeakHour(data.activity.peak_hour)}</dd>
          </div>
          <div>
            <dt>Busiest day</dt>
            <dd>{formatWeekday(data.activity.peak_weekday)}</dd>
          </div>
        </dl>
      </section>

      <EconomicsSection economics={data.economics} />

      <section className="section">
        <h2>Activity over time</h2>
        <div className="figure-grid">
          <ReportFigure caption="Sessions per day" svg={sessionsSvg} />
          <ReportFigure caption="Estimated cost per day" svg={costSvg} />
        </div>
      </section>

      <section className="section">
        <h2>Models</h2>
        <DimensionTable rows={data.byModel} />
      </section>

      <section className="section">
        <h2>Projects</h2>
        <DimensionTable path rows={data.byProject} />
      </section>

      <section className="section">
        <h2>Open insights</h2>
        {scoped ? (
          <p className="empty">
            Insights are omitted from filtered reports because signals use archive-wide evidence.
          </p>
        ) : data.insights.length === 0 ? (
          <p className="empty">No open signals are available.</p>
        ) : (
          <ol className="insight-list">
            {data.insights.map((insight) => (
              <li className="insight" key={insight.key}>
                <div className="insight-head">
                  <h3>{insight.title}</h3>
                  {insight.impact_label == null ? null : (
                    <span className="impact">{insight.impact_label}</span>
                  )}
                </div>
                {insight.detail == null ? null : <p>{insight.detail}</p>}
                {insight.suggestion == null ? null : <p>{insight.suggestion}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <ReportFooter options={normalized} />
    </main>
  );
  return staticDocument("Agent activity report · Decant", body, normalized.fontCss);
}

export function renderSessionReport(
  data: SessionReportData,
  options: ReportRenderOptions = {},
): string {
  const normalized = normalizeOptions(options);
  const summary = data.summary;
  const totalTokens = summary.total_input_tokens + summary.total_output_tokens;
  const timeline = data.contextWindow;
  const contextSvg = timeline == null ? null : renderContextWindowChart(timeline);
  const meta = [
    summary.project_path ?? "No project",
    [summary.model ?? summary.tool, formatEffort(summary.reasoning_effort)]
      .filter(Boolean)
      .join(" · "),
    formatSessionDates(summary.started_at, summary.ended_at),
  ];
  const body = (
    <main className="report">
      <ReportHeader
        eyebrow="Session analysis"
        lede="A focused record of this session’s shape, resource use, tools, and context-window pressure. Transcript content beyond the prompt preview is not included."
        meta={meta}
        subject={summary.title ?? "Untitled session"}
        title="Session report"
      />

      <section className="section">
        <h2>At a glance</h2>
        <div className="stat-grid">
          <Stat label="Turns" value={formatInteger(data.facets?.turn_count ?? 0)} />
          <Stat label="Replies" value={formatInteger(data.replyCount)} />
          <Stat label="Tool calls" value={formatInteger(data.toolCallCount)} />
          <Stat label="Tokens" value={formatCompact(totalTokens)} />
          <Stat label="Estimated cost" value={formatCurrency(summary.estimated_cost_usd)} />
          <Stat label="Duration" value={formatDuration(data.durationSeconds)} />
        </div>
      </section>

      {data.economics == null ? null : <EconomicsSection economics={data.economics} />}

      <section className="section">
        <h2>Context window</h2>
        {contextSvg == null || timeline == null || timeline.points.length === 0 ? (
          <p className="empty">No context-window telemetry is available for this session.</p>
        ) : (
          <>
            <ReportFigure caption="Context occupancy across calls" svg={contextSvg} />
            <dl className="activity-note">
              <div>
                <dt>Peak occupancy</dt>
                <dd>
                  {formatCompact(timeline.peak_tokens)}
                  {timeline.peak_pct == null ? "" : ` · ${formatPercent(timeline.peak_pct)}`}
                </dd>
              </div>
              <div>
                <dt>Compactions</dt>
                <dd>{formatInteger(timeline.compactions.length)}</dd>
              </div>
            </dl>
          </>
        )}
      </section>

      <section className="section">
        <h2>Tool usage</h2>
        <ToolTable rows={data.tools} />
      </section>

      <section className="section">
        <h2>Files touched</h2>
        {data.hotFiles.length === 0 ? (
          <p className="empty">No file activity was captured.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th className="number">Reads</th>
                <th className="number">Edits</th>
                <th className="number">Writes</th>
              </tr>
            </thead>
            <tbody>
              {data.hotFiles.map((file) => (
                <tr key={`${file.project ?? ""}:${file.key}`}>
                  <td className="path">{file.key}</td>
                  <td className="number">{formatInteger(file.reads)}</td>
                  <td className="number">{formatInteger(file.edits)}</td>
                  <td className="number">{formatInteger(file.writes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <ReportFooter options={normalized} />
    </main>
  );
  return staticDocument("Session report · Decant", body, normalized.fontCss);
}

function ReportHeader({
  eyebrow,
  lede,
  meta,
  subject,
  title,
}: {
  eyebrow: string;
  lede: string;
  meta: string[];
  subject?: string | null;
  title: string;
}) {
  return (
    <header className="report-header">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {subject == null ? null : (
        <p className="report-subject">
          <span>Session prompt</span>
          {subject}
        </p>
      )}
      <p className="lede">{lede}</p>
      <ul className="meta-list">
        {meta.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function ReportFigure({ caption, svg }: { caption: string; svg: string }) {
  return (
    <figure>
      <figcaption>{caption}</figcaption>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: renderChartSvg rejects active markup and event-handler attributes before this fixed local SVG reaches the report. */}
      <div className="chart" dangerouslySetInnerHTML={{ __html: svg }} />
    </figure>
  );
}

function DimensionTable({
  path = false,
  rows,
}: {
  path?: boolean;
  rows: AnalyticsReportData["byModel"];
}) {
  if (rows.length === 0) {
    return <p className="empty">No data for this range.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>{path ? "Project" : "Model"}</th>
          <th className="number">Sessions</th>
          <th className="number">Input</th>
          <th className="number">Output</th>
          <th className="number">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className={path ? "path" : undefined}>{row.key || "(unknown)"}</td>
            <td className="number">{formatInteger(row.sessions)}</td>
            <td className="number">{formatCompact(row.input_tokens)}</td>
            <td className="number">{formatCompact(row.output_tokens)}</td>
            <td className="number">{formatCurrency(row.estimated_cost_usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EconomicsSection({ economics }: { economics: TokenEconomics }) {
  return (
    <section className="section">
      <h2>Token economics</h2>
      <table className="compact">
        <thead>
          <tr>
            <th>Activity</th>
            <th className="number">Generation</th>
            <th className="number">Context</th>
            <th className="number">Tool calls</th>
            <th className="number">Active time</th>
            <th className="number">Cost</th>
          </tr>
        </thead>
        <tbody>
          {economics.buckets.map((bucket) => (
            <EconomicsRow bucket={bucket} key={bucket.bucket} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function EconomicsRow({ bucket }: { bucket: TokenEconomicsBucket }) {
  return (
    <tr>
      <td>{formatBucket(bucket.bucket)}</td>
      <td className="number">{formatCompact(bucket.generation_tokens)}</td>
      <td className="number">{formatCompact(bucket.context_window_tokens)}</td>
      <td className="number">{formatInteger(bucket.tool_calls)}</td>
      <td className="number">{formatDuration(Math.round(bucket.active_ms / 1000))}</td>
      <td className="number">{formatCurrency(bucket.estimated_cost_usd)}</td>
    </tr>
  );
}

function ToolTable({ rows }: { rows: SessionToolReportRow[] }) {
  // Same naming as the Tools & MCP view, disambiguated across the whole table
  // so two registrations of one server do not read as one duplicated row.
  const serverLabels = mcpServerLabels(rows.map((row) => row.mcpServer));
  if (rows.length === 0) {
    return <p className="empty">No tool calls were captured.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Tool</th>
          <th>Kind / server</th>
          <th className="number">Calls</th>
          <th className="number">Errors</th>
          <th className="number">Median elapsed</th>
          <th className="number">p95 elapsed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.toolName}:${row.toolKind ?? ""}:${row.mcpServer ?? ""}`}>
            <td className="path">{row.toolName}</td>
            <td title={row.mcpServer ?? undefined}>
              {[row.toolKind, mcpServerLabel(serverLabels, row.mcpServer)]
                .filter(Boolean)
                .join(" · ") || "—"}
            </td>
            <td className="number">{formatInteger(row.calls)}</td>
            <td className="number">{formatInteger(row.errors)}</td>
            <td className="number">{formatMilliseconds(row.p50Ms)}</td>
            <td className="number">{formatMilliseconds(row.p95Ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ReportFooter({ options }: { options: NormalizedRenderOptions }) {
  const generated = options.generatedAt.toISOString().slice(0, 10);
  return (
    <footer className="report-footer">
      <div className="footer-line">
        <span>
          Generated by Decant {options.version} · {generated}
        </span>
        <span aria-hidden="true">·</span>
        <DosuOptimizedMark />
      </div>
      <p className="report-cta">
        <a href={reportDosuLink("report_cta")} rel="noopener noreferrer" target="_blank">
          Dosu keeps agent context fresh automatically →
        </a>
      </p>
    </footer>
  );
}

function staticDocument(title: string, body: React.ReactNode, fontCss: string): string {
  const markup = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width, initial-scale=1" name="viewport" />
        <meta content="light" name="color-scheme" />
        <title>{title}</title>
        <style>{`${fontCss}\n${REPORT_CSS}`}</style>
      </head>
      <body>{body}</body>
    </html>,
  );
  return `<!doctype html>${markup}`;
}

function normalizeOptions(options: ReportRenderOptions): NormalizedRenderOptions {
  return {
    generatedAt: options.generatedAt ?? new Date(),
    version: options.version ?? DECANT_VERSION,
    fontCss: options.fontCss ?? REPORT_FONT_CSS,
  };
}

function formatRange(from: string | null | undefined, to: string | null | undefined): string {
  if (from == null && to == null) {
    return "All session logs";
  }
  if (from == null) {
    return `Through ${to}`;
  }
  if (to == null) {
    return `Since ${from}`;
  }
  return `${from} – ${to}`;
}

function formatSessionDates(started: string | null, ended: string | null): string {
  if (started == null && ended == null) {
    return "Date unavailable";
  }
  if (ended == null || started === ended) {
    return started ?? ended ?? "Date unavailable";
  }
  return `${started ?? "unknown"} – ${ended}`;
}

function formatEffort(effort: string | null): string | null {
  return effort == null || effort === "" ? null : `${effort} effort`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(value) >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 2 : 0,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) {
    return "—";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatMilliseconds(value: number | null): string {
  if (value == null) {
    return "—";
  }
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function formatPeakHour(hour: number | null): string {
  if (hour == null) {
    return "No activity";
  }
  const normalized = ((hour % 24) + 24) % 24;
  const suffix = normalized >= 12 ? "PM" : "AM";
  const display = normalized % 12 || 12;
  return `${display}:00 ${suffix}`;
}

function formatWeekday(day: number | null): string {
  return day == null
    ? "No activity"
    : (["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] ??
        "Unknown");
}

function formatBucket(bucket: string): string {
  return bucket.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
