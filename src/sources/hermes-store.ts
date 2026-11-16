// Read-only access to a Hermes Agent `state.db` (NousResearch/hermes-agent,
// `hermes_state_common.py` SCHEMA_SQL). Hermes owns the file and keeps it in
// WAL mode; this module only reads. The connection is opened read-only (never
// `immutable`), so rows Hermes committed since the last checkpoint are seen.
// Nothing here writes or checkpoints, and Hermes is never started.
//
// Hermes adds columns with ALTER TABLE as its schema moves, so an older
// database can lack any column past the core ones. Each read selects a missing
// column as NULL instead of failing on it.
import { Database } from "bun:sqlite";
import { createHash, type Hash } from "node:crypto";
import { queryRow, queryRows } from "../sqlite-statements.ts";
import type { HermesMessageRow, HermesModelUsageRow, HermesSessionRow } from "./hermes.ts";

export interface HermesSessionRef {
  dbPath: string;
  sessionId: string;
  /** Per-session change key (see `hermesFingerprint`), stored in
   * `ingest_source.hash` so an unchanged session is skipped. */
  fingerprint: string;
  /** Newest of the session's start and its last message, in epoch seconds.
   * Decides which copy wins when two databases hold one session ID. */
  activity: number;
}

export interface HermesLoadedSession {
  session: HermesSessionRow;
  /** Every stored row in insertion order (`id`), archived and rewound rows
   * included; the parser decides which rows form the transcript. */
  messages: HermesMessageRow[];
  modelUsage: HermesModelUsageRow[];
}

/** Columns read from `sessions`, beyond the required `id` and `started_at`. */
const SESSION_COLUMNS = [
  "source",
  "session_key",
  "model",
  "model_config",
  "title",
  "parent_session_id",
  "ended_at",
  "end_reason",
  "cwd",
  "git_branch",
  "git_repo_root",
  "message_count",
  "tool_call_count",
  "api_call_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "billing_provider",
  "billing_mode",
  "estimated_cost_usd",
  "actual_cost_usd",
  "cost_status",
  "profile_name",
  "archived",
] as const;

/** Columns read from `messages`, beyond the required `id`, `session_id`,
 * `role`, and `timestamp`. */
const MESSAGE_COLUMNS = [
  "content",
  "tool_call_id",
  "tool_calls",
  "tool_name",
  "token_count",
  "finish_reason",
  "reasoning",
  "reasoning_content",
  "active",
  "compacted",
  "_compressed_summary",
  "display_kind",
  "message_uid",
] as const;

const MODEL_USAGE_COLUMNS = [
  "model",
  "billing_provider",
  "billing_mode",
  "task",
  "api_call_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "estimated_cost_usd",
  "actual_cost_usd",
  "cost_status",
] as const;

const MODEL_USAGE_ORDER = ["model", "billing_provider", "task"] as const;

/** Every session column `loadSession` reads, plus `transcript_revision`.
 * `last_activity_at` is a heartbeat and `last_read_at`, `pinned`, and
 * `hidden` are UI state, so none of them is in the key: a session left open
 * would otherwise re-ingest every minute without anything new to read. Hermes
 * bumps `transcript_revision` from a trigger whenever an existing message is
 * rewritten in place (a redaction or a prompt expansion), which moves neither
 * the row count nor the highest ID. */
const CHANGE_COLUMNS = [...SESSION_COLUMNS, "transcript_revision"] as const;

/** Message columns whose in-place rewrite bumps `transcript_revision` (the
 * `messages_transcript_revision_update` and `messages_display_revision_update`
 * triggers). */
const REWRITE_COLUMNS = [
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
  "tool_name",
  "reasoning",
  "reasoning_content",
  "display_kind",
] as const;

export class HermesStoreError extends Error {}

export class HermesStore {
  readonly path: string;
  readonly #db: Database;
  readonly #columns = new Map<string, Set<string>>();

  private constructor(path: string, db: Database) {
    this.path = path;
    this.#db = db;
  }

  /** Throws `HermesStoreError` when the file is not a Hermes session store, so
   * a stray `state.db` from another program is reported and skipped. */
  static open(path: string): HermesStore {
    const db = new Database(path, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    const store = new HermesStore(path, db);
    try {
      store.#requireColumns("sessions", ["id", "started_at"]);
      store.#requireColumns("messages", ["id", "session_id", "role", "timestamp"]);
    } catch (error) {
      db.close(false);
      throw error;
    }
    return store;
  }

  /** Every session with a per-session change key. */
  listSessions(): HermesSessionRef[] {
    const changeColumns = CHANGE_COLUMNS.map((column) => this.#column("sessions", "s", column));
    const messageColumns = ["active", "compacted"].map((column) =>
      this.#has("messages", column) ? `IFNULL(SUM(m.${column}), -1)` : "-1",
    );
    const rows = queryRows<{
      id: string;
      started_at: number | null;
      parent_end_reason: string | null;
      parent_ended_at: number | null;
      parent_session_key: string | null;
      state: string;
      model_usage: string | null;
      message_key: string | null;
      last_message_at: number | null;
    }>(
      this.#db,
      `SELECT CAST(s.id AS TEXT) AS id, s.started_at,
              ${this.#parentEndReason()} AS parent_end_reason,
              ${this.#parentColumn("ended_at")} AS parent_ended_at,
              ${this.#parentColumn("session_key")} AS parent_session_key,
              json_array(${changeColumns.join(", ")}) AS state,
              ${this.#modelUsageState()} AS model_usage,
              (SELECT COUNT(*) || ':' || IFNULL(MAX(m.id), -1) || ':' || ${messageColumns.join(" || ':' || ")}
                 FROM messages m WHERE m.session_id = s.id) AS message_key,
              (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at
         FROM sessions s
        WHERE s.id IS NOT NULL
        ORDER BY s.id`,
    );
    const rewrites = this.#rewrittenContentDigests();
    return rows.map((row) => ({
      dbPath: this.path,
      sessionId: row.id,
      fingerprint: hermesFingerprint({
        state: row.state,
        parentEndReason: row.parent_end_reason,
        parentEndedAt: row.parent_ended_at,
        parentSessionKey: row.parent_session_key,
        modelUsage: row.model_usage,
        messageKey: row.message_key,
        rewriteDigest: rewrites?.get(row.id) ?? null,
      }),
      activity: Math.max(finiteOr(row.started_at, 0), finiteOr(row.last_message_at, 0)),
    }));
  }

  /** One session's rows, or null when it no longer exists. */
  loadSession(sessionId: string): HermesLoadedSession | null {
    const sessionColumns = SESSION_COLUMNS.map(
      (column) => `${this.#column("sessions", "s", column)} AS ${column}`,
    );
    const session = queryRow<HermesSessionRow>(
      this.#db,
      `SELECT CAST(s.id AS TEXT) AS id, s.started_at, ${sessionColumns.join(", ")},
              ${this.#parentEndReason()} AS parent_end_reason,
              ${this.#parentColumn("ended_at")} AS parent_ended_at,
              ${this.#parentColumn("session_key")} AS parent_session_key
         FROM sessions s WHERE s.id = ?1`,
      [sessionId],
    );
    if (session == null) {
      return null;
    }
    const messageColumns = MESSAGE_COLUMNS.map(
      (column) => `${this.#column("messages", "m", column)} AS ${column}`,
    );
    const messages = queryRows<HermesMessageRow>(
      this.#db,
      `SELECT m.id, m.role, m.timestamp, ${messageColumns.join(", ")}
         FROM messages m WHERE m.session_id = ?1 ORDER BY m.id`,
      [sessionId],
    );
    const modelUsage = this.#hasTable("session_model_usage")
      ? queryRows<HermesModelUsageRow>(
          this.#db,
          `SELECT ${MODEL_USAGE_COLUMNS.map((column) => `${this.#column("session_model_usage", "u", column)} AS ${column}`).join(", ")}
             FROM session_model_usage u WHERE u.session_id = ?1
            ORDER BY ${MODEL_USAGE_ORDER.map((column) => this.#column("session_model_usage", "u", column)).join(", ")}`,
          [sessionId],
        )
      : [];
    return { session, messages, modelUsage };
  }

  close(): void {
    this.#db.close(false);
  }

  #modelUsageState(): string {
    if (!this.#hasTable("session_model_usage")) {
      return "NULL";
    }
    const columns = MODEL_USAGE_COLUMNS.map((column) =>
      this.#column("session_model_usage", "u", column),
    );
    return `(SELECT json_group_array(usage_row) FROM (
               SELECT json_array(${columns.join(", ")}) AS usage_row
                 FROM session_model_usage u WHERE u.session_id = s.id
                ORDER BY usage_row))`;
  }

  /** Null when `transcript_revision` covers in-place rewrites. A database from
   * before that column has no rewrite signal, so each session's rewritable
   * message columns are hashed instead. */
  #rewrittenContentDigests(): Map<string, string> | null {
    if (this.#has("sessions", "transcript_revision")) {
      return null;
    }
    const columns = REWRITE_COLUMNS.filter((column) => this.#has("messages", column));
    const hashes = new Map<string, Hash>();
    const statement = this.#db.query(
      `SELECT CAST(m.session_id AS TEXT) AS session_id, ${columns.map((column) => `m.${column}`).join(", ")}
         FROM messages m ORDER BY m.id`,
    );
    try {
      for (const row of statement.iterate() as IterableIterator<Record<string, unknown>>) {
        const sessionId = row.session_id as string;
        let hash = hashes.get(sessionId);
        if (hash == null) {
          hash = createHash("sha256");
          hashes.set(sessionId, hash);
        }
        for (const column of columns) {
          updateWithValue(hash, row[column]);
        }
      }
    } finally {
      statement.finalize();
    }
    return new Map(
      [...hashes].map(([sessionId, hash]) => [sessionId, hash.digest("hex").slice(0, 16)]),
    );
  }

  #parentEndReason(): string {
    return this.#parentColumn("end_reason");
  }

  /** A parent's column decides whether a child is a subagent or a
   * compression, reset, or branch continuation. */
  #parentColumn(column: string): string {
    return this.#has("sessions", "parent_session_id") && this.#has("sessions", column)
      ? `(SELECT p.${column} FROM sessions p WHERE p.id = s.parent_session_id)`
      : "NULL";
  }

  #column(table: string, alias: string, column: string): string {
    return this.#has(table, column) ? `${alias}.${column}` : "NULL";
  }

  #requireColumns(table: string, required: readonly string[]): void {
    const missing = required.filter((column) => !this.#has(table, column));
    if (missing.length > 0) {
      throw new HermesStoreError(
        `not a Hermes session store: table ${table} lacks ${missing.join(", ")}`,
      );
    }
  }

  #hasTable(table: string): boolean {
    return this.#columnsOf(table).size > 0;
  }

  #has(table: string, column: string): boolean {
    return this.#columnsOf(table).has(column);
  }

  #columnsOf(table: string): Set<string> {
    let columns = this.#columns.get(table);
    if (columns == null) {
      columns = new Set(
        queryRows<{ name: string }>(this.#db, "SELECT name FROM pragma_table_info(?1)", [
          table,
        ]).map((row) => row.name),
      );
      this.#columns.set(table, columns);
    }
    return columns;
  }
}

export interface HermesChangeKeyParts {
  state: string;
  parentEndReason: string | null;
  parentEndedAt: number | null;
  parentSessionKey: string | null;
  modelUsage: string | null;
  messageKey: string | null;
  rewriteDigest: string | null;
}

/** A rewind or compaction flips `active` and `compacted` on existing rows
 * without adding one, so the message key carries those sums beside the row
 * count and newest row ID. */
export function hermesFingerprint(parts: HermesChangeKeyParts): string {
  const digest = createHash("sha256");
  for (const value of [
    parts.state,
    parts.parentEndReason,
    parts.parentEndedAt,
    parts.parentSessionKey,
    parts.modelUsage,
  ]) {
    updateWithValue(digest, value);
  }
  return `hermes:v2:${digest.digest("hex").slice(0, 16)}:${parts.messageKey ?? "0:-1:-1:-1"}:${parts.rewriteDigest ?? "-1"}`;
}

function updateWithValue(hash: Hash, value: unknown): void {
  if (value == null) {
    hash.update("\0n");
  } else if (value instanceof Uint8Array) {
    hash.update(`\0b${value.length}:`).update(value);
  } else {
    const text = String(value);
    hash.update(`\0${typeof value === "number" ? "d" : "s"}${text.length}:`).update(text);
  }
}

function finiteOr(value: number | null, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
