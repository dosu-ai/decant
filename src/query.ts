import type { Database } from "bun:sqlite";
import {
  contextTokensFromUsage,
  isCompactBoundary,
  MESSAGE_RAW_META_SQL,
  parseMessageRawMeta,
} from "./context-window.ts";
import { sessionDatePredicate } from "./date-filter.ts";
import { visibleSessionPredicate } from "./session-visibility.ts";
import { preview } from "./tools.ts";

export interface SessionSummary {
  id: number;
  tool: string;
  source_session_id: string;
  title: string | null;
  project_path: string | null;
  model: string | null;
  reasoning_effort: string | null;
  reasoning_effort_levels: string[];
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  estimated_cost_usd: number;
  is_archived: boolean;
  is_subagent: boolean;
  parent_session_id: number | null;
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
  context_window_tokens: number | null;
  peak_context_tokens: number | null;
  compaction_count: number;
  subagent_count: number;
  subagent_estimated_cost_usd: number;
  subagents?: SessionSummary[];
}

export interface ListFilter {
  tool?: string | null;
  model?: string | null;
  project?: string | null;
  includeSubagents?: boolean;
  includeNestedSubagents?: boolean;
  limit?: number;
  offset?: number;
  from?: string | null;
  to?: string | null;
}

interface SessionSummaryRow
  extends Omit<
    SessionSummary,
    "is_archived" | "is_subagent" | "reasoning_effort_levels" | "subagents"
  > {
  is_archived: number;
  is_subagent: number;
  reasoning_effort_levels_json: string | null;
}

const SESSION_SUMMARY_SELECT = `
  SELECT s.id, s.tool, s.source_session_id, s.title, p.path AS project_path,
         s.model, s.reasoning_effort,
         s.reasoning_effort_levels AS reasoning_effort_levels_json,
         s.started_at, s.ended_at, s.message_count,
         s.total_input_tokens, s.total_output_tokens, s.estimated_cost_usd,
         s.is_archived, s.is_subagent, s.parent_session_id, s.spawn_tool_use_id,
         s.agent_id, s.agent_type, s.spawn_depth,
         s.context_window_tokens, s.peak_context_tokens, s.compaction_count,
         COALESCE(sa.subagent_count, 0) AS subagent_count,
         COALESCE(sa.subagent_estimated_cost_usd, 0.0) AS subagent_estimated_cost_usd
  FROM session s
  LEFT JOIN project p ON p.id = s.project_id
  LEFT JOIN (
    SELECT parent_session_id, COUNT(*) AS subagent_count,
           COALESCE(SUM(estimated_cost_usd), 0.0) AS subagent_estimated_cost_usd
    FROM session
    WHERE is_subagent = 1 AND parent_session_id IS NOT NULL
    GROUP BY parent_session_id
  ) sa ON sa.parent_session_id = s.id`;

export function listSessions(db: Database, filter: ListFilter = {}): SessionSummary[] {
  const limit = normalizeLimit(filter.limit, 50);
  const offset = normalizeOffset(filter.offset);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tool != null) {
    clauses.push("s.tool = ?");
    params.push(filter.tool);
  }
  if (filter.model != null) {
    clauses.push("COALESCE(s.model, '') = ?");
    params.push(filter.model);
  }
  if (filter.project != null) {
    clauses.push("COALESCE(p.path, '') = ?");
    params.push(filter.project);
  }
  if (filter.includeSubagents !== true) {
    clauses.push("s.is_subagent = 0");
  }
  clauses.push(visibleSessionPredicate("s"));
  const date = sessionDatePredicate("s", filter);
  if (date.sql !== "") {
    clauses.push(date.sql);
    params.push(...date.params);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .query(`${SESSION_SUMMARY_SELECT}${where} ORDER BY s.started_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as SessionSummaryRow[];
  const summaries = withDisplayTitles(db, rows.map(mapSessionSummary));
  return filter.includeNestedSubagents === true ? withNestedSubagents(db, summaries) : summaries;
}

export interface SearchHit {
  session_id: number;
  session_title: string | null;
  tool: string;
  block_id: number;
  snippet: string;
}

export function search(db: Database, query: string, limitValue = 30): SearchHit[] {
  const limit = normalizeLimit(limitValue, 30);
  return db
    .query(
      `SELECT b.session_id, s.title AS session_title, s.tool, b.id AS block_id,
              COALESCE(snippet(block_fts, 0, '[', ']', '…', 12),
                       snippet(block_fts, 1, '[', ']', '…', 12),
                       snippet(block_fts, 2, '[', ']', '…', 12), '') AS snippet
       FROM block_fts
       JOIN block b ON b.id = block_fts.rowid
       JOIN session s ON s.id = b.session_id
       WHERE block_fts MATCH ?1
       ORDER BY bm25(block_fts)
       LIMIT ?2`,
    )
    .all(query, limit) as SearchHit[];
}

export interface BlockView {
  ordinal: number;
  block_type: string;
  text: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input: string | null;
  tool_result: string | null;
}

export interface MessageView {
  seq: number;
  role: string;
  timestamp: string | null;
  model: string | null;
  /** Window occupancy for this API call (input + cache_read + cache_creation);
   * null on rows without usage (user/tool/system, deduped stream lines). */
  context_tokens: number | null;
  output_tokens: number | null;
  is_sidechain: boolean;
  is_compact_boundary: boolean;
  compact_trigger: string | null;
  compact_pre_tokens: number | null;
  is_compact_summary: boolean;
  blocks: BlockView[];
}

/**
 * Whole-session counts that stay correct when `messages` holds only one page.
 * A reader counting the returned messages would undercount every paged
 * transcript, so these are aggregated across the session regardless of window.
 */
export interface SessionTotals {
  /** Assistant messages that have something to render. */
  reply_count: number;
  /** `tool_use` blocks across the session. */
  tool_call_count: number;
}

export interface SessionDetail {
  summary: SessionSummary;
  messages: MessageView[];
  subagents: SubagentDetail[];
  /**
   * Present on a real session read. Absent on the `subagents` stubs, which
   * carry structure and a summary but no messages, exactly like the paging
   * fields below.
   */
  totals?: SessionTotals;
  message_offset?: number;
  message_limit?: number | null;
  has_more_messages?: boolean;
}

export interface SubagentDetail extends SessionDetail {
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
}

export interface SessionReadOptions {
  messageLimit?: number | null;
  messageOffset?: number | null;
}

export interface SessionOutlineItem {
  seq: number;
  text: string;
}

interface SessionOutlineRow extends SessionOutlineItem {
  raw_meta: string | null;
}

interface MessageBlockRow {
  message_id: number;
  seq: number;
  role: string | null;
  timestamp: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  raw_meta: string | null;
  block_ordinal: number | null;
  block_type: string | null;
  text: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input: string | null;
  tool_result: string | null;
}

export function getSession(
  db: Database,
  id: number,
  options: SessionReadOptions = {},
): SessionDetail | null {
  const summaryRow = db
    .query(
      `SELECT s.id, s.tool, s.source_session_id, s.title, p.path AS project_path,
              s.model, s.reasoning_effort,
              s.reasoning_effort_levels AS reasoning_effort_levels_json,
              s.started_at, s.ended_at, s.message_count,
              s.total_input_tokens, s.total_output_tokens, s.estimated_cost_usd,
              s.is_archived, s.is_subagent, s.parent_session_id, s.spawn_tool_use_id,
              s.agent_id, s.agent_type, s.spawn_depth,
              s.context_window_tokens, s.peak_context_tokens, s.compaction_count,
              COALESCE(sa.subagent_count, 0) AS subagent_count,
              COALESCE(sa.subagent_estimated_cost_usd, 0.0) AS subagent_estimated_cost_usd
       FROM session s
       LEFT JOIN project p ON p.id = s.project_id
       LEFT JOIN (
         SELECT parent_session_id, COUNT(*) AS subagent_count,
                COALESCE(SUM(estimated_cost_usd), 0.0) AS subagent_estimated_cost_usd
         FROM session
         WHERE is_subagent = 1 AND parent_session_id IS NOT NULL
         GROUP BY parent_session_id
       ) sa ON sa.parent_session_id = s.id
       WHERE s.id = ?1`,
    )
    .get(id) as SessionSummaryRow | null;
  if (summaryRow == null) {
    return null;
  }

  const messages: MessageView[] = [];
  const messageLimit =
    options.messageLimit != null && options.messageLimit > 0 ? options.messageLimit : null;
  const messageOffset = normalizeOffset(options.messageOffset);
  const rows =
    messageLimit == null
      ? (db
          .query(
            `SELECT m.id AS message_id, m.seq, m.role, m.timestamp, m.model,
                    m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
                    ${MESSAGE_RAW_META_SQL} AS raw_meta,
                    b.ordinal AS block_ordinal, b.type AS block_type, b.text,
                    b.tool_name, b.tool_use_id, b.tool_input, b.tool_result
             FROM message m
             LEFT JOIN block b ON b.message_id = m.id
             WHERE m.session_id = ?1
             ORDER BY m.seq, b.ordinal`,
          )
          .all(id) as MessageBlockRow[])
      : (db
          .query(
            `WITH page_message AS (
               SELECT id
               FROM message
               WHERE session_id = ?1
               ORDER BY seq
               LIMIT ?2 OFFSET ?3
             )
             SELECT m.id AS message_id, m.seq, m.role, m.timestamp, m.model,
                    m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
                    ${MESSAGE_RAW_META_SQL} AS raw_meta,
                    b.ordinal AS block_ordinal, b.type AS block_type, b.text,
                    b.tool_name, b.tool_use_id, b.tool_input, b.tool_result
             FROM page_message pm
             JOIN message m ON m.id = pm.id
             LEFT JOIN block b ON b.message_id = m.id
             ORDER BY m.seq, b.ordinal`,
          )
          .all(id, messageLimit, messageOffset) as MessageBlockRow[]);

  let currentMessageId: number | null = null;
  for (const row of rows) {
    if (currentMessageId !== row.message_id) {
      currentMessageId = row.message_id;
      const rawMeta = parseMessageRawMeta(row.raw_meta);
      messages.push({
        seq: row.seq,
        role: row.role ?? "unknown",
        timestamp: row.timestamp,
        model: row.model,
        context_tokens: contextTokensFromUsage(row),
        output_tokens: row.output_tokens,
        is_sidechain: rawMeta.isSidechain,
        is_compact_boundary: isCompactBoundary(rawMeta),
        compact_trigger: rawMeta.compactTrigger,
        compact_pre_tokens: rawMeta.compactPreTokens,
        is_compact_summary: rawMeta.isCompactSummary,
        blocks: [],
      });
    }
    if (row.block_type != null) {
      messages.at(-1)?.blocks.push({
        ordinal: row.block_ordinal ?? 0,
        block_type: row.block_type,
        text: row.text,
        tool_name: row.tool_name,
        tool_use_id: row.tool_use_id,
        tool_input: row.tool_input,
        tool_result: row.tool_result,
      });
    }
  }

  // Titles for the root and its whole descendant tree resolve in one batch so a
  // session with many subagents costs two queries, not two per subagent.
  const descendantRows = db
    .query(
      `${SESSION_SUMMARY_SELECT}
       WHERE s.id IN (
         WITH RECURSIVE subtree(id, depth) AS (
           SELECT id, 1 FROM session WHERE parent_session_id = ?1
           UNION ALL
           SELECT child.id, subtree.depth + 1
           FROM session child
           JOIN subtree ON subtree.id = child.parent_session_id
           WHERE subtree.depth < 5
         )
         SELECT id FROM subtree
       )
       ORDER BY COALESCE(s.spawn_depth, 0), s.started_at, s.id`,
    )
    .all(id) as SessionSummaryRow[];
  const titled = withDisplayTitles(db, [summaryRow, ...descendantRows].map(mapSessionSummary));
  const rootSummary = titled[0] ?? mapSessionSummary(summaryRow);
  const childrenByParent = new Map<number, SessionSummary[]>();
  for (const child of titled.slice(1)) {
    if (child.parent_session_id == null) {
      continue;
    }
    const siblings = childrenByParent.get(child.parent_session_id);
    if (siblings == null) {
      childrenByParent.set(child.parent_session_id, [child]);
    } else {
      siblings.push(child);
    }
  }

  return {
    summary: rootSummary,
    messages,
    subagents: buildSubagentDetails(childrenByParent, id, 0, new Set([id])),
    totals: getSessionTotals(db, id),
    message_offset: messageLimit != null ? messageOffset : undefined,
    message_limit: messageLimit,
    has_more_messages:
      messageLimit != null ? messageOffset + messages.length < summaryRow.message_count : undefined,
  };
}

/**
 * Session-wide reply and tool-call counts.
 *
 * The renderable-block predicate mirrors the reader's own rule: a text or
 * thinking block counts only when it carries non-whitespace text, and tool
 * blocks always count. Keeping the two in step matters because these totals are
 * displayed next to a transcript the reader can also count by hand.
 */
function getSessionTotals(db: Database, id: number): SessionTotals {
  const row = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM message m
           WHERE m.session_id = ?1 AND m.role = 'assistant'
             AND EXISTS (
               SELECT 1 FROM block b
               WHERE b.message_id = m.id
                 AND (b.type IN ('tool_use', 'tool_result')
                      OR (b.type IN ('text', 'thinking') AND TRIM(COALESCE(b.text, '')) <> ''))
             )
         ) AS reply_count,
         (SELECT COUNT(*) FROM block b
           WHERE b.session_id = ?1 AND b.type = 'tool_use'
         ) AS tool_call_count`,
    )
    .get(id) as { reply_count: number; tool_call_count: number } | null;
  return {
    reply_count: row?.reply_count ?? 0,
    tool_call_count: row?.tool_call_count ?? 0,
  };
}

/**
 * Return the lightweight prompt outline independently from paged transcript
 * bodies. This keeps every turn reachable from the sticky navigation without
 * loading every rich block, tool result, and code sample up front.
 */
export function getSessionOutline(db: Database, id: number): SessionOutlineItem[] | null {
  const session = db.query("SELECT 1 AS present FROM session WHERE id = ?1").get(id);
  if (session == null) {
    return null;
  }
  const rows = db
    .query(
      `SELECT m.seq,
              (
                SELECT SUBSTR(b.text, 1, 240)
                FROM block b
                WHERE b.message_id = m.id AND b.type = 'text'
                  AND TRIM(COALESCE(b.text, '')) != ''
                ORDER BY b.ordinal
                LIMIT 1
              ) AS text,
              ${MESSAGE_RAW_META_SQL} AS raw_meta
       FROM message m
       WHERE m.session_id = ?1 AND m.role = 'user'
         AND EXISTS (
           SELECT 1
           FROM block b
           WHERE b.message_id = m.id AND b.type = 'text'
             AND TRIM(COALESCE(b.text, '')) != ''
         )
       ORDER BY m.seq`,
    )
    .all(id) as SessionOutlineRow[];
  return rows
    .filter((row) => !parseMessageRawMeta(row.raw_meta).isCompactSummary)
    .map(({ seq, text }) => ({ seq, text }));
}

function buildSubagentDetails(
  childrenByParent: Map<number, SessionSummary[]>,
  parentId: number,
  depth: number,
  seen: Set<number>,
): SubagentDetail[] {
  if (depth >= 5) {
    return [];
  }
  const details: SubagentDetail[] = [];
  for (const summary of childrenByParent.get(parentId) ?? []) {
    if (seen.has(summary.id)) {
      continue;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(summary.id);
    details.push({
      summary,
      messages: [],
      subagents: buildSubagentDetails(childrenByParent, summary.id, depth + 1, nextSeen),
      spawn_tool_use_id: summary.spawn_tool_use_id,
      agent_id: summary.agent_id,
      agent_type: summary.agent_type,
      spawn_depth: summary.spawn_depth,
    });
  }
  return details;
}

export interface ProjectSummary {
  id: number;
  path: string;
  name: string | null;
  sessions: number;
  estimated_cost_usd: number;
  last_seen_at: string | null;
  is_worktree: boolean;
  root_path: string | null;
  worktree_label: string | null;
  worktree_tool: string | null;
  root_source: string | null;
  worktree_count: number;
  session_tools: string[];
}

interface ProjectSummaryRow extends Omit<ProjectSummary, "is_worktree" | "session_tools"> {
  is_worktree: number;
  session_tools: string | null;
}

export function listProjects(db: Database): ProjectSummary[] {
  const rows = db
    .query(
      `SELECT p.id, p.path, p.name,
              COALESCE(SUM(CASE WHEN s.is_subagent = 0 THEN 1 ELSE 0 END), 0) AS sessions,
              COALESCE(SUM(s.estimated_cost_usd), 0.0) AS estimated_cost_usd,
              MAX(s.ended_at) AS last_seen_at,
              p.is_worktree, p.root_path, p.worktree_label, p.worktree_tool, p.root_source,
              (SELECT COUNT(*)
               FROM project child
               WHERE child.is_worktree = 1 AND child.root_path = p.path) AS worktree_count,
              GROUP_CONCAT(DISTINCT s.tool) AS session_tools
       FROM project p
       LEFT JOIN session s ON s.project_id = p.id
       GROUP BY p.id, p.path, p.name
       ORDER BY sessions DESC, p.path ASC`,
    )
    .all() as ProjectSummaryRow[];
  return rows.map((row) => ({
    ...row,
    is_worktree: row.is_worktree !== 0,
    session_tools:
      row.session_tools
        ?.split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool !== "")
        .sort() ?? [],
  }));
}

function mapSessionSummary(row: SessionSummaryRow): SessionSummary {
  const { reasoning_effort_levels_json: levelsJson, ...summary } = row;
  return {
    ...summary,
    reasoning_effort_levels: parseReasoningEffortLevels(levelsJson),
    is_archived: row.is_archived !== 0,
    is_subagent: row.is_subagent !== 0,
  };
}

function parseReasoningEffortLevels(value: string | null | undefined): string[] {
  if (value == null || value.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((level): level is string => typeof level === "string" && level !== "")
      : [];
  } catch {
    return [];
  }
}

function withDisplayTitles(db: Database, sessions: SessionSummary[]): SessionSummary[] {
  if (sessions.length === 0) {
    return sessions;
  }
  const placeholders = sessions.map(() => "?").join(", ");
  const ids = sessions.map((session) => session.id);
  // Pass 1: fetch only the first plausibly-usable candidate text per session.
  // The correlated subquery stops at the first hit instead of walking every
  // user message, and CROSS JOIN + INDEXED BY pin the plan to messages ->
  // blocks; left to its own devices SQLite starts from every text block in the
  // archive, which turns each title lookup into a multi-hundred-ms full scan.
  //
  // AGENT_CONTEXT_SQL must skip a subset (never a superset) of what
  // isAgentContextText skips: anything it wrongly lets through is re-checked in
  // JS and handled by pass 2, but anything it wrongly skips would silently
  // change which prompt becomes the title. That is why the case-sensitive JS
  // rules use GLOB here and the \b in the teammate rule is narrowed to the two
  // separators that occur in practice.
  const firstCandidates = db
    .query(
      `SELECT s.id AS session_id, s.is_subagent,
              (SELECT b.text
               FROM message m
               CROSS JOIN block b INDEXED BY idx_block_message ON b.message_id = m.id
               WHERE m.session_id = s.id
                 AND m.role = 'user'
                 AND ${HUMAN_TITLE_MESSAGE_SQL}
                 AND b.type = 'text'
                 AND b.text IS NOT NULL
                 AND TRIM(b.text) != ''
                 AND NOT (${AGENT_CONTEXT_SQL})
               ORDER BY m.seq, b.ordinal
               LIMIT 1) AS text
       FROM session s
       WHERE s.id IN (${placeholders})`,
    )
    .all(...ids) as { session_id: number; is_subagent: number; text: string | null }[];
  const titleBySession = new Map<number, string>();
  const needFullScan: number[] = [];
  for (const row of firstCandidates) {
    if (row.text == null) {
      continue;
    }
    const title = readableUserTitle(row.text, row.is_subagent !== 0);
    if (title != null) {
      titleBySession.set(row.session_id, title);
    } else {
      needFullScan.push(row.session_id);
    }
  }
  // Pass 2, only for sessions whose first candidate was agent context: walk all
  // their user text blocks in order, exactly like the single-pass version did.
  if (needFullScan.length > 0) {
    const scanPlaceholders = needFullScan.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT m.session_id AS session_id, s.is_subagent, b.text
         FROM message m
         JOIN session s ON s.id = m.session_id
         CROSS JOIN block b INDEXED BY idx_block_message ON b.message_id = m.id
         WHERE m.session_id IN (${scanPlaceholders})
           AND m.role = 'user'
           AND ${HUMAN_TITLE_MESSAGE_SQL}
           AND b.type = 'text'
           AND b.text IS NOT NULL
           AND TRIM(b.text) != ''
         ORDER BY m.session_id, m.seq, b.ordinal`,
      )
      .all(...needFullScan) as { session_id: number; is_subagent: number; text: string }[];
    for (const row of rows) {
      if (titleBySession.has(row.session_id)) {
        continue;
      }
      const title = readableUserTitle(row.text, row.is_subagent !== 0);
      if (title != null) {
        titleBySession.set(row.session_id, title);
      }
    }
  }
  return sessions.map((session) => {
    const title =
      titleBySession.get(session.id) ?? readableUserTitle(session.title, session.is_subagent);
    // Always replace the parser fallback. In Codex logs the first normalized
    // "user" row can be a developer prompt rather than something a human typed.
    return { ...session, title };
  });
}

function readableUserTitle(text: string | null | undefined, isSubagent: boolean): string | null {
  if (text == null) {
    return null;
  }
  const trimmed = stripAnsi(text).trim();
  if (trimmed === "") {
    return null;
  }
  if (isSubagent) {
    const task = subagentTaskTitle(trimmed);
    if (task != null) {
      return task;
    }
  }
  if (isAgentContextText(trimmed)) {
    return null;
  }
  return preview(trimmed.replace(/\s+/g, " "), 180);
}

function subagentTaskTitle(text: string): string | null {
  if (/^<teammate-message\b/i.test(text)) {
    const summary = tagAttribute(text, "summary");
    return summary == null ? null : preview(summary.replace(/\s+/g, " ").trim(), 180);
  }
  if (!/^<fork-boilerplate>/i.test(text)) {
    return null;
  }
  const marker = /Your directive:\s*/i.exec(text);
  if (marker == null) {
    return null;
  }
  const directive = text.slice(marker.index + marker[0].length).trim();
  const firstSection = directive.split(/\n\s*\n(?=[A-Z][A-Z /-]{2,}:)/)[0] ?? directive;
  const normalized = firstSection.replace(/\s+/g, " ").trim();
  return normalized === "" ? null : preview(normalized, 180);
}

// Source-level constraints for a title candidate. Codex stores developer
// messages as normalized user rows for transcript fidelity, so consult the raw
// payload role here. Claude parent files can contain copied sidechain rows;
// those belong to child agents unless the selected session is itself a
// standalone subagent. Compact summaries are machine continuations, not human
// prompts.
const HUMAN_TITLE_MESSAGE_SQL = `
  COALESCE(json_extract(m.raw, '$.payload.role'), 'user') = 'user'
  AND COALESCE(json_extract(m.raw, '$.isCompactSummary'), 0) != 1
  AND (
    s.is_subagent = 1
    OR COALESCE(json_extract(m.raw, '$.isSidechain'), 0) != 1
  )
`;

// SQL twin of isAgentContextText, used to early-exit title candidate scans.
// Keep the two in sync when adding rules, and keep this side conservative:
// LIKE mirrors the case-insensitive /^.../i prefixes, GLOB mirrors the
// case-sensitive includes/startsWith rules, and JS stripAnsi/trimStart nuances
// intentionally fall through to the JS check (pass 2) rather than being
// approximated here.
const AGENT_CONTEXT_SQL = `
  LTRIM(b.text) LIKE '<permissions instructions>%'
  OR LTRIM(b.text) LIKE '<local-command-caveat>%'
  OR LTRIM(b.text) LIKE '<local-command-stdout>%'
  OR LTRIM(b.text) LIKE '<local-command-stderr>%'
  OR LTRIM(b.text) LIKE '<local-command-output>%'
  OR LTRIM(b.text) LIKE '<command-name>%'
  OR b.text GLOB '*<environment_context>*'
  OR LTRIM(b.text) GLOB '# AGENTS.md instructions*'
  OR b.text GLOB '*<INSTRUCTIONS>*'
  OR LTRIM(b.text) LIKE 'The following is the Codex agent history%'
  OR LTRIM(b.text) LIKE 'Use prior reviews as context%'
`;

function isAgentContextText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    /^<permissions instructions>/i.test(trimmed) ||
    /^<local-command-caveat>/i.test(trimmed) ||
    /^<local-command-std(?:out|err)>/i.test(trimmed) ||
    /^<local-command-output>/i.test(trimmed) ||
    /^<command-name>/i.test(trimmed) ||
    /^<teammate-message\b/i.test(trimmed) ||
    /^<fork-boilerplate>/i.test(trimmed) ||
    /^You are\s+[`'"]?\/?root[`'"]?,\s+the primary agent\b/i.test(trimmed) ||
    /^<(?:multi_agent_mode|collaboration_mode|skills_instructions|apps_instructions|plugins_instructions|recommended_plugins)>/i.test(
      trimmed,
    ) ||
    trimmed.includes("<environment_context>") ||
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.includes("<INSTRUCTIONS>") ||
    /^The following is the Codex agent history/i.test(trimmed) ||
    /^Use prior reviews as context/i.test(trimmed)
  );
}

function stripAnsi(value: string): string {
  const pattern = `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`;
  return value.replace(new RegExp(pattern, "g"), "");
}

function tagAttribute(value: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedName}="([^"]*)"`, "i");
  return value.match(pattern)?.[1] ?? null;
}

function withNestedSubagents(db: Database, sessions: SessionSummary[]): SessionSummary[] {
  if (sessions.length === 0) {
    return sessions;
  }
  const placeholders = sessions.map(() => "?").join(", ");
  const rows = db
    .query(
      `${SESSION_SUMMARY_SELECT}
       WHERE s.id IN (
         WITH RECURSIVE subtree(id) AS (
           SELECT id
           FROM session
           WHERE is_subagent = 1 AND parent_session_id IN (${placeholders})
           UNION ALL
           SELECT child.id
           FROM session child
           JOIN subtree parent ON parent.id = child.parent_session_id
           WHERE child.is_subagent = 1
         )
         SELECT id FROM subtree
       )
       ORDER BY COALESCE(s.spawn_depth, 0), s.started_at, s.id`,
    )
    .all(...sessions.map((session) => session.id)) as SessionSummaryRow[];
  if (rows.length === 0) {
    return sessions;
  }

  const childrenByParent = new Map<number, SessionSummary[]>();
  for (const child of withDisplayTitles(db, rows.map(mapSessionSummary))) {
    if (child.parent_session_id == null) {
      continue;
    }
    const siblings = childrenByParent.get(child.parent_session_id);
    if (siblings == null) {
      childrenByParent.set(child.parent_session_id, [child]);
    } else {
      siblings.push(child);
    }
  }

  const attach = (session: SessionSummary, depth: number, seen: Set<number>): SessionSummary => {
    if (depth >= 5 || seen.has(session.id)) {
      return session;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(session.id);
    const children = (childrenByParent.get(session.id) ?? []).map((child) =>
      attach(child, depth + 1, nextSeen),
    );
    return children.length === 0 ? session : { ...session, subagents: children };
  };

  return sessions.map((session) => attach(session, 0, new Set()));
}

function normalizeLimit(value: number | null | undefined, fallback: number): number {
  return value != null && value > 0 ? value : fallback;
}

function normalizeOffset(value: number | null | undefined): number {
  return value != null && value > 0 ? value : 0;
}
