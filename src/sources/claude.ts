import { isPriceable } from "../cost.ts";
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
import { compareCodePoints } from "../order.ts";
import { preview } from "../tools.ts";

const KNOWN_META = new Set([
  "summary",
  "ai-title",
  "last-prompt",
  "permission-mode",
  "attachment",
  "file-history-snapshot",
  "queue-operation",
]);

const CHARS_PER_TOKEN = 4;
const encoder = new TextEncoder();

interface TurnAcc {
  output: number;
  visible: number;
  hasThinking: boolean;
}

type JsonObject = { [key: string]: Json };

export interface ClaudeParseOptions {
  sourcePath?: string;
  sidecarMeta?: Json;
}

export function parseClaudeSession(
  sourceSessionId: string,
  content: string,
  options: ClaudeParseOptions = {},
): ParsedSession {
  const messages: NormalizedMessage[] = [];
  const issues: ParsedSession["issues"] = [];
  const billed = new Map<string, number>();
  const turns = new Map<string, TurnAcc>();

  let rootSourceSessionId: string | null = null;
  const pathIndicatesSubagent = isSubagentPath(options.sourcePath) || isObject(options.sidecarMeta);
  let sawSidechainRecord = false;
  let sawMainRecord = false;
  let agentId = agentIdFromPath(options.sourcePath);
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let cliVersion: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let title: string | null = null;
  let seq = 0;

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

    const typ = asString(get(value, "type")) ?? "";
    rootSourceSessionId ??= asString(get(value, "sessionId"));
    if (asBoolean(get(value, "isSidechain")) === true) {
      sawSidechainRecord = true;
    } else if (typ === "user" || typ === "assistant" || typ === "system") {
      sawMainRecord = true;
    }
    agentId ??= asString(get(value, "agentId"));
    const timestamp = asString(get(value, "timestamp"));
    if (timestamp != null) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }
    cwd ??= asString(get(value, "cwd"));
    gitBranch ??= asString(get(value, "gitBranch"));
    cliVersion ??= asString(get(value, "version"));

    if (typ === "user") {
      const message = parseUser(value, seq);
      if (title == null && message.role === "user") {
        const text = firstText(message);
        if (text != null) {
          title = truncate(text, 120);
        }
      }
      messages.push(message);
      seq += 1;
    } else if (typ === "assistant") {
      const message = parseAssistant(value, seq);
      // Newer journals drop the top-level requestId and instead write one
      // line per content block (apiBlockIndex), each repeating the message's
      // usage; the API message id then identifies the billable turn.
      const requestId =
        asString(get(value, "requestId")) ?? asString(get(get(value, "message"), "id"));
      const key = requestId ?? `\0seq${seq}`;
      const [output, visible, hasThinking] = lineReasoningInputs(message);
      const acc = turns.get(key) ?? { output: 0, visible: 0, hasThinking: false };
      acc.output = Math.max(acc.output, output);
      acc.visible += visible;
      acc.hasThinking ||= hasThinking;
      turns.set(key, acc);
      billAssistant(messages, billed, message, requestId);
      seq += 1;
    } else if (typ === "system") {
      messages.push(simpleMessage(value, "system", seq));
      seq += 1;
    } else if (KNOWN_META.has(typ)) {
      if (title == null) {
        const metaTitle = asString(get(value, "summary")) ?? asString(get(value, "title"));
        if (metaTitle != null) {
          title = truncate(metaTitle, 120);
        }
      }
    } else {
      messages.push(simpleMessage(value, "other", seq));
      seq += 1;
    }
  }

  const totals = emptyUsage();
  for (const message of messages) {
    if (message.usage == null) {
      continue;
    }
    totals.input += message.usage.input;
    totals.output += message.usage.output;
    totals.cacheRead += message.usage.cacheRead;
    totals.cacheCreation += message.usage.cacheCreation;
    totals.cacheCreation1h += message.usage.cacheCreation1h;
    totals.reasoning += message.usage.reasoning;
  }

  let estReasoningTokens = 0;
  let anyThinking = false;
  for (const turn of turns.values()) {
    if (!turn.hasThinking) {
      continue;
    }
    anyThinking = true;
    estReasoningTokens += Math.max(0, turn.output - Math.trunc(turn.visible / CHARS_PER_TOKEN));
  }

  const model = primaryModel(messages);
  const meta = isObject(options.sidecarMeta) ? options.sidecarMeta : {};
  const spawnToolUseId = asString(meta.toolUseId);
  const agentType =
    asString(meta.subagent_type) ?? asString(meta.subagentType) ?? asString(meta.agentType);
  const spawnDepth = asInteger(meta.spawnDepth);
  const isSubagent = pathIndicatesSubagent || (sawSidechainRecord && !sawMainRecord);
  const rawMeta: Json = {
    sessionId: rootSourceSessionId,
    isSubagent,
    agentId,
    agentType,
    spawnToolUseId,
    spawnDepth,
  };

  return {
    session: {
      tool: "claude_code",
      sourceSessionId,
      projectPath: cwd,
      title,
      cwd,
      gitBranch,
      model,
      cliVersion,
      startedAt,
      endedAt,
      isArchived: false,
      isSubagent,
      rootSourceSessionId,
      spawnToolUseId,
      agentId,
      agentType,
      spawnDepth,
      rawMeta,
      totals,
      estReasoningTokens,
      reasoningSource: anyThinking ? "inferred" : "none",
      messages,
    },
    issues,
  };
}

function lineReasoningInputs(message: NormalizedMessage): [number, number, boolean] {
  const output = message.usage?.output ?? 0;
  let visible = 0;
  let hasThinking = false;
  for (const block of message.blocks) {
    if (block.blockType === "thinking") {
      hasThinking = true;
    } else if (block.blockType === "text") {
      visible += byteLength(block.text ?? "");
    } else if (block.blockType === "tool_use" && block.toolInput !== undefined) {
      visible += byteLength(canonicalJson(block.toolInput));
    }
  }
  return [output, visible, hasThinking];
}

function truncate(value: string, max: number): string {
  return preview(value.trim(), max);
}

function firstText(message: NormalizedMessage): string | null {
  return message.blocks.find((block) => block.blockType === "text")?.text ?? null;
}

function primaryModel(messages: NormalizedMessage[]): string | null {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.model != null) {
      counts.set(message.model, (counts.get(message.model) ?? 0) + 1);
    }
  }

  let best: { model: string; count: number } | null = null;
  for (const [model, count] of counts) {
    if (best == null || compareModelCandidate(model, count, best.model, best.count) > 0) {
      best = { model, count };
    }
  }
  return best?.model ?? null;
}

function compareModelCandidate(
  model: string,
  count: number,
  otherModel: string,
  otherCount: number,
): number {
  const priceable = Number(isPriceable(model)) - Number(isPriceable(otherModel));
  if (priceable !== 0) {
    return priceable;
  }
  const frequency = count - otherCount;
  if (frequency !== 0) {
    return frequency;
  }
  return compareCodePoints(otherModel, model);
}

function simpleMessage(value: Json, role: Role, seq: number): NormalizedMessage {
  return {
    seq,
    sourceUuid: asString(get(value, "uuid")),
    parentSourceUuid: asString(get(value, "parentUuid")),
    role,
    model: null,
    stopReason: null,
    timestamp: asString(get(value, "timestamp")),
    usage: null,
    raw: value,
    blocks: [],
  };
}

function parseUser(value: Json, seq: number): NormalizedMessage {
  const blocks: NormalizedBlock[] = [];
  let hasText = false;
  let hasToolResult = false;
  const content = get(get(value, "message"), "content");

  if (typeof content === "string") {
    hasText = true;
    blocks.push(textBlock(0, content));
  } else if (Array.isArray(content)) {
    for (const [ordinal, item] of content.entries()) {
      const blockType = asString(get(item, "type")) ?? "";
      if (blockType === "text") {
        hasText = true;
        blocks.push(textBlock(ordinal, asString(get(item, "text")) ?? ""));
      } else if (blockType === "tool_result") {
        hasToolResult = true;
        blocks.push({
          ordinal,
          blockType: "tool_result",
          text: null,
          toolName: null,
          toolUseId: asString(get(item, "tool_use_id")),
          toolInput: undefined,
          toolResult: stringifyContent(get(item, "content")),
          isError: asBoolean(get(item, "is_error")),
        });
      } else {
        blocks.push(otherBlock(ordinal, item));
      }
    }
  }

  return {
    seq,
    sourceUuid: asString(get(value, "uuid")),
    parentSourceUuid: asString(get(value, "parentUuid")),
    role: hasToolResult && !hasText ? "tool" : "user",
    model: null,
    stopReason: null,
    timestamp: asString(get(value, "timestamp")),
    usage: null,
    raw: value,
    blocks,
  };
}

function parseAssistant(value: Json, seq: number): NormalizedMessage {
  const message = get(value, "message");
  const blocks: NormalizedBlock[] = [];
  const content = get(message, "content");
  if (Array.isArray(content)) {
    for (const [ordinal, item] of content.entries()) {
      const blockType = asString(get(item, "type")) ?? "";
      if (blockType === "text") {
        blocks.push(textBlock(ordinal, asString(get(item, "text")) ?? ""));
      } else if (blockType === "thinking") {
        blocks.push({
          ordinal,
          blockType: "thinking",
          text: asString(get(item, "thinking")),
          toolName: null,
          toolUseId: null,
          toolInput: undefined,
          toolResult: null,
          isError: null,
        });
      } else if (blockType === "tool_use") {
        blocks.push({
          ordinal,
          blockType: "tool_use",
          text: null,
          toolName: asString(get(item, "name")),
          toolUseId: asString(get(item, "id")),
          toolInput: hasKey(item, "input") ? get(item, "input") : undefined,
          toolResult: null,
          isError: null,
        });
      } else {
        blocks.push(otherBlock(ordinal, item));
      }
    }
  }

  return {
    seq,
    sourceUuid: asString(get(value, "uuid")),
    parentSourceUuid: asString(get(value, "parentUuid")),
    role: "assistant",
    model: asString(get(message, "model")),
    stopReason: asString(get(message, "stop_reason")),
    timestamp: asString(get(value, "timestamp")),
    usage: parseUsage(get(message, "usage")),
    raw: value,
    blocks,
  };
}

function parseUsage(value: Json | undefined): TokenUsage | null {
  if (!isObject(value)) {
    return null;
  }
  const split = value.cache_creation;
  return {
    input: asInteger(value.input_tokens) ?? 0,
    output: asInteger(value.output_tokens) ?? 0,
    cacheRead: asInteger(value.cache_read_input_tokens) ?? 0,
    cacheCreation: asInteger(value.cache_creation_input_tokens) ?? 0,
    cacheCreation1h: isObject(split) ? (asInteger(split.ephemeral_1h_input_tokens) ?? 0) : 0,
    reasoning: 0,
  };
}

function billAssistant(
  messages: NormalizedMessage[],
  billed: Map<string, number>,
  message: NormalizedMessage,
  requestId: string | null,
): void {
  if (message.usage == null || requestId == null) {
    messages.push(message);
    return;
  }

  const previous = billed.get(requestId);
  if (previous == null) {
    billed.set(requestId, messages.length);
    messages.push(message);
    return;
  }

  if (message.usage.output <= previousOutput(messages, previous)) {
    messages.push({ ...message, usage: null });
    return;
  }

  const previousMessage = messages[previous];
  if (previousMessage != null) {
    messages[previous] = { ...previousMessage, usage: null };
  }
  billed.set(requestId, messages.length);
  messages.push(message);
}

function previousOutput(messages: NormalizedMessage[], index: number): number {
  return messages[index]?.usage?.output ?? 0;
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

function otherBlock(ordinal: number, item: Json): NormalizedBlock {
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
}

function stringifyContent(content: Json | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const text = asString(get(item, "text"));
        return text ?? canonicalJson(item);
      })
      .join("\n");
  }
  if (content !== undefined) {
    return canonicalJson(content);
  }
  return "";
}

function get(value: Json | undefined, key: string): Json | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return value[key];
}

function hasKey(value: Json, key: string): boolean {
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

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function isSubagentPath(path: string | undefined): boolean {
  return path?.split("/").includes("subagents") === true;
}

function agentIdFromPath(path: string | undefined): string | null {
  const filename = path?.split("/").at(-1);
  if (filename == null || !filename.startsWith("agent-") || !filename.endsWith(".jsonl")) {
    return null;
  }
  return filename.slice("agent-".length, -".jsonl".length);
}
