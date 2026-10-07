import type { Database } from "bun:sqlite";
import {
  type CostParts,
  defaultPricing,
  estimateCostParts,
  isPriceTier,
  type Price,
  type PriceTier,
  requestPriceTier,
} from "./cost.ts";
import { withImmediateTransaction } from "./db.ts";
import { asInteger, asString, isObject } from "./json.ts";
import { emptyUsage, type Json, type TokenUsage } from "./model.ts";
import { compareCodePoints } from "./order.ts";
import { queryRow, queryRows, runStatement } from "./sqlite-statements.ts";

/** Bump when the rules that split a session's usage change, such as a new
 * price tier, so the next sync rebuilds every session's rows once. */
export const MODEL_USAGE_FORMAT_VERSION = 1;

/** One session's usage served by one model at one price tier. A session that
 * switches models, or sends some requests in fast mode or past a long-prompt
 * threshold, has one row per combination; most sessions have exactly one. */
export interface ModelUsageRow {
  /** The model that served the requests; "" when no model was recorded. */
  model: string;
  tier: PriceTier;
  requests: number;
  usage: TokenUsage;
}

interface SessionTotalsRow {
  tool: string;
  model: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_creation_1h_tokens: number;
}

interface BilledMessageRow {
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  usage_json: string | null;
}

/** Split a stored session's token totals by the model and tier of each billed
 * request. Messages carry the per-request usage the parser kept after
 * deduplicating journal records, so this needs no transcript reread and works
 * for sessions whose source files are gone. */
export function deriveModelUsage(db: Database, sessionId: number): ModelUsageRow[] | null {
  const session = queryRow<SessionTotalsRow>(
    db,
    `SELECT tool, model, total_input_tokens, total_output_tokens, total_cache_read_tokens,
            total_cache_creation_tokens, total_cache_creation_1h_tokens
       FROM session WHERE id = ?1`,
    [sessionId],
  );
  if (session == null) {
    return null;
  }
  const sessionModel = session.model ?? "";
  const totals = sessionTotals(session);
  // Only Claude Code records the 1-hour cache split and fast-mode speed on the
  // request; other sources keep their usage in other shapes.
  const messages = queryRows<BilledMessageRow>(
    db,
    `SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
            CASE WHEN ?2 = 'claude_code' THEN json_extract(raw, '$.message.usage') END AS usage_json
       FROM message
      WHERE session_id = ?1
        AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL
             OR cache_read_tokens IS NOT NULL OR cache_creation_tokens IS NOT NULL)
      ORDER BY seq`,
    [sessionId, session.tool],
  );

  const groups = new Map<string, ModelUsageRow>();
  const billed = emptyUsage();
  for (const message of messages) {
    const recorded = parseUsageJson(message.usage_json);
    const cacheCreation = message.cache_creation_tokens ?? 0;
    const usage: TokenUsage = {
      input: message.input_tokens ?? 0,
      output: message.output_tokens ?? 0,
      cacheRead: message.cache_read_tokens ?? 0,
      cacheCreation,
      cacheCreation1h: Math.min(Math.max(0, recorded.cacheCreation1h), Math.max(0, cacheCreation)),
      reasoning: 0,
    };
    const model = isRecordedModel(message.model) ? message.model : sessionModel;
    const tier = requestPriceTier(model, usage, recorded.speed);
    addUsage(groups, model, tier, usage, 1);
    addTokens(billed, usage);
  }

  const residual = subtractUsage(totals, billed);
  const single =
    groups.size === 0 || (groups.size === 1 && groups.has(key(sessionModel, "standard")));
  // Totals that per-request usage cannot account for, such as an SDK result
  // record that disagrees with the journal, keep the session-level split.
  if (single || !isNonNegative(residual)) {
    return [{ model: sessionModel, tier: "standard", requests: messages.length, usage: totals }];
  }
  if (!isZero(residual)) {
    addUsage(groups, sessionModel, "standard", residual, 0);
  }
  return [...groups.values()].sort(compareRows);
}

/** Replace a session's stored split. Runs inside the caller's transaction. */
export function materializeModelUsage(db: Database, sessionId: number): ModelUsageRow[] {
  const rows = deriveModelUsage(db, sessionId) ?? [];
  runStatement(db, "DELETE FROM session_model_usage WHERE session_id = ?1", [sessionId]);
  const insert = db.prepare(
    `INSERT INTO session_model_usage(
       session_id, model, tier, requests, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_tokens, cache_creation_1h_tokens, format_version
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  );
  try {
    for (const row of rows) {
      insert.run(
        sessionId,
        row.model,
        row.tier,
        row.requests,
        row.usage.input,
        row.usage.output,
        row.usage.cacheRead,
        row.usage.cacheCreation,
        row.usage.cacheCreation1h,
        MODEL_USAGE_FORMAT_VERSION,
      );
    }
  } finally {
    insert.finalize();
  }
  return rows;
}

/** One-time upgrade/backfill path: sessions stored before this table existed,
 * or under an older split rule, get their rows rebuilt from stored messages. */
export function materializeMissingModelUsage(db: Database): number {
  const stale = (): number[] =>
    queryRows<{ id: number }>(
      db,
      `SELECT s.id FROM session s
        WHERE NOT EXISTS (
          SELECT 1 FROM session_model_usage u
           WHERE u.session_id = s.id AND u.format_version = ?1
        )
        ORDER BY s.id`,
      [MODEL_USAGE_FORMAT_VERSION],
    ).map((row) => row.id);
  if (stale().length === 0) {
    return 0;
  }
  return withImmediateTransaction(db, () => {
    const ids = stale();
    for (const id of ids) {
      materializeModelUsage(db, id);
    }
    return ids.length;
  });
}

/** Stored rows for every session in scope, keyed by session id. The scope CTE
 * must define `scoped_session(id)`. */
export function modelUsageForScope(
  db: Database,
  scopeCte: string,
  params: (string | number)[],
): Map<number, ModelUsageRow[]> {
  const rows = queryRows<{
    session_id: number;
    model: string;
    tier: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cache_creation_1h_tokens: number;
  }>(
    db,
    `${scopeCte}
       SELECT u.session_id, u.model, u.tier, u.requests, u.input_tokens, u.output_tokens,
              u.cache_read_tokens, u.cache_creation_tokens, u.cache_creation_1h_tokens
         FROM scoped_session fs
         JOIN session_model_usage u ON u.session_id = fs.id`,
    params,
  );
  const bySession = new Map<number, ModelUsageRow[]>();
  for (const row of rows) {
    const list = bySession.get(row.session_id) ?? [];
    list.push({
      model: row.model,
      tier: isPriceTier(row.tier) ? row.tier : "standard",
      requests: row.requests,
      usage: {
        input: row.input_tokens,
        output: row.output_tokens,
        cacheRead: row.cache_read_tokens,
        cacheCreation: row.cache_creation_tokens,
        cacheCreation1h: row.cache_creation_1h_tokens,
        reasoning: 0,
      },
    });
    bySession.set(row.session_id, list);
  }
  return bySession;
}

/** Price a session from its per-model rows. A session without rows (one
 * written before the backfill ran) is priced from its totals and label. */
export function sessionCostParts(
  rows: ModelUsageRow[] | undefined,
  fallback: { model: string | null; usage: TokenUsage },
  pricing: ReadonlyMap<string, Price> = defaultPricing(),
): CostParts {
  if (rows == null || rows.length === 0) {
    return estimateCostParts(fallback.model, fallback.usage, pricing);
  }
  const total: CostParts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const row of rows) {
    const parts = estimateCostParts(
      row.model === "" ? null : row.model,
      row.usage,
      pricing,
      row.tier,
    );
    total.input += parts.input;
    total.output += parts.output;
    total.cacheRead += parts.cacheRead;
    total.cacheCreation += parts.cacheCreation;
  }
  return total;
}

export function totalCost(parts: CostParts): number {
  return parts.input + parts.output + parts.cacheRead + parts.cacheCreation;
}

function sessionTotals(session: SessionTotalsRow): TokenUsage {
  return {
    input: session.total_input_tokens,
    output: session.total_output_tokens,
    cacheRead: session.total_cache_read_tokens,
    cacheCreation: session.total_cache_creation_tokens,
    cacheCreation1h: session.total_cache_creation_1h_tokens,
    reasoning: 0,
  };
}

// Claude Code writes "<synthetic>" on locally generated assistant records,
// which no model served.
function isRecordedModel(model: string | null): model is string {
  return model != null && model !== "" && !/^<.*>$/.test(model);
}

function parseUsageJson(value: string | null): { cacheCreation1h: number; speed: string | null } {
  if (value == null) {
    return { cacheCreation1h: 0, speed: null };
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(value) as Json;
  } catch {
    return { cacheCreation1h: 0, speed: null };
  }
  if (!isObject(parsed)) {
    return { cacheCreation1h: 0, speed: null };
  }
  const creation = parsed.cache_creation;
  return {
    cacheCreation1h: isObject(creation) ? (asInteger(creation.ephemeral_1h_input_tokens) ?? 0) : 0,
    speed: asString(parsed.speed),
  };
}

function key(model: string, tier: PriceTier): string {
  return `${model}\0${tier}`;
}

function addUsage(
  groups: Map<string, ModelUsageRow>,
  model: string,
  tier: PriceTier,
  usage: TokenUsage,
  requests: number,
): void {
  const id = key(model, tier);
  const row = groups.get(id) ?? { model, tier, requests: 0, usage: emptyUsage() };
  row.requests += requests;
  addTokens(row.usage, usage);
  groups.set(id, row);
}

function addTokens(target: TokenUsage, usage: TokenUsage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheCreation += usage.cacheCreation;
  target.cacheCreation1h += usage.cacheCreation1h;
}

function subtractUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input - right.input,
    output: left.output - right.output,
    cacheRead: left.cacheRead - right.cacheRead,
    cacheCreation: left.cacheCreation - right.cacheCreation,
    cacheCreation1h: left.cacheCreation1h - right.cacheCreation1h,
    reasoning: 0,
  };
}

function isNonNegative(usage: TokenUsage): boolean {
  return (
    usage.input >= 0 &&
    usage.output >= 0 &&
    usage.cacheRead >= 0 &&
    usage.cacheCreation >= 0 &&
    usage.cacheCreation1h >= 0
  );
}

function isZero(usage: TokenUsage): boolean {
  return (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheCreation === 0 &&
    usage.cacheCreation1h === 0
  );
}

function compareRows(left: ModelUsageRow, right: ModelUsageRow): number {
  return compareCodePoints(left.model, right.model) || compareCodePoints(left.tier, right.tier);
}
