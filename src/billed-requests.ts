import type { Database } from "bun:sqlite";
import { materializeContextWindow } from "./context-window.ts";
import { asInteger, asString, get, isObject } from "./json.ts";
import { decodeMessageRaw, MESSAGE_METADATA_SQL } from "./message-storage.ts";
import { emptyUsage, type Json, type TokenUsage } from "./model.ts";
import { materializeModelUsage, sessionCostParts, totalCost } from "./model-usage.ts";
import { inferredReasoningTokens } from "./sources/claude.ts";
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
 * file the same turn under different sessions from one run to the next, so
 * every pair of distinct sessions gets one answer and its reverse. */
export function takesOver(incoming: RequestClaim, current: RequestClaim): boolean {
  const incomingIsCopy = isCopy(incoming);
  if (incomingIsCopy !== isCopy(current)) {
    return !incomingIsCopy;
  }
  // Neither record stands out as the original, so the session the other one
  // was copied from keeps the turn, then the one that began first.
  const incomingIsSource = current.copiedFrom === incoming.sourceSessionId;
  if (incomingIsSource !== (incoming.copiedFrom === current.sourceSessionId)) {
    return incomingIsSource;
  }
  if (incoming.startedAt !== current.startedAt) {
    // A session with no start time ranks after any session that has one.
    return (
      current.startedAt == null ||
      (incoming.startedAt != null && incoming.startedAt < current.startedAt)
    );
  }
  // `/branch` copies of one original share its start time.
  return incoming.sourceSessionId < current.sourceSessionId;
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

/** The usage taken off one copy, as `unbilled_request` keeps it. */
interface UnbilledCopy {
  messageId: number;
  requestId: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
  cacheCreation1h: number;
}

interface Removal {
  usage: TokenUsage;
  copies: UnbilledCopy[];
}

interface CopyRow {
  request_id: string;
  session_id: number;
  message_id: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_creation_1h_tokens: number;
  totals_reduced: number;
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

  const removed = new Map<number, Removal>();
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
        unbill(db, owner.message_id, owner.session_id, requestId, removed);
        claim.run(requestId, sessionId, row.id);
      } else {
        unbill(db, row.id, sessionId, requestId, removed);
      }
    }
  } finally {
    claim.finalize();
    findOwner.finalize();
  }

  for (const [affected, removal] of removed) {
    const reduced = subtractFromTotals(db, affected, removal.usage);
    recordUnbilled(db, affected, removal.copies, reduced);
    refreshReasoningEstimate(db, affected, true);
    if (affected !== sessionId || refreshSelf) {
      refreshDerivedUsage(db, affected);
    }
  }
}

/** Before sessions are deleted, hand each request they bill to the copy that
 * ranks first among the sessions that stay, and give that copy back the usage
 * it lost. Without this a copy whose original leaves the archive would stay
 * unbilled, and an unchanged copy is never re-read to correct it. */
export function releaseBilledRequests(db: Database, sessionIds: readonly number[]): void {
  const gone = new Set(sessionIds);
  const copies = new Map<string, CopyRow[]>();
  for (const id of gone) {
    const rows = queryRows<CopyRow>(
      db,
      `SELECT u.request_id, u.session_id, u.message_id, u.input_tokens, u.output_tokens,
              u.cache_read_tokens, u.cache_creation_tokens, u.cache_creation_1h_tokens,
              u.totals_reduced
         FROM billed_request b JOIN unbilled_request u ON u.request_id = b.request_id
        WHERE b.session_id = ?1
        ORDER BY u.session_id, u.message_id`,
      [id],
    );
    for (const row of rows.filter((copy) => !gone.has(copy.session_id))) {
      const list = copies.get(row.request_id);
      if (list == null) {
        copies.set(row.request_id, [row]);
      } else {
        list.push(row);
      }
    }
  }

  const restored = new Map<number, TokenUsage>();
  for (const [requestId, candidates] of copies) {
    const best = firstCopy(db, candidates);
    if (best == null) {
      continue;
    }
    runStatement(
      db,
      `UPDATE message
          SET input_tokens = ?2, output_tokens = ?3,
              cache_read_tokens = ?4, cache_creation_tokens = ?5
        WHERE id = ?1`,
      [
        best.message_id,
        best.input_tokens,
        best.output_tokens,
        best.cache_read_tokens,
        best.cache_creation_tokens,
      ],
    );
    runStatement(db, "DELETE FROM unbilled_request WHERE session_id = ?1 AND message_id = ?2", [
      best.session_id,
      best.message_id,
    ]);
    runStatement(
      db,
      "UPDATE billed_request SET session_id = ?2, message_id = ?3 WHERE request_id = ?1",
      [requestId, best.session_id, best.message_id],
    );
    const usage = restored.get(best.session_id) ?? emptyUsage();
    // Totals a `result` record set for the new run alone never counted the copy.
    if (best.totals_reduced !== 0) {
      usage.input += best.input_tokens ?? 0;
      usage.output += best.output_tokens ?? 0;
      usage.cacheRead += best.cache_read_tokens ?? 0;
      usage.cacheCreation += best.cache_creation_tokens ?? 0;
      usage.cacheCreation1h += best.cache_creation_1h_tokens;
    }
    restored.set(best.session_id, usage);
  }

  for (const [sessionId, usage] of restored) {
    runStatement(
      db,
      `UPDATE session
          SET total_input_tokens = total_input_tokens + ?2,
              total_output_tokens = total_output_tokens + ?3,
              total_cache_read_tokens = total_cache_read_tokens + ?4,
              total_cache_creation_tokens = total_cache_creation_tokens + ?5,
              total_cache_creation_1h_tokens = total_cache_creation_1h_tokens + ?6
        WHERE id = ?1`,
      [
        sessionId,
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheCreation,
        usage.cacheCreation1h,
      ],
    );
    refreshReasoningEstimate(db, sessionId, false);
    refreshDerivedUsage(db, sessionId);
  }
}

function firstCopy(db: Database, candidates: readonly CopyRow[]): CopyRow | null {
  let best: { row: CopyRow; claim: RequestClaim } | null = null;
  for (const row of candidates) {
    const claim = requestClaim(db, row.message_id);
    if (claim != null && (best == null || takesOver(claim, best.claim))) {
      best = { row, claim };
    }
  }
  return best?.row ?? null;
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
  requestId: string,
  removed: Map<number, Removal>,
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
  const removal = removed.get(sessionId) ?? { usage: emptyUsage(), copies: [] };
  const { usage } = removal;
  const cacheCreation = row.cache_creation_tokens ?? 0;
  const cacheCreation1h = Math.min(Math.max(0, oneHourWrites(row.usage_json)), cacheCreation);
  usage.input += row.input_tokens ?? 0;
  usage.output += row.output_tokens ?? 0;
  usage.cacheRead += row.cache_read_tokens ?? 0;
  usage.cacheCreation += cacheCreation;
  usage.cacheCreation1h += cacheCreation1h;
  removal.copies.push({
    messageId,
    requestId,
    input: row.input_tokens,
    output: row.output_tokens,
    cacheRead: row.cache_read_tokens,
    cacheCreation: row.cache_creation_tokens,
    cacheCreation1h,
  });
  removed.set(sessionId, removal);
  runStatement(
    db,
    `UPDATE message
        SET input_tokens = NULL, output_tokens = NULL,
            cache_read_tokens = NULL, cache_creation_tokens = NULL
      WHERE id = ?1`,
    [messageId],
  );
}

function recordUnbilled(
  db: Database,
  sessionId: number,
  copies: readonly UnbilledCopy[],
  totalsReduced: boolean,
): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO unbilled_request(
       session_id, message_id, request_id, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, totals_reduced)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );
  try {
    for (const copy of copies) {
      insert.run(
        sessionId,
        copy.messageId,
        copy.requestId,
        copy.input,
        copy.output,
        copy.cacheRead,
        copy.cacheCreation,
        copy.cacheCreation1h,
        totalsReduced ? 1 : 0,
      );
    }
  } finally {
    insert.finalize();
  }
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

/** Take the copied usage out of the session's totals, and report whether it
 * did. Totals from an SDK `result` record can describe the new run alone; they
 * are left as recorded unless they cover every request the transcript billed. */
function subtractFromTotals(db: Database, sessionId: number, removed: TokenUsage): boolean {
  const row = queryRow<{
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
    cache_creation_1h: number;
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
    return false;
  }
  const cacheCreation = row.cache_creation - removed.cacheCreation;
  runStatement(
    db,
    `UPDATE session
        SET total_input_tokens = ?2, total_output_tokens = ?3, total_cache_read_tokens = ?4,
            total_cache_creation_tokens = ?5, total_cache_creation_1h_tokens = ?6
      WHERE id = ?1`,
    [
      sessionId,
      row.input - removed.input,
      row.output - removed.output,
      row.cache_read - removed.cacheRead,
      cacheCreation,
      Math.min(Math.max(0, row.cache_creation_1h - removed.cacheCreation1h), cacheCreation),
    ],
  );
  return true;
}

/** Recompute the reasoning estimate from the session's stored replies, leaving
 * out the requests another session bills. A copied turn's thinking says nothing
 * about the turns that stay, so scaling the old estimate would misplace it.
 * Losing turns cannot raise an estimate of zero, so that case skips the read. */
function refreshReasoningEstimate(db: Database, sessionId: number, lostTurns: boolean): void {
  const session = queryRow<{ output: number; estimate: number }>(
    db,
    "SELECT total_output_tokens AS output, est_reasoning_tokens AS estimate FROM session WHERE id = ?1",
    [sessionId],
  );
  if (session == null || (lostTurns && session.estimate === 0)) {
    return;
  }
  const copied = new Set(
    queryRows<{ request_id: string }>(
      db,
      "SELECT request_id FROM unbilled_request WHERE session_id = ?1",
      [sessionId],
    ).map((row) => row.request_id),
  );
  const replies = db.prepare<{ raw: string | Uint8Array; request_id: unknown }, [number]>(
    `SELECT m.raw, json_extract(${MESSAGE_METADATA_SQL}, '$.message.id') AS request_id
       FROM message m
      WHERE m.session_id = ?1 AND m.role = 'assistant'
      ORDER BY m.seq`,
  );
  let estimate: number;
  try {
    // Without a `result` record the total is the replies' own output, which
    // the estimate never exceeds, so the cap only binds where the parser's does.
    estimate = inferredReasoningTokens(
      storedRecords(replies.iterate(sessionId), copied),
      session.output,
    );
  } finally {
    replies.finalize();
  }
  runStatement(db, "UPDATE session SET est_reasoning_tokens = ?2 WHERE id = ?1", [
    sessionId,
    estimate,
  ]);
}

function* storedRecords(
  rows: Iterable<{ raw: string | Uint8Array; request_id: unknown }>,
  copied: ReadonlySet<string>,
): Generator<Json> {
  for (const row of rows) {
    if (typeof row.request_id === "string" && copied.has(row.request_id)) {
      continue;
    }
    let record: Json;
    try {
      record = JSON.parse(decodeMessageRaw(row.raw)) as Json;
    } catch {
      continue;
    }
    yield record;
  }
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
