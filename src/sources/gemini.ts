import { linkageIssues } from "../diagnostics.ts";
import { canonicalJson } from "../json.ts";
import {
  emptyUsage,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type NormalizedSession,
  type ParsedSession,
  type TokenUsage,
} from "../model.ts";
import { preview } from "../tools.ts";

type JsonObject = { [key: string]: Json };

export interface GeminiParseOptions {
  /** Source id of the parent chat when the file lives under `chats/<parent>/`. */
  parentSessionId?: string | null;
}

interface ReplayedRecord {
  record: JsonObject;
  lineNo: number;
}

interface Replay {
  metadata: JsonObject;
  messages: ReplayedRecord[];
}

type UnknownTypes = Map<string, { count: number; firstLine: number }>;

/**
 * Gemini CLI session format (`.gemini/tmp/<project>/chats/session-<ts>-<hash>.jsonl`;
 * subagent chats live under `chats/<parent-session-id>/<session-id>.jsonl`).
 *
 * The file is an event log rather than a list of independent messages, so it
 * is replayed the way Gemini CLI's own loader replays it before normalizing:
 *  - Metadata (line 0): `{ sessionId, projectHash, startTime, lastUpdated, kind }`
 *  - Message: `{ id, timestamp, type: "user"|"gemini"|"info"|…, content, tokens?, model?, toolCalls?, thoughts? }`.
 *    A repeated `id` replaces the earlier record in place; Gemini re-appends a
 *    turn whenever usage or tool calls arrive after its text.
 *  - `{ $set: {…} }` merges metadata, and `$set.messages` replaces every message.
 *  - `{ $rewindTo: id }` removes that message and everything after it.
 *  - Tool results are user records whose content holds `{ functionResponse }`.
 */
export function parseGeminiSession(
  fallbackId: string,
  content: string,
  projectPath: string | null,
  options: GeminiParseOptions = {},
): ParsedSession {
  const issues: ParsedSession["issues"] = [];
  const unknownTypes: UnknownTypes = new Map();
  const replayed = replay(content, issues, unknownTypes);
  const metadata = replayed.metadata;

  const messages: NormalizedMessage[] = [];
  const sourceSessionId = asString(metadata.sessionId) ?? fallbackId;
  let model: string | null = null;
  let startedAt: string | null = asString(metadata.startTime);
  let endedAt: string | null = null;
  let firstUserText: string | null = null;
  let totals = emptyUsage();
  let sawReportedReasoning = false;
  let seq = 0;
  const seenToolResultIds = new Set<string>();

  for (const { record: value, lineNo } of replayed.messages) {
    const typ = asString(value.type);
    const timestamp = asString(value.timestamp);

    if (timestamp != null) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }

    if (typ === "user") {
      const blocks = parseUserContent(value.content, seenToolResultIds);
      if (blocks.length === 0) {
        continue;
      }
      const firstText = blocks.find((b) => b.blockType === "text")?.text ?? "";
      if (firstUserText == null && firstText !== "") {
        firstUserText = firstText;
      }
      messages.push({
        seq,
        sourceUuid: asString(value.id),
        parentSourceUuid: null,
        role: blocks.every((block) => block.blockType === "tool_result")
          ? "tool"
          : blocks.every((block) => block.blockType === "other")
            ? "other"
            : "user",
        model: null,
        stopReason: null,
        timestamp,
        usage: null,
        raw: value,
        blocks,
      });
      seq += 1;
    } else if (typ === "gemini") {
      const msgModel: string | null = asString(value.model) ?? model;
      model ??= msgModel;
      const tokenRecord = value.tokens;
      sawReportedReasoning ||= isObject(tokenRecord) && hasKey(tokenRecord, "thoughts");
      const usage = usageFrom(tokenRecord);
      // Gemini records usage for each model turn, so session totals are the sum.
      totals = addUsage(totals, usage);

      const contentBlocks = parseGeminiContent(value.content);
      const toolCallBlocks = parseToolCalls(value.toolCalls, contentBlocks.length);
      const thoughtBlocks = parseThoughts(
        value.thoughts,
        contentBlocks.length + toolCallBlocks.length,
      );
      const allBlocks = [...contentBlocks, ...toolCallBlocks, ...thoughtBlocks];

      if (allBlocks.length === 0) {
        continue;
      }

      messages.push({
        seq,
        sourceUuid: asString(value.id),
        parentSourceUuid: null,
        role: "assistant",
        model: msgModel,
        stopReason: null,
        timestamp,
        usage,
        raw: value,
        blocks: allBlocks,
      });
      seq += 1;
    } else if (typ === "error" || typ === "info" || typ === "warning") {
      const text = asString(value.content);
      if (text == null || text === "") {
        continue;
      }
      messages.push({
        seq,
        sourceUuid: asString(value.id),
        parentSourceUuid: null,
        role: "other",
        model: null,
        stopReason: null,
        timestamp,
        usage: null,
        raw: value,
        blocks: [textBlock(0, text)],
      });
      seq += 1;
    } else if (typ != null) {
      countUnknown(unknownTypes, typ, lineNo);
    }
  }

  for (const [typ, seen] of unknownTypes) {
    issues.push({
      code: "unknown_record_type",
      lineNo: seen.firstLine,
      error: `unknown record type "${typ}" on ${seen.count} line(s); ignored`,
      rawLine: null,
    });
  }

  const parentSessionId = options.parentSessionId ?? null;
  const isSubagent = asString(metadata.kind) === "subagent" || parentSessionId != null;
  const summary = asString(metadata.summary);

  const normalized: NormalizedSession = {
    tool: "gemini",
    sourceSessionId,
    projectPath,
    title: summary ?? (firstUserText == null ? null : preview(firstUserText.trim(), 120)),
    cwd: projectPath,
    gitBranch: null,
    model,
    reasoningEffort: null,
    reasoningEffortLevels: [],
    cliVersion: null,
    startedAt,
    endedAt,
    isArchived: false,
    isSubagent,
    rootSourceSessionId: parentSessionId,
    spawnToolUseId: null,
    agentId: isSubagent ? sourceSessionId : null,
    agentType: null,
    spawnDepth: null,
    rawMeta: rawMetaFrom(metadata, parentSessionId),
    totals,
    estReasoningTokens: 0,
    reasoningSource: sawReportedReasoning ? "reported" : "none",
    messages,
  };
  issues.push(...linkageIssues(normalized));

  return { session: normalized, issues };
}

/** Replay the event log into Gemini's in-memory conversation shape. */
function replay(
  content: string,
  issues: ParsedSession["issues"],
  unknownTypes: UnknownTypes,
): Replay {
  let metadata: JsonObject = {};
  const messages = new Map<string, ReplayedRecord>();

  for (const [index, line] of content.split(/\n/).entries()) {
    const lineNo = index + 1;
    if (line.trim() === "") {
      continue;
    }

    let value: Json;
    try {
      value = JSON.parse(line) as Json;
    } catch (error) {
      issues.push({
        code: "unparsed_line",
        lineNo,
        error: error instanceof Error ? error.message : String(error),
        rawLine: line,
      });
      continue;
    }
    if (!isObject(value)) {
      continue;
    }

    const rewindTo = asString(value.$rewindTo);
    if (rewindTo != null) {
      rewind(messages, rewindTo);
      continue;
    }

    const id = asString(value.id);
    if (id != null) {
      messages.set(id, { record: value, lineNo });
      continue;
    }

    const patch = value.$set;
    if (isObject(patch)) {
      if (Array.isArray(patch.messages)) {
        messages.clear();
        setCheckpoint(messages, patch.messages, lineNo);
      }
      metadata = { ...metadata, ...patch };
      continue;
    }

    if (asString(value.sessionId) != null) {
      metadata = { ...metadata, ...value };
      if (Array.isArray(value.messages)) {
        setCheckpoint(messages, value.messages, lineNo);
      }
      continue;
    }

    const typ = asString(value.type);
    if (typ != null) {
      countUnknown(unknownTypes, typ, lineNo);
    }
  }

  return { metadata, messages: [...messages.values()] };
}

function rewind(messages: Map<string, ReplayedRecord>, id: string): void {
  // Gemini clears the whole conversation when the rewind target is unknown.
  if (!messages.has(id)) {
    messages.clear();
    return;
  }
  let found = false;
  for (const key of [...messages.keys()]) {
    found ||= key === id;
    if (found) {
      messages.delete(key);
    }
  }
}

function setCheckpoint(
  messages: Map<string, ReplayedRecord>,
  records: Json[],
  lineNo: number,
): void {
  for (const record of records) {
    const id = asString(get(record, "id"));
    if (id != null && isObject(record)) {
      messages.set(id, { record, lineNo });
    }
  }
}

function countUnknown(unknownTypes: UnknownTypes, typ: string, lineNo: number): void {
  const seen = unknownTypes.get(typ) ?? { count: 0, firstLine: lineNo };
  seen.count += 1;
  unknownTypes.set(typ, seen);
}

function rawMetaFrom(metadata: JsonObject, parentSessionId: string | null): Json {
  const meta: JsonObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    // Messages are normalized separately and the scratchpad is transcript-derived.
    if (key !== "messages" && key !== "memoryScratchpad") {
      meta[key] = value;
    }
  }
  if (parentSessionId != null) {
    meta.parentSessionId = parentSessionId;
  }
  return Object.keys(meta).length === 0 ? null : meta;
}

function parseUserContent(
  content: Json | undefined,
  seenToolResultIds: Set<string>,
): NormalizedBlock[] {
  if (!Array.isArray(content)) {
    const text = asString(content);
    if (text != null && text !== "") {
      return [textBlock(0, text)];
    }
    return [];
  }

  const blocks: NormalizedBlock[] = [];
  let ordinal = 0;

  for (const item of content) {
    const text = asString(get(item, "text"));
    if (text != null) {
      // Skip the boilerplate session-context injection Gemini prepends
      const trimmed = text.trimStart();
      if (!trimmed.startsWith("<session_context>") && !trimmed.startsWith("<hook_context>")) {
        blocks.push(textBlock(ordinal++, text));
      }
      continue;
    }

    const funcResponse = get(item, "functionResponse");
    if (funcResponse != null) {
      const name = asString(get(funcResponse, "name"));
      const callId = asString(get(funcResponse, "id")) ?? name;
      const response = get(funcResponse, "response");
      if (callId != null && seenToolResultIds.has(callId)) {
        // Gemini may repeat a completed function response in a later record.
        // Keep the source record without creating a second linked result.
        blocks.push(otherBlock(ordinal++, item));
        continue;
      }
      if (callId != null) {
        seenToolResultIds.add(callId);
      }
      blocks.push({
        ordinal: ordinal++,
        blockType: "tool_result",
        text: null,
        toolName: null,
        toolUseId: callId,
        toolInput: undefined,
        toolResult: canonicalJson(response ?? null),
        isError: toolResultIsError(response),
      });
    }
  }

  return blocks;
}

function parseGeminiContent(content: Json | undefined): NormalizedBlock[] {
  if (!Array.isArray(content)) {
    const text = asString(content);
    if (text != null && text !== "") {
      return [textBlock(0, text)];
    }
    return [];
  }

  const blocks: NormalizedBlock[] = [];
  let ordinal = 0;

  for (const item of content) {
    const text = asString(get(item, "text"));
    if (text != null && text !== "") {
      blocks.push(textBlock(ordinal++, text));
    }
  }

  return blocks;
}

function parseToolCalls(toolCalls: Json | undefined, startOrdinal: number): NormalizedBlock[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const blocks: NormalizedBlock[] = [];
  let ordinal = startOrdinal;
  for (const call of toolCalls) {
    // `result` is a UI snapshot. Gemini also writes the canonical
    // functionResponse as its own user record, which supplies linkage and raw.
    const name = normalizedToolName(call);
    const args = get(call, "args") ?? get(call, "function_args") ?? get(call, "input");
    const callId = asString(get(call, "id")) ?? name;
    blocks.push({
      ordinal: ordinal++,
      blockType: "tool_use",
      text: null,
      toolName: name,
      toolUseId: callId,
      toolInput: args,
      toolResult: null,
      isError: null,
    });
  }
  return blocks;
}

function normalizedToolName(call: Json): string | null {
  const name = asString(get(call, "name")) ?? asString(get(call, "function_name"));
  const displayName = asString(get(call, "displayName"));
  const displayMatch = displayName?.match(/^(.+) \((.+) MCP Server\)$/);
  if (displayMatch?.[1] != null && displayMatch[2] != null) {
    return `mcp__${displayMatch[2]}__${displayMatch[1]}`;
  }
  const qualifiedMatch = name?.match(/^mcp_([^_]+)_(.+)$/);
  if (qualifiedMatch?.[1] != null && qualifiedMatch[2] != null) {
    return `mcp__${qualifiedMatch[1]}__${qualifiedMatch[2]}`;
  }
  return name;
}

function toolResultIsError(response: Json | undefined): boolean | null {
  if (!isObject(response)) {
    return null;
  }
  const explicit = get(response, "isError");
  if (explicit === true || explicit === "true") {
    return true;
  }
  const error = get(response, "error");
  if (error != null && error !== false && error !== "") {
    return true;
  }
  return false;
}

function parseThoughts(thoughts: Json | undefined, startOrdinal: number): NormalizedBlock[] {
  if (!Array.isArray(thoughts)) {
    return [];
  }
  const blocks: NormalizedBlock[] = [];
  let ordinal = startOrdinal;
  for (const thought of thoughts) {
    const text = thoughtText(thought);
    if (text != null && text !== "") {
      blocks.push({
        ordinal: ordinal++,
        blockType: "thinking",
        text,
        toolName: null,
        toolUseId: null,
        toolInput: undefined,
        toolResult: null,
        isError: null,
      });
    }
  }
  return blocks;
}

/** Gemini records thought summaries as `{ subject, description }` pairs. */
function thoughtText(thought: Json): string | null {
  const subject = asString(get(thought, "subject"))?.trim() ?? "";
  const description = asString(get(thought, "description"))?.trim() ?? "";
  if (subject !== "" || description !== "") {
    return [subject, description].filter((part) => part !== "").join("\n\n");
  }
  return asString(get(thought, "text")) ?? asString(thought);
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

function otherBlock(ordinal: number, value: Json): NormalizedBlock {
  return {
    ordinal,
    blockType: "other",
    text: canonicalJson(value),
    toolName: null,
    toolUseId: null,
    toolInput: undefined,
    toolResult: null,
    isError: null,
  };
}

function usageFrom(tokens: Json | undefined): TokenUsage {
  if (!isObject(tokens)) {
    return emptyUsage();
  }
  // Gemini's `input` (promptTokenCount) already contains `cached`
  // (cachedContentTokenCount), and `thoughts` (thoughtsTokenCount) is billed as
  // output but reported outside `output` (candidatesTokenCount). Decant prices
  // input and cache reads separately and treats reasoning as a subset of output.
  const cached = getInteger(tokens, "cached");
  const thoughts = getInteger(tokens, "thoughts");
  return {
    input: Math.max(0, getInteger(tokens, "input") - cached),
    output: getInteger(tokens, "output") + thoughts,
    cacheRead: cached,
    cacheCreation: 0,
    cacheCreation1h: 0,
    reasoning: thoughts,
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheCreation1h: a.cacheCreation1h + b.cacheCreation1h,
    reasoning: a.reasoning + b.reasoning,
  };
}

function get(value: Json | undefined, key: string): Json | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return value[key];
}

function hasKey(value: Json | undefined, key: string): boolean {
  return isObject(value) && Object.hasOwn(value as JsonObject, key);
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function getInteger(value: JsonObject, key: string): number {
  const v = value[key];
  return typeof v === "number" && Number.isInteger(v) ? v : 0;
}
