import { canonicalJson } from "../json.ts";
import {
  emptyUsage,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type ParsedSession,
  type Role,
  type TokenUsage,
} from "../model.ts";
import { preview } from "../tools.ts";

type JsonObject = { [key: string]: Json };

export interface CursorParseOptions {
  sourcePath?: string;
  sidecarMeta?: Json;
}

export function parseCursorSession(
  sourceSessionId: string,
  content: string,
  options: CursorParseOptions = {},
): ParsedSession {
  const issues: ParsedSession["issues"] = [];
  const messages: NormalizedMessage[] = [];
  const totals = emptyUsage();
  let cwd: string | null = null;
  let model: string | null = null;
  let cliVersion: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let title: string | null = null;
  let initEvent: Json = null;
  let terminalResult: Json = null;
  let nativeTranscript = false;
  let thinkingText = "";
  let seq = 0;

  const flushThinking = (): void => {
    if (thinkingText === "") {
      return;
    }
    messages.push(
      messageWithBlocks("assistant", seq, null, null, { type: "thinking" }, [
        {
          ordinal: 0,
          blockType: "thinking",
          text: thinkingText,
          toolName: null,
          toolUseId: null,
          toolInput: undefined,
          toolResult: null,
          isError: null,
        },
      ]),
    );
    seq += 1;
    thinkingText = "";
  };

  for (const [index, line] of content.split(/\n/).entries()) {
    if (line.trim() === "") {
      continue;
    }

    let value: Json;
    try {
      value = JSON.parse(line) as Json;
    } catch (error) {
      issues.push({
        lineNo: index + 1,
        error: error instanceof Error ? error.message : String(error),
        rawLine: line,
      });
      continue;
    }

    const typ = asString(get(value, "type"));
    const timestamps = timestampsAt(value);
    const timestamp = timestamps[0] ?? null;
    rememberTimestamps(timestamps);

    if (typ == null && asString(get(value, "role")) != null && hasKey(value, "message")) {
      flushThinking();
      nativeTranscript = true;
      const message = parseRoleMessage(value, seq, timestamp);
      if (message != null) {
        if (message.role === "user" && title == null) {
          title = titleFromMessage(message);
        }
        messages.push(message);
        seq += 1;
      }
      continue;
    }

    switch (typ) {
      case "system": {
        if (asString(get(value, "subtype")) === "init") {
          flushThinking();
          initEvent = value;
          cwd = asString(get(value, "cwd")) ?? cwd;
          model = asString(get(value, "model")) ?? model;
          cliVersion = asString(get(value, "cliVersion", "cli_version", "version")) ?? cliVersion;
        } else {
          flushThinking();
          messages.push(simpleMessage(value, "system", seq, timestamp));
          seq += 1;
        }
        break;
      }
      case "user": {
        flushThinking();
        const message = parseChatMessage(value, "user", seq, timestamp);
        if (title == null) {
          title = titleFromMessage(message);
        }
        messages.push(message);
        seq += 1;
        break;
      }
      case "assistant": {
        if (get(value, "model_call_id") !== undefined) {
          break;
        }
        flushThinking();
        const message = parseChatMessage(value, "assistant", seq, timestamp);
        model = asString(get(value, "model")) ?? model;
        messages.push(message);
        seq += 1;
        break;
      }
      case "thinking": {
        thinkingText += thinkingTextFrom(value);
        break;
      }
      case "tool_call": {
        if (asString(get(value, "subtype")) !== "completed") {
          break;
        }
        flushThinking();
        const blocks = parseToolCall(value);
        messages.push(messageWithBlocks("assistant", seq, null, timestamp, value, blocks));
        seq += 1;
        break;
      }
      case "result": {
        flushThinking();
        terminalResult = value;
        const usage = parseUsage(get(value, "usage"));
        if (usage != null) {
          totals.input = usage.input;
          totals.output = usage.output;
          totals.cacheRead = usage.cacheRead;
          totals.cacheCreation = usage.cacheCreation;
          totals.reasoning = usage.reasoning;
        }
        break;
      }
      default: {
        flushThinking();
        messages.push(simpleMessage(value, "other", seq, timestamp));
        seq += 1;
      }
    }
  }
  flushThinking();

  const sidecar: JsonObject = isObject(options.sidecarMeta) ? options.sidecarMeta : {};
  startedAt =
    asString(get(sidecar, "startedAt")) ??
    asString(get(sidecar, "started_at")) ??
    timestampMsAt(sidecar, "createdAtMs", "created_at_ms") ??
    startedAt;
  endedAt =
    asString(get(sidecar, "endedAt")) ??
    asString(get(sidecar, "ended_at")) ??
    timestampMsAt(sidecar, "updatedAtMs", "updated_at_ms") ??
    endedAt;
  cwd = cwd ?? asString(get(sidecar, "cwd"));

  const visibleChars = messages.reduce((sum, message) => sum + visibleBytes(message), 0);
  const thinkingChars = messages.reduce((sum, message) => sum + thinkingBytes(message), 0);
  const hasReportedReasoning = totals.reasoning > 0;
  const estReasoningTokens =
    !hasReportedReasoning && thinkingChars > 0 && totals.output > 0
      ? Math.min(
          totals.output,
          Math.round(totals.output * (thinkingChars / (thinkingChars + visibleChars))),
        )
      : 0;

  return {
    session: {
      tool: "cursor",
      sourceSessionId,
      projectPath: cwd,
      title,
      cwd,
      gitBranch: null,
      model,
      cliVersion,
      startedAt,
      endedAt,
      isArchived: false,
      isSubagent: false,
      rootSourceSessionId: null,
      spawnToolUseId: null,
      agentId: null,
      agentType: null,
      spawnDepth: null,
      rawMeta: {
        init: initEvent,
        terminalResult,
        nativeTranscript,
        sidecar,
        sourcePath: options.sourcePath ?? null,
        sourceProjectKey: cursorProjectKey(options.sourcePath),
      },
      totals,
      estReasoningTokens,
      reasoningSource: hasReportedReasoning ? "reported" : thinkingChars > 0 ? "inferred" : "none",
      messages,
    },
    issues,
  };

  function rememberTimestamps(timestamps: string[]): void {
    for (const timestamp of timestamps) {
      if (startedAt == null || compareTimestamp(timestamp, startedAt) < 0) {
        startedAt = timestamp;
      }
      if (endedAt == null || compareTimestamp(timestamp, endedAt) > 0) {
        endedAt = timestamp;
      }
    }
  }
}

function parseRoleMessage(
  value: Json,
  seq: number,
  timestamp: string | null,
): NormalizedMessage | null {
  const role = messageRole(asString(get(value, "role")));
  if (role == null) {
    return null;
  }
  return messageWithBlocks(role, seq, null, timestamp, value, messageBlocks(get(value, "message")));
}

function parseChatMessage(
  value: Json,
  fallbackRole: Role,
  seq: number,
  timestamp: string | null,
): NormalizedMessage {
  const message = get(value, "message");
  return messageWithBlocks(
    messageRole(asString(get(message, "role"))) ?? fallbackRole,
    seq,
    asString(get(value, "session_id")),
    timestamp,
    value,
    messageBlocks(get(message, "content")),
  );
}

function parseToolCall(value: Json): NormalizedBlock[] {
  const parsed = toolPayload(value);
  const toolUseId = asString(get(value, "call_id")) ?? parsed.id;
  return [
    {
      ordinal: 0,
      blockType: "tool_use",
      text: null,
      toolName: parsed.name,
      toolUseId,
      toolInput: parsed.input,
      toolResult: null,
      isError: null,
    },
    {
      ordinal: 1,
      blockType: "tool_result",
      text: null,
      toolName: null,
      toolUseId,
      toolInput: undefined,
      toolResult: stringify(parsed.result),
      isError: parsed.isError,
    },
  ];
}

function toolPayload(value: Json): {
  id: string | null;
  name: string | null;
  input: Json | undefined;
  result: Json | undefined;
  isError: boolean | null;
} {
  const toolCall = get(value, "tool_call");
  if (!isObject(toolCall)) {
    return { id: null, name: null, input: undefined, result: undefined, isError: null };
  }
  const fn = get(toolCall, "function");
  if (isObject(fn)) {
    const args = get(fn, "arguments");
    const result = get(fn, "result");
    return {
      id: asString(get(fn, "id")) ?? null,
      name: asString(get(fn, "name")),
      input: parseMaybeJson(args),
      result,
      isError: errorFlag(value, result),
    };
  }

  for (const [key, payload] of Object.entries(toolCall)) {
    if (!isObject(payload)) {
      continue;
    }
    const result = get(payload, "result");
    return {
      id: asString(get(payload, "toolCallId", "tool_call_id")) ?? null,
      name: toolNameFromWrapper(key),
      input: parseMaybeJson(get(payload, "args") ?? get(payload, "arguments")),
      result,
      isError: errorFlag(value, result),
    };
  }
  return { id: null, name: null, input: undefined, result: undefined, isError: null };
}

function toolNameFromWrapper(key: string): string {
  return key
    .replace(/ToolCall$/i, "")
    .replace(/Tool$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function errorFlag(event: Json, result: Json | undefined): boolean | null {
  const fromEvent = asBoolean(get(event, "is_error"));
  if (fromEvent != null) {
    return fromEvent;
  }
  if (!isObject(result)) {
    return null;
  }
  if (hasKey(result, "error")) {
    return true;
  }
  const success = get(result, "success");
  return success === false;
}

function parseUsage(value: Json | undefined): TokenUsage | null {
  if (!isObject(value)) {
    return null;
  }
  return {
    input: integerAt(value, "inputTokens", "input_tokens"),
    output: integerAt(value, "outputTokens", "output_tokens"),
    cacheRead: integerAt(value, "cacheReadTokens", "cache_read_tokens"),
    cacheCreation: integerAt(value, "cacheWriteTokens", "cache_write_tokens"),
    reasoning: integerAt(value, "reasoningTokens", "reasoning_tokens", "reasoningOutputTokens"),
  };
}

function messageBlocks(content: Json | undefined): NormalizedBlock[] {
  content = normalizedMessageContent(content);
  if (typeof content === "string") {
    return [textBlock(0, content)];
  }
  if (Array.isArray(content)) {
    return content.map((item, ordinal) => {
      const type = asString(get(item, "type"));
      if (type === "text") {
        return textBlock(ordinal, asString(get(item, "text")) ?? "");
      }
      if (type === "tool_use") {
        return {
          ordinal,
          blockType: "tool_use",
          text: null,
          toolName: asString(get(item, "name")),
          toolUseId: asString(get(item, "id", "tool_use_id", "toolUseId")),
          toolInput: get(item, "input"),
          toolResult: null,
          isError: null,
        };
      }
      if (type === "tool_result") {
        return {
          ordinal,
          blockType: "tool_result",
          text: null,
          toolName: null,
          toolUseId: asString(get(item, "tool_use_id", "toolUseId", "id")),
          toolInput: undefined,
          toolResult: stringify(get(item, "content") ?? get(item, "result")),
          isError: asBoolean(get(item, "is_error", "isError")),
        };
      }
      return {
        ordinal,
        blockType: "other",
        text: canonicalJson(item),
        toolName: null,
        toolUseId: null,
        toolInput: undefined,
        toolResult: null,
        isError: null,
      };
    });
  }
  if (content !== undefined) {
    return [textBlock(0, stringify(content))];
  }
  return [];
}

function normalizedMessageContent(content: Json | undefined): Json | undefined {
  if (typeof content === "string") {
    const parsed = parseMaybeJson(content);
    if (parsed !== content) {
      return normalizedMessageContent(parsed);
    }
    return content;
  }
  if (!isObject(content)) {
    return content;
  }
  const nested = get(content, "content") ?? get(content, "text");
  return nested === undefined ? content : normalizedMessageContent(nested);
}

function textBlock(ordinal: number, text: string): NormalizedBlock {
  return {
    ordinal,
    blockType: "text",
    text,
    toolName: null,
    toolUseId: null,
    toolInput: undefined,
    toolResult: null,
    isError: null,
  };
}

function simpleMessage(
  value: Json,
  role: Role,
  seq: number,
  timestamp: string | null,
): NormalizedMessage {
  return messageWithBlocks(role, seq, asString(get(value, "session_id")), timestamp, value, []);
}

function messageWithBlocks(
  role: Role,
  seq: number,
  sourceUuid: string | null,
  timestamp: string | null,
  raw: Json,
  blocks: NormalizedBlock[],
): NormalizedMessage {
  return {
    seq,
    sourceUuid,
    parentSourceUuid: null,
    role,
    model: null,
    stopReason: null,
    timestamp,
    usage: null,
    raw,
    blocks,
  };
}

function titleFromMessage(message: NormalizedMessage): string | null {
  const text = message.blocks.find((block) => block.blockType === "text")?.text?.trim();
  if (text == null || text === "") {
    return null;
  }
  return preview(readableCursorPrompt(text), 120);
}

function readableCursorPrompt(text: string): string {
  const userQuery = text.match(/<user_query>([\s\S]*?)<\/user_query>/i)?.[1]?.trim();
  if (userQuery != null && userQuery !== "") {
    return userQuery;
  }
  return text.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "").trim();
}

function thinkingTextFrom(value: Json): string {
  const text =
    asString(get(value, "delta")) ??
    asString(get(value, "text")) ??
    asString(get(value, "content")) ??
    collectText(get(get(value, "message"), "content"));
  return text ?? "";
}

function collectText(content: Json | undefined): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.flatMap((item) => {
    const text = asString(get(item, "text"));
    return text == null ? [] : [text];
  });
  return parts.length === 0 ? null : parts.join("\n");
}

function visibleBytes(message: NormalizedMessage): number {
  let total = 0;
  for (const block of message.blocks) {
    if (block.blockType === "text") {
      total += byteLength(block.text ?? "");
    } else if (block.blockType === "tool_use" && block.toolInput !== undefined) {
      total += byteLength(canonicalJson(block.toolInput));
    }
  }
  return total;
}

function thinkingBytes(message: NormalizedMessage): number {
  return message.blocks
    .filter((block) => block.blockType === "thinking")
    .reduce((sum, block) => sum + byteLength(block.text ?? ""), 0);
}

function messageRole(role: string | null): Role | null {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }
  return role == null ? null : "other";
}

function parseMaybeJson(value: Json | undefined): Json | undefined {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

function stringify(value: Json | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (value !== undefined) {
    return canonicalJson(value);
  }
  return "";
}

function timestampsAt(value: Json): string[] {
  const out: string[] = [];
  const timestamp = asString(get(value, "timestamp"));
  if (timestamp != null) {
    out.push(timestamp);
  }
  const ms = asEpochMs(get(value, "timestamp_ms"));
  if (ms != null) {
    out.push(new Date(ms).toISOString());
  }

  const toolCall = get(value, "tool_call");
  if (isObject(toolCall)) {
    for (const payload of Object.values(toolCall)) {
      if (!isObject(payload)) {
        continue;
      }
      pushEpochMs(out, payload, "startedAtMs", "started_at_ms");
      pushEpochMs(out, payload, "completedAtMs", "completed_at_ms");
    }
  }
  return out;
}

function timestampMsAt(value: Json, ...keys: string[]): string | null {
  for (const key of keys) {
    const ms = asEpochMs(get(value, key));
    if (ms != null) {
      return new Date(ms).toISOString();
    }
  }
  return null;
}

function pushEpochMs(out: string[], value: Json, ...keys: string[]): void {
  for (const key of keys) {
    const ms = asEpochMs(get(value, key));
    if (ms != null) {
      out.push(new Date(ms).toISOString());
      return;
    }
  }
}

function compareTimestamp(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return leftMs - rightMs;
  }
  return left.localeCompare(right);
}

function cursorProjectKey(path: string | undefined): string | null {
  if (path == null) {
    return null;
  }
  const parts = path.split(/[\\/]+/);
  const index = parts.lastIndexOf("projects");
  return index < 0 ? null : (parts[index + 1] ?? null);
}

function integerAt(value: Json, ...keys: string[]): number {
  for (const key of keys) {
    const got = asInteger(get(value, key));
    if (got != null) {
      return got;
    }
  }
  return 0;
}

function get(value: Json | undefined, ...keys: string[]): Json | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  for (const key of keys) {
    const got = value[key];
    if (got !== undefined) {
      return got;
    }
  }
  return undefined;
}

function hasKey(value: Json | undefined, key: string): boolean {
  return isObject(value) && Object.hasOwn(value, key);
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asBoolean(value: Json | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asInteger(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asEpochMs(value: Json | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
