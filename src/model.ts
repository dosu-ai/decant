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

/** Provider-defined labels whose spelling is part of the current wire format.
 * `mixed` is Decant's own session summary value. */
const KNOWN_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "mixed",
]);

/** Read a provider-recorded effort value. Named levels are strings; Claude's
 * Agent SDK also permits numeric per-agent token budgets. Keep both losslessly
 * representable in the archive's string-valued effort columns. */
export function recordedReasoningEffort(value: Json | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

/** Collapse provider effort labels to one session-level value. Sessions almost
 * always use one value, but settings can change between turns; preserve that
 * distinction instead of presenting the last turn as representative. */
export function summarizeReasoningEfforts(values: Iterable<string>): string | null {
  const efforts = new Set(
    Array.from(values, normalizeReasoningEffort).filter((value): value is string => value != null),
  );
  if (efforts.size === 0) {
    return null;
  }
  if (efforts.size === 1) {
    return efforts.values().next().value ?? null;
  }
  return "mixed";
}

/** Normalize known provider effort labels without changing their meaning.
 * Future custom values may be case-sensitive, so preserve their spelling. */
export function normalizeReasoningEffort(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const canonical = trimmed.toLowerCase();
  return KNOWN_REASONING_EFFORTS.has(canonical) ? canonical : trimmed;
}

/** Unique normalized effort labels in first-seen order. This detail is kept
 * alongside the collapsed session value so `mixed` remains explainable. */
export function reasoningEffortLevels(values: Iterable<string>): string[] {
  const levels = new Set<string>();
  for (const value of values) {
    const normalized = normalizeReasoningEffort(value);
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

/** Wire strings stored in ingest_issue.code — never reworded (same contract
 * as the const tuples above). `unparsed_line` is the only data-loss code;
 * the rest are informational sensors. */
export const INGEST_ISSUE_CODES = [
  "unparsed_line",
  "unknown_record_type",
  "orphan_tool_result",
  "duplicate_tool_use_id",
  "duplicate_tool_result",
] as const;
export type IngestIssueCode = (typeof INGEST_ISSUE_CODES)[number];

export interface Issue {
  code: IngestIssueCode;
  /** 1-based source line, when the issue is tied to a specific line. */
  lineNo: number | null;
  error: string;
  /** Verbatim source line for unparsed_line only. May contain transcript
   * content: display-local, never logged (docs/logging.md). */
  rawLine: string | null;
}

export interface ParsedSession {
  session: NormalizedSession;
  issues: Issue[];
}
