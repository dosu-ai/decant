import type { Database } from "bun:sqlite";
import { defaultPricing } from "./cost.ts";
import { type DateFilter, sessionDatePredicate, whereClause } from "./date-filter.ts";
import type { Operation } from "./enrich.ts";
import type { Tool } from "./model.ts";
import { modelUsageForScope, sessionCostParts, totalCost } from "./model-usage.ts";
import { compareCodePoints } from "./order.ts";
import { cachedRead, statementKey } from "./read-cache.ts";
import { sessionUserStatePredicateForDatabase } from "./session-user-state.ts";
import { visibleSessionPredicate } from "./session-visibility.ts";
import { type SessionSource, sessionSourcePredicate } from "./source-filter.ts";

export interface Totals {
  sessions: number;
  usage_sessions: number;
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
  /** A repository root: matches sessions in the root and in its worktrees. */
  repo?: string | null;
  source?: SessionSource | null;
  tool?: string | null;
}

/** Sources whose sessions may hold no token usage at all: Cursor CLI stores
 * none, VS Code builds from before April 2026 wrote none for Copilot Chat,
 * and ATIF makes every metric optional. */
export const USAGE_OPTIONAL_TOOLS = [
  "cursor",
  "vscode_copilot",
  "atif",
] as const satisfies readonly Tool[];

/** 1 unless the session comes from a source that may record no token usage
 * and none of its messages carries any. There a zero cost means "unknown",
 * not "free". Other sources always count: Codex can report usage only as
 * session totals, and a zero total there is a real zero. */
export function sessionUsageAvailableSql(alias: string): string {
  const optional = USAGE_OPTIONAL_TOOLS.map((tool) => `'${tool}'`).join(", ");
  // An ATIF trajectory can record usage only as run totals (`final_metrics`),
  // zero included, or a cost only, with no per-step token counts.
  // COALESCE: a JSON path the metadata lacks yields NULL, which a caller
  // reading "not 0" as available would count as usage.
  return `COALESCE((${alias}.tool NOT IN (${optional}) OR EXISTS (
           SELECT 1 FROM message usage_message
           WHERE usage_message.session_id = ${alias}.id
             AND (usage_message.input_tokens IS NOT NULL
               OR usage_message.output_tokens IS NOT NULL
               OR usage_message.cache_read_tokens IS NOT NULL
               OR usage_message.cache_creation_tokens IS NOT NULL)
         ) OR (${alias}.tool = 'atif' AND (
           ${alias}.total_input_tokens + ${alias}.total_output_tokens
             + ${alias}.total_cache_read_tokens + ${alias}.total_cache_creation_tokens > 0
           OR ${alias}.estimated_cost_usd > 0
           OR (CASE WHEN json_valid(${alias}.raw_meta)
                 THEN json_type(${alias}.raw_meta, '$.final_metrics.total_prompt_tokens')
                        IN ('integer', 'real')
                   OR json_type(${alias}.raw_meta, '$.final_metrics.total_completion_tokens')
                        IN ('integer', 'real')
               END) = 1))), 0)`;
}

const TOTALS_COLUMNS = `s.id, s.is_subagent,
         s.total_input_tokens, s.total_output_tokens, s.total_cache_read_tokens,
         s.total_cache_creation_tokens, s.total_reasoning_tokens, s.est_reasoning_tokens,
         s.estimated_cost_usd, ${sessionUsageAvailableSql("s")} AS usage_available`;

export function totals(db: Database, filter?: StatsFilter | null): Totals {
  const visible = statsScope(db, "s", filter);
  // CROSS JOIN keeps the session scope outermost. With no planner statistics
  // SQLite scans the child table and reruns the scope's subqueries per row.
  const sql = `WITH filtered_session AS (
         SELECT ${TOTALS_COLUMNS} FROM session s ${whereClause(visible)}
       )
       SELECT
         (SELECT COUNT(*) FROM filtered_session WHERE is_subagent = 0) AS sessions,
         (SELECT COUNT(*) FROM filtered_session
          WHERE is_subagent = 0 AND usage_available = 1) AS usage_sessions,
         (SELECT COUNT(*) FROM filtered_session s2
          CROSS JOIN message m ON m.session_id = s2.id) AS messages,
         (SELECT COUNT(*) FROM filtered_session s3
          CROSS JOIN tool_call t ON t.session_id = s3.id) AS tool_calls,
         (SELECT COALESCE(SUM(total_input_tokens), 0) FROM filtered_session) AS input_tokens,
         (SELECT COALESCE(SUM(total_output_tokens), 0) FROM filtered_session) AS output_tokens,
         (SELECT COALESCE(SUM(total_cache_read_tokens), 0) FROM filtered_session) AS cache_read_tokens,
         (SELECT COALESCE(SUM(total_cache_creation_tokens), 0) FROM filtered_session) AS cache_creation_tokens,
         (SELECT COALESCE(SUM(total_reasoning_tokens), 0) FROM filtered_session) AS reasoning_tokens,
         (SELECT COALESCE(SUM(est_reasoning_tokens), 0) FROM filtered_session) AS est_reasoning_tokens,
         (SELECT COALESCE(SUM(estimated_cost_usd), 0.0) FROM filtered_session) AS estimated_cost_usd`;
  return {
    ...cachedRead(
      db,
      statementKey(sql, visible.params),
      () => db.query(sql).get(...visible.params) as Totals,
    ),
  };
}

export type Dimension = "tool" | "model" | "project" | "repo" | "outcome" | "day";
export const DIMENSIONS = [
  "tool",
  "model",
  "project",
  "repo",
  "outcome",
  "day",
] as const satisfies readonly Dimension[];

/** Key for sessions with no project, or whose run has no outcome label. */
export const NO_PROJECT_KEY = "(none)";
export const UNCLASSIFIED_OUTCOME_KEY = "(unclassified)";

export function parseDimension(value: string): Dimension | null {
  return DIMENSIONS.includes(value as Dimension) ? (value as Dimension) : null;
}

export interface DimRow {
  key: string;
  sessions: number;
  /** Top-level sessions in the row whose source records token usage. When
   * this is below `sessions`, the row's tokens and cost cover only these. */
  usage_sessions: number;
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
  const visible = statsScope(db, "s", filter);
  const rows = cachedRead(
    db,
    statementKey(`byDimension:${dimension}:${visible.sql}`, visible.params),
    () =>
      dimension === "model"
        ? byModel(db, visible)
        : dimension === "outcome"
          ? byOutcome(db, visible)
          : groupedRows(db, dimension, visible),
  );
  return rows.map((row) => ({ ...row }));
}

function groupedRows(
  db: Database,
  dimension: Exclude<Dimension, "model" | "outcome">,
  visible: { sql: string; params: string[] },
): DimRow[] {
  const { groupExpr, join } = dimensionSql(dimension);
  const statement = db.prepare(
    `WITH filtered_session AS (
         SELECT s.id, s.tool, s.model, s.project_id, s.started_at, s.is_subagent,
                s.total_input_tokens, s.total_output_tokens, s.total_reasoning_tokens,
                s.est_reasoning_tokens, s.estimated_cost_usd,
                ${sessionUsageAvailableSql("s")} AS usage_available
         FROM session s ${whereClause(visible)}
       )
       SELECT ${groupExpr} AS key,
              COALESCE(SUM(CASE WHEN s.is_subagent = 0 THEN 1 ELSE 0 END), 0) AS sessions,
              COALESCE(SUM(CASE WHEN s.is_subagent = 0 AND s.usage_available = 1 THEN 1 ELSE 0 END), 0)
                AS usage_sessions,
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

/** Sessions count under the model that served most of their requests, but
 * tokens and cost follow the model behind each request, so a session that
 * switched models adds to every model it used. Each session's stored cost is
 * split in proportion to what its models cost at current rates, so the rows
 * still sum to the archive total. */
function byModel(db: Database, visible: { sql: string; params: string[] }): DimRow[] {
  const sessions = db
    .query(
      `SELECT s.id, s.model, s.is_subagent, s.total_input_tokens, s.total_output_tokens,
              s.total_reasoning_tokens, s.est_reasoning_tokens, s.estimated_cost_usd,
              ${sessionUsageAvailableSql("s")} AS usage_available
         FROM session s ${whereClause(visible)}`,
    )
    .all(...visible.params) as {
    id: number;
    model: string | null;
    is_subagent: number;
    usage_available: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_reasoning_tokens: number;
    est_reasoning_tokens: number;
    estimated_cost_usd: number;
  }[];
  const usage = modelUsageForScope(
    db,
    `WITH scoped_session AS (SELECT s.id FROM session s ${whereClause(visible)})`,
    visible.params,
  );
  const pricing = defaultPricing();
  const rows = new Map<string, DimRow>();
  const row = (model: string | null): DimRow => {
    const key = model == null || model === "" ? "(unknown)" : model;
    const existing = rows.get(key);
    if (existing != null) {
      return existing;
    }
    const created: DimRow = {
      key,
      sessions: 0,
      usage_sessions: 0,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      est_reasoning_tokens: 0,
      estimated_cost_usd: 0,
    };
    rows.set(key, created);
    return created;
  };
  for (const session of sessions) {
    const label = row(session.model);
    label.sessions += session.is_subagent === 0 ? 1 : 0;
    label.usage_sessions += session.is_subagent === 0 && session.usage_available === 1 ? 1 : 0;
    // Reasoning is recorded per session, not per request.
    label.reasoning_tokens += session.total_reasoning_tokens;
    label.est_reasoning_tokens += session.est_reasoning_tokens;
    // A row with no model (Copilot's model-less usage checkpoints) is priced
    // at the session's model when the session cost is stored, so it is
    // priced and counted under that model here too.
    const served = (usage.get(session.id) ?? []).map((part) =>
      part.model === "" && part.reportedCostUsd == null && session.model
        ? { ...part, model: session.model }
        : part,
    );
    const costs = served.map((part) =>
      totalCost(sessionCostParts([part], { model: part.model, usage: part.usage }, pricing)),
    );
    const priced = costs.reduce((sum, cost) => sum + cost, 0);
    for (const [index, part] of served.entries()) {
      const target = row(part.model);
      target.input_tokens += part.usage.input;
      target.output_tokens += part.usage.output;
      if (priced > 0) {
        target.estimated_cost_usd += session.estimated_cost_usd * ((costs[index] ?? 0) / priced);
      }
    }
    if (served.length === 0) {
      label.input_tokens += session.total_input_tokens;
      label.output_tokens += session.total_output_tokens;
    }
    if (priced <= 0) {
      label.estimated_cost_usd += session.estimated_cost_usd;
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      right.sessions - left.sessions || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
}

/** Each run counts under the outcome of the top-level session it belongs to,
 * so a subagent's tokens and cost land on the session that spawned it rather
 * than on the subagent's own label (usually none). Ancestors are read from the
 * whole archive because a date filter can keep a subagent and drop its parent. */
function byOutcome(db: Database, visible: { sql: string; params: string[] }): DimRow[] {
  const sessions = db
    .query(
      `SELECT s.id, s.is_subagent, s.parent_session_id, s.outcome,
              s.total_input_tokens, s.total_output_tokens, s.total_reasoning_tokens,
              s.est_reasoning_tokens, s.estimated_cost_usd,
              ${sessionUsageAvailableSql("s")} AS usage_available
         FROM session s ${whereClause(visible)}`,
    )
    .all(...visible.params) as {
    id: number;
    is_subagent: number;
    parent_session_id: number | null;
    outcome: string | null;
    total_input_tokens: number;
    total_output_tokens: number;
    total_reasoning_tokens: number;
    est_reasoning_tokens: number;
    estimated_cost_usd: number;
    usage_available: number;
  }[];
  const lineage = sessions.some((session) => session.is_subagent === 1)
    ? new Map(
        (
          db.query("SELECT id, parent_session_id, is_subagent, outcome FROM session").all() as {
            id: number;
            parent_session_id: number | null;
            is_subagent: number;
            outcome: string | null;
          }[]
        ).map((row) => [row.id, row]),
      )
    : null;
  // A run takes its top-level session's label, even when that label is empty.
  // Only a subagent whose chain never reaches a top-level session (its parent
  // is not in the archive) keeps its own label.
  const rootOutcome = (session: (typeof sessions)[number]): string | null => {
    if (session.is_subagent === 0 || lineage == null) {
      return session.outcome;
    }
    let current = lineage.get(session.id);
    const seen = new Set<number>();
    while (current != null && current.is_subagent === 1 && current.parent_session_id != null) {
      if (seen.has(current.id)) {
        break;
      }
      seen.add(current.id);
      const parent = lineage.get(current.parent_session_id);
      if (parent == null) {
        break;
      }
      current = parent;
    }
    return current != null && current.is_subagent === 0 ? current.outcome : session.outcome;
  };
  const rows = new Map<string, DimRow>();
  for (const session of sessions) {
    const key = rootOutcome(session) ?? UNCLASSIFIED_OUTCOME_KEY;
    let row = rows.get(key);
    if (row == null) {
      row = {
        key,
        sessions: 0,
        usage_sessions: 0,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        est_reasoning_tokens: 0,
        estimated_cost_usd: 0,
      };
      rows.set(key, row);
    }
    row.sessions += session.is_subagent === 0 ? 1 : 0;
    row.usage_sessions += session.is_subagent === 0 && session.usage_available === 1 ? 1 : 0;
    row.input_tokens += session.total_input_tokens;
    row.output_tokens += session.total_output_tokens;
    row.reasoning_tokens += session.total_reasoning_tokens;
    row.est_reasoning_tokens += session.est_reasoning_tokens;
    row.estimated_cost_usd += session.estimated_cost_usd;
  }
  return [...rows.values()].sort(
    (left, right) => right.sessions - left.sessions || compareCodePoints(left.key, right.key),
  );
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
  if (filter?.repo != null) {
    clauses.push(
      `EXISTS (
         SELECT 1
         FROM project stats_repo
         WHERE stats_repo.id = ${alias}.project_id
           AND COALESCE(stats_repo.root_path, stats_repo.path) = ?
       )`,
    );
    params.push(filter.repo);
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

/**
 * Select-list columns adding nearest-rank duration ordering, for a relation
 * of rows with a non-null duration_ms. Pair with NEAREST_RANK_PERCENTILES_SQL.
 */
export function durationRankSql(partitionBy?: string): string {
  const partition = partitionBy == null ? "" : `PARTITION BY ${partitionBy}`;
  return `ROW_NUMBER() OVER (${partition} ORDER BY duration_ms) AS duration_rank,
                COUNT(*) OVER (${partition} ORDER BY duration_ms
                  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS duration_count`;
}

/** Aggregate columns picking p50 and p95 out of a durationRankSql relation. */
export const NEAREST_RANK_PERCENTILES_SQL = `MAX(CASE
                  WHEN duration_rank = CAST((duration_count + 1) / 2 AS INTEGER)
                  THEN duration_ms
                END) AS p50_ms,
                MAX(CASE
                  WHEN duration_rank = CAST((duration_count * 95 + 99) / 100 AS INTEGER)
                  THEN duration_ms
                END) AS p95_ms`;

/**
 * Nearest-rank p50 and p95 of durations sorted ascending, using the same ranks
 * as NEAREST_RANK_PERCENTILES_SQL. On 160k calls the SQL window pass took about
 * 150 ms, while sorting the same durations in memory takes about 20 ms.
 */
export function nearestRankPercentiles(sorted: ArrayLike<number>): {
  p50_ms: number | null;
  p95_ms: number | null;
} {
  const count = sorted.length;
  if (count === 0) {
    return { p50_ms: null, p95_ms: null };
  }
  return {
    p50_ms: sorted[Math.floor((count + 1) / 2) - 1] ?? null,
    p95_ms: sorted[Math.floor((count * 95 + 99) / 100) - 1] ?? null,
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
  const from = `FROM tool_call t INDEXED BY idx_toolcall_usage
       ${scope}`;
  // Grouping by session first follows idx_toolcall_usage order, so SQLite
  // sorts only the per-session rows by tool, not every call.
  const aggregateSql = `WITH per_session AS (
         SELECT t.tool_name, t.tool_kind, t.mcp_server,
                COUNT(*) AS calls,
                SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END) AS errors,
                MAX(t.timestamp) AS last_used_at
         ${from}
         GROUP BY t.session_id, t.tool_name, t.tool_kind, t.mcp_server
       ),
       aggregate AS (
         SELECT COALESCE(tool_name, '') AS tool_name,
                COALESCE(tool_kind, '') AS tool_kind,
                mcp_server,
                SUM(calls) AS calls,
                SUM(errors) AS errors,
                MAX(last_used_at) AS last_used_at
         FROM per_session
         GROUP BY COALESCE(tool_name, ''), COALESCE(tool_kind, ''), mcp_server
       )
       SELECT a.tool_name, a.tool_kind, a.mcp_server, a.calls, a.errors, a.last_used_at
       FROM aggregate a
       ${errorFilter}
       ORDER BY a.calls DESC, a.tool_name ASC, a.tool_kind ASC,
                (a.mcp_server IS NOT NULL) ASC, COALESCE(a.mcp_server, '') ASC
       LIMIT ?`;
  const durationSql = `SELECT COALESCE(t.tool_name, '') AS tool_name,
              COALESCE(t.tool_kind, '') AS tool_kind,
              t.mcp_server, t.duration_ms
       ${from}
       WHERE t.duration_ms IS NOT NULL`;
  const params = [...visible.params, limit];
  // Both scans run in one read transaction so they see the same snapshot.
  const rows = cachedRead(db, statementKey(aggregateSql, params), () =>
    db.transaction(() => {
      const aggregates = withStatement(
        db,
        aggregateSql,
        (statement) => statement.all(...params) as ToolAggregateDb[],
      );
      const durations = new Map<string, number[]>();
      for (const row of aggregates) {
        durations.set(toolGroupKey(row.tool_name, row.tool_kind, row.mcp_server), []);
      }
      withStatement(db, durationSql, (statement) => {
        for (const row of statement.iterate(
          ...visible.params,
        ) as IterableIterator<ToolDurationDb>) {
          durations
            .get(toolGroupKey(row.tool_name, row.tool_kind, row.mcp_server))
            ?.push(row.duration_ms);
        }
      });
      return aggregates.map(
        ({ tool_name, tool_kind, mcp_server, calls, errors, last_used_at }): ToolStatRow => ({
          tool_name,
          tool_kind,
          mcp_server,
          calls,
          errors,
          ...nearestRankPercentiles(
            Float64Array.from(
              durations.get(toolGroupKey(tool_name, tool_kind, mcp_server)) ?? [],
            ).sort(),
          ),
          last_used_at,
        }),
      );
    })(),
  );
  return rows.map((row) => ({ ...row }));
}

type ToolAggregateDb = Omit<ToolStatRow, "p50_ms" | "p95_ms">;

interface ToolDurationDb {
  tool_name: string;
  tool_kind: string;
  mcp_server: string | null;
  duration_ms: number;
}

function toolGroupKey(toolName: string, toolKind: string, mcpServer: string | null): string {
  return JSON.stringify([toolName, toolKind, mcpServer]);
}

function withStatement<T>(
  db: Database,
  sql: string,
  use: (statement: ReturnType<Database["prepare"]>) => T,
): T {
  const statement = db.prepare(sql);
  try {
    return use(statement);
  } finally {
    statement.finalize();
  }
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

type McpAggregateDb = Omit<McpStatRow, "p50_ms" | "p95_ms">;

/** Same approach as toolUsage: counts in one SQL pass, durations in another,
 * percentiles from a sorted array instead of a window row per call. */
export function mcpUsage(db: Database, limitValue = 50, filter?: DateFilter | null): McpStatRow[] {
  const limit = normalizeLimit(limitValue, 50);
  const visible = statsScope(db, "s", filter);
  const from = `FROM tool_call t INDEXED BY idx_toolcall_usage
       JOIN (SELECT id FROM session s ${whereClause(visible)}) fs ON fs.id = t.session_id
       WHERE t.tool_kind = 'mcp' AND t.mcp_server IS NOT NULL`;
  const aggregateSql = `SELECT t.mcp_server,
              COUNT(DISTINCT t.tool_name) AS tools,
              COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END), 0) AS errors,
              MAX(t.timestamp) AS last_used_at
       ${from}
       GROUP BY t.mcp_server
       ORDER BY calls DESC, t.mcp_server ASC
       LIMIT ?`;
  const durationSql = `SELECT t.mcp_server, t.duration_ms ${from} AND t.duration_ms IS NOT NULL`;
  const params = [...visible.params, limit];
  const rows = cachedRead(db, statementKey(aggregateSql, params), () =>
    db.transaction(() => {
      const aggregates = withStatement(
        db,
        aggregateSql,
        (statement) => statement.all(...params) as McpAggregateDb[],
      );
      const durations = new Map<string, number[]>(aggregates.map((row) => [row.mcp_server, []]));
      withStatement(db, durationSql, (statement) => {
        for (const row of statement.iterate(...visible.params) as IterableIterator<{
          mcp_server: string;
          duration_ms: number;
        }>) {
          durations.get(row.mcp_server)?.push(row.duration_ms);
        }
      });
      return aggregates.map(
        ({ mcp_server, tools, calls, errors, last_used_at }): McpStatRow => ({
          mcp_server,
          tools,
          calls,
          errors,
          ...nearestRankPercentiles(Float64Array.from(durations.get(mcp_server) ?? []).sort()),
          last_used_at,
        }),
      );
    })(),
  );
  return rows.map((row) => ({ ...row }));
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
               LIMIT ?`;
  const rows = cachedRead(
    db,
    statementKey(sql, [...params, limit]),
    () => db.query(sql).all(...params, limit) as FileStatDb[],
  );
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
  const visible = statsScope(db, "s", filter);
  // Buckets use the server's local time, which moves at a daylight-saving
  // change without any write, so the offset is part of the key.
  const key = statementKey(`activity:${new Date().getTimezoneOffset()}:${visible.sql}`, [
    ...visible.params,
  ]);
  const result = cachedRead(db, key, () => {
    const byHour = bucket(db, "strftime('%H', s.started_at, 'localtime')", 24, filter);
    const byWeekday = bucket(db, "strftime('%w', s.started_at, 'localtime')", 7, filter);
    return {
      by_hour: byHour,
      by_weekday: byWeekday,
      timezone: localTimezone(),
      peak_hour: peak(byHour),
      peak_weekday: peak(byWeekday),
    };
  });
  return { ...result, by_hour: [...result.by_hour], by_weekday: [...result.by_weekday] };
}

export interface ModelSparklines {
  models: Record<string, number[]>;
  days: string[];
}

export function modelSparklines(db: Database, filter?: StatsFilter | null): ModelSparklines {
  const visible = statsScope(db, "s", filter);
  const result = cachedRead(
    db,
    statementKey(`modelSparklines:${visible.sql}`, visible.params),
    () => sparklineRows(db, visible),
  );
  return {
    days: [...result.days],
    models: Object.fromEntries(
      Object.entries(result.models).map(([model, counts]) => [model, [...counts]]),
    ),
  };
}

function sparklineRows(db: Database, visible: { sql: string; params: string[] }): ModelSparklines {
  const rows = db
    .query(
      `SELECT COALESCE(s.model, '(unknown)') AS model,
              substr(s.started_at, 1, 10) AS day,
              SUM(CASE WHEN s.is_subagent = 0 THEN 1 ELSE 0 END) AS count
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
  // min and max are UTC days. The newest start instant lets a client name the
  // latest day in its own time zone, which a UTC day alone cannot do.
  latest_started_at: string | null;
}

export function dateBounds(db: Database): DateBounds {
  const visible = statsScope(db, "s");
  const sql = `SELECT MIN(substr(s.started_at, 1, 10)) AS min,
              MAX(substr(s.started_at, 1, 10)) AS max,
              -- julianday orders by instant, so an offset timestamp cannot win
              -- on text alone. It reads +05:30 but not +0530, which Claude
              -- records may carry, so the colon is added first. Values that
              -- still do not parse are NULL and drop out.
              strftime(
                '%Y-%m-%dT%H:%M:%fZ',
                MAX(julianday(
                  CASE WHEN s.started_at GLOB '*T*[+-][0-9][0-9][0-9][0-9]'
                    THEN substr(s.started_at, 1, length(s.started_at) - 2)
                         || ':' || substr(s.started_at, -2)
                    ELSE s.started_at
                  END
                ))
              ) AS latest_started_at
       FROM session s
       ${whereClause({
         sql: ["s.started_at IS NOT NULL", visible.sql].join(" AND "),
         params: visible.params,
       })}`;
  return { ...cachedRead(db, statementKey(sql, []), () => db.query(sql).get() as DateBounds) };
}

// started_at is UTC, so "today" is the local calendar day as a UTC range.
export function todayTotals(db: Database, now: Date = new Date()): Totals {
  const visible = statsScope(db, "s");
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const scope = {
    sql: [visible.sql, "s.started_at >= ? AND s.started_at < ?"].join(" AND "),
    params: [...visible.params, utcSecond(start), utcSecond(end)],
  };
  return db
    .query(
      `WITH filtered_session AS (
         SELECT ${TOTALS_COLUMNS}
         FROM session s
         ${whereClause(scope)}
       )
       SELECT
         COALESCE(SUM(CASE WHEN is_subagent = 0 THEN 1 ELSE 0 END), 0) AS sessions,
         COALESCE(SUM(CASE WHEN is_subagent = 0 AND usage_available = 1 THEN 1 ELSE 0 END), 0)
           AS usage_sessions,
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
    .get(...scope.params) as Totals;
}

function dimensionSql(dimension: Exclude<Dimension, "model" | "outcome">): {
  groupExpr: string;
  join: string;
} {
  switch (dimension) {
    case "tool":
      return { groupExpr: "s.tool", join: "" };
    case "project":
      return {
        groupExpr: `COALESCE(p.path, '${NO_PROJECT_KEY}')`,
        join: "LEFT JOIN project p ON p.id = s.project_id",
      };
    // Worktrees fold into the repository they were created from. A project that
    // is not a worktree records itself as its own root.
    case "repo":
      return {
        groupExpr: `COALESCE(p.root_path, p.path, '${NO_PROJECT_KEY}')`,
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
      `SELECT ${expr} AS key, SUM(CASE WHEN s.is_subagent = 0 THEN 1 ELSE 0 END) AS count
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

// Second precision compares correctly against stored timestamps with or
// without fractional seconds.
function utcSecond(date: Date): string {
  return date.toISOString().slice(0, 19);
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
