import type { Database } from "bun:sqlite";
import {
  ACTIVITY_BUCKETS,
  type ActivityBucket,
  blockBucket,
  isCodeEditTool,
  toolBucket,
} from "./buckets.ts";
import { defaultPricing, estimateCostParts } from "./cost.ts";
import { type DateFilter, sessionDatePredicate, whereClause } from "./date-filter.ts";

const CHARS_PER_TOKEN = 4;
const encoder = new TextEncoder();
// Bump when vector semantics change so the next sync rebuilds derived rows.
// Version 2 includes corrected wall-clock attribution plus the billed-input
// and waiting-on-user fields required by the current activity model.
export const SESSION_ECONOMICS_FORMAT_VERSION = 2;

// Cap every inter-message gap so long model, tool, or human pauses do not
// dominate the timing breakdown. Mirrors the ACTIVE_GAP_CAP_SECONDS used for
// session active_seconds in enrich.ts.
const ACTIVE_GAP_CAP_MS = 300_000;

/** A run splits into two phases at the first file edit: "orientation" (reading
 * and planning HOW to change the code) and "implementation" (writing it). The
 * phase breakdown is orthogonal to the activity buckets -- every bucket carries
 * how much of it happened before vs after the first edit. */
export type Phase = "orientation" | "implementation";

export interface PhaseAmounts {
  generation_tokens: number;
  context_window_tokens: number;
  estimated_cost_usd: number;
  // Wall-clock time attributed to this phase, from capped inter-message gaps.
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
  // Wall-clock time spent on this activity, in milliseconds. Measured as the
  // sum of capped gaps between consecutive messages, charged to the activity
  // mix of the message that closed each gap (see allocateLatency). Answers
  // "how much *time* went to orientation/planning/etc.", not just tokens.
  // User-authored response gaps are reported separately in totals.
  active_ms: number;
  // Ordered block allocation places each contribution before/after the first
  // edit for both archive-wide and per-session results.
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
    // Time attributed to the four agent activity buckets.
    active_ms: number;
    // Capped gaps closed by user-authored text, kept separate from agent time.
    waiting_on_user_ms: number;
    // All timing captured from block-bearing messages: agent time plus waiting.
    attributed_ms: number;
    phases?: Record<Phase, PhaseAmounts>;
  };
}

interface SessionRow {
  id: number;
  started_at: string | null;
  model: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_reasoning_tokens: number;
  est_reasoning_tokens: number;
}

interface BlockRow {
  session_id: number;
  message_id: number;
  seq: number;
  role: string | null;
  output_tokens: number | null;
  type: string | null;
  tool_name: string | null;
  tool_input: string | null;
  text_bytes: number;
  timestamp: string | null;
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
  // Orientation-phase portions (pre-first-edit). Implementation = total - these.
  // genOrientation feeds windowOrientation the same way generation feeds
  // contextWindow, so the phase cost split mirrors the whole-bucket formula.
  // costOrientation is derived at aggregation only (the builder leaves it 0).
  genOrientation: number;
  windowOrientation: number;
  costOrientation: number;
  // Wall-clock ms attributed to this bucket, and the orientation-phase portion
  // (pre-first-edit). Implementation = activeMs - activeMsOrientation.
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
  // Total billed input volume, including cache reads and cache creation.
  billed_input_tokens: number;
  waiting_on_user_ms: number;
  buckets: Record<
    ActivityBucket,
    {
      generation: number;
      context_window: number;
      tool_calls: number;
      touched: boolean;
      // Pre-first-edit portions. context_window_orientation holds the
      // tool-result orientation window only (before generation is folded in),
      // matching how context_window excludes folded-in generation.
      generation_orientation: number;
      context_window_orientation: number;
      // Wall-clock ms on this activity, and its orientation-phase portion.
      active_ms: number;
      active_ms_orientation: number;
    }
  >;
}

export function tokenEconomics(db: Database, filter?: DateFilter | null): TokenEconomics {
  const date = sessionDatePredicate("s", filter);
  return aggregateEconomicsVectors(
    vectorsForScopeWithCache(
      db,
      `WITH scoped_session AS (
         SELECT s.id FROM session s ${whereClause(date)}
       )`,
      date.params,
    ),
  );
}

/** Load persisted per-session activity vectors for the in-memory server cache.
 * This intentionally never falls back to transcript scans: startup sync
 * backfills missing rows and then invalidates the cache. */
export function computeSessionEconomicsVectors(db: Database): SessionEconomicsVector[] {
  return cachedVectorsForScope(db, "WITH scoped_session AS (SELECT id FROM session)", []);
}

/** Mirrors sessionDatePredicate: string-compare on the YYYY-MM-DD prefix. */
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
  let waitingOnUserMs = 0;
  for (const vector of vectors) {
    inputCost += vector.input_cost;
    outputCost += vector.output_cost;
    waitingOnUserMs += vector.waiting_on_user_ms;
    for (const bucket of ACTIVITY_BUCKETS) {
      const entry = buckets.get(bucket);
      const part = vector.buckets[bucket];
      if (entry == null || part == null) {
        continue;
      }
      entry.generation += part.generation;
      entry.contextWindow += part.context_window;
      entry.genOrientation += part.generation_orientation;
      entry.windowOrientation += part.context_window_orientation;
      entry.activeMs += part.active_ms;
      entry.activeMsOrientation += part.active_ms_orientation;
      entry.toolCalls += part.tool_calls;
      if (part.touched) {
        entry.sessions.add(vector.id);
      }
    }
  }

  const totalGeneration = sumBuckets(buckets, "generation");
  const totalWindow = sumBuckets(buckets, "contextWindow");
  for (const entry of buckets.values()) {
    // Generation is part of the window; mirror it into the orientation portion
    // so the phase cost split uses the same window basis as the whole bucket.
    entry.contextWindow += entry.generation;
    entry.windowOrientation += entry.genOrientation;
  }
  const totalWindowWithGeneration = sumBuckets(buckets, "contextWindow");
  const windowBasis = totalWindowWithGeneration || totalWindow;
  for (const entry of buckets.values()) {
    entry.cost =
      outputCost * share(entry.generation, totalGeneration) +
      inputCost * share(entry.contextWindow, windowBasis);
    entry.costOrientation =
      outputCost * share(entry.genOrientation, totalGeneration) +
      inputCost * share(entry.windowOrientation, windowBasis);
  }
  return finish(buckets, inputCost, outputCost, waitingOnUserMs);
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

/** Session panels retain their billed-input Window total while using the same
 * block-level activity weights as archive analytics. Allocate each run's input
 * volume over the content that actually contributed to its context. */
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

/** Persist the complete per-session vector while its normalized rows are hot
 * in the ingest transaction. Descendant rollups stay dynamic: parent reads
 * aggregate the independently cached vectors for the current subtree. */
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

/** One-time upgrade/backfill path. Normal ingest writes vectors immediately;
 * sync also calls this so unchanged pre-v10 sessions become cached after upgrading. */
export function materializeMissingSessionEconomics(db: Database): number {
  const vectors = vectorsForScope(
    db,
    `WITH scoped_session AS (
       SELECT s.id
       FROM session s
       LEFT JOIN session_economics e ON e.session_id = s.id
       WHERE e.session_id IS NULL
          OR e.format_version != ?1
          OR NOT json_valid(e.vector_json)
          OR CASE WHEN json_valid(e.vector_json) THEN
               COALESCE(json_type(e.vector_json, '$.id'), '') != 'integer'
               OR COALESCE(json_type(e.vector_json, '$.billed_input_tokens'), '') NOT IN ('integer', 'real')
               OR COALESCE(json_type(e.vector_json, '$.waiting_on_user_ms'), '') NOT IN ('integer', 'real')
               OR COALESCE(json_type(e.vector_json, '$.buckets'), '') != 'object'
             ELSE 0 END
     )`,
    [SESSION_ECONOMICS_FORMAT_VERSION],
  );
  if (vectors.length === 0) {
    return 0;
  }
  const persist = db.transaction((items: SessionEconomicsVector[]) => {
    for (const vector of items) {
      storeEconomicsVector(db, vector);
    }
  });
  persist(vectors);
  return vectors.length;
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
    db.query(`${scopeCte} SELECT COUNT(*) AS count FROM scoped_session`).get(...params) as {
      count: number;
    }
  ).count;
}

function cachedVectorsForScope(
  db: Database,
  scopeCte: string,
  params: QueryParam[],
): SessionEconomicsVector[] {
  const versionParam = `?${params.length + 1}`;
  const rows = db
    .query(
      `${scopeCte}
       SELECT e.session_id, e.vector_json, s.started_at
       FROM scoped_session fs
       JOIN session s ON s.id = fs.id
       JOIN session_economics e ON e.session_id = fs.id
       WHERE e.format_version = ${versionParam}
       ORDER BY e.session_id`,
    )
    .all(...params, SESSION_ECONOMICS_FORMAT_VERSION) as {
    session_id: number;
    vector_json: string;
    started_at: string | null;
  }[];
  const vectors: SessionEconomicsVector[] = [];
  for (const row of rows) {
    const vector = parseEconomicsVector(row.vector_json);
    if (vector != null && vector.id === row.session_id) {
      vector.started_at = row.started_at;
      vectors.push(vector);
    }
  }
  return vectors;
}

function parseEconomicsVector(raw: string): SessionEconomicsVector | null {
  try {
    const vector = JSON.parse(raw) as SessionEconomicsVector;
    if (
      typeof vector.id !== "number" ||
      typeof vector.input_cost !== "number" ||
      typeof vector.output_cost !== "number" ||
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
  db.query(
    `INSERT INTO session_economics(session_id, format_version, vector_json, computed_at)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       format_version = excluded.format_version,
       vector_json = excluded.vector_json,
       computed_at = excluded.computed_at`,
  ).run(vector.id, SESSION_ECONOMICS_FORMAT_VERSION, JSON.stringify(vector));
}

/** Load ordered block rows for generation and latency allocation. Tool-result
 * blocks do not duplicate their calling tool metadata, so resolve it through
 * the ingest-time tool_call linkage. The scope-first join is intentional: it
 * prevents SQLite from scanning the whole block table for a single session. */
function blockRowsForScope(db: Database, scopeCte: string, params: QueryParam[]): BlockRow[] {
  return db
    .query(
      `${scopeCte}
       SELECT b.session_id, b.message_id, m.seq AS seq, m.role, m.output_tokens, b.type,
              COALESCE(b.tool_name, tc.tool_name) AS tool_name,
              m.timestamp AS timestamp,
              CASE WHEN b.type IN ('tool_use', 'tool_result', 'web_search')
                   THEN COALESCE(b.tool_input, tc.input) END AS tool_input,
              CASE WHEN b.type = 'tool_result'
                   THEN COALESCE(length(CAST(b.tool_result AS BLOB)), 0)
                   ELSE COALESCE(length(CAST(b.text AS BLOB)), 0)
              END AS text_bytes
       FROM scoped_session fs
       CROSS JOIN block b INDEXED BY idx_block_session
       JOIN message m ON m.id = b.message_id
       LEFT JOIN tool_call tc ON tc.result_block_id = b.id
       WHERE b.session_id = fs.id
       ORDER BY b.session_id, m.seq, b.ordinal`,
    )
    .all(...params) as BlockRow[];
}

function vectorsForScope(
  db: Database,
  scopeCte: string,
  params: QueryParam[],
): SessionEconomicsVector[] {
  const sessions = db
    .query(
      `${scopeCte}
       SELECT s.id, s.started_at, s.model, s.total_input_tokens, s.total_output_tokens,
              s.total_cache_read_tokens, s.total_cache_creation_tokens,
              s.total_reasoning_tokens, s.est_reasoning_tokens
       FROM session s
       JOIN scoped_session fs ON fs.id = s.id`,
    )
    .all(...params) as SessionRow[];
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

  // Ship byte lengths, not text: bucket math only needs sizes, plus the tool
  // input for the block types whose bucket depends on the command being run.
  // Ordering (session, seq, ordinal) lets us place each block before/after the
  // session's first file edit.
  const blocks = blockRowsForScope(db, scopeCte, params);
  const boundaries = firstEditSeqBySession(blocks);
  const blocksBySession = groupBy(blocks, (block) => block.session_id);
  for (const [sessionId, sessionBlocks] of blocksBySession) {
    const vector = vectorBySession.get(sessionId);
    if (vector != null) {
      allocateGeneration([vector.session], sessionBlocks, vector.buckets, boundaries);
      allocateLatency(sessionId, sessionBlocks, vector.buckets, boundaries, vector.latency);
    }
  }
  for (const vector of vectorBySession.values()) {
    if (!blocksBySession.has(vector.session.id)) {
      allocateGeneration([vector.session], [], vector.buckets, boundaries);
    }
  }

  const results = db
    .query(
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
    )
    .all(...params) as ResultRow[];
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
    // A tool result belongs to orientation if its call happened before the
    // session's first edit. Unplaceable calls (no call block) default to
    // implementation so orientation is never overstated.
    if (phaseOf(boundaries, row.session_id, row.call_seq) === "orientation") {
      entry.windowOrientation += tokens;
    }
  }

  return sessions.map((session) => {
    const mutable = vectorBySession.get(session.id);
    const parts = estimateCostParts(
      session.model,
      {
        input: session.total_input_tokens,
        output: session.total_output_tokens,
        cacheRead: session.total_cache_read_tokens,
        cacheCreation: session.total_cache_creation_tokens,
        reasoning: session.total_reasoning_tokens,
      },
      defaultPricing(),
    );
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
      billed_input_tokens:
        session.total_input_tokens +
        session.total_cache_read_tokens +
        session.total_cache_creation_tokens,
      waiting_on_user_ms: mutable?.latency.waitingOnUserMs ?? 0,
      buckets,
    };
  });
}

type PerSessionBuckets = Map<ActivityBucket, MutableBucket>;

/** First-edit boundary per session: the message seq of the first file-editing
 * tool_use. Messages with seq < boundary are orientation; the edit's own
 * message and everything after are implementation. Sessions that never edit
 * have no boundary (Infinity) -> the whole run is orientation. */
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

function allocateGeneration(
  sessions: SessionRow[],
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
): void {
  const blocksBySession = groupBy(blocks, (block) => block.session_id);
  for (const session of sessions) {
    const sessionBlocks = blocksBySession.get(session.id) ?? [];
    const messageBlocks = groupBy(sessionBlocks, (block) => block.message_id);
    const messageOutput = new Map<number, number>();
    for (const block of sessionBlocks) {
      if (block.output_tokens != null && block.output_tokens > 0) {
        messageOutput.set(block.message_id, block.output_tokens);
      }
    }
    if (messageOutput.size > 0) {
      for (const [messageId, outputTokens] of messageOutput) {
        const rows = messageBlocks.get(messageId) ?? [];
        const phase = phaseOf(boundaries, session.id, rows[0]?.seq);
        allocateOutput(session.id, outputTokens, rows, buckets, phase);
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
    // No per-message usage: split the aggregate planning lump between phases by
    // the size-weight of assistant blocks on each side of the boundary.
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

/** Charge wall-clock time to activity buckets. The gap between a message and
 * the one before it is the time that produced the later message: the model
 * generating, a tool executing, or the human writing the next prompt. Each gap
 * is capped like session active_seconds, then split across the closing
 * message's blocks by the same byte weight generation uses. Blockless messages
 * are absent here, so attributed time only approximates active_seconds. */
function allocateLatency(
  sessionId: number,
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
      distributeLatency(
        gap,
        message.blocks,
        buckets,
        phaseOf(boundaries, sessionId, message.seq),
        latency,
      );
    }
    previous = at;
  }
}

interface OrderedMessage {
  seq: number;
  timestamp: string | null;
  blocks: BlockRow[];
}

/** Regroup seq-ordered blocks back into their messages, preserving order. */
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

/** Split one message's gap across its blocks by byte-weight into their buckets. */
function distributeLatency(
  ms: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  phase: Phase,
  latency: MutableLatency,
): void {
  if (ms <= 0 || blocks.length === 0) {
    return;
  }
  const weighted = blocks.map((block) => ({ block, weight: Math.max(1, blockSize(block)) }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) {
    const shareMs = ms * (item.weight / totalWeight);
    if (item.block.role === "user" && item.block.type === "text") {
      latency.waitingOnUserMs += shareMs;
      continue;
    }
    addLatency(
      buckets,
      blockBucket(item.block.type, item.block.tool_name, item.block.tool_input),
      shareMs,
      phase,
    );
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

/** Parse an ISO-8601 `...Z` timestamp to epoch milliseconds, keeping any
 * fractional-second precision. Returns null for anything not UTC-suffixed,
 * matching the conservative parsing enrich.ts uses for active_seconds. */
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

function allocateOutput(
  sessionId: number,
  outputTokens: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  phase: Phase,
): void {
  const hasThinking = blocks.some((block) => block.type === "thinking");
  const visible = blocks
    .filter((block) => block.type !== "thinking")
    .reduce((sum, block) => sum + blockSize(block), 0);
  const planning = hasThinking ? Math.max(0, outputTokens - visible / CHARS_PER_TOKEN) : 0;
  addBucket(buckets, "planning", planning, sessionId, phase);
  distributeVisible(
    sessionId,
    Math.max(0, outputTokens - planning),
    blocks.filter((block) => block.type !== "thinking"),
    buckets,
    phase,
  );
}

/** Distribute across blocks that all share one phase (used per-message). */
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

/** Distribute across blocks that may straddle the boundary (fallback branch);
 * each block's phase is decided by its own seq. */
function distribute(
  sessionId: number,
  tokens: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
  boundaries: Map<number, number>,
): void {
  if (tokens <= 0 || blocks.length === 0) {
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

function phasesFor(entry: MutableBucket | undefined): Record<Phase, PhaseAmounts> {
  const gen = entry?.generation ?? 0;
  const win = entry?.contextWindow ?? 0;
  const cost = entry?.cost ?? 0;
  const genO = entry?.genOrientation ?? 0;
  const winO = entry?.windowOrientation ?? 0;
  const costO = entry?.costOrientation ?? 0;
  const active = entry?.activeMs ?? 0;
  const activeO = entry?.activeMsOrientation ?? 0;
  return {
    orientation: {
      generation_tokens: Math.round(genO),
      context_window_tokens: Math.round(winO),
      estimated_cost_usd: costO,
      active_ms: Math.round(activeO),
    },
    implementation: {
      generation_tokens: Math.round(gen - genO),
      context_window_tokens: Math.round(win - winO),
      estimated_cost_usd: cost - costO,
      active_ms: Math.round(active - activeO),
    },
  };
}

function finish(
  buckets: Map<ActivityBucket, MutableBucket>,
  inputCost: number,
  outputCost: number,
  waitingOnUserMs = 0,
): TokenEconomics {
  const totalCost = sumBuckets(buckets, "cost");
  const rows: TokenEconomicsBucket[] = ACTIVITY_BUCKETS.map((bucket) => {
    const entry = buckets.get(bucket);
    const row: TokenEconomicsBucket = {
      bucket,
      generation_tokens: Math.round(entry?.generation ?? 0),
      context_window_tokens: Math.round(entry?.contextWindow ?? 0),
      estimated_cost_usd: entry?.cost ?? 0,
      tool_calls: entry?.toolCalls ?? 0,
      sessions: entry?.sessions.size ?? 0,
      cost_share: share(entry?.cost ?? 0, totalCost),
      active_ms: Math.round(entry?.activeMs ?? 0),
    };
    row.phases = phasesFor(entry);
    return row;
  });
  const activeMs = rows.reduce((sum, row) => sum + row.active_ms, 0);
  const waitingMs = Math.round(waitingOnUserMs);
  const totals: TokenEconomics["totals"] = {
    generation_tokens: rows.reduce((sum, row) => sum + row.generation_tokens, 0),
    context_window_tokens: rows.reduce((sum, row) => sum + row.context_window_tokens, 0),
    estimated_cost_usd: totalCost,
    input_cost_usd: inputCost,
    output_cost_usd: outputCost,
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

function byteLength(value: string): number {
  return encoder.encode(value).length;
}
