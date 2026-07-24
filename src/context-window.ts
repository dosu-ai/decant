import type { Database } from "bun:sqlite";

/** Baseline for Claude models whose published limit is still 200k. */
const DEFAULT_WINDOW_TOKENS = 200_000;
/** Current long-context Claude models use 1M as both the default and maximum. */
const EXTENDED_WINDOW_TOKENS = 1_000_000;
const ONE_MILLION_CLAUDE_FAMILIES = [
  /(?:^|-)opus-(?:5|4-(?:6|7|8))(?:-|$)/,
  /(?:^|-)sonnet-(?:5|4-6)(?:-|$)/,
  /(?:^|-)fable-5(?:-|$)/,
  /(?:^|-)mythos-(?:5|preview)(?:-|$)/,
];

/**
 * Claude Code logs do not record the model's context-window size. Infer it
 * from Anthropic's published model limits, while preserving historical 1M
 * beta sessions when their observed usage already proves a larger window.
 */
export function inferClaudeContextWindowTokens(model: string | null, maxSeen: number): number {
  if (maxSeen > DEFAULT_WINDOW_TOKENS) {
    return EXTENDED_WINDOW_TOKENS;
  }
  if (model == null) {
    return DEFAULT_WINDOW_TOKENS;
  }
  const normalized = model.toLowerCase().replace(/[._/:]/g, "-");
  return ONE_MILLION_CLAUDE_FAMILIES.some((pattern) => pattern.test(normalized))
    ? EXTENDED_WINDOW_TOKENS
    : DEFAULT_WINDOW_TOKENS;
}

export interface ContextWindowPoint {
  seq: number;
  timestamp: string | null;
  /** 1-based user turn this API call belongs to (machine summaries excluded). */
  turn: number;
  /** Window occupancy for this API call: input + cache_read + cache_creation. */
  context_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
}

export interface ContextWindowCompaction {
  seq: number;
  timestamp: string | null;
  /** "auto" | "manual" when compactMetadata is present in the source record. */
  trigger: string | null;
  /** Tokens in the window when compaction fired; falls back to the last point before it. */
  pre_tokens: number | null;
  /** Occupancy of the first API call after the boundary. */
  post_tokens: number | null;
}

export interface ContextWindowTimeline {
  session_id: number;
  tool: string;
  /** Null when the session has no usable usage data (e.g. Codex until Phase 2). */
  window_tokens: number | null;
  /** True whenever window_tokens comes from Claude's model limit rather than the log. */
  window_inferred: boolean;
  peak_tokens: number;
  peak_pct: number | null;
  /** User turns counted with the same rule enrich uses for session.turn_count. */
  turn_count: number;
  points: ContextWindowPoint[];
  compactions: ContextWindowCompaction[];
}

/** Compaction/sidechain markers mined from a message's raw source record. */
export interface MessageRawMeta {
  isSidechain: boolean;
  subtype: string | null;
  rawType: string | null;
  isCompactSummary: boolean;
  compactTrigger: string | null;
  compactPreTokens: number | null;
}

/** Single-parse extraction of every raw field the read path needs; expects the
 * message table aliased as `m`. Multi-path json_extract returns one JSON array
 * per row, so large raw payloads are parsed once, not once per field. */
export const MESSAGE_RAW_META_SQL = `json_extract(m.raw, '$.isSidechain', '$.subtype',
  '$.type', '$.isCompactSummary', '$.compactMetadata.trigger', '$.compactMetadata.preTokens')`;

/** Parses the MESSAGE_RAW_META_SQL array; malformed raw degrades to defaults. */
export function parseMessageRawMeta(value: string | null): MessageRawMeta {
  const none: MessageRawMeta = {
    isSidechain: false,
    subtype: null,
    rawType: null,
    isCompactSummary: false,
    compactTrigger: null,
    compactPreTokens: null,
  };
  if (value == null) {
    return none;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return none;
  }
  if (!Array.isArray(parsed)) {
    return none;
  }
  const [sidechain, subtype, rawType, compactSummary, trigger, preTokens] = parsed as unknown[];
  return {
    isSidechain: sidechain === true,
    subtype: typeof subtype === "string" ? subtype : null,
    rawType: typeof rawType === "string" ? rawType : null,
    isCompactSummary: compactSummary === true,
    compactTrigger: typeof trigger === "string" ? trigger : null,
    compactPreTokens:
      typeof preTokens === "number" && Number.isFinite(preTokens) && preTokens >= 0
        ? preTokens
        : null,
  };
}

/** True for both compaction shapes: Claude's system/compact_boundary records
 * and Codex's top-level `compacted` records. */
export function isCompactBoundary(meta: MessageRawMeta): boolean {
  return meta.subtype === "compact_boundary" || meta.rawType === "compacted";
}

interface UsageColumns {
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

/** Shared occupancy definition for the timeline and per-message transcript chips. */
export function contextTokensFromUsage(row: UsageColumns): number | null {
  if (
    row.input_tokens == null &&
    row.cache_read_tokens == null &&
    row.cache_creation_tokens == null
  ) {
    return null;
  }
  const total =
    (row.input_tokens ?? 0) + (row.cache_read_tokens ?? 0) + (row.cache_creation_tokens ?? 0);
  return total > 0 ? total : null;
}

interface TimelineRow {
  seq: number;
  timestamp: string | null;
  role: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  raw_meta: string | null;
  has_text: number;
}

export function contextWindowForSession(
  db: Database,
  sessionId: number,
): ContextWindowTimeline | null {
  const session = db
    .query(
      `SELECT id, tool, is_subagent,
              model,
              json_extract(raw_meta, '$.model_context_window') AS explicit_window
       FROM session WHERE id = ?1`,
    )
    .get(sessionId) as {
    id: number;
    tool: string;
    is_subagent: number;
    model: string | null;
    explicit_window: number | null;
  } | null;
  if (session == null) {
    return null;
  }
  const explicitWindow =
    typeof session.explicit_window === "number" && session.explicit_window > 0
      ? session.explicit_window
      : null;

  // has_text mirrors enrich's hasRealText turn rule (a text block that is not
  // an interruption marker and not a slash-command wrapper) so per-point turn
  // numbers line up with the session's stored turn_count.
  const rows = db
    .query(
      `SELECT m.seq, m.timestamp, m.role,
              m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
              ${MESSAGE_RAW_META_SQL} AS raw_meta,
              EXISTS(
                SELECT 1 FROM block b
                WHERE b.message_id = m.id AND b.type = 'text'
                  AND TRIM(COALESCE(b.text, '')) != ''
                  AND b.text NOT LIKE '[Request interrupted by user%'
                  AND b.text NOT LIKE '%<command-name>%'
              ) AS has_text
       FROM message m
       WHERE m.session_id = ?1 AND m.role IN ('assistant', 'system', 'user')
       ORDER BY m.seq`,
    )
    .all(sessionId) as TimelineRow[];

  const points: ContextWindowPoint[] = [];
  const compactions: ContextWindowCompaction[] = [];
  let turn = 0;
  let lastContextSinceCompaction: number | null = null;
  for (const row of rows) {
    const meta = parseMessageRawMeta(row.raw_meta);
    // Main Claude transcripts can contain copied sidechain rows that belong to
    // a child agent, so exclude those from the parent's curve. In a standalone
    // subagent archive those same isSidechain rows are the session's primary
    // thread and must remain visible.
    if (meta.isSidechain && session.is_subagent === 0) {
      continue;
    }
    if (row.role === "user") {
      if (row.has_text !== 0 && !meta.isCompactSummary) {
        turn += 1;
      }
      continue;
    }
    if (row.role === "system") {
      if (isCompactBoundary(meta)) {
        compactions.push({
          seq: row.seq,
          timestamp: row.timestamp,
          trigger: meta.compactTrigger,
          pre_tokens: meta.compactPreTokens ?? lastContextSinceCompaction,
          post_tokens: null,
        });
        lastContextSinceCompaction = null;
      }
      continue;
    }
    const context = contextTokensFromUsage(row);
    if (context == null) {
      continue;
    }
    const point: ContextWindowPoint = {
      seq: row.seq,
      timestamp: row.timestamp,
      turn: Math.max(1, turn),
      context_tokens: context,
      input_tokens: row.input_tokens ?? 0,
      cache_read_tokens: row.cache_read_tokens ?? 0,
      cache_creation_tokens: row.cache_creation_tokens ?? 0,
      output_tokens: row.output_tokens ?? 0,
    };
    const pending = compactions.at(-1);
    if (pending != null && pending.post_tokens == null && pending.seq < point.seq) {
      pending.post_tokens = point.context_tokens;
    }
    points.push(point);
    lastContextSinceCompaction = point.context_tokens;
  }

  let peak = 0;
  for (const point of points) {
    peak = Math.max(peak, point.context_tokens);
  }
  let maxSeen = peak;
  for (const compaction of compactions) {
    maxSeen = Math.max(maxSeen, compaction.pre_tokens ?? 0);
  }
  const inferredWindow =
    session.tool !== "claude_code" || maxSeen <= 0
      ? null
      : inferClaudeContextWindowTokens(session.model, maxSeen);
  const window = explicitWindow ?? inferredWindow;
  const displayTurnCount = Math.max(turn, points.length > 0 ? 1 : 0);

  return {
    session_id: session.id,
    tool: session.tool,
    window_tokens: window,
    window_inferred: explicitWindow == null && window != null,
    peak_tokens: peak,
    peak_pct: window == null ? null : peak / window,
    turn_count: displayTurnCount,
    points,
    compactions,
  };
}

/** Persist the session's context-window rollups while its rows are hot in the
 * ingest transaction. Turn count is written from the same main-thread rules so
 * migrated archives also stop treating compact summaries as user prompts.
 * peak_context_tokens doubles as the materialization marker: non-null means
 * computed (0 when the session has no usable usage). */
export function materializeContextWindow(db: Database, sessionId: number): boolean {
  const timeline = contextWindowForSession(db, sessionId);
  if (timeline == null) {
    return false;
  }
  db.query(
    `UPDATE session
     SET context_window_tokens = ?2, peak_context_tokens = ?3,
         compaction_count = ?4, turn_count = ?5
     WHERE id = ?1`,
  ).run(
    sessionId,
    timeline.window_tokens,
    timeline.peak_tokens,
    timeline.compactions.length,
    timeline.turn_count,
  );
  return true;
}

/** One-time upgrade/backfill path, mirroring the economics materializer: sync
 * calls this so sessions ingested before v11 gain rollups without re-ingest. */
export function materializeMissingContextWindows(db: Database): number {
  const rows = db.query("SELECT id FROM session WHERE peak_context_tokens IS NULL").all() as {
    id: number;
  }[];
  if (rows.length === 0) {
    return 0;
  }
  const persist = db.transaction((items: { id: number }[]) => {
    let materialized = 0;
    for (const row of items) {
      if (materializeContextWindow(db, row.id)) {
        materialized += 1;
      }
    }
    return materialized;
  });
  return persist(rows);
}
