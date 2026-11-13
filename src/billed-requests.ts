import type { Database } from "bun:sqlite";
import { materializeContextWindow } from "./context-window.ts";
import { asInteger, asString, get, isObject } from "./json.ts";
import { decodeMessageRaw, MESSAGE_METADATA_SQL } from "./message-storage.ts";
import { emptyUsage, type Json, type TokenUsage } from "./model.ts";
import { materializeModelUsage, sessionCostParts, totalCost } from "./model-usage.ts";
import { queryRow, queryRows, runStatement } from "./sqlite-statements.ts";
import { materializeSessionEconomics } from "./token-economics.ts";

/** What one session's copy of an API request says about where it came from. */
export interface RequestClaim {
  sourceSessionId: string;
  startedAt: string | null;
  /** The session Claude Code names in `forkedFrom` on a record `/branch` copied. */
  copiedFrom: string | null;
  /** The record is older than its session's first record. `--fork-session`
   * writes new records first and the copied history after them. */
  predatesSession: boolean;
}

/** Decide whether a session that holds a request another session already
 * bills takes the request over. Returning false keeps the current owner. The
 * answer cannot depend on which session was read first, or a bulk sync would
 * file the same turn under different sessions from one run to the next. */
export function takesOver(incoming: RequestClaim, current: RequestClaim): boolean {
  const incomingIsCopy = isCopy(incoming);
  if (incomingIsCopy !== isCopy(current)) {
    return !incomingIsCopy;
  }
  // Neither record stands out as the original, so the session the other one
  // was copied from keeps the turn, and failing that the one that began first.
  if (current.copiedFrom === incoming.sourceSessionId) {
    return true;
  }
  if (incoming.copiedFrom === current.sourceSessionId) {
    return false;
  }
  return (
    incoming.startedAt != null &&
    current.startedAt != null &&
    incoming.startedAt < current.startedAt
  );
}

function isCopy(claim: RequestClaim): boolean {
  return claim.copiedFrom != null || claim.predatesSession;
}

interface BilledRow {
  id: number;
  request_id: unknown;
}

interface OwnerRow {
  session_id: number;
  message_id: number;
}

const BILLED = `(m.input_tokens IS NOT NULL OR m.output_tokens IS NOT NULL
  OR m.cache_read_tokens IS NOT NULL OR m.cache_creation_tokens IS NOT NULL)`;

/** Bill each Claude Code API request in one session only. `/branch` and
 * `--fork-session` copy earlier turns into a new transcript with their usage,
 * so the same request can be stored under several sessions. The copy keeps its
 * transcript row and loses its usage. Works from stored rows, so it also
 * reaches sessions whose source files are gone. Runs inside the caller's
 * transaction; `refreshSelf` is false when the caller derives this session's
 * usage, cost, and context afterwards. */
export function reconcileBilledRequests(
  db: Database,
  sessionId: number,
  refreshSelf: boolean,
): void {
  const session = queryRow<{ tool: string }>(db, "SELECT tool FROM session WHERE id = ?1", [
    sessionId,
  ]);
  if (session?.tool !== "claude_code") {
    return;
  }
  const billed = queryRows<BilledRow>(
    db,
    `SELECT m.id, json_extract(${MESSAGE_METADATA_SQL}, '$.message.id') AS request_id
       FROM message m
      WHERE m.session_id = ?1 AND ${BILLED}
      ORDER BY m.seq`,
    [sessionId],
  );
  if (billed.length === 0) {
    return;
  }

  const removed = new Map<number, TokenUsage>();
  const findOwner = db.prepare<OwnerRow, [string]>(
    "SELECT session_id, message_id FROM billed_request WHERE request_id = ?1",
  );
  const claim = db.prepare(
    `INSERT INTO billed_request(request_id, session_id, message_id) VALUES (?1, ?2, ?3)
     ON CONFLICT(request_id) DO UPDATE SET session_id = ?2, message_id = ?3`,
  );
  try {
    for (const row of billed) {
      const requestId = row.request_id;
      if (typeof requestId !== "string" || requestId === "") {
        continue;
      }
      const owner = findOwner.get(requestId);
      if (owner == null) {
        claim.run(requestId, sessionId, row.id);
        continue;
      }
      if (owner.session_id === sessionId) {
        continue;
      }
      const incoming = requestClaim(db, row.id);
      const current = requestClaim(db, owner.message_id);
      if (incoming != null && current != null && takesOver(incoming, current)) {
        unbill(db, owner.message_id, owner.session_id, removed);
        claim.run(requestId, sessionId, row.id);
      } else {
        unbill(db, row.id, sessionId, removed);
      }
    }
  } finally {
    claim.finalize();
    findOwner.finalize();
  }

  for (const [affected, usage] of removed) {
    subtractFromTotals(db, affected, usage);
    if (affected !== sessionId || refreshSelf) {
      refreshDerivedUsage(db, affected);
    }
  }
}

function requestClaim(db: Database, messageId: number): RequestClaim | null {
  const row = queryRow<{
    raw: string | Uint8Array;
    timestamp: string | null;
    started_at: string | null;
    source_session_id: string;
  }>(
    db,
    `SELECT m.raw, m.timestamp, s.started_at, s.source_session_id
       FROM message m JOIN session s ON s.id = m.session_id
      WHERE m.id = ?1`,
    [messageId],
  );
  if (row == null) {
    return null;
  }
  let record: Json | undefined;
  try {
    record = JSON.parse(decodeMessageRaw(row.raw)) as Json;
  } catch {
    record = undefined;
  }
  return {
    sourceSessionId: row.source_session_id,
    startedAt: row.started_at,
    copiedFrom: asString(get(get(record, "forkedFrom"), "sessionId")),
    predatesSession:
      row.timestamp != null && row.started_at != null && row.timestamp < row.started_at,
  };
}

function unbill(
  db: Database,
  messageId: number,
  sessionId: number,
  removed: Map<number, TokenUsage>,
): void {
  const row = queryRow<{
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    usage_json: string | null;
  }>(
    db,
    `SELECT m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
            json_extract(${MESSAGE_METADATA_SQL}, '$.message.usage') AS usage_json
       FROM message m WHERE m.id = ?1`,
    [messageId],
  );
  if (row == null) {
    return;
  }
  const usage = removed.get(sessionId) ?? emptyUsage();
  const cacheCreation = row.cache_creation_tokens ?? 0;
  usage.input += row.input_tokens ?? 0;
  usage.output += row.output_tokens ?? 0;
  usage.cacheRead += row.cache_read_tokens ?? 0;
  usage.cacheCreation += cacheCreation;
  usage.cacheCreation1h += Math.min(Math.max(0, oneHourWrites(row.usage_json)), cacheCreation);
  removed.set(sessionId, usage);
  runStatement(
    db,
    `UPDATE message
        SET input_tokens = NULL, output_tokens = NULL,
            cache_read_tokens = NULL, cache_creation_tokens = NULL
      WHERE id = ?1`,
    [messageId],
  );
}

function oneHourWrites(usageJson: string | null): number {
  if (usageJson == null) {
    return 0;
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(usageJson) as Json;
  } catch {
    return 0;
  }
  const creation = isObject(parsed) ? parsed.cache_creation : undefined;
  return isObject(creation) ? (asInteger(creation.ephemeral_1h_input_tokens) ?? 0) : 0;
}

/** Take the copied usage out of the session's totals. Totals from an SDK
 * `result` record can describe the new run alone; they are left as recorded
 * unless they cover every request the transcript billed. */
function subtractFromTotals(db: Database, sessionId: number, removed: TokenUsage): void {
  const row = queryRow<{
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
    cache_creation_1h: number;
    est_reasoning: number;
    billed_input: number;
    billed_output: number;
    billed_cache_read: number;
    billed_cache_creation: number;
  }>(
    db,
    `SELECT s.total_input_tokens AS input, s.total_output_tokens AS output,
            s.total_cache_read_tokens AS cache_read,
            s.total_cache_creation_tokens AS cache_creation,
            s.total_cache_creation_1h_tokens AS cache_creation_1h,
            s.est_reasoning_tokens AS est_reasoning,
            COALESCE(SUM(m.input_tokens), 0) AS billed_input,
            COALESCE(SUM(m.output_tokens), 0) AS billed_output,
            COALESCE(SUM(m.cache_read_tokens), 0) AS billed_cache_read,
            COALESCE(SUM(m.cache_creation_tokens), 0) AS billed_cache_creation
       FROM session s LEFT JOIN message m ON m.session_id = s.id
      WHERE s.id = ?1
      GROUP BY s.id`,
    [sessionId],
  );
  if (
    row == null ||
    row.input < row.billed_input + removed.input ||
    row.output < row.billed_output + removed.output ||
    row.cache_read < row.billed_cache_read + removed.cacheRead ||
    row.cache_creation < row.billed_cache_creation + removed.cacheCreation
  ) {
    return;
  }
  const output = row.output - removed.output;
  const cacheCreation = row.cache_creation - removed.cacheCreation;
  // The reasoning estimate is inferred per turn from output, so it shrinks by
  // the share of output that left.
  const estReasoning =
    row.output > 0 ? Math.round((row.est_reasoning * output) / row.output) : row.est_reasoning;
  runStatement(
    db,
    `UPDATE session
        SET total_input_tokens = ?2, total_output_tokens = ?3, total_cache_read_tokens = ?4,
            total_cache_creation_tokens = ?5, total_cache_creation_1h_tokens = ?6,
            est_reasoning_tokens = ?7
      WHERE id = ?1`,
    [
      sessionId,
      row.input - removed.input,
      output,
      row.cache_read - removed.cacheRead,
      cacheCreation,
      Math.min(Math.max(0, row.cache_creation_1h - removed.cacheCreation1h), cacheCreation),
      estReasoning,
    ],
  );
}

function refreshDerivedUsage(db: Database, sessionId: number): void {
  const session = queryRow<{
    model: string | null;
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
    cache_creation_1h: number;
  }>(
    db,
    `SELECT model, total_input_tokens AS input, total_output_tokens AS output,
            total_cache_read_tokens AS cache_read, total_cache_creation_tokens AS cache_creation,
            total_cache_creation_1h_tokens AS cache_creation_1h
       FROM session WHERE id = ?1`,
    [sessionId],
  );
  if (session == null) {
    return;
  }
  const rows = materializeModelUsage(db, sessionId);
  const usage: TokenUsage = {
    input: session.input,
    output: session.output,
    cacheRead: session.cache_read,
    cacheCreation: session.cache_creation,
    cacheCreation1h: session.cache_creation_1h,
    reasoning: 0,
  };
  runStatement(db, "UPDATE session SET estimated_cost_usd = ?1 WHERE id = ?2", [
    totalCost(sessionCostParts(rows, { model: session.model, usage })),
    sessionId,
  ]);
  materializeSessionEconomics(db, sessionId);
  materializeContextWindow(db, sessionId);
}
