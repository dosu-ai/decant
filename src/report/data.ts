import type { Database } from "bun:sqlite";
import { type ContextWindowTimeline, contextWindowForSession } from "../context-window.ts";
import type { DateFilter } from "../date-filter.ts";
import { getSession, type SessionSummary } from "../query.ts";
import { list, type StoredRecommendation } from "../recommendations.ts";
import {
  type Activity,
  activity,
  byDimension,
  type DimRow,
  type FileStatRow,
  type SessionFacetRow,
  sessionFacets,
  type Totals,
  totals,
} from "../stats.ts";
import {
  type TokenEconomics,
  tokenEconomics,
  tokenEconomicsForSession,
} from "../token-economics.ts";

export interface AnalyticsReportData {
  kind: "analytics";
  range: DateFilter;
  totals: Totals;
  sessionsByDay: DimRow[];
  byModel: DimRow[];
  byProject: DimRow[];
  activity: Activity;
  economics: TokenEconomics;
  insights: StoredRecommendation[];
}

export interface SessionToolReportRow {
  toolName: string;
  toolKind: string | null;
  mcpServer: string | null;
  calls: number;
  errors: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface SessionReportData {
  kind: "session";
  summary: SessionSummary;
  replyCount: number;
  toolCallCount: number;
  durationSeconds: number | null;
  facets: SessionFacetRow | null;
  contextWindow: ContextWindowTimeline | null;
  economics: TokenEconomics | null;
  tools: SessionToolReportRow[];
  hotFiles: FileStatRow[];
}

export interface AnalyticsReportOptions {
  filter?: DateFilter | null;
  insightLimit?: number;
}

/**
 * Compose the report from the same read APIs that power Analytics. This stays
 * presentation-free so an HTTP route can build JSON, screen markup, or a
 * downloadable static document from one data shape.
 */
export function assembleAnalyticsReport(
  db: Database,
  options: AnalyticsReportOptions = {},
): AnalyticsReportData {
  const filter = options.filter ?? {};
  const insightLimit = normalizePositiveInteger(options.insightLimit, 5, 20);
  const dateScoped = filter.from != null || filter.to != null;
  return {
    kind: "analytics",
    range: { from: filter.from ?? null, to: filter.to ?? null },
    totals: totals(db, filter),
    sessionsByDay: byDimension(db, "day", filter),
    byModel: byDimension(db, "model", filter).sort(
      (left, right) => right.estimated_cost_usd - left.estimated_cost_usd,
    ),
    byProject: byDimension(db, "project", filter).sort(
      (left, right) => right.estimated_cost_usd - left.estimated_cost_usd,
    ),
    activity: activity(db, filter),
    economics: tokenEconomics(db, filter),
    insights: dateScoped
      ? []
      : list(db, "open")
          .filter((recommendation) => recommendation.kind === "signal")
          .slice(0, insightLimit),
  };
}

/** Build a session report without loading its transcript. */
export function assembleSessionReport(db: Database, sessionId: number): SessionReportData | null {
  const detail = getSession(db, sessionId, { messageLimit: 1 });
  if (detail == null) {
    return null;
  }
  const facets = sessionFacets(db, sessionId);
  return {
    kind: "session",
    summary: detail.summary,
    replyCount: detail.totals?.reply_count ?? 0,
    toolCallCount: detail.totals?.tool_call_count ?? 0,
    durationSeconds: wallDurationSeconds(detail.summary.started_at, detail.summary.ended_at),
    facets,
    contextWindow: contextWindowForSession(db, sessionId),
    economics: tokenEconomicsForSession(db, sessionId),
    tools: sessionToolSummary(db, sessionId),
    hotFiles: sessionHotFiles(db, sessionId),
  };
}

/**
 * Aggregate the full session once in SQLite. Paging through listToolCalls would
 * recompute its global count and percentile window for every 100-row page,
 * turning large report exports into repeated synchronous scans.
 */
function sessionToolSummary(db: Database, sessionId: number): SessionToolReportRow[] {
  type Row = {
    tool_name: string;
    tool_kind: string | null;
    mcp_server: string | null;
    calls: number;
    errors: number;
    p50_ms: number | null;
    p95_ms: number | null;
  };
  const rows = db
    .query(
      `WITH calls AS (
         SELECT COALESCE(tool_name, '(unknown)') AS tool_name,
                tool_kind, mcp_server, is_error, duration_ms
         FROM tool_call
         WHERE session_id = ?1
       ),
       groups AS (
         SELECT tool_name, tool_kind, mcp_server,
                COUNT(*) AS calls,
                SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors
         FROM calls
         GROUP BY tool_name, tool_kind, mcp_server
       ),
       ranked AS (
         SELECT tool_name, tool_kind, mcp_server, duration_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY tool_name, tool_kind, mcp_server
                  ORDER BY duration_ms
                ) AS duration_rank,
                COUNT(*) OVER (
                  PARTITION BY tool_name, tool_kind, mcp_server
                ) AS duration_count
         FROM calls
         WHERE duration_ms IS NOT NULL
       ),
       percentiles AS (
         SELECT tool_name, tool_kind, mcp_server,
                MAX(CASE
                  WHEN duration_rank = CAST((duration_count + 1) / 2 AS INTEGER)
                  THEN duration_ms
                END) AS p50_ms,
                MAX(CASE
                  WHEN duration_rank = CAST((duration_count * 95 + 99) / 100 AS INTEGER)
                  THEN duration_ms
                END) AS p95_ms
         FROM ranked
         GROUP BY tool_name, tool_kind, mcp_server
       )
       SELECT groups.tool_name, groups.tool_kind, groups.mcp_server,
              groups.calls, groups.errors, percentiles.p50_ms, percentiles.p95_ms
       FROM groups
       LEFT JOIN percentiles
         ON percentiles.tool_name = groups.tool_name
        AND percentiles.tool_kind IS groups.tool_kind
        AND percentiles.mcp_server IS groups.mcp_server
       ORDER BY groups.calls DESC, groups.tool_name ASC`,
    )
    .all(sessionId) as Row[];
  return rows.map((row) => ({
    toolName: row.tool_name,
    toolKind: row.tool_kind,
    mcpServer: row.mcp_server,
    calls: row.calls,
    errors: row.errors,
    p50Ms: row.p50_ms,
    p95Ms: row.p95_ms,
  }));
}

/**
 * fileHotspots has date and operation filters but no session scope. Keep this
 * narrow query beside report assembly until the shared stats API gains one.
 */
function sessionHotFiles(db: Database, sessionId: number): FileStatRow[] {
  return (
    db
      .query(
        `SELECT COALESCE(f.rel_path, f.path) AS key, p.path AS project,
                SUM(f.operation = 'read') AS reads,
                SUM(f.operation = 'edit') AS edits,
                SUM(f.operation = 'write') AS writes,
                SUM(f.operation = 'delete') AS deletes,
                COUNT(DISTINCT f.session_id) AS sessions,
                MAX(f.timestamp) AS last_touched_at
         FROM file_ref f
         JOIN session s ON s.id = f.session_id
         LEFT JOIN project p ON p.id = s.project_id
         WHERE f.session_id = ?1
         GROUP BY key, project
         ORDER BY (reads + edits + writes + deletes) DESC, key ASC
         LIMIT 25`,
      )
      .all(sessionId) as FileStatRow[]
  ).map((row) => ({ ...row, key: row.key ?? "" }));
}

function wallDurationSeconds(startedAt: string | null, endedAt: string | null): number | null {
  if (startedAt == null || endedAt == null) {
    return null;
  }
  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return null;
  }
  return Math.round((ended - started) / 1000);
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.floor(value));
}
