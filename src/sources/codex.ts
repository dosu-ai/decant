import { linkageIssues } from "../diagnostics.ts";
import { asInteger, asString, canonicalJson, get, hasKey, isObject } from "../json.ts";
import {
  emptyUsage,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type NormalizedSession,
  type ParsedSession,
  type Role,
  reasoningEffortLevels,
  recordedReasoningEffort,
  summarizeReasoningEfforts,
  type TokenUsage,
} from "../model.ts";
import { preview } from "../tools.ts";
import {
  block,
  contentText,
  countUnknown,
  parseJsonLine,
  type UnknownTypes,
  unknownTypeIssues,
} from "./shared.ts";

const IGNORED_TOP_LEVEL = new Set([
  "world_state",
  "token_usage_record",
  "inter_agent_communication_metadata",
]);

export interface CodexStepperState {
  sourceSessionId: string;
  cwd: string | null;
  cliVersion: string | null;
  gitBranch: string | null;
  model: string | null;
  reasoningEfforts: string[];
  startedAt: string | null;
  endedAt: string | null;
  title: string | null;
  isSubagent: boolean;
  parentThreadId: string | null;
  agentId: string | null;
  agentType: string | null;
  spawnDepth: number | null;
  totals: TokenUsage;
  sawTokenCount: boolean;
  contextWindow: number | null;
  rawMeta: Json;
  seq: number;
  ownSessionId: string | null;
  historyStartOrdinal: number | null;
  unknownTypes: Record<string, { count: number; firstLine: number }>;
  latestAssistant: { seq: number; usage: TokenUsage | null } | null;
}

export interface CodexLineStepResult {
  messages: NormalizedMessage[];
  stampedAssistant?: {
    seq: number;
    usage: TokenUsage;
    previousUsage: TokenUsage | null;
  };
}

export function createCodexStepper(fallbackId: string): CodexStepperState {
  return {
    sourceSessionId: fallbackId,
    cwd: null,
    cliVersion: null,
    gitBranch: null,
    model: null,
    reasoningEfforts: [],
    startedAt: null,
    endedAt: null,
    title: null,
    isSubagent: false,
    parentThreadId: null,
    agentId: null,
    agentType: null,
    spawnDepth: null,
    totals: emptyUsage(),
    sawTokenCount: false,
    contextWindow: null,
    rawMeta: null,
    seq: 0,
    ownSessionId: null,
    historyStartOrdinal: null,
    unknownTypes: {},
    latestAssistant: null,
  };
}

function trackLatestAssistant(state: CodexStepperState, message: NormalizedMessage): void {
  if (message.role === "user" || message.role === "system") {
    state.latestAssistant = null;
  } else if (message.role === "assistant") {
    state.latestAssistant = {
      seq: message.seq,
      usage: message.usage == null ? null : { ...message.usage },
    };
  }
}

export function stepCodexLine(
  state: CodexStepperState,
  line: string,
  lineNo: number,
  issues: ParsedSession["issues"],
): CodexLineStepResult {
  const value = parseJsonLine(line, lineNo, issues);
  if (value === undefined) {
    return { messages: [] };
  }

  const typ = asString(get(value, "type")) ?? "";
  const payload = get(value, "payload") ?? null;
  // A forked subagent's rollout opens with its own session_meta, then
  // replays the thread it forked from, sometimes with that thread's
  // session_meta.
  const metaId = typ === "session_meta" ? asString(get(payload, "id")) : null;
  const ordinal = asInteger(get(value, "ordinal"));
  if (
    (state.ownSessionId != null && metaId != null && metaId !== state.ownSessionId) ||
    (state.historyStartOrdinal != null && ordinal != null && ordinal < state.historyStartOrdinal)
  ) {
    return { messages: [] };
  }

  const timestamp = asString(get(value, "timestamp"));
  if (timestamp != null) {
    state.startedAt ??= timestamp;
    state.endedAt = timestamp;
  }

  if (typ === "session_meta") {
    if (state.ownSessionId == null) {
      state.historyStartOrdinal = forkHistoryStart(payload);
    }
    state.ownSessionId ??= metaId;
    state.sourceSessionId = metaId ?? state.sourceSessionId;
    state.gitBranch = asString(get(get(payload, "git"), "branch")) ?? state.gitBranch;
    state.cwd = asString(get(payload, "cwd")) ?? state.cwd;
    state.cliVersion = asString(get(payload, "cli_version")) ?? state.cliVersion;
    const source = get(payload, "source");
    const subagentSource = get(source, "subagent");
    const threadSpawn = get(subagentSource, "thread_spawn");
    state.parentThreadId =
      asString(get(payload, "parent_thread_id")) ??
      asString(get(threadSpawn, "parent_thread_id")) ??
      state.parentThreadId;
    state.isSubagent =
      state.isSubagent || subagentSource !== undefined || state.parentThreadId != null;
    const nickname =
      asString(get(payload, "agent_nickname")) ?? asString(get(threadSpawn, "agent_nickname"));
    const role =
      asString(get(payload, "agent_role")) ??
      asString(get(threadSpawn, "agent_role")) ??
      asString(subagentSource);
    state.agentId = nickname ?? state.agentId;
    state.agentType = role ?? state.agentType;
    state.spawnDepth =
      asInteger(get(threadSpawn, "depth")) ??
      asInteger(get(payload, "spawn_depth")) ??
      state.spawnDepth;
    state.rawMeta = payload;
    return { messages: [] };
  }

  if (typ === "turn_context") {
    state.model = asString(get(payload, "model")) ?? state.model;
    const effort = recordedReasoningEffort(get(payload, "effort"));
    if (effort != null && !state.reasoningEfforts.includes(effort)) {
      state.reasoningEfforts.push(effort);
    }
    state.cwd ??= asString(get(payload, "cwd"));
    return { messages: [] };
  }

  if (typ === "event_msg" && asString(get(payload, "type")) === "token_count") {
    const info = get(payload, "info");
    const nested = get(info, "total_token_usage");
    const source = nested ?? payload;
    state.sawTokenCount = true;
    state.totals = usageFrom(source);
    state.contextWindow = asInteger(get(info, "model_context_window")) ?? state.contextWindow;
    const last = get(info, "last_token_usage");
    if (isObject(last) && state.latestAssistant != null) {
      const nextUsage = usageFrom(last);
      const stampedAssistant = {
        seq: state.latestAssistant.seq,
        usage: nextUsage,
        previousUsage: state.latestAssistant.usage,
      };
      state.latestAssistant = { seq: state.latestAssistant.seq, usage: { ...nextUsage } };
      return { messages: [], stampedAssistant };
    }
    return { messages: [] };
  }

  if (typ === "event_msg" && asString(get(payload, "type")) === "mcp_tool_call_end") {
    // Current Codex rollouts record MCP calls only here: there is no
    // response_item counterpart, so this event IS the durable copy.
    const pair = mcpEventMessages(value, payload, state.seq, timestamp);
    if (pair != null) {
      state.seq += 2;
      trackLatestAssistant(state, pair.call);
      trackLatestAssistant(state, pair.result);
      return { messages: [pair.call, pair.result] };
    }
    return { messages: [] };
  }

  if (typ === "compacted") {
    const message = compactedMessage(value, payload, state.seq, timestamp);
    state.seq += 1;
    trackLatestAssistant(state, message);
    return { messages: [message] };
  }

  if (typ === "response_item") {
    const message = parseItem(value, payload, state.seq, state.title);
    if (message != null) {
      if (message.nextTitle != null) {
        state.title = message.nextTitle;
      }
      state.seq += 1;
      trackLatestAssistant(state, message.message);
      return { messages: [message.message] };
    }
    return { messages: [] };
  }

  if (typ !== "event_msg" && !IGNORED_TOP_LEVEL.has(typ)) {
    const unknownMap: UnknownTypes = new Map(Object.entries(state.unknownTypes));
    countUnknown(unknownMap, typ, lineNo);
    state.unknownTypes = Object.fromEntries(unknownMap);
  }
  return { messages: [] };
}

export function codexSessionFromState(
  state: CodexStepperState,
  titles: ReadonlyMap<string, string>,
  messages: NormalizedMessage[] = [],
  isArchived = false,
): NormalizedSession {
  const title = titles.get(state.sourceSessionId) ?? state.title;
  const rawMeta =
    state.contextWindow != null
      ? {
          ...(isObject(state.rawMeta) ? state.rawMeta : {}),
          model_context_window: state.contextWindow,
        }
      : state.rawMeta;
  const effortLevels = reasoningEffortLevels(state.reasoningEfforts);

  return {
    tool: "codex",
    sourceSessionId: state.sourceSessionId,
    projectPath: state.cwd,
    title,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    model: state.model,
    reasoningEffort: summarizeReasoningEfforts(effortLevels),
    reasoningEffortLevels: effortLevels,
    cliVersion: state.cliVersion,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    isArchived,
    isSubagent: state.isSubagent,
    rootSourceSessionId: state.parentThreadId,
    spawnToolUseId: null,
    agentId: state.agentId ?? (state.isSubagent ? state.sourceSessionId : null),
    agentType: state.agentType,
    spawnDepth: state.spawnDepth,
    rawMeta,
    totals: state.totals,
    estReasoningTokens: 0,
    reasoningSource: state.sawTokenCount ? "reported" : "none",
    messages,
  };
}

export function codexUnknownTypeIssues(state: CodexStepperState): ParsedSession["issues"] {
  return unknownTypeIssues(new Map(Object.entries(state.unknownTypes)), "ignored");
}

export function parseCodexSession(
  fallbackId: string,
  content: string,
  titles: ReadonlyMap<string, string>,
): ParsedSession {
  const state = createCodexStepper(fallbackId);
  const issues: ParsedSession["issues"] = [];
  const messages: NormalizedMessage[] = [];

  for (const [index, line] of content.split(/\n/).entries()) {
    const step = stepCodexLine(state, line, index + 1, issues);
    if (step.stampedAssistant != null) {
      const target = messages[step.stampedAssistant.seq];
      if (target != null) {
        messages[step.stampedAssistant.seq] = { ...target, usage: step.stampedAssistant.usage };
      }
    }
    for (const message of step.messages) {
      messages.push(message);
    }
  }

  issues.push(...codexUnknownTypeIssues(state));
  const normalized = codexSessionFromState(state, titles, messages);
  issues.push(...linkageIssues(normalized));

  return { session: normalized, issues };
}

/** Guardian rollouts carry subagent_history_start_ordinal over turns of their
 * own, so the ordinal marks replayed history only alongside forked_from_id. */
export function forkHistoryStart(sessionMeta: Json | undefined): number | null {
  return asString(get(sessionMeta, "forked_from_id")) == null
    ? null
    : asInteger(get(sessionMeta, "subagent_history_start_ordinal"));
}

function usageFrom(source: Json | undefined): TokenUsage {
  const totalInput = getInteger(source, "input_tokens");
  const cached = getInteger(source, "cached_input_tokens");
  const cacheWrite = getInteger(source, "cache_write_input_tokens");
  const disjointBreakdown = cached + cacheWrite <= totalInput;
  return {
    // Codex reports input_tokens as the inclusive prompt total. Cached and
    // cache-write tokens are component breakdowns of it.
    input: Math.max(0, totalInput - cached - (disjointBreakdown ? cacheWrite : 0)),
    output: getInteger(source, "output_tokens"),
    cacheRead: cached,
    cacheCreation: disjointBreakdown ? cacheWrite : 0,
    cacheCreation1h: 0,
    reasoning: getInteger(source, "reasoning_output_tokens"),
  };
}

function compactedMessage(
  line: Json,
  payload: Json,
  seq: number,
  timestamp: string | null,
): NormalizedMessage {
  const summary = asString(get(payload, "message")) ?? "";
  return {
    seq,
    sourceUuid: null,
    parentSourceUuid: null,
    role: "system",
    model: null,
    stopReason: null,
    timestamp,
    usage: null,
    raw: line,
    blocks: summary === "" ? [] : [block(0, "text", { text: summary })],
  };
}

interface ParsedItem {
  message: NormalizedMessage;
  nextTitle: string | null;
}

function parseItem(
  line: Json,
  payload: Json,
  seq: number,
  currentTitle: string | null,
): ParsedItem | null {
  const payloadType = asString(get(payload, "type")) ?? "";
  const timestamp = asString(get(line, "timestamp"));
  const mk = (role: Role, block: NormalizedBlock): ParsedItem => ({
    nextTitle: null,
    message: {
      seq,
      sourceUuid: null,
      parentSourceUuid: null,
      role,
      model: null,
      stopReason: null,
      timestamp,
      usage: null,
      raw: line,
      blocks: [block],
    },
  });

  if (payloadType === "message") {
    const content = get(payload, "content");
    const role = messageRole(asString(get(payload, "role")), content);
    const text = collectText(content);
    const parsed = mk(role, block(0, "text", { text }));
    if (role === "user" && currentTitle == null && text !== "") {
      parsed.nextTitle = preview(text.trim(), 120);
    }
    return parsed;
  }

  if (payloadType === "reasoning") {
    const summary = collectText(get(payload, "summary")).trim();
    return mk(
      "assistant",
      block(0, "thinking", {
        text: summary === "" ? collectText(get(payload, "content")) : summary,
      }),
    );
  }

  if (
    payloadType === "function_call" ||
    payloadType === "custom_tool_call" ||
    payloadType === "tool_search_call" ||
    payloadType === "mcp_tool_call"
  ) {
    return mk(
      "assistant",
      block(0, "tool_use", {
        toolName: qualifiedToolName(payload),
        toolUseId: asString(get(payload, "call_id")),
        toolInput: callInput(payload),
      }),
    );
  }

  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output" ||
    payloadType === "tool_search_output"
  ) {
    return mk(
      "tool",
      block(0, "tool_result", {
        toolUseId: asString(get(payload, "call_id")),
        toolResult: contentText(get(payload, "output")),
      }),
    );
  }

  if (payloadType === "web_search_call") {
    return mk("assistant", block(0, "web_search", { toolName: "web_search" }));
  }

  return mk("other", block(0, "other", { text: canonicalJson(payload) }));
}

function qualifiedToolName(payload: Json): string | null {
  const name = asString(get(payload, "name"));
  const namespace = asString(get(payload, "namespace"));
  if (name == null || name === "" || namespace == null || namespace === "") {
    return name;
  }
  return name.startsWith(`${namespace}__`) ? name : `${namespace}__${name}`;
}

function mcpEventMessages(
  value: Json,
  payload: Json,
  seq: number,
  timestamp: string | null,
): { call: NormalizedMessage; result: NormalizedMessage } | null {
  const invocation = get(payload, "invocation");
  const server = asString(get(invocation, "server"));
  const tool = asString(get(invocation, "tool"));
  const callId = asString(get(payload, "call_id"));
  if (server == null || server === "" || tool == null || tool === "" || callId == null) {
    return null;
  }
  const name = server.startsWith("mcp__") ? `${server}__${tool}` : `mcp__${server}__${tool}`;
  const result = get(payload, "result") ?? null;
  const ok = get(result, "Ok");
  const isError = get(result, "Err") !== undefined || get(ok, "isError") === true;
  const text = mcpResultText(result);
  const callTimestamp = backdate(timestamp, get(payload, "duration"));
  return {
    call: {
      seq,
      sourceUuid: null,
      parentSourceUuid: null,
      role: "assistant",
      model: null,
      stopReason: null,
      timestamp: callTimestamp,
      usage: null,
      raw: value,
      blocks: [
        block(0, "tool_use", {
          toolName: name,
          toolUseId: callId,
          toolInput: get(invocation, "arguments"),
        }),
      ],
    },
    result: {
      seq: seq + 1,
      sourceUuid: null,
      parentSourceUuid: null,
      role: "tool",
      model: null,
      stopReason: null,
      timestamp,
      usage: null,
      raw: value,
      blocks: [block(0, "tool_result", { toolUseId: callId, toolResult: text, isError })],
    },
  };
}

function mcpResultText(result: Json): string {
  const ok = get(result, "Ok");
  if (ok === undefined) {
    return canonicalJson(result);
  }
  const content = get(ok, "content");
  if (Array.isArray(content)) {
    const texts = content
      .filter((entry) => asString(get(entry, "type")) === "text")
      .map((entry) => asString(get(entry, "text")))
      .filter((entry): entry is string => entry != null && entry !== "");
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  const structured = get(ok, "structuredContent");
  if (structured !== undefined) {
    return canonicalJson(structured);
  }
  return Array.isArray(content) ? "" : canonicalJson(result);
}

function backdate(timestamp: string | null, duration: Json | undefined): string | null {
  if (timestamp == null) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return timestamp;
  }
  const secs = asInteger(get(duration, "secs")) ?? 0;
  const nanos = asInteger(get(duration, "nanos")) ?? 0;
  const ms = secs * 1000 + Math.round(nanos / 1_000_000);
  return new Date(parsed - ms).toISOString();
}

// Context Codex injects as a "user" message: the workspace's AGENTS.md, the
// environment block, and app-supplied context.
const INJECTED_CONTEXT =
  /^\s*(?:# AGENTS\.md instructions\b|<(?:environment_context|user_instructions|recommended_plugins|codex_internal_context|in-app-browser-context)>)/;

function messageRole(role: string | null, content: Json | undefined): Role {
  if (role === "assistant" || role === "system") {
    return role;
  }
  if (role === "developer" || isInjectedContext(content)) {
    return "system";
  }
  return "user";
}

function isInjectedContext(content: Json | undefined): boolean {
  const parts = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
  return (
    parts.length > 0 &&
    parts.every((part) => {
      const text = typeof part === "string" ? part : asString(get(part, "text"));
      return text != null && INJECTED_CONTEXT.test(text);
    })
  );
}

function collectText(content: Json | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((item) => {
        const text = asString(get(item, "text"));
        return text == null ? [] : [text];
      })
      .join("\n");
  }
  return "";
}

function callInput(payload: Json): Json | undefined {
  if (hasKey(payload, "arguments")) {
    return get(payload, "arguments");
  }
  if (hasKey(payload, "input")) {
    return get(payload, "input");
  }
  return undefined;
}

function getInteger(value: Json | undefined, key: string): number {
  return asInteger(get(value, key)) ?? 0;
}
