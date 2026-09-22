import type { Database } from "bun:sqlite";
import { type DateFilter, sessionDatePredicate, whereClause } from "./date-filter.ts";
import type { Operation } from "./enrich.ts";
import { sessionUserStatePredicateForDatabase } from "./session-user-state.ts";
import { visibleSessionPredicate } from "./session-visibility.ts";
import { type SessionSource, sessionSourcePredicate } from "./source-filter.ts";

export interface Totals {
  sessions: number;
  messages: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  est_reasoning_tokens: number;
  estimated_cost_usd: number;
}

export interface StatsFilter extends DateFilter {
  includeArchived?: boolean;
  project?: string | null;
  source?: SessionSource | null;
  tool?: string | null;
}

export function totals(db: Database, filter?: StatsFilter | null): Totals {
  const visible = statsScope(db, "s", filter);
  return db
    .query(
      `WITH filtered_session AS (
         SELECT * FROM session s ${whereClause(visible)}
       )
       SELECT
         (SELECT COUNT(*) FROM filtered_session WHERE is_subagent = 0) AS sessions,
         (SELECT COUNT(*) FROM message m JOIN filtered_session s2 ON s2.id = m.session_id) AS messages,
         (SELECT COUNT(*) FROM tool_call t JOIN filtered_session s3 ON s3.id = t.session_id) AS tool_calls,
         (SELECT COALESCE(SUM(total_input_tokens), 0) FROM filtered_session) AS input_tokens,
         (SELECT COALESCE(SUM(total_output_tokens), 0) FROM filtered_session) AS output_tokens,
         (SELECT COALESCE(SUM(total_cache_read_tokens), 0) FROM filtered_session) AS cache_read_tokens,
         (SELECT COALESCE(SUM(total_cache_creation_tokens), 0) FROM filtered_session) AS cache_creation_tokens,
         (SELECT COALESCE(SUM(total_reasoning_tokens), 0) FROM filtered_session) AS reasoning_tokens,
         (SELECT COALESCE(SUM(est_reasoning_tokens), 0) FROM filtered_session) AS est_reasoning_tokens,
         (SELECT COALESCE(SUM(estimated_cost_usd), 0.0) FROM filtered_session) AS estimated_cost_usd`,
    )
    .get(...visible.params) as Totals;
}

export type Dimension = "tool" | "model" | "project" | "day";
export const DIMENSIONS = [
  "tool",
  "model",
  "project",
  "day",
] as const satisfies readonly Dimension[];

export function parseDimension(value: string): Dimension | null {
  return DIMENSIONS.includes(value as Dimension) ? (value as Dimension) : null;
}

export interface DimRow {
  key: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  est_reasoning_tokens: number;
  estimated_cost_usd: number;
}

interface DimRowDb extends Omit<DimRow, "key"> {
  key: string | null;
}

export function byDimension(
  db: Database,
  dimension: Dimension,
  filter?: StatsFilter | null,
): DimRow[] {
  const { groupExpr, join } = dimensionSql(dimension);
  const visible = statsScope(db, "s", filter);
  const statement = db.prepare(
    `WITH filtered_session AS (
         SELECT * FROM session s ${whereClause(visible)}
       )
       SELECT ${groupExpr} AS key,
              COALESCE(SUM(CASE WHEN s.is_subagent = 0 THEN 1 ELSE 0 END), 0) AS sessions,
              COALESCE(SUM(s.total_input_tokens), 0) AS input_tokens,
              COALESCE(SUM(s.total_output_tokens), 0) AS output_tokens,
              COALESCE(SUM(s.total_reasoning_tokens), 0) AS reasoning_tokens,
              COALESCE(SUM(s.est_reasoning_tokens), 0) AS est_reasoning_tokens,
              COALESCE(SUM(s.estimated_cost_usd), 0.0) AS estimated_cost_usd
       FROM filtered_session s ${join}
       GROUP BY key
       ORDER BY sessions DESC, key ASC`,
  );
  let rows: DimRowDb[];
  try {
    rows = statement.all(...visible.params) as DimRowDb[];
  } finally {
    statement.finalize();
  }
  return rows.map((row) => ({ ...row, key: row.key ?? "" }));
}

function statsScope(
  db: Database,
  alias: string,
  filter?: StatsFilter | null,
): { sql: string; params: string[] } {
  const date = sessionDatePredicate(alias, filter);
  const clauses = [
    visibleSessionPredicate(alias),
    sessionUserStatePredicateForDatabase(db, alias, filter?.includeArchived === true),
    date.sql,
  ];
  const params = [...date.params];
  if (filter?.project != null) {
    clauses.push(
      `EXISTS (
         SELECT 1
         FROM project stats_project
         WHERE stats_project.id = ${alias}.project_id
           AND stats_project.path = ?
       )`,
    );
    params.push(filter.project);
  }
  if (filter?.tool != null) {
    clauses.push(`${alias}.tool = ?`);
    params.push(filter.tool);
  }
  const source = sessionSourcePredicate(alias, filter?.source);
  if (source.sql !== "") {
    clauses.push(source.sql);
    params.push(...source.params);
  }
  return {
    sql: clauses.filter((clause) => clause !== "").join(" AND "),
    params,
  };
}

export interface ToolStatRow {
  tool_name: string;
  tool_kind: string;
  mcp_server: string | null;
  calls: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
  last_used_at: string | null;
}

interface ToolStatDb extends Omit<ToolStatRow, "tool_name" | "tool_kind"> {
  tool_name: string | null;
  tool_kind: string | null;
}

export function toolUsage(
  db: Database,
  errorsOnly: boolean,
  limitValue = 50,
  filter?: DateFilter | null,
): ToolStatRow[] {
  const limit = normalizeLimit(limitValue, 50);
  const errorFilter = errorsOnly ? "WHERE a.errors > 0" : "";
  const visible = statsScope(db, "s", filter);
  const scope = `JOIN (SELECT id FROM session s ${whereClause(visible)}) fs
    ON fs.id = t.session_id`;
  const statement = db.prepare(
    `WITH scoped AS (
         SELECT COALESCE(t.tool_name, '') AS tool_name,
                COALESCE(t.tool_kind, '') AS tool_kind,
                t.mcp_server, t.is_error,
                t.duration_ms, t.timestamp
         FROM tool_call t
         ${scope}
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
         FROM scoped
         WHERE duration_ms IS NOT NULL
       ),
       latency AS (
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
       ),
       aggregate AS (
         SELECT tool_name, tool_kind, mcp_server,
                COUNT(*) AS calls,
                COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0) AS errors,
                MAX(timestamp) AS last_used_at
         FROM scoped
         GROUP BY tool_name, tool_kind, mcp_server
       )
       SELECT a.tool_name, a.tool_kind, a.mcp_server, a.calls, a.errors,
              l.p50_ms, l.p95_ms, a.last_used_at
       FROM aggregate a
       LEFT JOIN latency l
         ON l.tool_name IS a.tool_name
        AND l.tool_kind IS a.tool_kind
        AND l.mcp_server IS a.mcp_server
       ${errorFilter}
       ORDER BY a.calls DESC, a.tool_name ASC, a.tool_kind ASC,
                (a.mcp_server IS NOT NULL) ASC, COALESCE(a.mcp_server, '') ASC
       LIMIT ${limit}`,
  );
  let rows: ToolStatDb[];
  try {
    rows = statement.all(...visible.params) as ToolStatDb[];
  } finally {
    statement.finalize();
  }
  return rows.map((row) => ({
    ...row,
    tool_name: row.tool_name ?? "",
    tool_kind: row.tool_kind ?? "",
  }));
}

export interface McpStatRow {
  mcp_server: string;
  tools: number;
  calls: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
  last_used_at: string | null;
}

interface McpStatDb extends Omit<McpStatRow, "mcp_server"> {
  mcp_server: string | null;
}

export function mcpUsage(db: Database, limitValue = 50, filter?: DateFilter | null): McpStatRow[] {
  const limit = normalizeLimit(limitValue, 50);
  const visible = statsScope(db, "s", filter);
  const statement = db.prepare(
    `WITH filtered_session AS (
         SELECT id, started_at FROM session s ${whereClause(visible)}
       ),
       scoped AS (
         SELECT t.mcp_server, t.tool_name, t.is_error, t.duration_ms, t.timestamp
         FROM tool_call t
         JOIN filtered_session s ON s.id = t.session_id
         WHERE t.tool_kind = 'mcp' AND t.mcp_server IS NOT NULL
       ),
       ranked AS (
         SELECT mcp_server, duration_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY mcp_server
                  ORDER BY duration_ms
                ) AS duration_rank,
                COUNT(*) OVER (
                  PARTITION BY mcp_server
                ) AS duration_count
         FROM scoped
         WHERE duration_ms IS NOT NULL
       ),
       latency AS (
         SELECT mcp_server,
                MAX(CASE
                  WHEN duration_rank = CAST((duration_count + 1) / 2 AS INTEGER)
                  THEN duration_ms
                END) AS p50_ms,
                MAX(CASE
                  WHEN duration_rank = CAST((duration_count * 95 + 99) / 100 AS INTEGER)
                  THEN duration_ms
                END) AS p95_ms
         FROM ranked
         GROUP BY mcp_server
       ),
       aggregate AS (
         SELECT mcp_server,
                COUNT(DISTINCT tool_name) AS tools,
                COUNT(*) AS calls,
                COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0) AS errors,
                MAX(timestamp) AS last_used_at
         FROM scoped
         GROUP BY mcp_server
       )
       SELECT a.mcp_server, a.tools, a.calls, a.errors,
              l.p50_ms, l.p95_ms, a.last_used_at
       FROM aggregate a
       LEFT JOIN latency l ON l.mcp_server = a.mcp_server
       ORDER BY a.calls DESC, a.mcp_server ASC
       LIMIT ?`,
  );
  let rows: McpStatDb[];
  try {
    rows = statement.all(...visible.params, limit) as McpStatDb[];
  } finally {
    statement.finalize();
  }
  return rows.map((row) => ({ ...row, mcp_server: row.mcp_server ?? "" }));
}

export type FileGroup = "path" | "ext";

export function parseFileGroup(value: string): FileGroup | null {
  return value === "path" || value === "ext" ? value : null;
}

export interface FileStatRow {
  key: string;
  project: string | null;
  reads: number;
  edits: number;
  writes: number;
  deletes: number;
  sessions: number;
  last_touched_at: string | null;
}

interface FileStatDb extends Omit<FileStatRow, "key"> {
  key: string | null;
}

export function fileHotspots(
  db: Database,
  group: FileGroup,
  op: Operation | null,
  limitValue = 50,
  filter?: DateFilter | null,
): FileStatRow[] {
  const limit = normalizeLimit(limitValue, 50);
  const { keyExpr, projectExpr, join } = fileGroupSql(group);
  const visible = statsScope(db, "s", filter);
  const clauses = [op == null ? null : "f.operation = ?", visible.sql].filter(
    (clause): clause is string => clause != null && clause !== "",
  );
  const params = [...(op == null ? [] : [op]), ...visible.params];
  const opFilter = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const sql = `SELECT ${keyExpr} AS key, ${projectExpr} AS project,
                      SUM(f.operation = 'read') AS reads,
                      SUM(f.operation = 'edit') AS edits,
                      SUM(f.operation = 'write') AS writes,
                      SUM(f.operation = 'delete') AS deletes,
                      COUNT(DISTINCT f.session_id) AS sessions,
                      MAX(f.timestamp) AS last_touched_at
               FROM file_ref f ${join}
               ${opFilter}
               GROUP BY key, project
               ORDER BY (reads + edits + writes + deletes) DESC, key ASC
               LIMIT ${limit}`;
  const rows = db.query(sql).all(...params) as FileStatDb[];
  return rows.map((row) => ({ ...row, key: row.key ?? "" }));
}

export interface SessionFacetRow {
  turn_count: number;
  error_count: number;
  interruption_count: number;
  compaction_count: number;
  sidechain_message_count: number;
  agent_spawn_count: number;
  skill_count: number;
  command_count: number;
  thinking_block_count: number;
  thinking_chars: number;
  active_seconds: number;
  outcome: string | null;
  work_type: string | null;
}

export function sessionFacets(db: Database, sessionId: number): SessionFacetRow | null {
  return db
    .query(
      `SELECT turn_count, error_count, interruption_count, compaction_count,
              sidechain_message_count, agent_spawn_count, skill_count, command_count,
              thinking_block_count, thinking_chars, active_seconds, outcome, work_type
       FROM session WHERE id = ?1`,
    )
    .get(sessionId) as SessionFacetRow | null;
}

export interface Activity {
  by_hour: number[];
  by_weekday: number[];
  timezone: string;
  peak_hour: number | null;
  peak_weekday: number | null;
}

export function activity(db: Database, filter?: StatsFilter | null): Activity {
  const byHour = bucket(db, "strftime('%H', s.started_at, 'localtime')", 24, filter);
  const byWeekday = bucket(db, "strftime('%w', s.started_at, 'localtime')", 7, filter);
  return {
    by_hour: byHour,
    by_weekday: byWeekday,
    timezone: localTimezone(),
    peak_hour: peak(byHour),
    peak_weekday: peak(byWeekday),
  };
}

export interface ModelSparklines {
  models: Record<string, number[]>;
  days: string[];
}

export function modelSparklines(db: Database, filter?: StatsFilter | null): ModelSparklines {
  const visible = statsScope(db, "s", filter);
  const rows = db
    .query(
      `SELECT COALESCE(s.model, '(unknown)') AS model,
              substr(s.started_at, 1, 10) AS day,
              COUNT(*) AS count
       FROM session s
       ${whereClause({
         sql: ["s.started_at IS NOT NULL", visible.sql].filter(Boolean).join(" AND "),
         params: visible.params,
       })}
       GROUP BY model, day
       ORDER BY model ASC, day ASC`,
    )
    .all(...visible.params) as { model: string; day: string; count: number }[];
  const days = [...new Set(rows.map((row) => row.day))].sort();
  const dayIndex = new Map(days.map((day, index) => [day, index]));
  const models: Record<string, number[]> = {};
  for (const row of rows) {
    if (models[row.model] == null) {
      models[row.model] = Array.from({ length: days.length }, () => 0);
    }
    const modelCounts = models[row.model];
    const index = dayIndex.get(row.day);
    if (index != null && modelCounts != null) {
      modelCounts[index] = row.count;
    }
  }
  return { models, days };
}

export interface DateBounds {
  min: string | null;
  max: string | null;
}

export function dateBounds(db: Database): DateBounds {
  const visible = statsScope(db, "s");
  return db
    .query(
      `SELECT MIN(substr(s.started_at, 1, 10)) AS min,
              MAX(substr(s.started_at, 1, 10)) AS max
       FROM session s
       ${whereClause({
         sql: ["s.started_at IS NOT NULL", visible.sql].join(" AND "),
         params: visible.params,
       })}`,
    )
    .get() as DateBounds;
}

export function todayTotals(db: Database): Totals {
  const visible = statsScope(db, "s");
  return db
    .query(
      `WITH filtered_session AS (
         SELECT *
         FROM session s
         ${whereClause({
           sql: [visible.sql, "substr(s.started_at, 1, 10) = date('now', 'localtime')"].join(
             " AND ",
           ),
           params: visible.params,
         })}
       )
       SELECT
         COALESCE(SUM(CASE WHEN is_subagent = 0 THEN 1 ELSE 0 END), 0) AS sessions,
         (SELECT COUNT(*) FROM message m
          JOIN filtered_session s2 ON s2.id = m.session_id) AS messages,
         (SELECT COUNT(*) FROM tool_call t
          JOIN filtered_session s3 ON s3.id = t.session_id) AS tool_calls,
         COALESCE(SUM(total_input_tokens), 0) AS input_tokens,
         COALESCE(SUM(total_output_tokens), 0) AS output_tokens,
         COALESCE(SUM(total_cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(total_cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(total_reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(est_reasoning_tokens), 0) AS est_reasoning_tokens,
         COALESCE(SUM(estimated_cost_usd), 0.0) AS estimated_cost_usd
       FROM filtered_session`,
    )
    .get() as Totals;
}

function dimensionSql(dimension: Dimension): { groupExpr: string; join: string } {
  switch (dimension) {
    case "tool":
      return { groupExpr: "s.tool", join: "" };
    case "model":
      return { groupExpr: "COALESCE(s.model, '(unknown)')", join: "" };
    case "project":
      return {
        groupExpr: "COALESCE(p.path, '(none)')",
        join: "LEFT JOIN project p ON p.id = s.project_id",
      };
    case "day":
      return { groupExpr: "substr(s.started_at, 1, 10)", join: "" };
  }
}

function fileGroupSql(group: FileGroup): { keyExpr: string; projectExpr: string; join: string } {
  switch (group) {
    case "path":
      return {
        keyExpr: "COALESCE(f.rel_path, f.path)",
        projectExpr: "p.path",
        join: "JOIN session s ON s.id = f.session_id LEFT JOIN project p ON p.id = s.project_id",
      };
    case "ext":
      return {
        keyExpr: "COALESCE(f.ext, '(none)')",
        projectExpr: "NULL",
        join: "JOIN session s ON s.id = f.session_id",
      };
  }
}

function bucket(db: Database, expr: string, size: number, filter?: DateFilter | null): number[] {
  const out = Array.from({ length: size }, () => 0);
  const visible = statsScope(db, "s", filter);
  const rows = db
    .query(
      `SELECT ${expr} AS key, COUNT(*) AS count
       FROM session s
       ${whereClause({
         sql: ["s.started_at IS NOT NULL", visible.sql].filter(Boolean).join(" AND "),
         params: visible.params,
       })}
       GROUP BY key`,
    )
    .all(...visible.params) as { key: string | null; count: number }[];
  for (const row of rows) {
    const key = row.key == null || row.key === "" ? Number.NaN : Number.parseInt(row.key, 10);
    if (Number.isInteger(key) && key >= 0 && key < size) {
      out[key] = row.count;
    }
  }
  return out;
}

function peak(counts: number[]): number | null {
  let bestIndex: number | null = null;
  let bestCount = 0;
  for (const [index, count] of counts.entries()) {
    if (count > bestCount) {
      bestIndex = index;
      bestCount = count;
    }
  }
  return bestIndex;
}

function localTimezone(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

function normalizeLimit(value: number | null | undefined, fallback: number): number {
  return value != null && value > 0 ? Math.trunc(value) : fallback;
}
