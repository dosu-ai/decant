// Normalized domain model shared by every source parser (port of model.rs).
// The const tuples are the wire strings stored in SQLite — never reworded.

export const TOOLS = ["claude_code", "codex"] as const;
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
  /** Portion of `cacheCreation` written with a 1-hour TTL. Billed at 2x the base
   * input rate, where a 5-minute write bills at 1.25x. */
  cacheCreation1h: number;
  /** Output tokens spent on internal reasoning — a sub-component of `output`,
   * never priced separately. Codex reports it exactly; Claude reports none. */
  reasoning: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, reasoning: 0 };
}

/** Collapse provider effort labels to one session-level value. Sessions almost
 * always use one value, but settings can change between turns; preserve that
 * distinction instead of presenting the last turn as representative. */
export function summarizeReasoningEfforts(values: Iterable<string>): string | null {
  const efforts = new Set(
    Array.from(values, (value) => value.trim().toLowerCase()).filter((value) => value !== ""),
  );
  if (efforts.size === 0) {
    return null;
  }
  if (efforts.size === 1) {
    return efforts.values().next().value ?? null;
  }
  return "mixed";
}

/** Normalize provider wire labels to the effort names users selected. Claude
 * Code writes its highest `ultra` setting as `max`; Codex uses `max` and
 * `ultra` as distinct labels, so that alias is intentionally provider-scoped. */
export function normalizeReasoningEffort(tool: Tool, value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") {
    return null;
  }
  return tool === "claude_code" && normalized === "max" ? "ultra" : normalized;
}

/** Unique normalized effort labels in first-seen order. This detail is kept
 * alongside the collapsed session value so `mixed` remains explainable. */
export function reasoningEffortLevels(tool: Tool, values: Iterable<string>): string[] {
  const levels = new Set<string>();
  for (const value of values) {
    const normalized = normalizeReasoningEffort(tool, value);
    if (normalized != null) {
      levels.add(normalized);
    }
  }
  return Array.from(levels);
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
  /** Provider-supplied reasoning effort, or `mixed` when turns differ. */
  reasoningEffort: string | null;
  /** Unique normalized labels behind `reasoningEffort`, including every value
   * represented when the session summary is `mixed`. */
  reasoningEffortLevels: string[];
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
