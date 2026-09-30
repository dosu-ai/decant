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

export function parseCodexSession(
  fallbackId: string,
  content: string,
  titles: ReadonlyMap<string, string>,
): ParsedSession {
  const issues: ParsedSession["issues"] = [];
  const messages: NormalizedMessage[] = [];
  let sourceSessionId = fallbackId;
  let cwd: string | null = null;
  let cliVersion: string | null = null;
  let model: string | null = null;
  const reasoningEfforts = new Set<string>();
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let title: string | null = null;
  let isSubagent = false;
  let parentThreadId: string | null = null;
  let agentId: string | null = null;
  let agentType: string | null = null;
  let spawnDepth: number | null = null;
  let totals = emptyUsage();
  let sawTokenCount = false;
  let contextWindow: number | null = null;
  let rawMeta: Json = null;
  let seq = 0;
  const unknownTypes: UnknownTypes = new Map();

  for (const [index, line] of content.split(/\n/).entries()) {
    const value = parseJsonLine(line, index + 1, issues);
    if (value === undefined) {
      continue;
    }

    const typ = asString(get(value, "type")) ?? "";
    const timestamp = asString(get(value, "timestamp"));
    if (timestamp != null) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }
    const payload = get(value, "payload") ?? null;

    if (typ === "session_meta") {
      sourceSessionId = asString(get(payload, "id")) ?? sourceSessionId;
      cwd = asString(get(payload, "cwd")) ?? cwd;
      cliVersion = asString(get(payload, "cli_version")) ?? cliVersion;
      const source = get(payload, "source");
      const subagentSource = get(source, "subagent");
      const threadSpawn = get(subagentSource, "thread_spawn");
      parentThreadId =
        asString(get(payload, "parent_thread_id")) ??
        asString(get(threadSpawn, "parent_thread_id")) ??
        parentThreadId;
      isSubagent = isSubagent || subagentSource !== undefined || parentThreadId != null;
      const nickname =
        asString(get(payload, "agent_nickname")) ?? asString(get(threadSpawn, "agent_nickname"));
      const role =
        asString(get(payload, "agent_role")) ??
        asString(get(threadSpawn, "agent_role")) ??
        asString(subagentSource);
      agentId = nickname ?? agentId;
      agentType = role ?? agentType;
      spawnDepth =
        asInteger(get(threadSpawn, "depth")) ??
        asInteger(get(payload, "spawn_depth")) ??
        spawnDepth;
      rawMeta = payload;
    } else if (typ === "turn_context") {
      model = asString(get(payload, "model")) ?? model;
      const effort = recordedReasoningEffort(get(payload, "effort"));
      if (effort != null) {
        reasoningEfforts.add(effort);
      }
      cwd ??= asString(get(payload, "cwd"));
    } else if (typ === "event_msg" && asString(get(payload, "type")) === "token_count") {
      const info = get(payload, "info");
      const nested = get(info, "total_token_usage");
      const source = nested ?? payload;
      sawTokenCount = true;
      totals = usageFrom(source);
      contextWindow = asInteger(get(info, "model_context_window")) ?? contextWindow;
      // last_token_usage is the most recent request's context reading; stamp
      // it on the assistant message that request produced so per-call window
      // occupancy is queryable, exactly like Claude's per-message usage.
      const last = get(info, "last_token_usage");
      if (isObject(last)) {
        stampLatestAssistant(messages, usageFrom(last));
      }
    } else if (typ === "event_msg" && asString(get(payload, "type")) === "mcp_tool_call_end") {
      // Current Codex rollouts record MCP calls only here: there is no
      // response_item counterpart, so this event IS the durable copy.
      const pair = mcpEventMessages(value, payload, seq, timestamp);
      if (pair != null) {
        messages.push(pair.call, pair.result);
        seq += 2;
      }
    } else if (typ === "compacted") {
      messages.push(compactedMessage(value, payload, seq, timestamp));
      seq += 1;
    } else if (typ === "response_item") {
      const message = parseItem(value, payload, seq, title);
      if (message != null) {
        if (message.nextTitle != null) {
          title = message.nextTitle;
        }
        messages.push(message.message);
        seq += 1;
      }
    } else if (typ !== "event_msg") {
      // Remaining event_msg subtypes are stream noise whose durable copy is a
      // response_item. The exceptions are token_count and mcp_tool_call_end,
      // handled above — MCP calls have no response_item in current rollouts.
      // Anything else is a top-level record type this parser has never seen —
      // the drift sensor.
      countUnknown(unknownTypes, typ, index + 1);
    }
  }

  issues.push(...unknownTypeIssues(unknownTypes, "ignored"));

  title = titles.get(sourceSessionId) ?? title;
  if (contextWindow != null) {
    rawMeta = { ...(isObject(rawMeta) ? rawMeta : {}), model_context_window: contextWindow };
  }
  const effortLevels = reasoningEffortLevels(reasoningEfforts);

  const normalized: NormalizedSession = {
    tool: "codex",
    sourceSessionId,
    projectPath: cwd,
    title,
    cwd,
    gitBranch: null,
    model,
    reasoningEffort: summarizeReasoningEfforts(effortLevels),
    reasoningEffortLevels: effortLevels,
    cliVersion,
    startedAt,
    endedAt,
    isArchived: false,
    isSubagent,
    rootSourceSessionId: parentThreadId,
    spawnToolUseId: null,
    agentId: agentId ?? (isSubagent ? sourceSessionId : null),
    agentType,
    spawnDepth,
    rawMeta,
    totals,
    estReasoningTokens: 0,
    reasoningSource: sawTokenCount ? "reported" : "none",
    messages,
  };
  issues.push(...linkageIssues(normalized));

  return { session: normalized, issues };
}

function usageFrom(source: Json | undefined): TokenUsage {
  const totalInput = getInteger(source, "input_tokens");
  const cached = getInteger(source, "cached_input_tokens");
  const cacheWrite = getInteger(source, "cache_write_input_tokens");
  // Current Codex logs, when they carry cache_write_input_tokens at all, report
  // cached and cache-write input as subsets of input_tokens. Gate that contract:
  // if a future producer emits an incompatible breakdown, preserve the inclusive
  // total and cached portion instead of silently zeroing uncached input or
  // double-counting the write bucket.
  const disjointBreakdown = cached + cacheWrite <= totalInput;
  return {
    // Codex reports input_tokens as the inclusive prompt total. Cached and
    // cache-write tokens are component breakdowns, so normalize them into
    // disjoint buckets before the rest of Decant adds the buckets together.
    input: Math.max(0, totalInput - cached - (disjointBreakdown ? cacheWrite : 0)),
    output: getInteger(source, "output_tokens"),
    cacheRead: cached,
    cacheCreation: disjointBreakdown ? cacheWrite : 0,
    cacheCreation1h: 0,
    reasoning: getInteger(source, "reasoning_output_tokens"),
  };
}

/** Applies a token_count reading to the assistant message its request produced.
 * Readings land after the response items they describe, so walk back past tool
 * rows to the nearest assistant message. User and system rows are hard
 * boundaries: in particular, post-compaction zero readings must not overwrite
 * the pre-compaction assistant peak. Later readings within one request win. */
function stampLatestAssistant(messages: NormalizedMessage[], usage: TokenUsage): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message == null || message.role === "user" || message.role === "system") {
      return;
    }
    if (message.role === "assistant") {
      messages[index] = { ...message, usage };
      return;
    }
  }
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

/** Readable projection of an MCP result: Ok text content first, then
 * structured content, then empty for a bare success — never the Result
 * envelope, which stays available on message.raw. Non-Ok results (Err,
 * unrecognized) serialize whole so the failure remains visible. */
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

/** Event timestamp minus the reported duration; the event marks the call's end. */
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
// environment block, and app-supplied context. The user never typed it, so it is
// neither a turn nor time spent waiting on the user.
const INJECTED_CONTEXT =
  /^\s*(?:# AGENTS\.md instructions\b|<(?:environment_context|user_instructions|recommended_plugins|codex_internal_context|in-app-browser-context)>)/;

/** `developer` messages and injected context are harness instructions, so they
 * are system rows; a user message is a turn only when the user wrote part of it. */
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
  // An attached image, or any part that is not injected text, is the user's.
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
