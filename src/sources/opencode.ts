import { emptyUsage, type NormalizedSession, type ParsedSession } from "../model.ts";
import { compareCodePoints } from "../order.ts";

/** One `session_v2` row as `OpenCodeStore.loadSession` reads it. */
export interface OpenCodeSessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  fork_session_id: string | null;
  fork_boundary: string | null;
  slug: string;
  directory: string;
  title: string | null;
  version: string;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  agent: string | null;
  /** JSON `{ providerID, id, variant? }` for the session's current model. */
  model: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

/** One `session_message` row; `data` is the message JSON minus `id` and `type`. */
export interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface OpenCodeModelRef {
  providerID: string | null;
  id: string | null;
  variant: string | null;
}

export interface OpenCodeParseContext {
  /** MCP server names from opencode.json, as written there (unsanitized). */
  mcpServers: readonly string[];
  /** models.dev context limits keyed `<providerID>/<modelID>`. */
  contextWindows: ReadonlyMap<string, number>;
}

/** Sanitized server names, longest first, so `a_b` wins over `a` for `a_b_tool`. */
export function mcpServerPrefixes(servers: readonly string[]): string[] {
  const unique = new Set(servers.map(sanitizeMcpName).filter((name) => name !== ""));
  return [...unique].sort((a, b) => b.length - a.length || compareCodePoints(a, b));
}

/** OpenCode registers MCP tools as `<server>_<tool>` with both parts passed
 * through this replacement (packages/core/src/tool/mcp.ts). */
export function normalizeOpenCodeToolName(name: string, serverPrefixes: readonly string[]): string {
  for (const server of serverPrefixes) {
    if (name.length > server.length + 1 && name.startsWith(`${server}_`)) {
      return `mcp__${server}__${name.slice(server.length + 1)}`;
    }
  }
  return name;
}

function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * OpenCode 2.x session parser. Pure and print-free: takes the rows the store
 * read and returns a ParsedSession. Lane A (Task 2) supplies the body; the
 * signature and the types above are the contract other lanes rely on.
 */
export function parseOpenCodeSession(
  row: OpenCodeSessionRow,
  _rows: readonly OpenCodeMessageRow[],
  _context: OpenCodeParseContext,
): ParsedSession {
  const session: NormalizedSession = {
    tool: "opencode",
    sourceSessionId: row.id,
    projectPath: null,
    title: row.title,
    cwd: null,
    gitBranch: null,
    model: null,
    reasoningEffort: null,
    reasoningEffortLevels: [],
    cliVersion: row.version,
    startedAt: null,
    endedAt: null,
    isArchived: row.time_archived != null,
    isSubagent: row.parent_id != null,
    rootSourceSessionId: row.parent_id,
    spawnToolUseId: null,
    agentId: null,
    agentType: row.agent,
    spawnDepth: null,
    rawMeta: null,
    totals: emptyUsage(),
    estReasoningTokens: 0,
    reasoningSource: "none",
    messages: [],
  };
  return { session, issues: [] };
}
