import type { Database } from "bun:sqlite";
import { apportion } from "./apportion.ts";
import {
  ACTIVITY_BUCKETS,
  type ActivityBucket,
  blockBucket,
  isCodeEditTool,
  isUserQuestionTool,
  toolBucket,
} from "./buckets.ts";
import { defaultPricing } from "./cost.ts";
import { type DateFilter, sessionDatePredicate, whereClause } from "./date-filter.ts";
import { withImmediateTransaction } from "./db.ts";
import { byteLength } from "./json.ts";
import { MESSAGE_METADATA_SQL } from "./message-storage.ts";
import type { TokenUsage } from "./model.ts";
import { modelUsageForScope, sessionCostParts, totalCost } from "./model-usage.ts";
import { sessionUserStatePredicateForDatabase } from "./session-user-state.ts";
import { type SessionSource, sessionSourcePredicate } from "./source-filter.ts";
import { queryRow, queryRows, runStatement } from "./sqlite-statements.ts";

const CHARS_PER_TOKEN = 4;
export const SESSION_ECONOMICS_FORMAT_VERSION = 12;

const ACTIVE_GAP_CAP_MS = 300_000;

export type Phase = "orientation" | "implementation";

export interface PhaseAmounts {
  generation_tokens: number;
  context_window_tokens: number;
  estimated_cost_usd: number;
  active_ms: number;
}

export interface TokenEconomicsBucket {
  bucket: ActivityBucket;
  generation_tokens: number;
  context_window_tokens: number;
  estimated_cost_usd: number;
  tool_calls: number;
  sessions: number;
  cost_share: number;
  active_ms: number;
  phases?: Record<Phase, PhaseAmounts>;
}

export interface TokenEconomics {
  buckets: TokenEconomicsBucket[];
  totals: {
    generation_tokens: number;
    context_window_tokens: number;
    estimated_cost_usd: number;
    input_cost_usd: number;
    output_cost_usd: number;
    reported_cost_usd: number;
    active_ms: number;
    waiting_on_user_ms: number;
    attributed_ms: number;
    phases?: Record<Phase, PhaseAmounts>;
  };
}

interface SessionRow {
  id: number;
  tool: string;
  started_at: string | null;
  model: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_creation_1h_tokens: number;
  total_reasoning_tokens: number;
  est_reasoning_tokens: number;
}

interface BlockRow {
  session_id: number;
  message_id: number;
  seq: number;
  role: string | null;
  output_tokens: number | null;
  // The API message id behind an assistant record. Claude Code journals one
  // response as a record per content block, all sharing this id.
  response_id: string | null;
  reasoning_tokens: number | null;
  type: string | null;
  tool_name: string | null;
  tool_input: string | null;
  text_bytes: number;
  timestamp: string | null;
  other_kind: string | null;
}

interface ResultRow {
  session_id: number;
  tool_name: string | null;
  input: string | null;
  bytes: number;
  call_seq: number | null;
}

interface MutableBucket {
  generation: number;
  contextWindow: number;
  cost: number;
  toolCalls: number;
  sessions: Set<number>;
  genOrientation: number;
  windowOrientation: number;
  costOrientation: number;
  activeMs: number;
  activeMsOrientation: number;
}

interface MutableLatency {
  waitingOnUserMs: number;
}

type QueryParam = string | number;

export interface SessionEconomicsVector {
  id: number;
  started_at: string | null;
  input_cost: number;
  output_cost: number;
  reported_cost: number;
  billed_input_tokens: number;
  waiting_on_user_ms: number;
  buckets: Record<
    ActivityBucket,
    {
      generation: number;
      context_window: number;
      tool_calls: number;
      touched: boolean;
      generation_orientation: number;
      context_window_orientation: number;
      active_ms: number;
      active_ms_orientation: number;
    }
  >;
}

export interface TokenEconomicsFilter extends DateFilter {
  source?: SessionSource | null;
}

export function tokenEconomics(db: Database, filter?: TokenEconomicsFilter | null): TokenEconomics {
  const date = sessionDatePredicate("s", filter);
  const source = sessionSourcePredicate("s", filter?.source);
  const visible = {
    sql: [date.sql, source.sql, sessionUserStatePredicateForDatabase(db, "s")]
      .filter((clause) => clause !== "")
      .join(" AND "),
    params: [...date.params, ...source.params],
  };
  return aggregateEconomicsVectors(
    vectorsForScopeWithCache(
      db,
      `WITH scoped_session AS (
         SELECT s.id FROM session s ${whereClause(visible)}
       )`,
      visible.params,
    ),
  );
}

export function computeSessionEconomicsVectors(
  db: Database,
  options: { cancelled?: () => boolean } = {},
): SessionEconomicsVector[] {
  const visibleSession = sessionUserStatePredicateForDatabase(db, "s");
  return cachedVectorsForScope(
    db,
    `WITH scoped_session AS (
       SELECT s.id
       FROM session s
       WHERE ${visibleSession}
     )`,
    [],
    options.cancelled,
  );
}

export function economicsVectorMatchesFilter(
  vector: SessionEconomicsVector,
  filter?: DateFilter | null,
): boolean {
  const from = filter?.from ?? null;
  const to = filter?.to ?? null;
  if (from == null && to == null) {
    return true;
  }
  if (vector.started_at == null) {
    return false;
  }
  const day = vector.started_at.slice(0, 10);
  return (from == null || day >= from) && (to == null || day <= to);
}

export function aggregateEconomicsVectors(
  vectors: Iterable<SessionEconomicsVector>,
): TokenEconomics {
  const buckets = emptyBuckets();
  let inputCost = 0;
  let outputCost = 0;
  let reportedCost = 0;
  let waitingOnUserMs = 0;
  for (const vector of vectors) {
    inputCost += vector.input_cost;
    outputCost += vector.output_cost;
    reportedCost += vector.reported_cost;
    waitingOnUserMs += vector.waiting_on_user_ms;
    let generation = 0;
    let window = 0;
    let windowOrientation = 0;
    for (const bucket of ACTIVITY_BUCKETS) {
      const part = vector.buckets[bucket];
      generation += part.generation;
      window += part.context_window + part.generation;
      windowOrientation += part.context_window_orientation + part.generation_orientation;
    }
    for (const bucket of ACTIVITY_BUCKETS) {
      const entry = buckets.get(bucket);
      const part = vector.buckets[bucket];
      if (entry == null || part == null) {
        continue;
      }
      const partWindow = part.context_window + part.generation;
      const partWindowOrientation = part.context_window_orientation + part.generation_orientation;
      entry.generation += part.generation;
      entry.contextWindow += partWindow;
      entry.genOrientation += part.generation_orientation;
      entry.windowOrientation += partWindowOrientation;
      entry.activeMs += part.active_ms;
      entry.activeMsOrientation += part.active_ms_orientation;
      entry.toolCalls += part.tool_calls;
      entry.cost +=
        vector.output_cost * share(part.generation, generation) +
        (vector.input_cost + vector.reported_cost) * share(partWindow, window);
      entry.costOrientation +=
        vector.output_cost * share(part.generation_orientation, generation) +
        (vector.input_cost + vector.reported_cost) * share(partWindowOrientation, window);
      if (part.touched) {
        entry.sessions.add(vector.id);
      }
    }
    const orientationShare = window > 0 ? windowOrientation / window : 1;
    if (generation <= 0) {
      chargeUnattributed(buckets, "communicating", vector.id, vector.output_cost, orientationShare);
    }
    if (window <= 0) {
      chargeUnattributed(
        buckets,
        "context",
        vector.id,
        vector.input_cost + vector.reported_cost,
        orientationShare,
      );
    }
  }
  return finish(buckets, inputCost, outputCost, reportedCost, waitingOnUserMs);
}

function chargeUnattributed(
  buckets: Map<ActivityBucket, MutableBucket>,
  bucket: ActivityBucket,
  sessionId: number,
  cost: number,
  orientationShare: number,
): void {
  const entry = buckets.get(bucket);
  if (entry == null || cost <= 0) {
    return;
  }
  entry.cost += cost;
  entry.costOrientation += cost * orientationShare;
  entry.sessions.add(sessionId);
}

export function tokenEconomicsForSession(db: Database, sessionId: number): TokenEconomics | null {
  const scopeCte = `WITH RECURSIVE scoped_session(id) AS (
    SELECT id FROM session WHERE id = ?1
    UNION ALL
    SELECT child.id
    FROM session child
    JOIN scoped_session parent ON parent.id = child.parent_session_id
  )`;
  const expected = scopeCount(db, scopeCte, [sessionId]);
  if (expected === 0) {
    return null;
  }
  const cached = cachedVectorsForScope(db, scopeCte, [sessionId]);
  const vectors = cached.length === expected ? cached : vectorsForScope(db, scopeCte, [sessionId]);
  return aggregateEconomicsVectors(withBilledInputWindow(vectors));
}

function withBilledInputWindow(vectors: SessionEconomicsVector[]): SessionEconomicsVector[] {
  return vectors.map((vector) => {
    const totalWeight = ACTIVITY_BUCKETS.reduce((sum, bucket) => {
      const part = vector.buckets[bucket];
      return sum + part.generation + part.context_window;
    }, 0);
    const buckets = {} as SessionEconomicsVector["buckets"];
    for (const bucket of ACTIVITY_BUCKETS) {
      const part = vector.buckets[bucket];
      const weight = part.generation + part.context_window;
      const allocatedInput =
        totalWeight > 0
          ? vector.billed_input_tokens * (weight / totalWeight)
          : bucket === "context"
            ? vector.billed_input_tokens
            : 0;
      const orientationWeight = part.generation_orientation + part.context_window_orientation;
      const orientationShare =
        weight > 0 ? orientationWeight / weight : bucket === "context" ? 1 : 0;
      buckets[bucket] = {
        ...part,
        context_window: part.context_window + allocatedInput,
        context_window_orientation:
          part.context_window_orientation + allocatedInput * orientationShare,
        touched: part.touched || allocatedInput > 0,
      };
    }
    return { ...vector, buckets };
  });
}

export function materializeSessionEconomics(db: Database, sessionId: number): boolean {
  const vectors = vectorsForScope(
    db,
    "WITH scoped_session AS (SELECT id FROM session WHERE id = ?1)",
    [sessionId],
  );
  const vector = vectors[0];
  if (vector == null) {
    return false;
  }
  storeEconomicsVector(db, vector);
  return true;
}

interface CostRefresh {
  id: number;
  total: number;
  totalChanged: boolean;
  staleVector: SessionEconomicsVector | null;
}

function pendingCostRefreshes(db: Database): CostRefresh[] {
  const pricing = defaultPricing();
  const rows = queryRows<
    SessionRow & {
      estimated_cost_usd: number;
      format_version: number | null;
      vector_json: string | null;
    }
  >(
    db,
    `SELECT s.id, s.model, s.estimated_cost_usd,
             s.total_input_tokens, s.total_output_tokens, s.total_cache_read_tokens,
             s.total_cache_creation_tokens, s.total_cache_creation_1h_tokens,
             s.total_reasoning_tokens, e.format_version, e.vector_json
           FROM session s LEFT JOIN session_economics e ON e.session_id = s.id`,
  );
  const usage = modelUsageForScope(db, "WITH scoped_session AS (SELECT id FROM session)", []);
  const pending: CostRefresh[] = [];
  for (const row of rows) {
    const parts = sessionCostParts(usage.get(row.id), sessionFallback(row), pricing);
    const inputCost = parts.input + parts.cacheRead + parts.cacheCreation;
    const total = totalCost(parts);
    const vector =
      row.format_version === SESSION_ECONOMICS_FORMAT_VERSION && row.vector_json != null
        ? parseEconomicsVector(row.vector_json)
        : null;
    const staleVector =
      vector != null &&
      vector.id === row.id &&
      (vector.input_cost !== inputCost ||
        vector.output_cost !== parts.output ||
        vector.reported_cost !== parts.reported)
        ? {
            ...vector,
            input_cost: inputCost,
            output_cost: parts.output,
            reported_cost: parts.reported,
          }
        : null;
    const totalChanged = row.estimated_cost_usd !== total;
    if (totalChanged || staleVector != null) {
      pending.push({ id: row.id, total, totalChanged, staleVector });
    }
  }
  return pending;
}

export function refreshSessionCosts(db: Database): number {
  if (pendingCostRefreshes(db).length === 0) {
    return 0;
  }
  return withImmediateTransaction(db, () => {
    const pending = pendingCostRefreshes(db);
    for (const refresh of pending) {
      if (refresh.totalChanged) {
        runStatement(db, "UPDATE session SET estimated_cost_usd = ?1 WHERE id = ?2", [
          refresh.total,
          refresh.id,
        ]);
      }
      if (refresh.staleVector != null) {
        storeEconomicsVector(db, refresh.staleVector);
      }
    }
    return pending.length;
  });
}

export function materializeMissingSessionEconomics(db: Database): number {
  const rows = queryRows<{
    id: number;
    format_version: number | null;
    vector_json: string | null;
  }>(
    db,
    `SELECT s.id, e.format_version, e.vector_json
       FROM session s
       LEFT JOIN session_economics e ON e.session_id = s.id
      ORDER BY s.id`,
  );
  const staleIds = rows.flatMap((row) => {
    if (row.format_version !== SESSION_ECONOMICS_FORMAT_VERSION || row.vector_json == null) {
      return [row.id];
    }
    const vector = parseEconomicsVector(row.vector_json);
    return vector == null || vector.id !== row.id ? [row.id] : [];
  });
  if (staleIds.length === 0) {
    return 0;
  }

  withImmediateTransaction(db, () => {
    for (let offset = 0; offset < staleIds.length; offset += 250) {
      const sessionIds = staleIds.slice(offset, offset + 250);
      const placeholders = sessionIds.map((_, index) => `?${index + 1}`).join(", ");
      const vectors = vectorsForScope(
        db,
        `WITH scoped_session AS (
           SELECT id FROM session WHERE id IN (${placeholders})
         )`,
        sessionIds,
      );
      for (const vector of vectors) {
        storeEconomicsVector(db, vector);
      }
    }
  });
  return staleIds.length;
}

function vectorsForScopeWithCache(
  db: Database,
  scopeCte: string,
  params: QueryParam[],
): SessionEconomicsVector[] {
  const expected = scopeCount(db, scopeCte, params);
  if (expected === 0) {
    return [];
  }
  const cached = cachedVectorsForScope(db, scopeCte, params);
  return cached.length === expected ? cached : vectorsForScope(db, scopeCte, params);
}

function scopeCount(db: Database, scopeCte: string, params: QueryParam[]): number {
  return (
    queryRow<{ count: number }>(
      db,
      `${scopeCte} SELECT COUNT(*) AS count FROM scoped_session`,
      params,
    )?.count ?? 0
  );
}

function cachedVectorsForScope(
  db: Database,
  scopeCte: string,
  params: QueryParam[],
  cancelled?: () => boolean,
): SessionEconomicsVector[] {
  throwIfEconomicsCancelled(cancelled);
  const versionParam = `?${params.length + 1}`;
  const rows = queryRows<{
    session_id: number;
    vector_json: string;
    started_at: string | null;
  }>(
    db,
    `${scopeCte}
       SELECT e.session_id, e.vector_json, s.started_at
       FROM scoped_session fs
       JOIN session s ON s.id = fs.id
       JOIN session_economics e ON e.session_id = fs.id
       WHERE e.format_version = ${versionParam}
       ORDER BY e.session_id`,
    [...params, SESSION_ECONOMICS_FORMAT_VERSION],
  );
  throwIfEconomicsCancelled(cancelled);
  const vectors: SessionEconomicsVector[] = [];
  for (const row of rows) {
    throwIfEconomicsCancelled(cancelled);
    const vector = parseEconomicsVector(row.vector_json);
    if (vector != null && vector.id === row.session_id) {
      vector.started_at = row.started_at;
      vectors.push(vector);
    }
  }
  return vectors;
}

function throwIfEconomicsCancelled(cancelled?: () => boolean): void {
  if (cancelled?.() === true) {
    throw new Error("aborted");
  }
}

function parseEconomicsVector(raw: string): SessionEconomicsVector | null {
  try {
    const vector = JSON.parse(raw) as SessionEconomicsVector;
    if (
      typeof vector.id !== "number" ||
      typeof vector.input_cost !== "number" ||
      typeof vector.output_cost !== "number" ||
      typeof vector.reported_cost !== "number" ||
      typeof vector.billed_input_tokens !== "number" ||
      typeof vector.waiting_on_user_ms !== "number" ||
      vector.buckets == null ||
      typeof vector.buckets !== "object"
    ) {
      return null;
    }
    for (const bucket of ACTIVITY_BUCKETS) {
      const part = vector.buckets[bucket];
      if (
        part == null ||
        typeof part.generation !== "number" ||
        typeof part.context_window !== "number" ||
        typeof part.tool_calls !== "number" ||
        typeof part.touched !== "boolean" ||
        typeof part.generation_orientation !== "number" ||
        typeof part.context_window_orientation !== "number" ||
        typeof part.active_ms !== "number" ||
        typeof part.active_ms_orientation !== "number"
      ) {
        return null;
      }
    }
    return vector;
  } catch {
    return null;
  }
}

function storeEconomicsVector(db: Database, vector: SessionEconomicsVector): void {
  runStatement(
    db,
    `INSERT INTO session_economics(session_id, format_version, vector_json, computed_at)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       format_version = excluded.format_version,
       vector_json = excluded.vector_json,
       computed_at = excluded.computed_at`,
    [vector.id, SESSION_ECONOMICS_FORMAT_VERSION, JSON.stringify(vector)],
  );
}

function blockRowsForScope(db: Database, scopeCte: string, params: QueryParam[]): BlockRow[] {
  return queryRows<BlockRow>(
    db,
    `${scopeCte}
       SELECT b.session_id, b.message_id, m.seq AS seq, m.role, m.output_tokens,
              CASE WHEN m.role = 'assistant' AND json_valid(${MESSAGE_METADATA_SQL})
                   THEN json_extract(${MESSAGE_METADATA_SQL}, '$.message.id') END AS response_id,
              CASE WHEN s.tool = 'opencode' AND m.role = 'assistant' AND json_valid(${MESSAGE_METADATA_SQL})
                   THEN json_extract(${MESSAGE_METADATA_SQL}, '$.reasoning_tokens') END AS reasoning_tokens,
              b.type,
              COALESCE(b.tool_name, tc.tool_name) AS tool_name,
              m.timestamp AS timestamp,
              CASE WHEN b.type IN ('tool_use', 'tool_result', 'web_search')
                   THEN COALESCE(b.tool_input, tc.input) END AS tool_input,
              CASE WHEN b.type = 'tool_result'
                   THEN COALESCE(length(CAST(b.tool_result AS BLOB)), 0)
                   -- An agent message's routing metadata outweighs its text,
                   -- and only the text reaches the model.
                   WHEN b.type = 'other' AND json_valid(b.text)
                        AND json_extract(b.text, '$.type') = 'agent_message'
                   THEN (SELECT COALESCE(SUM(length(CAST(json_extract(c.value, '$.text') AS BLOB))), 0)
                         FROM json_each(b.text, '$.content') c)
                   ELSE COALESCE(length(CAST(b.text AS BLOB)), 0)
              END AS text_bytes,
              CASE WHEN b.type = 'other' AND json_valid(b.text)
                   THEN json_extract(b.text, '$.type') END AS other_kind
       FROM scoped_session fs
       CROSS JOIN block b INDEXED BY idx_block_session
       JOIN message m ON m.id = b.message_id
       JOIN session s ON s.id = b.session_id
       LEFT JOIN tool_call tc ON tc.result_block_id = b.id
       WHERE b.session_id = fs.id
       ORDER BY b.session_id, m.seq, b.ordinal`,
    params,
  );
}

function vectorsForScope(
  db: Database,
  scopeCte: string,
  params: QueryParam[],
): SessionEconomicsVector[] {
  const sessions = queryRows<SessionRow>(
    db,
    `${scopeCte}
       SELECT s.id, s.tool, s.started_at, s.model, s.total_input_tokens, s.total_output_tokens,
              s.total_cache_read_tokens, s.total_cache_creation_tokens,
              s.total_cache_creation_1h_tokens,
              s.total_reasoning_tokens, s.est_reasoning_tokens
       FROM session s
       JOIN scoped_session fs ON fs.id = s.id`,
    params,
  );
  if (sessions.length === 0) {
    return [];
  }

  const vectorBySession = new Map<
    number,
    { session: SessionRow; buckets: PerSessionBuckets; latency: MutableLatency }
  >();
  for (const session of sessions) {
    vectorBySession.set(session.id, {
      session,
      buckets: emptyBuckets(),
      latency: emptyLatency(),
    });
  }

  const blocks = blockRowsForScope(db, scopeCte, params).filter(
    (block) => blockActivity(block) !== "skip",
  );
  const boundaries = firstEditSeqBySession(blocks);
  const blocksBySession = groupBy(blocks, (block) => block.session_id);
  for (const [sessionId, sessionBlocks] of blocksBySession) {
    const vector = vectorBySession.get(sessionId);
    if (vector != null) {
      allocateGeneration([vector.session], sessionBlocks, vector.buckets, boundaries);
      allocateLatency(vector.session, sessionBlocks, vector.buckets, boundaries, vector.latency);
      allocateAgentMessages(sessionId, sessionBlocks, vector.buckets, boundaries);
    }
  }
  for (const vector of vectorBySession.values()) {
    if (!blocksBySession.has(vector.session.id)) {
      allocateGeneration([vector.session], [], vector.buckets, boundaries);
    }
  }

  const results = queryRows<ResultRow>(
    db,
    `${scopeCte}
       SELECT t.session_id, t.tool_name, t.input,
              COALESCE(t.output_bytes, length(CAST(rb.tool_result AS BLOB)), 0) AS bytes,
              cm.seq AS call_seq
       FROM scoped_session fs
       CROSS JOIN tool_call t INDEXED BY idx_toolcall_session
       LEFT JOIN block rb ON rb.id = t.result_block_id
       LEFT JOIN block cb ON cb.id = t.call_block_id
       LEFT JOIN message cm ON cm.id = cb.message_id
       WHERE t.session_id = fs.id`,
    params,
  );
  for (const row of results) {
    const vector = vectorBySession.get(row.session_id);
    const entry = vector?.buckets.get(toolBucket(row.tool_name, row.input));
    if (entry == null) {
      continue;
    }
    const tokens = row.bytes / CHARS_PER_TOKEN;
    entry.contextWindow += tokens;
    entry.toolCalls += 1;
    entry.sessions.add(row.session_id);
    if (phaseOf(boundaries, row.session_id, row.call_seq) === "orientation") {
      entry.windowOrientation += tokens;
    }
  }

  const usage = modelUsageForScope(db, scopeCte, params);
  return sessions.map((session) => {
    const mutable = vectorBySession.get(session.id);
    const parts = sessionCostParts(usage.get(session.id), sessionFallback(session));
    const buckets = {} as SessionEconomicsVector["buckets"];
    for (const bucket of ACTIVITY_BUCKETS) {
      const entry = mutable?.buckets.get(bucket);
      buckets[bucket] = {
        generation: entry?.generation ?? 0,
        context_window: entry?.contextWindow ?? 0,
        tool_calls: entry?.toolCalls ?? 0,
        touched: (entry?.sessions.size ?? 0) > 0 || (entry?.activeMs ?? 0) > 0,
        generation_orientation: entry?.genOrientation ?? 0,
        context_window_orientation: entry?.windowOrientation ?? 0,
        active_ms: entry?.activeMs ?? 0,
        active_ms_orientation: entry?.activeMsOrientation ?? 0,
      };
    }
    return {
      id: session.id,
      started_at: session.started_at,
      input_cost: parts.input + parts.cacheRead + parts.cacheCreation,
      output_cost: parts.output,
      reported_cost: parts.reported,
      billed_input_tokens:
        session.total_input_tokens +
        session.total_cache_read_tokens +
        session.total_cache_creation_tokens,
      waiting_on_user_ms: mutable?.latency.waitingOnUserMs ?? 0,
      buckets,
    };
  });
}

function sessionFallback(session: SessionRow): { model: string | null; usage: TokenUsage } {
  return {
    model: session.model,
    usage: {
      input: session.total_input_tokens,
      output: session.total_output_tokens,
      cacheRead: session.total_cache_read_tokens,
      cacheCreation: session.total_cache_creation_tokens,
      cacheCreation1h: session.total_cache_creation_1h_tokens,
      reasoning: session.total_reasoning_tokens,
    },
  };
}

type PerSessionBuckets = Map<ActivityBucket, MutableBucket>;

function firstEditSeqBySession(blocks: BlockRow[]): Map<number, number> {
  const boundary = new Map<number, number>();
  for (const block of blocks) {
    if (block.type !== "tool_use" || !isCodeEditTool(block.tool_name, block.tool_input)) {
      continue;
    }
    const current = boundary.get(block.session_id);
    if (current == null || block.seq < current) {
      boundary.set(block.session_id, block.seq);
    }
  }
  return boundary;
}

function phaseOf(
  boundaries: Map<number, number>,
  sessionId: number,
  seq: number | null | undefined,
): Phase {
  if (seq == null) {
    return "implementation";
  }
  const boundary = boundaries.get(sessionId) ?? Number.POSITIVE_INFINITY;
  return seq < boundary ? "orientation" : "implementation";
}

function responseKey(block: BlockRow): string {
  return block.response_id == null ? `#${block.message_id}` : `id:${block.response_id}`;
}

function allocateGeneration(
  sessions: SessionRow[],
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
): void {
  const blocksBySession = groupBy(blocks, (block) => block.session_id);
  for (const session of sessions) {
    const sessionBlocks = blocksBySession.get(session.id) ?? [];
    // Claude Code writes one response as a record per content block and bills
    // its output to just one of them, so a response's output is split across
    // all of its records' blocks. Otherwise a thinking record would take the
    // whole turn as planning, or a text record would take its tool calls.
    const messageBlocks = groupBy(sessionBlocks, responseKey);
    const messageOutput = new Map<string, number>();
    for (const block of sessionBlocks) {
      if (block.output_tokens != null && block.output_tokens > 0) {
        const key = responseKey(block);
        messageOutput.set(key, Math.max(messageOutput.get(key) ?? 0, block.output_tokens));
      }
    }
    if (messageOutput.size > 0 && session.tool !== "codex") {
      for (const [messageId, outputTokens] of messageOutput) {
        const rows = messageBlocks.get(messageId) ?? [];
        const phase = phaseOf(boundaries, session.id, rows[0]?.seq);
        allocateOutput(
          session.id,
          outputTokens,
          reportedReasoning(session, rows),
          rows,
          buckets,
          phase,
        );
      }
      continue;
    }
    const planning = Math.min(
      session.total_output_tokens,
      session.total_reasoning_tokens || session.est_reasoning_tokens,
    );
    const assistantBlocks = sessionBlocks.filter(
      (block) => block.role === "assistant" && block.type !== "thinking",
    );
    const orientationWeight = assistantBlocks
      .filter((block) => phaseOf(boundaries, session.id, block.seq) === "orientation")
      .reduce((sum, block) => sum + Math.max(1, blockSize(block)), 0);
    const totalWeight =
      assistantBlocks.reduce((sum, block) => sum + Math.max(1, blockSize(block)), 0) || 1;
    addBucket(
      buckets,
      "planning",
      planning * (orientationWeight / totalWeight),
      session.id,
      "orientation",
    );
    addBucket(
      buckets,
      "planning",
      planning * (1 - orientationWeight / totalWeight),
      session.id,
      "implementation",
    );
    distribute(
      session.id,
      Math.max(0, session.total_output_tokens - planning),
      assistantBlocks,
      buckets,
      boundaries,
    );
  }
}

function allocateLatency(
  session: SessionRow,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
  latency: MutableLatency,
): void {
  let previous: number | null = null;
  for (const message of orderedMessages(blocks)) {
    const at = epochMillis(message.timestamp);
    if (at == null) {
      continue;
    }
    if (previous != null) {
      const gap = Math.min(Math.max(0, at - previous), ACTIVE_GAP_CAP_MS);
      const first = message.blocks[0];
      const reasoning = reportedReasoning(session, message.blocks);
      const output = first?.output_tokens ?? 0;
      distributeLatency(
        gap,
        message.blocks,
        buckets,
        phaseOf(boundaries, session.id, message.seq),
        latency,
        reasoning != null && output > 0 ? Math.min(1, reasoning / output) : null,
      );
    }
    // Codex backdates parallel MCP calls, so measure from the latest time seen
    // or overlapping spans count twice.
    previous = previous == null ? at : Math.max(previous, at);
  }
}

interface OrderedMessage {
  seq: number;
  timestamp: string | null;
  blocks: BlockRow[];
}

function orderedMessages(blocks: BlockRow[]): OrderedMessage[] {
  const byId = new Map<number, OrderedMessage>();
  const order: number[] = [];
  for (const block of blocks) {
    let message = byId.get(block.message_id);
    if (message == null) {
      message = { seq: block.seq, timestamp: block.timestamp, blocks: [] };
      byId.set(block.message_id, message);
      order.push(block.message_id);
    }
    message.blocks.push(block);
  }
  return order.map((id) => byId.get(id) as OrderedMessage);
}

function distributeLatency(
  ms: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  phase: Phase,
  latency: MutableLatency,
  planningShare: number | null = null,
): void {
  if (ms <= 0 || blocks.length === 0) {
    return;
  }
  if (planningShare != null) {
    addLatency(buckets, "planning", ms * planningShare, phase);
    const visible = blocks.filter((block) => block.type !== "thinking");
    if (visible.length === 0) {
      addLatency(buckets, "communicating", ms * (1 - planningShare), phase);
      return;
    }
    distributeLatency(ms * (1 - planningShare), visible, buckets, phase, latency);
    return;
  }
  const weighted = blocks.map((block) => ({ block, weight: Math.max(1, blockSize(block)) }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) {
    const shareMs = ms * (item.weight / totalWeight);
    const activity = blockActivity(item.block);
    if (activity === "waiting") {
      latency.waitingOnUserMs += shareMs;
    } else if (activity !== "skip") {
      addLatency(buckets, activity, shareMs, phase);
    }
  }
}

const MODEL_INPUT_KINDS = new Set(["agent_message", "compaction"]);

function blockActivity(block: BlockRow): ActivityBucket | "waiting" | "skip" {
  if (
    block.type === "tool_result" &&
    isUserQuestionTool(block.tool_name, block.tool_input ?? undefined)
  ) {
    return "waiting";
  }
  if (block.role === "user" && block.type !== "tool_result") {
    return "waiting";
  }
  if (block.role === "other") {
    return MODEL_INPUT_KINDS.has(block.other_kind ?? "") ? "context" : "skip";
  }
  if (block.role === "system") {
    return "skip";
  }
  if (block.type === "other") {
    if (block.other_kind === "fallback") {
      return "skip";
    }
    if (block.role === "tool") {
      return "context";
    }
  }
  return blockBucket(block.type, block.tool_name, block.tool_input);
}

function allocateAgentMessages(
  sessionId: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
): void {
  const entry = buckets.get("context");
  if (entry == null) {
    return;
  }
  for (const block of blocks) {
    if (block.role !== "other" || block.other_kind !== "agent_message") {
      continue;
    }
    const tokens = block.text_bytes / CHARS_PER_TOKEN;
    entry.contextWindow += tokens;
    entry.sessions.add(sessionId);
    if (phaseOf(boundaries, sessionId, block.seq) === "orientation") {
      entry.windowOrientation += tokens;
    }
  }
}

function addLatency(
  buckets: Map<ActivityBucket, MutableBucket>,
  bucket: ActivityBucket,
  ms: number,
  phase: Phase,
): void {
  const entry = buckets.get(bucket);
  if (entry == null || ms <= 0) {
    return;
  }
  entry.activeMs += ms;
  if (phase === "orientation") {
    entry.activeMsOrientation += ms;
  }
}

function epochMillis(timestamp: string | null): number | null {
  if (timestamp == null || !timestamp.endsWith("Z")) {
    return null;
  }
  const withoutZone = timestamp.slice(0, -1);
  const [date, time] = withoutZone.split("T");
  if (date == null || time == null) {
    return null;
  }
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const [clock, fraction] = time.split(".");
  const [hour, minute, second] = (clock ?? "").split(":").map((part) => Number.parseInt(part, 10));
  if (
    [year, month, day, hour, minute, second].some((part) => part == null || !Number.isFinite(part))
  ) {
    return null;
  }
  const millis = fraction == null ? 0 : Math.round(Number.parseFloat(`0.${fraction}`) * 1000);
  return Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hour as number,
    minute as number,
    second as number,
    millis,
  );
}

function reportedReasoning(session: SessionRow, blocks: BlockRow[]): number | null {
  const block = blocks[0];
  if (session.tool !== "opencode" || block?.role !== "assistant") {
    return null;
  }
  const reasoning = block.reasoning_tokens;
  if (typeof reasoning !== "number" || !Number.isFinite(reasoning) || reasoning < 0) {
    return null;
  }
  if (
    reasoning === 0 &&
    blocks.some((candidate) => candidate.type === "thinking" && candidate.text_bytes > 0)
  ) {
    return null;
  }
  return reasoning;
}

function allocateOutput(
  sessionId: number,
  outputTokens: number,
  reasoning: number | null,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  phase: Phase,
): void {
  const visibleBlocks = blocks.filter((block) => block.type !== "thinking");
  let planning: number;
  if (reasoning != null) {
    planning = Math.min(outputTokens, reasoning);
  } else {
    const hasThinking = blocks.length > visibleBlocks.length;
    const visible = visibleBlocks.reduce((sum, block) => sum + blockSize(block), 0);
    planning = hasThinking ? Math.max(0, outputTokens - visible / CHARS_PER_TOKEN) : 0;
  }
  addBucket(buckets, "planning", planning, sessionId, phase);
  const rest = Math.max(0, outputTokens - planning);
  if (reasoning != null && visibleBlocks.length === 0) {
    addBucket(buckets, "communicating", rest, sessionId, phase);
    return;
  }
  distributeVisible(sessionId, rest, visibleBlocks, buckets, phase);
}

function distributeVisible(
  sessionId: number,
  tokens: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  phase: Phase,
): void {
  if (tokens <= 0 || blocks.length === 0) {
    return;
  }
  const weighted = blocks.map((block) => ({ block, weight: Math.max(1, blockSize(block)) }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) {
    addBucket(
      buckets,
      blockBucket(item.block.type, item.block.tool_name, item.block.tool_input),
      tokens * (item.weight / totalWeight),
      sessionId,
      phase,
    );
  }
}

function distribute(
  sessionId: number,
  tokens: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
): void {
  if (tokens <= 0) {
    return;
  }
  if (blocks.length === 0) {
    addBucket(
      buckets,
      "communicating",
      tokens,
      sessionId,
      boundaries.has(sessionId) ? "implementation" : "orientation",
    );
    return;
  }
  const weighted = blocks.map((block) => ({
    block,
    weight: Math.max(1, blockSize(block)),
  }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) {
    addBucket(
      buckets,
      blockBucket(item.block.type, item.block.tool_name, item.block.tool_input),
      tokens * (item.weight / totalWeight),
      sessionId,
      phaseOf(boundaries, sessionId, item.block.seq),
    );
  }
}

function blockSize(block: BlockRow): number {
  if (block.type === "tool_use") {
    return byteLength(`${block.tool_name ?? ""}\n${block.tool_input ?? ""}`);
  }
  return block.text_bytes;
}

function addBucket(
  buckets: Map<ActivityBucket, MutableBucket>,
  bucket: ActivityBucket,
  tokens: number,
  sessionId: number,
  phase?: Phase,
): void {
  const entry = buckets.get(bucket);
  if (entry == null || tokens <= 0) {
    return;
  }
  entry.generation += tokens;
  if (phase === "orientation") {
    entry.genOrientation += tokens;
  }
  entry.sessions.add(sessionId);
}

function emptyBuckets(): Map<ActivityBucket, MutableBucket> {
  return new Map(
    ACTIVITY_BUCKETS.map((bucket) => [
      bucket,
      {
        generation: 0,
        contextWindow: 0,
        cost: 0,
        toolCalls: 0,
        sessions: new Set<number>(),
        genOrientation: 0,
        windowOrientation: 0,
        costOrientation: 0,
        activeMs: 0,
        activeMsOrientation: 0,
      },
    ]),
  );
}

function emptyLatency(): MutableLatency {
  return { waitingOnUserMs: 0 };
}

type CountKey = "generation_tokens" | "context_window_tokens" | "active_ms";

type MutableAmount =
  | "generation"
  | "contextWindow"
  | "activeMs"
  | "genOrientation"
  | "windowOrientation"
  | "activeMsOrientation";

const COUNTS: { key: CountKey; total: MutableAmount; orientation: MutableAmount }[] = [
  { key: "generation_tokens", total: "generation", orientation: "genOrientation" },
  { key: "context_window_tokens", total: "contextWindow", orientation: "windowOrientation" },
  { key: "active_ms", total: "activeMs", orientation: "activeMsOrientation" },
];

function finish(
  buckets: Map<ActivityBucket, MutableBucket>,
  inputCost: number,
  outputCost: number,
  reportedCost: number,
  waitingOnUserMs = 0,
): TokenEconomics {
  const totalCost = sumBuckets(buckets, "cost");
  const entries = ACTIVITY_BUCKETS.map((bucket) => buckets.get(bucket));
  const counts = {} as Record<CountKey, { total: number; rows: number[]; phases: number[][] }>;
  for (const { key, total, orientation } of COUNTS) {
    const raw = entries.map((entry) => Math.max(0, entry?.[total] ?? 0));
    const sum = Math.round(raw.reduce((acc, value) => acc + value, 0));
    const rows = apportion(raw, sum);
    const phases = entries.map((entry, index) => {
      const whole = raw[index] ?? 0;
      const early = Math.min(whole, Math.max(0, entry?.[orientation] ?? 0));
      return apportion([early, whole - early], rows[index] ?? 0);
    });
    counts[key] = { total: sum, rows, phases };
  }
  const rows: TokenEconomicsBucket[] = ACTIVITY_BUCKETS.map((bucket, index) => {
    const entry = entries[index];
    const count = (key: CountKey) => counts[key].rows[index] ?? 0;
    const phase = (key: CountKey, side: 0 | 1) => counts[key].phases[index]?.[side] ?? 0;
    const cost = entry?.cost ?? 0;
    const costOrientation = entry?.costOrientation ?? 0;
    return {
      bucket,
      generation_tokens: count("generation_tokens"),
      context_window_tokens: count("context_window_tokens"),
      estimated_cost_usd: cost,
      tool_calls: entry?.toolCalls ?? 0,
      sessions: entry?.sessions.size ?? 0,
      cost_share: share(cost, totalCost),
      active_ms: count("active_ms"),
      phases: {
        orientation: {
          generation_tokens: phase("generation_tokens", 0),
          context_window_tokens: phase("context_window_tokens", 0),
          estimated_cost_usd: costOrientation,
          active_ms: phase("active_ms", 0),
        },
        implementation: {
          generation_tokens: phase("generation_tokens", 1),
          context_window_tokens: phase("context_window_tokens", 1),
          estimated_cost_usd: cost - costOrientation,
          active_ms: phase("active_ms", 1),
        },
      },
    };
  });
  const activeMs = counts.active_ms.total;
  const waitingMs = Math.round(waitingOnUserMs);
  const totals: TokenEconomics["totals"] = {
    generation_tokens: counts.generation_tokens.total,
    context_window_tokens: counts.context_window_tokens.total,
    estimated_cost_usd: totalCost,
    input_cost_usd: inputCost,
    output_cost_usd: outputCost,
    reported_cost_usd: reportedCost,
    active_ms: activeMs,
    waiting_on_user_ms: waitingMs,
    attributed_ms: activeMs + waitingMs,
  };
  totals.phases = {
    orientation: sumPhase(rows, "orientation"),
    implementation: sumPhase(rows, "implementation"),
  };
  return { buckets: rows, totals };
}

function sumPhase(rows: TokenEconomicsBucket[], phase: Phase): PhaseAmounts {
  const acc: PhaseAmounts = {
    generation_tokens: 0,
    context_window_tokens: 0,
    estimated_cost_usd: 0,
    active_ms: 0,
  };
  for (const row of rows) {
    const p = row.phases?.[phase];
    if (p == null) {
      continue;
    }
    acc.generation_tokens += p.generation_tokens;
    acc.context_window_tokens += p.context_window_tokens;
    acc.estimated_cost_usd += p.estimated_cost_usd;
    acc.active_ms += p.active_ms;
  }
  return acc;
}

function sumBuckets(
  buckets: Map<ActivityBucket, MutableBucket>,
  key: "generation" | "contextWindow" | "cost",
): number {
  let total = 0;
  for (const bucket of buckets.values()) {
    total += bucket[key];
  }
  return total;
}

function share(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function groupBy<T, K>(items: T[], keyFor: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}
