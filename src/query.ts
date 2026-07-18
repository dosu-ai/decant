import type { Database } from "bun:sqlite";
import { sessionDatePredicate } from "./date-filter.ts";
import { preview } from "./tools.ts";

export interface SessionSummary {
  id: number;
  tool: string;
  source_session_id: string;
  title: string | null;
  project_path: string | null;
  model: string | null;
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
  extends Omit<SessionSummary, "is_archived" | "is_subagent" | "subagents"> {
  is_archived: number;
  is_subagent: number;
}

const SESSION_SUMMARY_SELECT = `
  SELECT s.id, s.tool, s.source_session_id, s.title, p.path AS project_path,
         s.model, s.started_at, s.ended_at, s.message_count,
         s.total_input_tokens, s.total_output_tokens, s.estimated_cost_usd,
         s.is_archived, s.is_subagent, s.parent_session_id, s.spawn_tool_use_id,
         s.agent_id, s.agent_type, s.spawn_depth,
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
  role: string;
  timestamp: string | null;
  model: string | null;
  blocks: BlockView[];
}

export interface SessionDetail {
  summary: SessionSummary;
  messages: MessageView[];
  subagents: SubagentDetail[];
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

interface MessageBlockRow {
  message_id: number;
  role: string | null;
  timestamp: string | null;
  model: string | null;
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
              s.model, s.started_at, s.ended_at, s.message_count,
              s.total_input_tokens, s.total_output_tokens, s.estimated_cost_usd,
              s.is_archived, s.is_subagent, s.parent_session_id, s.spawn_tool_use_id,
              s.agent_id, s.agent_type, s.spawn_depth,
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
            `SELECT m.id AS message_id, m.role, m.timestamp, m.model,
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
             SELECT m.id AS message_id, m.role, m.timestamp, m.model,
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
      messages.push({
        role: row.role ?? "unknown",
        timestamp: row.timestamp,
        model: row.model,
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
    message_offset: messageLimit != null ? messageOffset : undefined,
    message_limit: messageLimit,
    has_more_messages:
      messageLimit != null ? messageOffset + messages.length < summaryRow.message_count : undefined,
  };
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
  return { ...row, is_archived: row.is_archived !== 0, is_subagent: row.is_subagent !== 0 };
}

function withDisplayTitles(db: Database, sessions: SessionSummary[]): SessionSummary[] {
  if (sessions.length === 0) {
    return sessions;
  }
  const titleBySession = new Map<number, string>();
  const needsLookup: SessionSummary[] = [];
  for (const session of sessions) {
    const title = readableStoredTitle(session.title);
    if (title == null) {
      needsLookup.push(session);
    } else {
      titleBySession.set(session.id, title);
    }
  }
  if (needsLookup.length === 0) {
    return sessions.map((session) => ({
      ...session,
      title: titleBySession.get(session.id) ?? null,
    }));
  }

  const placeholders = needsLookup.map(() => "?").join(", ");
  const ids = needsLookup.map((session) => session.id);
  // Pass 1: fetch only the first plausibly-usable candidate text per session.
  // The correlated subquery stops at the first hit instead of walking every
  // user message. CROSS JOIN pins the loop order to messages -> blocks while
  // allowing SQLite to choose the available message_id index.
  //
  // AGENT_CONTEXT_SQL must skip a subset (never a superset) of what
  // isAgentContextText skips: anything it wrongly lets through is re-checked in
  // JS and handled by pass 2, but anything it wrongly skips would silently
  // change which prompt becomes the title. That is why the case-sensitive JS
  // rules use GLOB here and the \b in the teammate rule is narrowed to the two
  // separators that occur in practice.
  const firstCandidates = db
    .query(
      `SELECT s.id AS session_id,
              (SELECT b.text
               FROM message m
               CROSS JOIN block b ON b.message_id = m.id
               WHERE m.session_id = s.id
                 AND m.role = 'user'
                 AND b.type = 'text'
                 AND b.text IS NOT NULL
                 AND TRIM(b.text) != ''
                 AND NOT (${AGENT_CONTEXT_SQL})
               ORDER BY m.seq, b.ordinal
               LIMIT 1) AS text
       FROM session s
       WHERE s.id IN (${placeholders})`,
    )
    .all(...ids) as { session_id: number; text: string | null }[];
  const needFullScan: number[] = [];
  for (const row of firstCandidates) {
    if (row.text == null) {
      continue;
    }
    const title = readableUserTitle(row.text);
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
        `SELECT m.session_id AS session_id, b.text
         FROM message m
         CROSS JOIN block b ON b.message_id = m.id
         WHERE m.session_id IN (${scanPlaceholders})
           AND m.role = 'user'
           AND b.type = 'text'
           AND b.text IS NOT NULL
           AND TRIM(b.text) != ''
         ORDER BY m.session_id, m.seq, b.ordinal`,
      )
      .all(...needFullScan) as { session_id: number; text: string }[];
    for (const row of rows) {
      if (titleBySession.has(row.session_id)) {
        continue;
      }
      const title = readableUserTitle(row.text);
      if (title != null) {
        titleBySession.set(row.session_id, title);
      }
    }
  }
  return sessions.map((session) => {
    const title = titleBySession.get(session.id) ?? readableFallbackTitle(session.title);
    return title == null ? session : { ...session, title };
  });
}

function readableUserTitle(text: string): string | null {
  const trimmed = stripAnsi(text).trim();
  if (trimmed === "" || isAgentContextText(trimmed)) {
    return null;
  }
  return preview(readablePromptText(trimmed).replace(/\s+/g, " "), 180);
}

function readableStoredTitle(text: string | null | undefined): string | null {
  if (text == null) {
    return null;
  }
  const trimmed = stripAnsi(text).trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return null;
  }
  if (readableFallbackTitle(text) != null || isAgentContextText(text)) {
    return null;
  }
  return readableUserTitle(text);
}

function readablePromptText(text: string): string {
  const parsed = parseJsonTextContent(text);
  const normalized = parsed ?? text;
  const userQuery = normalized.match(/<user_query>([\s\S]*?)<\/user_query>/i)?.[1]?.trim();
  if (userQuery != null && userQuery !== "") {
    return userQuery;
  }
  return normalized.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "").trim();
}

function parseJsonTextContent(text: string): string | null {
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return null;
  }
  try {
    return collectJsonText(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function collectJsonText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      const text = collectJsonText(item);
      return text == null ? [] : [text];
    });
    return parts.length === 0 ? null : parts.join("\n");
  }
  if (value == null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return collectJsonText(record.content) ?? collectJsonText(record.text);
}

function readableFallbackTitle(text: string | null | undefined): string | null {
  if (text == null) {
    return null;
  }
  const trimmed = stripAnsi(text).trim();
  if (trimmed === "") {
    return null;
  }
  if (
    /^<permissions instructions>/i.test(trimmed) ||
    trimmed.includes("Filesystem sandboxing defines")
  ) {
    return "Execution permissions";
  }
  if (/^<local-command-caveat>/i.test(trimmed) || /^<command-name>/i.test(trimmed)) {
    return "Command context";
  }
  if (
    /^<local-command-std(?:out|err)>/i.test(trimmed) ||
    /^<local-command-output>/i.test(trimmed)
  ) {
    return "Command output";
  }
  if (/^<environment_context>/i.test(trimmed)) {
    return "Environment context";
  }
  if (/^<teammate-message\b/i.test(trimmed)) {
    return tagAttribute(trimmed, "summary") ?? "Subagent request";
  }
  if (trimmed.startsWith("# AGENTS.md instructions") || trimmed.includes("<INSTRUCTIONS>")) {
    return "Repository instructions";
  }
  if (/^The following is the Codex agent history/i.test(trimmed)) {
    return "Agent history";
  }
  if (/^Use prior reviews as context/i.test(trimmed)) {
    return "Review context";
  }
  return null;
}

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
  OR LTRIM(b.text) LIKE '<teammate-message %'
  OR LTRIM(b.text) LIKE '<teammate-message>%'
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
