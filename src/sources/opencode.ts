import { linkageIssues } from "../diagnostics.ts";
import { asInteger, asString, canonicalJson, get, isObject, type JsonObject } from "../json.ts";
import {
  emptyUsage,
  type Issue,
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
import { compareCodePoints } from "../order.ts";
import { preview } from "../tools.ts";
import type { OpenCodeLegacyMessageRow, OpenCodeLegacyPartRow } from "./opencode-legacy.ts";
import {
  addTokenUsage,
  type MigratedUsage,
  migratedUsage,
  openCodeUsage,
  parseOpenCodeVersion,
  reasoningOverlap,
} from "./opencode-usage.ts";
import {
  block,
  contentText,
  countUnknown,
  diagnosticRawLine,
  jsonProblem,
  parseSourceJson,
  type UnknownTypes,
  unknownTypeIssues,
} from "./shared.ts";

export interface OpenCodeSessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  fork_session_id: string | null;
  fork_boundary: string | null;
  slug: string;
  directory: string;
  title: string | null;
  version: string;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  agent: string | null;
  model: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

export interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface OpenCodeLegacyCounterpart {
  version: string | null;
  messages: readonly OpenCodeLegacyMessageRow[];
  parts: readonly OpenCodeLegacyPartRow[];
}

export interface OpenCodeModelRef {
  providerID: string | null;
  id: string | null;
  variant: string | null;
}

export interface OpenCodeParseContext {
  mcpServers: readonly string[];
  contextWindows: ReadonlyMap<string, number>;
}

export function mcpServerPrefixes(servers: readonly string[]): string[] {
  const unique = new Set(servers.map(sanitizeMcpName).filter((name) => name !== ""));
  return [...unique].sort((a, b) => b.length - a.length || compareCodePoints(a, b));
}

/** OpenCode registers MCP tools as `<server>_<tool>` with both parts passed
 * through this replacement (packages/core/src/tool/mcp.ts). */
export function normalizeOpenCodeToolName(name: string, serverPrefixes: readonly string[]): string {
  for (const server of serverPrefixes) {
    if (name.length > server.length + 1 && name.startsWith(`${server}_`)) {
      return `mcp__${server}__${name.slice(server.length + 1)}`;
    }
  }
  return name;
}

function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const SWITCH_TYPES = new Set(["agent-switched", "model-switched", "location-switched"]);

type MessageFields = Partial<
  Pick<NormalizedMessage, "sourceUuid" | "model" | "stopReason" | "timestamp" | "usage">
>;

interface ToolResult {
  raw: Json;
  timestamp: string | null;
  block: NormalizedBlock;
}

export function parseOpenCodeSession(
  row: OpenCodeSessionRow,
  rows: readonly OpenCodeMessageRow[],
  context: OpenCodeParseContext,
  legacy: OpenCodeLegacyCounterpart | null = null,
): ParsedSession {
  const issues: Issue[] = [];
  const unknownTypes: UnknownTypes = new Map();
  const messages: NormalizedMessage[] = [];
  const switches: Json[] = [];
  const efforts: string[] = [];
  const servers = mcpServerPrefixes(context.mcpServers);
  let totals = emptyUsage();
  let sawUsage = false;
  let lastModel: OpenCodeModelRef | null = null;
  let firstUserText: string | null = null;
  let forkRowsSkipped = 0;
  let seq = 0;
  let migratedRows = 0;
  const migrated: MigratedUsage | null =
    legacy != null && legacy.messages.length > 0
      ? migratedUsage(legacy.version, legacy.messages, legacy.parts)
      : null;
  const rowUsage = (tokens: Json | undefined): TokenUsage | null =>
    openCodeUsage(
      tokens,
      migrated != null || !isObject(tokens) ? "disjoint" : reasoningOverlap(tokens, row.version),
    );

  const emit = (role: Role, raw: Json, fields: MessageFields, blocks: NormalizedBlock[]): void => {
    messages.push({
      seq,
      sourceUuid: null,
      parentSourceUuid: null,
      role,
      model: null,
      stopReason: null,
      timestamp: null,
      usage: null,
      raw,
      blocks,
      ...fields,
    });
    seq += 1;
  };

  // A fork copies the parent's settled rows with their original timestamps.
  // `opencode stats` skips them only when `fork_session_id` is set; a fork
  // OpenCode migrated from 1.x has no such link.
  const majorVersion = parseOpenCodeVersion(row.version)?.[0];
  const skipInherited =
    row.fork_session_id != null || legacy != null || (majorVersion != null && majorVersion < 2);
  for (const message of rows) {
    if (skipInherited && message.time_created < row.time_created) {
      forkRowsSkipped += 1;
      continue;
    }
    const data = parseMessageData(message, issues);
    if (data == null) {
      continue;
    }
    const raw: JsonObject = { ...data, id: message.id, type: message.type, seq: message.seq };
    const timestamp = isoFromMillis(asInteger(get(data.time, "created")) ?? message.time_created);
    const typ = message.type;

    if (typ === "user") {
      const text = asString(data.text) ?? "";
      if (firstUserText == null && text.trim() !== "") {
        firstUserText = text;
      }
      emit("user", raw, { sourceUuid: message.id, timestamp }, userBlocks(data));
    } else if (typ === "assistant") {
      const model = modelRef(data.model);
      if (model.id != null) {
        lastModel = model;
      }
      if (model.variant != null && model.variant !== "default") {
        efforts.push(model.variant);
      }
      const corrected = migrated?.assistants.get(message.id);
      if (corrected != null) {
        migratedRows += 1;
      }
      const usage = corrected?.usage ?? rowUsage(data.tokens);
      if (usage != null) {
        totals = addTokenUsage(totals, usage);
        sawUsage = true;
        raw.reasoning_tokens = usage.reasoning;
      }
      const { blocks, results } = assistantContent(data.content, servers);
      const generated = isoFromMillis(stepGenerationEnd(data)) ?? timestamp;
      emit(
        "assistant",
        raw,
        {
          sourceUuid: message.id,
          model: model.id,
          stopReason: data.error != null ? "error" : asString(data.finish),
          timestamp: generated,
          usage,
        },
        blocks,
      );
      for (const result of results) {
        emit("tool", result.raw, { timestamp: result.timestamp ?? generated }, [result.block]);
      }
    } else if (typ === "compaction") {
      const model = modelRef(data.model);
      const answer = migrated?.compactions.get(message.id);
      if (answer != null) {
        migratedRows += 1;
        if (data.cost == null && answer.cost != null) {
          raw.cost = answer.cost;
        }
      }
      const usage = answer != null ? answer.usage : rowUsage(data.tokens);
      if (usage != null) {
        totals = addTokenUsage(totals, usage);
        sawUsage = true;
      }
      const status = asString(data.status);
      const summary = asString(data.summary) ?? "";
      const text =
        summary !== "" ? summary : `Context compacted${status == null ? "" : ` (${status})`}`;
      emit(
        "system",
        raw,
        {
          sourceUuid: message.id,
          model: model.id ?? answer?.modelId ?? null,
          stopReason: status === "failed" ? "error" : null,
          timestamp,
          usage,
        },
        [block(0, "text", { text })],
      );
    } else if (typ === "shell") {
      const command = asString(data.command) ?? "";
      const output = contentText(data.output);
      const text = output === "" ? `$ ${command}` : `$ ${command}\n${output}`;
      emit("user", raw, { sourceUuid: message.id, timestamp }, [block(0, "text", { text })]);
    } else if (typ === "synthetic" || typ === "system" || typ === "skill") {
      const text = asString(data.text) ?? "";
      emit(
        "system",
        raw,
        { sourceUuid: message.id, timestamp },
        text === "" ? [] : [block(0, "text", { text })],
      );
    } else if (typ === "idle") {
      const outcome = asString(data.outcome);
      if (outcome === "failed" || outcome === "interrupted") {
        const detail = asString(get(data.error, "message"));
        emit(
          "system",
          raw,
          { sourceUuid: message.id, stopReason: outcome === "failed" ? "error" : null, timestamp },
          [
            block(0, "text", {
              text: detail == null ? `Turn ${outcome}` : `Turn ${outcome}: ${detail}`,
            }),
          ],
        );
      }
    } else if (SWITCH_TYPES.has(typ)) {
      switches.push(raw);
    } else {
      countUnknown(unknownTypes, typ, message.seq);
    }
  }

  issues.push(...unknownTypeIssues(unknownTypes, "ignored"));

  const sessionModel = modelRef(parseModelJson(row.model));
  const model = sessionModel.id != null ? sessionModel : lastModel;
  const modelId = model?.id ?? null;
  const providerId = model?.providerID ?? null;
  const contextWindow =
    modelId != null && providerId != null
      ? (context.contextWindows.get(`${providerId}/${modelId}`) ?? null)
      : null;
  const isSubagent = row.parent_id != null;
  const directory = row.directory === "" ? null : row.directory;

  const rawMeta: JsonObject = {
    id: row.id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    fork_session_id: row.fork_session_id,
    fork_boundary: row.fork_boundary,
    slug: row.slug,
    directory: row.directory,
    title: row.title,
    version: row.version,
    agent: row.agent,
    model: parseModelJson(row.model) ?? null,
    model_provider: providerId,
    model_variant: model?.variant ?? null,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache_read: row.tokens_cache_read,
      cache_write: row.tokens_cache_write,
    },
    time_created: row.time_created,
    time_updated: row.time_updated,
    time_archived: row.time_archived,
  };
  if (row.parent_id != null) {
    rawMeta.parentSessionId = row.parent_id;
  }
  if (contextWindow != null) {
    rawMeta.model_context_window = contextWindow;
  }
  if (switches.length > 0) {
    rawMeta.switches = switches;
  }
  if (forkRowsSkipped > 0) {
    rawMeta.fork_rows_skipped = forkRowsSkipped;
  }
  if (migratedRows > 0) {
    rawMeta.migrated_rows_from_v1 = migratedRows;
  }

  const normalized: NormalizedSession = {
    tool: "opencode",
    sourceSessionId: row.id,
    projectPath: directory,
    title: row.title ?? (firstUserText == null ? null : preview(firstUserText.trim(), 120)),
    cwd: directory,
    gitBranch: null,
    model: modelId,
    reasoningEffort: summarizeReasoningEfforts(efforts),
    reasoningEffortLevels: reasoningEffortLevels(efforts),
    cliVersion: row.version,
    startedAt: isoFromMillis(row.time_created),
    endedAt: isoFromMillis(row.time_updated),
    isArchived: row.time_archived != null,
    isSubagent,
    rootSourceSessionId: row.parent_id,
    spawnToolUseId: null,
    agentId: isSubagent ? row.id : null,
    agentType: row.agent,
    spawnDepth: null,
    rawMeta,
    totals,
    estReasoningTokens: 0,
    reasoningSource: sawUsage ? "reported" : "none",
    messages,
  };
  issues.push(...linkageIssues(normalized));
  return { session: normalized, issues };
}

function parseMessageData(message: OpenCodeMessageRow, issues: Issue[]): JsonObject | null {
  let value: Json;
  try {
    value = parseSourceJson(message.data) as Json;
  } catch (error) {
    issues.push({
      code: "unparsed_line",
      lineNo: message.seq,
      error: jsonProblem(error),
      rawLine: diagnosticRawLine(error, message.data),
    });
    return null;
  }
  if (!isObject(value)) {
    issues.push({
      code: "unparsed_line",
      lineNo: message.seq,
      error: "message data is not a JSON object",
      rawLine: message.data,
    });
    return null;
  }
  return value;
}

function userBlocks(data: JsonObject): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  const text = asString(data.text) ?? "";
  if (text !== "") {
    blocks.push(block(0, "text", { text }));
  }
  if (Array.isArray(data.files)) {
    for (const file of data.files) {
      const label = asString(get(file, "filename")) ?? asString(get(file, "mime")) ?? "attachment";
      blocks.push(block(blocks.length, "image", { text: label }));
    }
  }
  return blocks;
}

function assistantContent(
  content: Json | undefined,
  servers: readonly string[],
): { blocks: NormalizedBlock[]; results: ToolResult[] } {
  const blocks: NormalizedBlock[] = [];
  const results: ToolResult[] = [];
  if (!Array.isArray(content)) {
    return { blocks, results };
  }
  for (const item of content) {
    const type = asString(get(item, "type"));
    const text = asString(get(item, "text")) ?? "";
    if (type === "text") {
      if (text !== "") {
        blocks.push(block(blocks.length, "text", { text }));
      }
    } else if (type === "reasoning") {
      // Kept when empty: providers that hide reasoning (often via OpenRouter)
      // leave the text blank but still bill the tokens.
      blocks.push(block(blocks.length, "thinking", { text }));
    } else if (type === "tool") {
      const id = asString(get(item, "id"));
      const name = asString(get(item, "name")) ?? "unknown";
      const state = get(item, "state");
      const status = asString(get(state, "status"));
      const time = get(item, "time");
      const call = block(blocks.length, "tool_use", {
        toolName: normalizeOpenCodeToolName(name, servers),
        toolUseId: id,
        toolInput: get(state, "input"),
      });
      // OpenCode's own stats time a call from `ran`, or from `created` on a
      // row migrated from 1.x, whose `created` is when the 1.x run started.
      const calledAt = isoFromMillis(
        asInteger(get(time, "ran")) ?? asInteger(get(time, "created")),
      );
      if (calledAt != null) {
        call.calledAt = calledAt;
      }
      if (name === CODE_EXECUTION_TOOL) {
        const inner = innerToolCalls(get(get(state, "metadata"), "toolCalls"), id);
        if (inner.length > 0) {
          call.innerToolCalls = inner;
        }
      }
      blocks.push(call);
      if (status === "completed" || status === "error") {
        const error = get(state, "error");
        results.push({
          raw: item,
          timestamp: isoFromMillis(asInteger(get(time, "completed"))),
          block: block(0, "tool_result", {
            toolUseId: id,
            toolResult:
              status === "error"
                ? (asString(get(error, "message")) ?? canonicalJson(error ?? null))
                : contentText(get(state, "content")),
            isError: status === "error",
          }),
        });
      }
    } else {
      blocks.push(block(blocks.length, "other", { text: canonicalJson(item) }));
    }
  }
  return { blocks, results };
}

/** OpenCode stamps a step `created` when it starts, `streamed` when the
 * provider response ends, and `completed` after its tools settle. */
function stepGenerationEnd(data: JsonObject): number | null {
  const ends: number[] = [];
  let untimedText = false;
  let hasTools = false;
  for (const item of Array.isArray(data.content) ? data.content : []) {
    const type = asString(get(item, "type"));
    const time = get(item, "time");
    if (type === "tool") {
      hasTools = true;
      pushTime(ends, get(time, "ran") ?? get(time, "created"));
    } else if (type === "reasoning" || type === "text") {
      const end = asInteger(get(time, "completed")) ?? asInteger(get(time, "end"));
      if (end == null) {
        untimedText = true;
      } else {
        ends.push(end);
      }
    }
  }
  return stepEnd({
    streamed: asInteger(get(data.time, "streamed")),
    completed: asInteger(get(data.time, "completed")),
    created: asInteger(get(data.time, "created")),
    partEnds: ends,
    untimedText,
    hasTools,
  });
}

function pushTime(into: number[], value: Json | undefined): void {
  const ms = asInteger(value);
  if (ms != null) {
    into.push(ms);
  }
}

export interface StepTimes {
  streamed: number | null;
  completed: number | null;
  created: number | null;
  partEnds: readonly number[];
  untimedText: boolean;
  hasTools: boolean;
}

export function stepEnd(times: StepTimes): number | null {
  if (times.streamed != null) {
    return times.streamed;
  }
  const latest = times.partEnds.length > 0 ? Math.max(...times.partEnds) : null;
  if (latest != null && (times.hasTools || !times.untimedText)) {
    return latest;
  }
  return times.completed ?? latest ?? times.created;
}

/** OpenCode 2.x runs MCP tools (and some built-ins) from a JavaScript program
 * passed to this tool, recording each call it made in
 * `state.metadata.toolCalls`. */
const CODE_EXECUTION_TOOL = "execute";

const OPENCODE_NAMESPACE = "opencode";

export function innerToolCalls(
  entries: Json | undefined,
  wrapperId: string | null,
): NormalizedInnerToolCall[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const calls: NormalizedInnerToolCall[] = [];
  entries.forEach((entry, index) => {
    const tool = asString(get(entry, "tool"));
    if (tool == null || tool === "") {
      return;
    }
    const status = asString(get(entry, "status"));
    calls.push({
      toolName: innerToolName(tool),
      toolUseId: wrapperId == null ? null : `${wrapperId}#${index}`,
      toolInput: get(entry, "input"),
      isError: status === "completed" ? false : status === "error" ? true : null,
    });
  });
  return calls;
}

export function innerToolName(tool: string): string {
  const dot = tool.indexOf(".");
  if (dot <= 0 || dot === tool.length - 1) {
    return tool;
  }
  const namespace = tool.slice(0, dot);
  if (namespace === OPENCODE_NAMESPACE) {
    return tool;
  }
  return `mcp__${sanitizeMcpName(namespace)}__${sanitizeMcpName(tool.slice(dot + 1))}`;
}

export function parseModelJson(value: string | null): Json | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    return parseSourceJson(value) as Json;
  } catch {
    return undefined;
  }
}

function modelRef(value: Json | undefined): OpenCodeModelRef {
  return {
    providerID: asString(get(value, "providerID")),
    id: asString(get(value, "id")),
    variant: asString(get(value, "variant")),
  };
}

export function isoFromMillis(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
