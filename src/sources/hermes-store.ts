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
import { createHash } from "node:crypto";
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

/** The session columns that change when a session does. `last_activity_at`
 * is a heartbeat and `last_read_at`, `pinned`, and `hidden` are UI state, so
 * none of them is in the key: a session left open would otherwise re-ingest
 * every minute without anything new to read. */
const CHANGE_COLUMNS = [
  "title",
  "model",
  "parent_session_id",
  "ended_at",
  "end_reason",
  "cwd",
  "git_branch",
  "git_repo_root",
  "message_count",
  "api_call_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "archived",
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
      state: string;
      message_key: string | null;
      last_message_at: number | null;
    }>(
      this.#db,
      `SELECT CAST(s.id AS TEXT) AS id, s.started_at,
              ${this.#parentEndReason()} AS parent_end_reason,
              json_array(${changeColumns.join(", ")}) AS state,
              (SELECT COUNT(*) || ':' || IFNULL(MAX(m.id), -1) || ':' || ${messageColumns.join(" || ':' || ")}
                 FROM messages m WHERE m.session_id = s.id) AS message_key,
              (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_message_at
         FROM sessions s
        WHERE s.id IS NOT NULL
        ORDER BY s.id`,
    );
    return rows.map((row) => ({
      dbPath: this.path,
      sessionId: row.id,
      fingerprint: hermesFingerprint(row.state, row.parent_end_reason, row.message_key),
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
              ${this.#parentColumn("ended_at")} AS parent_ended_at
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
            ORDER BY u.model, u.billing_provider, u.task`,
          [sessionId],
        )
      : [];
    return { session, messages, modelUsage };
  }

  close(): void {
    this.#db.close(false);
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

/** The session's own changing columns, its parent's end reason (which decides
 * whether it is a subagent), and its message set's count, newest row ID, and
 * active and archived counts. A rewind or compaction flips `active` and
 * `compacted` on existing rows without adding one, so those sums are in the
 * key. The title goes in only as part of a digest. */
export function hermesFingerprint(
  state: string,
  parentEndReason: string | null,
  messageKey: string | null,
): string {
  const digest = createHash("sha256")
    .update(state)
    .update("\0")
    .update(parentEndReason ?? "")
    .digest("hex")
    .slice(0, 16);
  return `hermes:v1:${digest}:${messageKey ?? "0:-1:-1:-1"}`;
}

function finiteOr(value: number | null, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
