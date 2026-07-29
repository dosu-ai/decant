import { isPriceable } from "../cost.ts";
import { linkageIssues } from "../diagnostics.ts";
import { canonicalJson } from "../json.ts";
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
import { compareCodePoints } from "../order.ts";
import { preview } from "../tools.ts";

const TITLE_META = new Set(["summary", "ai-title"]);

// Operational journal records are neither conversation messages nor title
// sources. Keep their payloads opaque until Claude documents stable semantics.
const IGNORED_JOURNAL_META = new Set([
  "agent-name",
  "last-prompt",
  "permission-mode",
  "attachment",
  "file-history-delta",
  "file-history-snapshot",
  "frame-link",
  "inter_agent_communication_metadata",
  "mode",
  "pr-link",
  "queue-operation",
  "world_state",
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
  let sessionModel: string | null = null;
  const reasoningEfforts = new Set<string>();
  let resultTotals: TokenUsage | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let promptTitle: string | null = null;
  let metadataTitle: string | null = null;
  let seq = 0;
  const unknownTypes = new Map<string, { count: number; firstLine: number }>();

  for (const [index, line] of content.split(/\n/).entries()) {
    if (line.trim() === "") {
      continue;
    }

    let value: Json;
    try {
      value = JSON.parse(line) as Json;
    } catch (error) {
      issues.push({
        code: "unparsed_line",
        lineNo: index + 1,
        error: error instanceof Error ? error.message : String(error),
        rawLine: line,
      });
      continue;
    }

    const typ = stringAt(value, "type") ?? "";
    rootSourceSessionId ??= stringAt(value, "sessionId", "session_id");
    if (asBoolean(get(value, "isSidechain")) === true) {
      sawSidechainRecord = true;
    } else if (typ === "user" || typ === "assistant" || typ === "system") {
      sawMainRecord = true;
    }
    agentId ??= stringAt(value, "agentId", "agent_id");
    const timestamp = stringAt(value, "timestamp");
    if (timestamp != null) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }
    cwd ??= stringAt(value, "cwd");
    gitBranch ??= stringAt(value, "gitBranch", "git_branch");
    cliVersion ??= stringAt(value, "version", "cli_version");
    sessionModel ??= stringAt(get(value, "message"), "model") ?? stringAt(value, "model");
    const effort = recordedReasoningEffort(get(value, "effort"));
    if (effort != null) {
      reasoningEfforts.add(effort);
    }

    if (typ === "user") {
      const message = parseUser(value, seq);
      if (promptTitle == null && message.role === "user") {
        const text = firstText(message);
        if (text != null) {
          promptTitle = truncate(text, 120);
        }
      }
      messages.push(message);
      seq += 1;
    } else if (typ === "assistant") {
      const message = parseAssistant(value, seq);
      const requestId = stringAt(value, "requestId", "request_id");
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
    } else if (typ === "result") {
      resultTotals = parseUsage(get(value, "usage")) ?? resultTotals;
    } else if (TITLE_META.has(typ)) {
      if (metadataTitle == null) {
        const metaTitle = stringAt(value, "summary", "title");
        if (metaTitle != null) {
          metadataTitle = truncate(metaTitle, 120);
        }
      }
    } else if (!IGNORED_JOURNAL_META.has(typ)) {
      const seen = unknownTypes.get(typ) ?? { count: 0, firstLine: index + 1 };
      seen.count += 1;
      unknownTypes.set(typ, seen);
      messages.push(simpleMessage(value, "other", seq));
      seq += 1;
    }
  }

  for (const [typ, seen] of unknownTypes) {
    issues.push({
      code: "unknown_record_type",
      lineNo: seen.firstLine,
      error: `unknown record type "${typ}" on ${seen.count} line(s); kept as role "other"`,
      rawLine: null,
    });
  }

  const messageTotals = emptyUsage();
  for (const message of messages) {
    if (message.usage == null) {
      continue;
    }
    messageTotals.input += message.usage.input;
    messageTotals.output += message.usage.output;
    messageTotals.cacheRead += message.usage.cacheRead;
    messageTotals.cacheCreation += message.usage.cacheCreation;
    messageTotals.cacheCreation1h += message.usage.cacheCreation1h;
    messageTotals.reasoning += message.usage.reasoning;
  }
  const totals = resultTotals ?? messageTotals;

  let estReasoningTokens = 0;
  let anyThinking = false;
  for (const turn of turns.values()) {
    if (!turn.hasThinking) {
      continue;
    }
    anyThinking = true;
    estReasoningTokens += Math.max(0, turn.output - Math.trunc(turn.visible / CHARS_PER_TOKEN));
  }
  if (resultTotals != null) {
    estReasoningTokens = Math.min(estReasoningTokens, resultTotals.output);
  }

  const model = primaryModel(messages) ?? sessionModel;
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
  const effortLevels = reasoningEffortLevels(reasoningEfforts);

  const normalized: NormalizedSession = {
    tool: "claude_code",
    sourceSessionId,
    projectPath: cwd,
    // Claude emits ai-title after the first user record in normal sessions.
    // Keep the human prompt as the display title and use its metadata only
    // when the session has no usable prompt.
    title: promptTitle ?? metadataTitle,
    cwd,
    gitBranch,
    model,
    reasoningEffort: summarizeReasoningEfforts(effortLevels),
    reasoningEffortLevels: effortLevels,
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
  };
  issues.push(...linkageIssues(normalized));

  return { session: normalized, issues };
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
    sourceUuid: sourceUuid(value),
    parentSourceUuid: stringAt(value, "parentUuid", "parent_uuid"),
    role,
    model: null,
    stopReason: null,
    timestamp: stringAt(value, "timestamp"),
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
    sourceUuid: sourceUuid(value),
    parentSourceUuid: stringAt(value, "parentUuid", "parent_uuid"),
    role: hasToolResult && !hasText ? "tool" : "user",
    model: null,
    stopReason: null,
    timestamp: stringAt(value, "timestamp"),
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
    sourceUuid: sourceUuid(value),
    parentSourceUuid: stringAt(value, "parentUuid", "parent_uuid"),
    role: "assistant",
    model: asString(get(message, "model")),
    stopReason: asString(get(message, "stop_reason")),
    timestamp: stringAt(value, "timestamp"),
    usage: parseUsage(get(message, "usage")),
    raw: value,
    blocks,
  };
}

function parseUsage(value: Json | undefined): TokenUsage | null {
  if (!isObject(value)) {
    return null;
  }
  return {
    input: asInteger(value.input_tokens) ?? 0,
    output: asInteger(value.output_tokens) ?? 0,
    cacheRead: asInteger(value.cache_read_input_tokens) ?? 0,
    cacheCreation: asInteger(value.cache_creation_input_tokens) ?? 0,
    cacheCreation1h: isObject(value.cache_creation)
      ? (asInteger(value.cache_creation.ephemeral_1h_input_tokens) ?? 0)
      : 0,
    reasoning: 0,
  };
}

function sourceUuid(value: Json): string | null {
  return stringAt(value, "uuid") ?? stringAt(get(value, "message"), "id");
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

function stringAt(value: Json | undefined, ...keys: string[]): string | null {
  for (const key of keys) {
    const got = asString(get(value, key));
    if (got != null) {
      return got;
    }
  }
  return null;
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
