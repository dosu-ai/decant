import { linkageIssues } from "../diagnostics.ts";
import { asString, get, isObject, type JsonObject } from "../json.ts";
import {
  emptyUsage,
  type Json,
  type NormalizedBlock,
  type NormalizedInnerToolCall,
  type NormalizedMessage,
  type NormalizedSession,
  type ParsedSession,
  type Role,
  reasoningEffortLevels,
  summarizeReasoningEfforts,
  type TokenUsage,
} from "../model.ts";
import { preview } from "../tools.ts";
import {
  block,
  countUnknownInRecord,
  nullRecord,
  parseJsonLine,
  unknownTypeIssues,
} from "./shared.ts";

/** Entry types Pi writes that carry nothing Decant stores (session-format.md). */
const IGNORED_TYPES = new Set(["context_edit", "custom", "label"]);

/** The largest magnitude a JavaScript Date can hold (ECMA-262 21.4.1.1). */
const MAX_DATE_MILLIS = 8.64e15;

/** A session file is named `<timestamp>_<session id>.jsonl`; the header's
 * own `id` wins when the file has one. */
export function piSessionIdFromStem(stem: string): string {
  const separator = stem.indexOf("_");
  return separator < 0 || separator === stem.length - 1 ? stem : stem.slice(separator + 1);
}

export interface PiStepperState {
  fallbackId: string;
  headerRecord: JsonObject | null;
  sourceSessionId: string | null;
  cwd: string | null;
  name: string | null;
  firstUserText: string | null;
  currentModel: string | null;
  startedAt: string | null;
  endedAt: string | null;
  efforts: string[];
  outputByModel: [model: string, output: number][];
  totals: TokenUsage;
  reasoningReported: boolean;
  copiedEntries: number;
  forkedAt: number | null;
  seq: number;
  unknownTypes: Record<string, { count: number; firstLine: number }>;
}

export interface PiLineStepResult {
  message?: NormalizedMessage;
  nestedCalls?: {
    toolCallId: string;
    inner: NormalizedInnerToolCall[];
  };
}

export function createPiStepper(fallbackId: string): PiStepperState {
  return {
    fallbackId,
    headerRecord: null,
    sourceSessionId: null,
    cwd: null,
    name: null,
    firstUserText: null,
    currentModel: null,
    startedAt: null,
    endedAt: null,
    efforts: [],
    outputByModel: [],
    totals: emptyUsage(),
    reasoningReported: false,
    copiedEntries: 0,
    forkedAt: null,
    seq: 0,
    unknownTypes: nullRecord<{ count: number; firstLine: number }>(),
  };
}

export function stepPiLine(
  state: PiStepperState,
  line: string,
  lineNo: number,
  issues: ParsedSession["issues"],
): PiLineStepResult {
  const entry = parseJsonLine(line, lineNo, issues);
  if (entry === undefined) {
    return {};
  }
  const noteUnknown = (typ: string): void => {
    countUnknownInRecord(state.unknownTypes, typ, lineNo);
  };
  if (!isObject(entry)) {
    noteUnknown("entry.non_object");
    return {};
  }
  const typ = asString(entry.type);
  if (typ == null) {
    noteUnknown("entry.untyped");
    return {};
  }
  const timestamp = entryTimestamp(entry);
  let entryIsCopy = false;
  if (typ !== "session") {
    entryIsCopy = state.forkedAt != null && isCopiedFromParent(timestamp, state.forkedAt);
    if (!entryIsCopy) {
      state.forkedAt = null;
    }
  }
  if (timestamp != null && typ !== "session" && !entryIsCopy) {
    state.startedAt = earlier(state.startedAt, timestamp);
    state.endedAt = later(state.endedAt, timestamp);
  }

  const makeMessage = (
    role: Role,
    blocks: NormalizedBlock[],
    fields: { model?: string | null; usage?: TokenUsage | null; stopReason?: string | null } = {},
  ): NormalizedMessage => {
    const message: NormalizedMessage = {
      seq: state.seq,
      sourceUuid: asString(entry.id),
      parentSourceUuid: asString(entry.parentId),
      role,
      model: fields.model ?? null,
      stopReason: fields.stopReason ?? null,
      timestamp: entryTimestamp(entry),
      usage: fields.usage ?? null,
      raw: entry,
      blocks,
    };
    state.seq += 1;
    return message;
  };

  const billed = (usage: Json | undefined): TokenUsage | null => {
    const converted = piUsage(usage);
    if (converted == null) {
      return null;
    }
    if (entryIsCopy) {
      state.copiedEntries += 1;
      return null;
    }
    addInto(state.totals, converted);
    state.reasoningReported ||= converted.reasoning > 0;
    return converted;
  };

  switch (typ) {
    case "session": {
      if (state.headerRecord != null) {
        return {};
      }
      state.headerRecord = entry;
      const headerTime = asString(entry.timestamp);
      state.sourceSessionId = asString(entry.id);
      state.cwd = asString(entry.cwd);
      if (headerTime != null) {
        state.startedAt = earlier(state.startedAt, headerTime);
      }
      const forked = asString(entry.parentSession) == null ? Number.NaN : timeOf(headerTime);
      state.forkedAt = Number.isFinite(forked) ? forked : null;
      return {};
    }
    case "message": {
      const message = isObject(entry.message) ? entry.message : null;
      if (message == null) {
        noteUnknown("message.missing");
        return {};
      }
      const role = asString(message.role);
      switch (role) {
        case "user": {
          const blocks = contentBlocks(message.content);
          const text = firstText(blocks);
          if (text != null) {
            state.firstUserText ??= text;
          }
          return { message: makeMessage("user", blocks) };
        }
        case "assistant": {
          const model = asString(message.model) ?? state.currentModel;
          const blocks = assistantBlocks(message.content);
          const usage = billed(message.usage);
          if (model != null && usage != null) {
            addModelOutput(state.outputByModel, model, usage.output);
          }
          const error = asString(message.errorMessage);
          if (error != null && error !== "") {
            blocks.push(block(blocks.length, "text", { text: error }));
          }
          collectEffort(state.efforts, message.thinkingLevel);
          return {
            message: makeMessage("assistant", blocks, {
              model,
              usage,
              stopReason: asString(message.stopReason),
            }),
          };
        }
        case "toolResult": {
          const toolCallId = asString(message.toolCallId);
          const result = block(0, "tool_result", {
            toolName: asString(message.toolName),
            toolUseId: toolCallId,
            toolResult: resultText(message.content),
            isError: message.isError === true,
          });
          const inner = toolCallId == null ? [] : nestedToolCalls(message.nestedCalls, toolCallId);
          return {
            message: makeMessage("tool", [result], { usage: billed(message.usage) }),
            ...(toolCallId != null && inner.length > 0
              ? { nestedCalls: { toolCallId, inner } }
              : {}),
          };
        }
        case "system": {
          const text = textOf(message.content);
          return {
            message: makeMessage("system", text === "" ? [] : [block(0, "text", { text })]),
          };
        }
        case "bashExecution": {
          return {
            message: makeMessage("other", [block(0, "text", { text: bashText(message) })]),
          };
        }
        // Version 2 named the role `hookMessage`; version 3 renamed it.
        case "custom":
        case "hookMessage": {
          return { message: makeMessage("other", contentBlocks(message.content)) };
        }
        case "branchSummary":
        case "compactionSummary": {
          const summary = asString(message.summary) ?? "";
          return {
            message: makeMessage(
              "system",
              summary === "" ? [] : [block(0, "text", { text: summary })],
            ),
          };
        }
        default: {
          noteUnknown(role == null ? "message.no_role" : `message:${role}`);
          return { message: makeMessage("other", contentBlocks(message.content)) };
        }
      }
    }
    case "model_change": {
      state.currentModel = asString(entry.modelId) ?? state.currentModel;
      return {};
    }
    case "thinking_level_change": {
      collectEffort(state.efforts, entry.thinkingLevel);
      return {};
    }
    case "usage": {
      const model = asString(entry.model) ?? state.currentModel;
      const usage = billed(entry.usage);
      if (usage == null) {
        return {};
      }
      if (model != null) {
        addModelOutput(state.outputByModel, model, usage.output);
      }
      return { message: makeMessage("other", [], { model, usage }) };
    }
    case "compaction":
    case "branch_summary": {
      // Pi writes the summary with the session's selected model and records
      // usage without naming it.
      const summary = asString(entry.summary) ?? "";
      return {
        message: makeMessage(
          "system",
          summary === "" ? [] : [block(0, "text", { text: summary })],
          {
            model: state.currentModel,
            usage: billed(entry.usage),
          },
        ),
      };
    }
    case "custom_message": {
      return { message: makeMessage("other", contentBlocks(entry.content)) };
    }
    case "session_info": {
      const value = asString(entry.name);
      state.name = value == null || value.trim() === "" ? null : value.trim();
      return {};
    }
    default: {
      if (!IGNORED_TYPES.has(typ)) {
        noteUnknown(typ);
      }
      return {};
    }
  }
}

export function piSessionFromState(
  state: PiStepperState,
  messages: NormalizedMessage[] = [],
  isArchived = false,
): NormalizedSession {
  return {
    tool: "pi",
    sourceSessionId: state.sourceSessionId ?? state.fallbackId,
    projectPath: state.cwd,
    title:
      state.name ?? (state.firstUserText == null ? null : preview(state.firstUserText.trim(), 120)),
    cwd: state.cwd,
    gitBranch: null,
    model: heaviestModel(state.outputByModel) ?? state.currentModel,
    reasoningEffort: summarizeReasoningEfforts(state.efforts),
    reasoningEffortLevels: reasoningEffortLevels(state.efforts),
    cliVersion: null,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    isArchived,
    isSubagent: false,
    rootSourceSessionId: null,
    spawnToolUseId: null,
    agentId: null,
    agentType: null,
    spawnDepth: null,
    rawMeta: rawMetaFrom(state.headerRecord, state.copiedEntries),
    totals: state.totals,
    estReasoningTokens: 0,
    reasoningSource: state.reasoningReported ? "reported" : "none",
    messages,
  };
}

export function piUnknownTypeIssues(state: PiStepperState): ParsedSession["issues"] {
  return unknownTypeIssues(new Map(Object.entries(state.unknownTypes)), "ignored");
}

export function parsePiSession(fallbackId: string, content: string): ParsedSession {
  const state = createPiStepper(fallbackId);
  const issues: ParsedSession["issues"] = [];
  const messages: NormalizedMessage[] = [];
  const toolUses = new Map<string, NormalizedBlock>();

  for (const [index, line] of content.split(/\n/).entries()) {
    const step = stepPiLine(state, line, index + 1, issues);
    if (step.nestedCalls != null) {
      const wrapper = toolUses.get(step.nestedCalls.toolCallId);
      if (wrapper != null) {
        wrapper.innerToolCalls = step.nestedCalls.inner;
      }
    }
    if (step.message != null) {
      for (const blk of step.message.blocks) {
        if (blk.blockType === "tool_use" && blk.toolUseId != null) {
          toolUses.set(blk.toolUseId, blk);
        }
      }
      messages.push(step.message);
    }
  }

  issues.push(...piUnknownTypeIssues(state));
  const normalized = piSessionFromState(state, messages);
  issues.push(...linkageIssues(normalized));
  return { session: normalized, issues };
}

/**
 * `/fork`, `/clone`, and `SessionManager.forkFrom` write a new session file in
 * one pass: a header naming the original in `parentSession` and stamped with
 * the fork time, then the original's entries with their ids, timestamps, and
 * usage unchanged. Pi already billed those entries in the original session.
 * New entries are only ever appended after them, so the copies are the run of
 * entries right after the header that were written at or before the fork.
 */
function isCopiedFromParent(timestamp: string | null, forkedAt: number): boolean {
  const at = timeOf(timestamp);
  return Number.isFinite(at) && at <= forkedAt;
}

function timeOf(timestamp: string | null): number {
  return timestamp == null ? Number.NaN : Date.parse(timestamp);
}

/** Pi's `input` excludes cache reads and writes, as Decant's does, and its
 * `reasoning` is already part of `output`. */
export function piUsage(value: Json | undefined): TokenUsage | null {
  if (!isObject(value)) {
    return null;
  }
  const cacheCreation = count(value.cacheWrite);
  return {
    input: count(value.input),
    output: count(value.output),
    cacheRead: count(value.cacheRead),
    cacheCreation,
    cacheCreation1h: Math.min(count(value.cacheWrite1h), cacheCreation),
    reasoning: Math.min(count(value.reasoning), count(value.output)),
  };
}

function entryTimestamp(entry: JsonObject): string | null {
  const recorded = asString(entry.timestamp);
  if (recorded != null) {
    return recorded;
  }
  const millis = get(entry.message, "timestamp");
  return typeof millis === "number" && Math.abs(millis) <= MAX_DATE_MILLIS
    ? new Date(millis).toISOString()
    : null;
}

function contentBlocks(content: Json | undefined): NormalizedBlock[] {
  if (typeof content === "string") {
    return content === "" ? [] : [block(0, "text", { text: content })];
  }
  const blocks: NormalizedBlock[] = [];
  for (const item of Array.isArray(content) ? content : []) {
    const type = asString(get(item, "type"));
    if (type === "text") {
      const text = asString(get(item, "text")) ?? "";
      if (text !== "") {
        blocks.push(block(blocks.length, "text", { text }));
      }
    } else if (type === "image") {
      blocks.push(block(blocks.length, "image", { text: asString(get(item, "mimeType")) }));
    } else if (item != null) {
      blocks.push(block(blocks.length, "other", { text: type }));
    }
  }
  return blocks;
}

function assistantBlocks(content: Json | undefined): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  for (const item of Array.isArray(content) ? content : []) {
    const type = asString(get(item, "type"));
    if (type === "text") {
      const text = asString(get(item, "text")) ?? "";
      if (text !== "") {
        blocks.push(block(blocks.length, "text", { text }));
      }
    } else if (type === "thinking") {
      const text = asString(get(item, "thinking")) ?? "";
      if (text !== "" || get(item, "redacted") === true) {
        blocks.push(block(blocks.length, "thinking", { text }));
      }
    } else if (type === "toolCall") {
      const id = asString(get(item, "id"));
      const toolUse = block(blocks.length, "tool_use", {
        toolName: asString(get(item, "name")),
        toolUseId: id,
        toolInput: get(item, "arguments"),
      });
      blocks.push(toolUse);
    } else if (item != null) {
      blocks.push(block(blocks.length, "other", { text: type }));
    }
  }
  return blocks;
}

function nestedToolCalls(
  nested: Json | undefined,
  wrapperId: string | null,
): NormalizedInnerToolCall[] {
  const calls: NormalizedInnerToolCall[] = [];
  const records = get(nested, "calls");
  for (const [index, call] of (Array.isArray(records) ? records : []).entries()) {
    const toolName = asString(get(call, "name"));
    if (toolName == null || toolName === "") {
      continue;
    }
    const id = asString(get(call, "id"));
    const status = asString(get(call, "status"));
    calls.push({
      toolName,
      toolUseId: wrapperId == null ? null : `${wrapperId}#${id ?? index}`,
      toolInput: get(call, "arguments"),
      isError: status === "ok" ? false : status === "error" ? true : null,
    });
  }
  return calls;
}

function resultText(content: Json | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const item of Array.isArray(content) ? content : []) {
    const type = asString(get(item, "type"));
    if (type === "text") {
      parts.push(asString(get(item, "text")) ?? "");
    } else if (type === "image") {
      const mimeType = asString(get(item, "mimeType"));
      parts.push(mimeType == null ? "[image]" : `[image ${mimeType}]`);
    }
  }
  return parts.join("\n");
}

function textOf(content: Json | undefined): string {
  if (typeof content === "string") {
    return content;
  }
  return (Array.isArray(content) ? content : [])
    .map((item) => asString(get(item, "text")) ?? "")
    .filter((text) => text !== "")
    .join("\n");
}

function firstText(blocks: NormalizedBlock[]): string | null {
  for (const candidate of blocks) {
    if (candidate.blockType === "text" && candidate.text != null && candidate.text.trim() !== "") {
      return candidate.text;
    }
  }
  return null;
}

function bashText(message: JsonObject): string {
  const command = asString(message.command) ?? "";
  const output = asString(message.output) ?? "";
  return output === "" ? `$ ${command}` : `$ ${command}\n${output}`;
}

/** Pi names the lowest level `off`; Decant's shared name for it is `none`. */
function collectEffort(efforts: string[], value: Json | undefined): void {
  const effort = asString(value);
  if (effort != null) {
    efforts.push(effort === "off" ? "none" : effort);
  }
}

function earlier(current: string | null, candidate: string): string {
  return current == null || candidate < current ? candidate : current;
}

function later(current: string | null, candidate: string): string {
  return current == null || candidate > current ? candidate : current;
}

function addModelOutput(
  outputByModel: [model: string, output: number][],
  model: string,
  output: number,
): void {
  const entry = outputByModel.find(([seen]) => seen === model);
  if (entry == null) {
    outputByModel.push([model, output]);
  } else {
    entry[1] += output;
  }
}

function heaviestModel(outputByModel: Iterable<[string, number]>): string | null {
  let best: { model: string; output: number } | null = null;
  for (const [model, output] of outputByModel) {
    if (best == null || output > best.output) {
      best = { model, output };
    }
  }
  return best?.model ?? null;
}

function rawMetaFrom(header: JsonObject | null, copiedEntries: number): Json {
  const meta: JsonObject = {};
  if (header != null) {
    meta.header = header;
  }
  if (copiedEntries > 0) {
    meta.copiedUsageEntries = copiedEntries;
  }
  return Object.keys(meta).length === 0 ? null : meta;
}

function addInto(total: TokenUsage, usage: TokenUsage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheCreation += usage.cacheCreation;
  total.cacheCreation1h += usage.cacheCreation1h;
  total.reasoning += usage.reasoning;
}

function count(value: Json | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
