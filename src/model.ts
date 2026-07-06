// Normalized domain model shared by every source parser (port of model.rs).
// The const tuples are the wire strings stored in SQLite — never reworded.

export const TOOLS = ["claude_code", "codex", "cursor"] as const;
export type Tool = (typeof TOOLS)[number];

export const ROLES = ["user", "assistant", "system", "tool", "other"] as const;
export type Role = (typeof ROLES)[number];

export const BLOCK_TYPES = [
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "web_search",
  "image",
  "other",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const TOOL_KINDS = ["builtin", "mcp", "custom", "web_search", "tool_search"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** Provenance of a session's reasoning-token figure: exact (`reported`, Codex),
 * estimated by subtraction (`inferred`, Claude), or unavailable (`none`). */
export const REASONING_SOURCES = ["reported", "inferred", "none"] as const;
export type ReasoningSource = (typeof REASONING_SOURCES)[number];

/** Any JSON value. `undefined` never appears inside; use `Json | undefined`
 * where absent and JSON null carry different meanings. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Output tokens spent on internal reasoning — a sub-component of `output`,
   * never priced separately. Codex reports it exactly; Claude reports none. */
  reasoning: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 };
}

export interface NormalizedBlock {
  ordinal: number;
  blockType: BlockType;
  text: string | null;
  toolName: string | null;
  toolUseId: string | null;
  /** `undefined` = field absent in the source (SQL NULL); a Json value
   * (including JSON null) = present. */
  toolInput: Json | undefined;
  toolResult: string | null;
  isError: boolean | null;
}

export interface NormalizedMessage {
  seq: number;
  sourceUuid: string | null;
  parentSourceUuid: string | null;
  role: Role;
  model: string | null;
  stopReason: string | null;
  timestamp: string | null;
  usage: TokenUsage | null;
  raw: Json;
  blocks: NormalizedBlock[];
}

export interface NormalizedSession {
  tool: Tool;
  sourceSessionId: string;
  projectPath: string | null;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  cliVersion: string | null;
  startedAt: string | null;
  endedAt: string | null;
  isArchived: boolean;
  isSubagent: boolean;
  rootSourceSessionId: string | null;
  spawnToolUseId: string | null;
  agentId: string | null;
  agentType: string | null;
  spawnDepth: number | null;
  rawMeta: Json;
  /** Session-level token totals (Codex sets these directly; Claude sums per-message). */
  totals: TokenUsage;
  /** Estimated reasoning tokens when the tool reports no exact count (Claude);
   * always ≤ totals.output; 0 with reasoningSource "none" or for Codex. */
  estReasoningTokens: number;
  reasoningSource: ReasoningSource;
  messages: NormalizedMessage[];
}

export interface Issue {
  lineNo: number;
  error: string;
  rawLine: string;
}

export interface ParsedSession {
  session: NormalizedSession;
  issues: Issue[];
}
