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
  countUnknown,
  parseJsonLine,
  type UnknownTypes,
  unknownTypeIssues,
} from "./shared.ts";

/** Entry types Pi writes that carry nothing Decant stores (session-format.md). */
const IGNORED_TYPES = new Set(["context_edit", "custom", "label"]);

export interface PiSessionHeader {
  timestamp: string | null;
  parentSession: string | null;
}

/** A session file is named `<timestamp>_<session id>.jsonl`; the header's
 * own `id` wins when the file has one. */
export function piSessionIdFromStem(stem: string): string {
  const separator = stem.indexOf("_");
  return separator < 0 || separator === stem.length - 1 ? stem : stem.slice(separator + 1);
}

export function parsePiSession(fallbackId: string, content: string): ParsedSession {
  const issues: ParsedSession["issues"] = [];
  const unknownTypes: UnknownTypes = new Map();
  const messages: NormalizedMessage[] = [];
  const toolUses = new Map<string, NormalizedBlock>();
  const efforts: string[] = [];
  const outputByModel = new Map<string, number>();
  const totals = emptyUsage();

  let header: PiSessionHeader | null = null;
  let headerRecord: JsonObject | null = null;
  let sourceSessionId: string | null = null;
  let cwd: string | null = null;
  let name: string | null = null;
  let firstUserText: string | null = null;
  let currentModel: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let reasoningReported = false;
  let copiedEntries = 0;
  let seq = 0;

  const push = (
    role: Role,
    entry: JsonObject,
    blocks: NormalizedBlock[],
    fields: { model?: string | null; usage?: TokenUsage | null; stopReason?: string | null } = {},
  ): void => {
    messages.push({
      seq,
      sourceUuid: asString(entry.id),
      parentSourceUuid: asString(entry.parentId),
      role,
      model: fields.model ?? null,
      stopReason: fields.stopReason ?? null,
      timestamp: entryTimestamp(entry),
      usage: fields.usage ?? null,
      raw: entry,
      blocks,
    });
    seq += 1;
  };

  /** Usage on an entry the session copied from its parent was billed there. */
  const billed = (entry: JsonObject, usage: Json | undefined): TokenUsage | null => {
    const converted = piUsage(usage);
    if (converted == null) {
      return null;
    }
    if (header != null && isCopiedFromParent(entry, header)) {
      copiedEntries += 1;
      return null;
    }
    addInto(totals, converted);
    reasoningReported ||= converted.reasoning > 0;
    return converted;
  };

  for (const [index, line] of content.split(/\n/).entries()) {
    const lineNo = index + 1;
    const entry = parseJsonLine(line, lineNo, issues);
    if (entry === undefined || !isObject(entry)) {
      continue;
    }
    const typ = asString(entry.type);
    if (typ == null) {
      continue;
    }
    const timestamp = entryTimestamp(entry);
    if (timestamp != null && typ !== "session") {
      startedAt = earlier(startedAt, timestamp);
      endedAt = later(endedAt, timestamp);
    }

    switch (typ) {
      case "session": {
        if (headerRecord != null) {
          break;
        }
        headerRecord = entry;
        header = {
          timestamp: asString(entry.timestamp),
          parentSession: asString(entry.parentSession),
        };
        sourceSessionId = asString(entry.id);
        cwd = asString(entry.cwd);
        if (header.timestamp != null) {
          startedAt = earlier(startedAt, header.timestamp);
        }
        break;
      }
      case "message": {
        const message = isObject(entry.message) ? entry.message : null;
        if (message == null) {
          countUnknown(unknownTypes, "message:(no message)", lineNo);
          break;
        }
        const role = asString(message.role);
        switch (role) {
          case "user": {
            const blocks = contentBlocks(message.content);
            const text = firstText(blocks);
            if (text != null) {
              firstUserText ??= text;
            }
            push("user", entry, blocks);
            break;
          }
          case "assistant": {
            const model = asString(message.model) ?? currentModel;
            const blocks = assistantBlocks(message.content, toolUses);
            const usage = billed(entry, message.usage);
            if (model != null && usage != null) {
              outputByModel.set(model, (outputByModel.get(model) ?? 0) + usage.output);
            }
            const error = asString(message.errorMessage);
            if (error != null && error !== "") {
              blocks.push(block(blocks.length, "text", { text: error }));
            }
            collectEffort(efforts, message.thinkingLevel);
            push("assistant", entry, blocks, {
              model,
              usage,
              stopReason: asString(message.stopReason),
            });
            break;
          }
          case "toolResult": {
            const toolCallId = asString(message.toolCallId);
            const result = block(0, "tool_result", {
              toolName: asString(message.toolName),
              toolUseId: toolCallId,
              toolResult: resultText(message.content),
              isError: message.isError === true,
            });
            const wrapper = toolCallId == null ? undefined : toolUses.get(toolCallId);
            if (wrapper != null) {
              const inner = nestedToolCalls(message.nestedCalls, toolCallId);
              if (inner.length > 0) {
                wrapper.innerToolCalls = inner;
              }
            }
            push("tool", entry, [result], { usage: billed(entry, message.usage) });
            break;
          }
          case "system": {
            const text = textOf(message.content);
            push("system", entry, text === "" ? [] : [block(0, "text", { text })]);
            break;
          }
          case "bashExecution": {
            push("other", entry, [block(0, "text", { text: bashText(message) })]);
            break;
          }
          case "custom": {
            push("other", entry, contentBlocks(message.content));
            break;
          }
          case "branchSummary":
          case "compactionSummary": {
            const summary = asString(message.summary) ?? "";
            push("system", entry, summary === "" ? [] : [block(0, "text", { text: summary })]);
            break;
          }
          default: {
            countUnknown(unknownTypes, `message:${role ?? "(no role)"}`, lineNo);
            push("other", entry, contentBlocks(message.content));
          }
        }
        break;
      }
      case "model_change": {
        currentModel = asString(entry.modelId) ?? currentModel;
        break;
      }
      case "thinking_level_change": {
        collectEffort(efforts, entry.thinkingLevel);
        break;
      }
      case "usage": {
        const model = asString(entry.model) ?? currentModel;
        const usage = billed(entry, entry.usage);
        if (usage == null) {
          break;
        }
        if (model != null) {
          outputByModel.set(model, (outputByModel.get(model) ?? 0) + usage.output);
        }
        push("other", entry, [], { model, usage });
        break;
      }
      case "compaction":
      case "branch_summary": {
        // Pi writes the summary with the session's selected model and records
        // usage without naming it.
        const summary = asString(entry.summary) ?? "";
        push("system", entry, summary === "" ? [] : [block(0, "text", { text: summary })], {
          model: currentModel,
          usage: billed(entry, entry.usage),
        });
        break;
      }
      case "custom_message": {
        push("other", entry, contentBlocks(entry.content));
        break;
      }
      case "session_info": {
        const value = asString(entry.name);
        name = value == null || value.trim() === "" ? null : value.trim();
        break;
      }
      default: {
        if (!IGNORED_TYPES.has(typ)) {
          countUnknown(unknownTypes, typ, lineNo);
        }
      }
    }
  }

  issues.push(...unknownTypeIssues(unknownTypes, "ignored"));

  const normalized: NormalizedSession = {
    tool: "pi",
    sourceSessionId: sourceSessionId ?? fallbackId,
    projectPath: cwd,
    title: name ?? (firstUserText == null ? null : preview(firstUserText.trim(), 120)),
    cwd,
    gitBranch: null,
    model: heaviestModel(outputByModel) ?? currentModel,
    reasoningEffort: summarizeReasoningEfforts(efforts),
    reasoningEffortLevels: reasoningEffortLevels(efforts),
    cliVersion: null,
    startedAt,
    endedAt,
    isArchived: false,
    isSubagent: false,
    rootSourceSessionId: null,
    spawnToolUseId: null,
    agentId: null,
    agentType: null,
    spawnDepth: null,
    rawMeta: rawMetaFrom(headerRecord, copiedEntries),
    totals,
    estReasoningTokens: 0,
    reasoningSource: reasoningReported ? "reported" : "none",
    messages,
  };
  issues.push(...linkageIssues(normalized));
  return { session: normalized, issues };
}

/**
 * `/fork`, `/clone`, and `SessionManager.forkFrom` start a new session file
 * whose header names the original in `parentSession`, then copy the original's
 * entries into it with their ids, timestamps, and usage unchanged. Pi already
 * billed those entries in the original session.
 *
 * Return true when `entry` is such a copy, so its usage is not counted twice.
 */
export function isCopiedFromParent(entry: JsonObject, header: PiSessionHeader): boolean {
  if (header.parentSession == null || header.timestamp == null) {
    return false;
  }
  const forkedAt = Date.parse(header.timestamp);
  const recorded = entryTimestamp(entry);
  const at = recorded == null ? Number.NaN : Date.parse(recorded);
  return Number.isFinite(forkedAt) && Number.isFinite(at) && at < forkedAt;
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
  return typeof millis === "number" && Number.isFinite(millis)
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

function assistantBlocks(
  content: Json | undefined,
  toolUses: Map<string, NormalizedBlock>,
): NormalizedBlock[] {
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
      if (id != null) {
        toolUses.set(id, toolUse);
      }
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

function heaviestModel(outputByModel: Map<string, number>): string | null {
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
