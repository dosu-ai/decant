export const TOOLS = [
  "claude_code",
  "codex",
  "gemini",
  "opencode",
  "cursor",
  "copilot",
  "vscode_copilot",
  "atif",
] as const;
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

export const REASONING_SOURCES = ["reported", "inferred", "none"] as const;
export type ReasoningSource = (typeof REASONING_SOURCES)[number];

export const COST_SOURCES = ["decant", "reported", "mixed"] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
  reasoning: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, reasoning: 0 };
}

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

export function recordedReasoningEffort(value: Json | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

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

export function normalizeReasoningEffort(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const canonical = trimmed.toLowerCase();
  return KNOWN_REASONING_EFFORTS.has(canonical) ? canonical : trimmed;
}

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
  toolInput: Json | undefined;
  toolResult: string | null;
  isError: boolean | null;
  innerToolCalls?: NormalizedInnerToolCall[];
  calledAt?: string;
}

export interface NormalizedInnerToolCall {
  toolName: string;
  toolUseId: string | null;
  toolInput: Json | undefined;
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
  reasoningEffort: string | null;
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
  totals: TokenUsage;
  estReasoningTokens: number;
  reasoningSource: ReasoningSource;
  messages: NormalizedMessage[];
}

export const INGEST_ISSUE_CODES = [
  "unparsed_line",
  "unknown_record_type",
  "orphan_tool_result",
  "duplicate_tool_use_id",
  "duplicate_tool_result",
  "unreachable_project_directory",
] as const;
export type IngestIssueCode = (typeof INGEST_ISSUE_CODES)[number];

export interface Issue {
  code: IngestIssueCode;
  lineNo: number | null;
  error: string;
  rawLine: string | null;
}

export interface ParsedSession {
  session: NormalizedSession;
  issues: Issue[];
}
