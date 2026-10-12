// OpenCode 1.x storage: `session`, `message`, and `part` tables. OpenCodeStore
// reads these rows read-only; they hold JSON text exactly as OpenCode wrote it,
// so a malformed `data` value reaches the parser unchanged and becomes a
// diagnostic there.

/** One 1.x `session` row. Columns added after v1.2.0 (`cost`, `tokens_*`,
 * `agent`, `model`) read as NULL on older databases, because OpenCodeStore
 * projects every column through `pragma_table_info`. */
export interface OpenCodeLegacySessionRow {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  slug: string | null;
  directory: string | null;
  title: string | null;
  version: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  /** JSON `{ messageID, partID?, snapshot?, diff? }`. */
  revert: string | null;
  agent: string | null;
  /** JSON `{ id, providerID, variant? }`, 1.18+ only. */
  model: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

/** `data` is the message info minus `id` and `sessionID`. */
export interface OpenCodeLegacyMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

/** `data` is the part minus `id`, `sessionID`, and `messageID`. */
export interface OpenCodeLegacyPartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}
