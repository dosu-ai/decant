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
interface RequestClaim {
  sourceSessionId: string;
  startedAt: string | null;
  /** The session Claude Code names in `forkedFrom` on a record `/branch` copied. */
  copiedFrom: string | null;
  /** The record is older than its session's first record. `--fork-session`
   * writes new records first and the copied history after them. */
  predatesSession: boolean;
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

/** One session's stored reply to a request. */
interface Holder {
  sessionId: number;
  messageId: number;
  /** What was taken off the reply, while another session bills the request. */
  copy: CopyRow | null;
  claim: RequestClaim;
}

interface Changes {
  removed: Map<number, Removal>;
  /** Sessions that bill a request again, with the usage their totals get back. */
  restored: Map<number, TokenUsage>;
}

interface Reply {
  sessionId: number;
  messageId: number;
}

const BILLED = `(m.input_tokens IS NOT NULL OR m.output_tokens IS NOT NULL
  OR m.cache_read_tokens IS NOT NULL OR m.cache_creation_tokens IS NOT NULL)`;

const NO_SESSIONS: ReadonlySet<number> = new Set();

/** Bill each Claude Code API request in one session only. `/branch` and
 * `--fork-session` copy earlier turns into a new transcript with their usage,
 * so the same request can be stored under several sessions. The copy keeps its
 * transcript row and loses its usage. Works from stored rows, so it also
 * reaches sessions whose source files are gone. Runs inside the caller's
 * transaction; `refreshSelf` is false when the caller derives this session's
 * usage, cost, and context afterwards. `unsettled` names requests whose holders
 * changed when this session's previous rows were removed. */
export function reconcileBilledRequests(
  db: Database,
  sessionId: number,
  refreshSelf: boolean,
  unsettled: Iterable<string> = [],
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
  const pending = new Set(unsettled);
  if (billed.length === 0 && pending.size === 0) {
    return;
  }

  const changes: Changes = { removed: new Map(), restored: new Map() };
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
      if (owner == null && !pending.has(requestId)) {
        claim.run(requestId, sessionId, row.id);
        continue;
      }
      pending.delete(requestId);
      if (owner?.session_id !== sessionId) {
        settle(db, requestId, { sessionId, messageId: row.id }, NO_SESSIONS, changes);
      }
    }
  } finally {
    claim.finalize();
    findOwner.finalize();
  }
  for (const requestId of pending) {
    settle(db, requestId, null, NO_SESSIONS, changes);
  }
  applyChanges(db, changes, (affected) => affected !== sessionId || refreshSelf);
}

/** Before sessions are deleted, settle their requests among the sessions that
 * stay. An unchanged copy is never re-read, so it would stay unbilled. */
export function releaseBilledRequests(db: Database, sessionIds: readonly number[]): void {
  const gone = new Set(sessionIds);
  const requests = new Set<string>();
  for (const id of gone) {
    for (const requestId of unsettledRequests(db, id)) {
      requests.add(requestId);
    }
  }
  const changes: Changes = { removed: new Map(), restored: new Map() };
  for (const requestId of requests) {
    settle(db, requestId, null, gone, changes);
  }
  applyChanges(db, changes, () => true);
}

/** The requests whose holders change when this session's rows go. */
export function unsettledRequests(db: Database, sessionId: number): string[] {
  return queryRows<{ request_id: string }>(
    db,
    `SELECT b.request_id FROM billed_request b
      WHERE b.session_id = ?1
        AND EXISTS (SELECT 1 FROM unbilled_request u WHERE u.request_id = b.request_id)
     UNION
     SELECT request_id FROM unbilled_request WHERE session_id = ?1`,
    [sessionId],
  ).map((row) => row.request_id);
}

/** Bill a request in the first of the sessions that hold it, apart from `gone`.
 * `fresh` is a reply being written that neither table names yet. */
function settle(
  db: Database,
  requestId: string,
  fresh: Reply | null,
  gone: ReadonlySet<number>,
  changes: Changes,
): void {
  const owner = queryRow<OwnerRow>(
    db,
    "SELECT session_id, message_id FROM billed_request WHERE request_id = ?1",
    [requestId],
  );
  const holders: Holder[] = [];
  const hold = (sessionId: number, messageId: number, copy: CopyRow | null): void => {
    const claim = gone.has(sessionId) ? null : requestClaim(db, messageId);
    if (claim != null) {
      holders.push({ sessionId, messageId, copy, claim });
    }
  };
  if (owner != null) {
    hold(owner.session_id, owner.message_id, null);
  }
  for (const copy of queryRows<CopyRow>(
    db,
    `SELECT request_id, session_id, message_id, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, totals_reduced
       FROM unbilled_request WHERE request_id = ?1`,
    [requestId],
  )) {
    hold(copy.session_id, copy.message_id, copy);
  }
  if (fresh != null) {
    hold(fresh.sessionId, fresh.messageId, null);
  }

  const first = firstHolder(holders);
  if (first == null || first.messageId === owner?.message_id) {
    if (first != null && fresh != null) {
      unbill(db, fresh.messageId, fresh.sessionId, requestId, changes.removed);
    }
    return;
  }
  if (owner != null && !gone.has(owner.session_id)) {
    unbill(db, owner.message_id, owner.session_id, requestId, changes.removed);
  }
  if (fresh != null && first.messageId !== fresh.messageId) {
    unbill(db, fresh.messageId, fresh.sessionId, requestId, changes.removed);
  }
  if (first.copy != null) {
    restore(db, first.copy, changes.restored);
  }
  runStatement(
    db,
    `INSERT INTO billed_request(request_id, session_id, message_id) VALUES (?1, ?2, ?3)
     ON CONFLICT(request_id) DO UPDATE SET session_id = ?2, message_id = ?3`,
    [requestId, first.sessionId, first.messageId],
  );
}

/** Ranks within the holders only, so the owner depends on which sessions hold
 * the request and never on the order they were read in. */
function firstHolder(holders: readonly Holder[]): Holder | null {
  const bySource = new Map(holders.map((holder) => [holder.claim.sourceSessionId, holder]));
  let best: { holder: Holder; copy: boolean; depth: number } | null = null;
  for (const holder of holders) {
    const ranked = {
      holder,
      copy: isCopy(holder.claim),
      depth: lineageDepth(holder, bySource),
    };
    if (best == null || ranksBefore(ranked, best)) {
      best = ranked;
    }
  }
  return best?.holder ?? null;
}

/** A cycle stops the count where it closes. */
function lineageDepth(holder: Holder, bySource: ReadonlyMap<string, Holder>): number {
  const seen = new Set<Holder>([holder]);
  let current = holder;
  for (;;) {
    const from = current.claim.copiedFrom;
    const parent = from == null ? undefined : bySource.get(from);
    if (parent == null || seen.has(parent)) {
      return seen.size;
    }
    seen.add(parent);
    current = parent;
  }
}

function ranksBefore(
  a: { holder: Holder; copy: boolean; depth: number },
  b: { holder: Holder; copy: boolean; depth: number },
): boolean {
  if (a.copy !== b.copy) {
    return !a.copy;
  }
  if (a.depth !== b.depth) {
    return a.depth < b.depth;
  }
  const aStart = a.holder.claim.startedAt;
  const bStart = b.holder.claim.startedAt;
  if (aStart !== bStart) {
    // A session with no start time ranks after any session that has one.
    return bStart == null || (aStart != null && aStart < bStart);
  }
  return a.holder.claim.sourceSessionId < b.holder.claim.sourceSessionId;
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

function restore(db: Database, copy: CopyRow, restored: Map<number, TokenUsage>): void {
  runStatement(
    db,
    `UPDATE message
        SET input_tokens = ?2, output_tokens = ?3,
            cache_read_tokens = ?4, cache_creation_tokens = ?5
      WHERE id = ?1`,
    [
      copy.message_id,
      copy.input_tokens,
      copy.output_tokens,
      copy.cache_read_tokens,
      copy.cache_creation_tokens,
    ],
  );
  runStatement(db, "DELETE FROM unbilled_request WHERE session_id = ?1 AND message_id = ?2", [
    copy.session_id,
    copy.message_id,
  ]);
  const usage = restored.get(copy.session_id) ?? emptyUsage();
  // Totals a `result` record set for the new run alone never counted the copy.
  if (copy.totals_reduced !== 0) {
    usage.input += copy.input_tokens ?? 0;
    usage.output += copy.output_tokens ?? 0;
    usage.cacheRead += copy.cache_read_tokens ?? 0;
    usage.cacheCreation += copy.cache_creation_tokens ?? 0;
    usage.cacheCreation1h += copy.cache_creation_1h_tokens;
  }
  restored.set(copy.session_id, usage);
}

function applyChanges(
  db: Database,
  changes: Changes,
  refreshDerived: (sessionId: number) => boolean,
): void {
  // Restored usage goes back first, because the check for totals that cover
  // every billed request counts the restored replies.
  for (const [sessionId, usage] of changes.restored) {
    runStatement(
      db,
      `UPDATE session
          SET total_input_tokens = total_input_tokens + ?2,
              total_output_tokens = total_output_tokens + ?3,
              total_cache_read_tokens = total_cache_read_tokens + ?4,
              total_cache_creation_tokens = total_cache_creation_tokens + ?5,
              total_cache_creation_1h_tokens =
                MIN(total_cache_creation_1h_tokens + ?6, total_cache_creation_tokens + ?5)
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
  }
  for (const [sessionId, removal] of changes.removed) {
    const taken1h = subtractFromTotals(db, sessionId, removal.usage);
    recordUnbilled(db, sessionId, removal.copies, taken1h);
  }
  for (const sessionId of new Set([...changes.restored.keys(), ...changes.removed.keys()])) {
    refreshReasoningEstimate(db, sessionId, !changes.restored.has(sessionId));
    if (refreshDerived(sessionId)) {
      refreshDerivedUsage(db, sessionId);
    }
  }
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
  taken1h: number | null,
): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO unbilled_request(
       session_id, message_id, request_id, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, totals_reduced)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );
  // A restore puts back what the clamp took, which can differ from the replies'
  // own one-hour writes, so the last copy keeps whatever the others did not.
  let left = taken1h ?? 0;
  try {
    copies.forEach((copy, index) => {
      const share = index === copies.length - 1 ? left : Math.min(copy.cacheCreation1h, left);
      left -= share;
      insert.run(
        sessionId,
        copy.messageId,
        copy.requestId,
        copy.input,
        copy.output,
        copy.cacheRead,
        copy.cacheCreation,
        share,
        taken1h == null ? 0 : 1,
      );
    });
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

/** Take the copied usage out of the session's totals, and return how much came
 * off the one-hour total, or null when nothing did. Totals from an SDK `result`
 * record can describe the new run alone; they are left as recorded unless they
 * cover every request the transcript billed. */
function subtractFromTotals(db: Database, sessionId: number, removed: TokenUsage): number | null {
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
    return null;
  }
  const cacheCreation = row.cache_creation - removed.cacheCreation;
  const cacheCreation1h = Math.min(
    Math.max(0, row.cache_creation_1h - removed.cacheCreation1h),
    cacheCreation,
  );
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
      cacheCreation1h,
    ],
  );
  return row.cache_creation_1h - cacheCreation1h;
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
