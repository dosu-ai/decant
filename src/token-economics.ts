import type { Database } from "bun:sqlite";
import { ACTIVITY_BUCKETS, type ActivityBucket, blockBucket, toolBucket } from "./buckets.ts";
import { defaultPricing, estimateCostParts } from "./cost.ts";
import { type DateFilter, sessionDatePredicate, whereClause } from "./date-filter.ts";

const CHARS_PER_TOKEN = 4;
const encoder = new TextEncoder();

export interface TokenEconomicsBucket {
  bucket: ActivityBucket;
  generation_tokens: number;
  context_window_tokens: number;
  estimated_cost_usd: number;
  tool_calls: number;
  sessions: number;
  cost_share: number;
}

export interface TokenEconomics {
  buckets: TokenEconomicsBucket[];
  totals: {
    generation_tokens: number;
    context_window_tokens: number;
    estimated_cost_usd: number;
    input_cost_usd: number;
    output_cost_usd: number;
  };
}

interface SessionRow {
  id: number;
  model: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_creation_1h_tokens: number;
  total_reasoning_tokens: number;
  est_reasoning_tokens: number;
}

interface FastToolRow {
  session_id: number;
  tool_name: string | null;
  calls: number;
  output_bytes: number | null;
}

interface BlockRow {
  session_id: number;
  message_id: number;
  role: string | null;
  output_tokens: number | null;
  type: string | null;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
}

interface ResultRow {
  session_id: number;
  tool_name: string | null;
  input: string | null;
  tool_result: string | null;
  output_bytes: number | null;
}

interface MutableBucket {
  generation: number;
  contextWindow: number;
  cost: number;
  toolCalls: number;
  sessions: Set<number>;
}

type QueryParam = string | number;

export function tokenEconomics(db: Database, filter?: DateFilter | null): TokenEconomics {
  const date = sessionDatePredicate("s", filter);
  return tokenEconomicsForScope(
    db,
    `WITH scoped_session AS (
       SELECT s.id FROM session s ${whereClause(date)}
     )`,
    date.params,
  );
}

export function tokenEconomicsForSession(db: Database, sessionId: number): TokenEconomics | null {
  return fastTokenEconomicsForSession(db, sessionId);
}

function tokenEconomicsForScope(
  db: Database,
  scopeCte: string,
  params: QueryParam[],
): TokenEconomics {
  const sessions = db
    .query(
      `${scopeCte}
       SELECT s.id, s.model, s.total_input_tokens, s.total_output_tokens,
              s.total_cache_read_tokens, s.total_cache_creation_tokens,
              s.total_cache_creation_1h_tokens,
              s.total_reasoning_tokens, s.est_reasoning_tokens
       FROM session s
       JOIN scoped_session fs ON fs.id = s.id`,
    )
    .all(...params) as SessionRow[];
  const sessionIds = sessions.map((session) => session.id);
  const buckets = emptyBuckets();

  if (sessionIds.length === 0) {
    return finish(buckets, 0, 0);
  }

  const blocks = db
    .query(
      `${scopeCte}
       SELECT b.session_id, m.id AS message_id, m.role, m.output_tokens, b.type,
              b.text, b.tool_name, b.tool_input
       FROM block b
       JOIN message m ON m.id = b.message_id
       JOIN scoped_session fs ON fs.id = b.session_id
       ORDER BY b.session_id, m.seq, b.ordinal`,
    )
    .all(...params) as BlockRow[];
  allocateGeneration(sessions, blocks, buckets);

  const results = db
    .query(
      `${scopeCte}
       SELECT t.session_id, t.tool_name, t.input, rb.tool_result, t.output_bytes
       FROM tool_call t
       JOIN scoped_session fs ON fs.id = t.session_id
       LEFT JOIN block rb ON rb.id = t.result_block_id`,
    )
    .all(...params) as ResultRow[];
  for (const row of results) {
    const bucket = toolBucket(row.tool_name, row.input);
    const size = row.output_bytes ?? byteLength(row.tool_result ?? "");
    const entry = buckets.get(bucket);
    if (entry == null) {
      continue;
    }
    entry.contextWindow += size / CHARS_PER_TOKEN;
    entry.toolCalls += 1;
    entry.sessions.add(row.session_id);
  }

  let inputCost = 0;
  let outputCost = 0;
  for (const session of sessions) {
    const parts = estimateCostParts(
      session.model,
      {
        input: session.total_input_tokens,
        output: session.total_output_tokens,
        cacheRead: session.total_cache_read_tokens,
        cacheCreation: session.total_cache_creation_tokens,
        cacheCreation1h: session.total_cache_creation_1h_tokens,
        reasoning: session.total_reasoning_tokens,
      },
      defaultPricing(),
    );
    inputCost += parts.input + parts.cacheRead + parts.cacheCreation;
    outputCost += parts.output;
  }

  const totalGeneration = sumBuckets(buckets, "generation");
  const totalWindow = sumBuckets(buckets, "contextWindow");
  for (const entry of buckets.values()) {
    entry.contextWindow += entry.generation;
  }
  const totalWindowWithGeneration = sumBuckets(buckets, "contextWindow");
  for (const entry of buckets.values()) {
    entry.cost =
      outputCost * share(entry.generation, totalGeneration) +
      inputCost * share(entry.contextWindow, totalWindowWithGeneration || totalWindow);
  }
  return finish(buckets, inputCost, outputCost);
}

function fastTokenEconomicsForSession(db: Database, sessionId: number): TokenEconomics | null {
  const scopeCte = `WITH RECURSIVE scoped_session(id) AS (
    SELECT id FROM session WHERE id = ?1
    UNION ALL
    SELECT child.id
    FROM session child
    JOIN scoped_session parent ON parent.id = child.parent_session_id
  )`;
  const sessions = db
    .query(
      `${scopeCte}
       SELECT s.id, s.model, s.total_input_tokens, s.total_output_tokens,
              s.total_cache_read_tokens, s.total_cache_creation_tokens,
              s.total_cache_creation_1h_tokens,
              s.total_reasoning_tokens, s.est_reasoning_tokens
       FROM session s
       JOIN scoped_session fs ON fs.id = s.id`,
    )
    .all(sessionId) as SessionRow[];
  if (sessions.length === 0) {
    return null;
  }

  const buckets = emptyBuckets();
  const toolRows = db
    .query(
      `${scopeCte}
       SELECT t.session_id, t.tool_name, COUNT(*) AS calls,
              SUM(COALESCE(t.output_bytes, 0)) AS output_bytes
       FROM tool_call t
       JOIN scoped_session fs ON fs.id = t.session_id
       GROUP BY t.session_id, t.tool_name`,
    )
    .all(sessionId) as FastToolRow[];

  let inputCost = 0;
  let outputCost = 0;
  let inputWindowTokens = 0;
  let remainingOutputTokens = 0;
  const toolCallWeights = new Map<ActivityBucket, number>();
  for (const session of sessions) {
    const planning = Math.min(
      session.total_output_tokens,
      session.total_reasoning_tokens || session.est_reasoning_tokens,
    );
    addBucket(buckets, "planning", planning, session.id);
    remainingOutputTokens += Math.max(0, session.total_output_tokens - planning);
    inputWindowTokens +=
      session.total_input_tokens +
      session.total_cache_read_tokens +
      session.total_cache_creation_tokens;
    const parts = estimateCostParts(
      session.model,
      {
        input: session.total_input_tokens,
        output: session.total_output_tokens,
        cacheRead: session.total_cache_read_tokens,
        cacheCreation: session.total_cache_creation_tokens,
        cacheCreation1h: session.total_cache_creation_1h_tokens,
        reasoning: session.total_reasoning_tokens,
      },
      defaultPricing(),
    );
    inputCost += parts.input + parts.cacheRead + parts.cacheCreation;
    outputCost += parts.output;
  }

  for (const row of toolRows) {
    const bucket = toolBucket(row.tool_name, null);
    const entry = buckets.get(bucket);
    if (entry == null) {
      continue;
    }
    entry.contextWindow += (row.output_bytes ?? 0) / CHARS_PER_TOKEN;
    entry.toolCalls += row.calls;
    entry.sessions.add(row.session_id);
    toolCallWeights.set(bucket, (toolCallWeights.get(bucket) ?? 0) + row.calls);
  }

  distributeByWeights(remainingOutputTokens, toolCallWeights, buckets, sessions);
  const windowWeights = toolCallWeights.size > 0 ? toolCallWeights : generationWeights(buckets);
  distributeWindow(inputWindowTokens, windowWeights, buckets, sessions);
  for (const entry of buckets.values()) {
    entry.contextWindow += entry.generation;
  }

  const totalGeneration = sumBuckets(buckets, "generation");
  const totalWindow = sumBuckets(buckets, "contextWindow");
  for (const entry of buckets.values()) {
    entry.cost =
      outputCost * share(entry.generation, totalGeneration) +
      inputCost * share(entry.contextWindow, totalWindow);
  }
  return finish(buckets, inputCost, outputCost);
}

function distributeByWeights(
  tokens: number,
  weights: Map<ActivityBucket, number>,
  buckets: Map<ActivityBucket, MutableBucket>,
  sessions: SessionRow[],
): void {
  if (tokens <= 0) {
    return;
  }
  const totalWeight = sumWeights(weights);
  if (totalWeight <= 0) {
    addSharedGeneration(buckets, "communicating", tokens, sessions);
    return;
  }
  for (const [bucket, weight] of weights) {
    addSharedGeneration(buckets, bucket, tokens * (weight / totalWeight), sessions);
  }
}

function distributeWindow(
  tokens: number,
  weights: Map<ActivityBucket, number>,
  buckets: Map<ActivityBucket, MutableBucket>,
  sessions: SessionRow[],
): void {
  if (tokens <= 0) {
    return;
  }
  const totalWeight = sumWeights(weights);
  if (totalWeight <= 0) {
    addSharedWindow(buckets, "context", tokens, sessions);
    return;
  }
  for (const [bucket, weight] of weights) {
    addSharedWindow(buckets, bucket, tokens * (weight / totalWeight), sessions);
  }
}

function generationWeights(
  buckets: Map<ActivityBucket, MutableBucket>,
): Map<ActivityBucket, number> {
  const weights = new Map<ActivityBucket, number>();
  for (const [bucket, entry] of buckets) {
    if (entry.generation > 0) {
      weights.set(bucket, entry.generation);
    }
  }
  return weights;
}

function addSharedGeneration(
  buckets: Map<ActivityBucket, MutableBucket>,
  bucket: ActivityBucket,
  tokens: number,
  sessions: SessionRow[],
): void {
  const entry = buckets.get(bucket);
  if (entry == null || tokens <= 0) {
    return;
  }
  entry.generation += tokens;
  for (const session of sessions) {
    entry.sessions.add(session.id);
  }
}

function addSharedWindow(
  buckets: Map<ActivityBucket, MutableBucket>,
  bucket: ActivityBucket,
  tokens: number,
  sessions: SessionRow[],
): void {
  const entry = buckets.get(bucket);
  if (entry == null || tokens <= 0) {
    return;
  }
  entry.contextWindow += tokens;
  for (const session of sessions) {
    entry.sessions.add(session.id);
  }
}

function sumWeights(weights: Map<ActivityBucket, number>): number {
  let total = 0;
  for (const value of weights.values()) {
    total += value;
  }
  return total;
}

function allocateGeneration(
  sessions: SessionRow[],
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
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
        allocateOutput(session.id, outputTokens, messageBlocks.get(messageId) ?? [], buckets);
      }
      continue;
    }
    const planning = Math.min(
      session.total_output_tokens,
      session.total_reasoning_tokens || session.est_reasoning_tokens,
    );
    addBucket(buckets, "planning", planning, session.id);
    const assistantBlocks = sessionBlocks.filter(
      (block) => block.role === "assistant" && block.type !== "thinking",
    );
    distribute(
      session.id,
      Math.max(0, session.total_output_tokens - planning),
      assistantBlocks,
      buckets,
    );
  }
}

function allocateOutput(
  sessionId: number,
  outputTokens: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
): void {
  const hasThinking = blocks.some((block) => block.type === "thinking");
  const visible = blocks
    .filter((block) => block.type !== "thinking")
    .reduce((sum, block) => sum + blockSize(block), 0);
  const planning = hasThinking ? Math.max(0, outputTokens - visible / CHARS_PER_TOKEN) : 0;
  addBucket(buckets, "planning", planning, sessionId);
  distribute(
    sessionId,
    Math.max(0, outputTokens - planning),
    blocks.filter((block) => block.type !== "thinking"),
    buckets,
  );
}

function distribute(
  sessionId: number,
  tokens: number,
  blocks: BlockRow[],
  buckets: Map<ActivityBucket, MutableBucket>,
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
    );
  }
}

function blockSize(block: BlockRow): number {
  if (block.type === "tool_use") {
    return byteLength(`${block.tool_name ?? ""}\n${block.tool_input ?? ""}`);
  }
  return byteLength(block.text ?? "");
}

function addBucket(
  buckets: Map<ActivityBucket, MutableBucket>,
  bucket: ActivityBucket,
  tokens: number,
  sessionId: number,
): void {
  const entry = buckets.get(bucket);
  if (entry == null || tokens <= 0) {
    return;
  }
  entry.generation += tokens;
  entry.sessions.add(sessionId);
}

function emptyBuckets(): Map<ActivityBucket, MutableBucket> {
  return new Map(
    ACTIVITY_BUCKETS.map((bucket) => [
      bucket,
      { generation: 0, contextWindow: 0, cost: 0, toolCalls: 0, sessions: new Set<number>() },
    ]),
  );
}

function finish(
  buckets: Map<ActivityBucket, MutableBucket>,
  inputCost: number,
  outputCost: number,
): TokenEconomics {
  const totalCost = sumBuckets(buckets, "cost");
  const rows = ACTIVITY_BUCKETS.map((bucket) => {
    const entry = buckets.get(bucket);
    return {
      bucket,
      generation_tokens: Math.round(entry?.generation ?? 0),
      context_window_tokens: Math.round(entry?.contextWindow ?? 0),
      estimated_cost_usd: entry?.cost ?? 0,
      tool_calls: entry?.toolCalls ?? 0,
      sessions: entry?.sessions.size ?? 0,
      cost_share: share(entry?.cost ?? 0, totalCost),
    };
  });
  return {
    buckets: rows,
    totals: {
      generation_tokens: rows.reduce((sum, row) => sum + row.generation_tokens, 0),
      context_window_tokens: rows.reduce((sum, row) => sum + row.context_window_tokens, 0),
      estimated_cost_usd: totalCost,
      input_cost_usd: inputCost,
      output_cost_usd: outputCost,
    },
  };
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
