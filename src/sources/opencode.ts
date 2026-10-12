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
} from "../model.ts";
import { compareCodePoints } from "../order.ts";
import { preview } from "../tools.ts";
import { addTokenUsage, openCodeUsage } from "./opencode-usage.ts";
import {
  block,
  contentText,
  countUnknown,
  type UnknownTypes,
  unknownTypeIssues,
} from "./shared.ts";

/** One `session_v2` row as `OpenCodeStore.loadSession` reads it. */
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
  /** JSON `{ providerID, id, variant? }` for the session's current model. */
  model: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

/** One `session_message` row; `data` is the message JSON minus `id` and `type`. */
export interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface OpenCodeModelRef {
  providerID: string | null;
  id: string | null;
  variant: string | null;
}

export interface OpenCodeParseContext {
  /** MCP server names from the global and project OpenCode configs, as
   * written there (unsanitized). */
  mcpServers: readonly string[];
  /** models.dev context limits keyed `<providerID>/<modelID>`. */
  contextWindows: ReadonlyMap<string, number>;
}

/** Sanitized server names, longest first, so `a_b` wins over `a` for `a_b_tool`. */
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

/**
 * OpenCode 2.x session parser (`session_v2` + `session_message`). Pure and
 * print-free. Each `session_message` row is one record; assistant rows carry
 * their parts inline in `content[]`, so a completed or failed tool item yields
 * a `tool_use` on the assistant message and a separate `tool` message holding
 * the `tool_result` (writeSession pairs a result only with an earlier call).
 */
export function parseOpenCodeSession(
  row: OpenCodeSessionRow,
  rows: readonly OpenCodeMessageRow[],
  context: OpenCodeParseContext,
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

  for (const message of rows) {
    // A fork copies the parent's settled rows with their original timestamps.
    // OpenCode's own stats exclude them with this predicate; so does Decant,
    // or the inherited history would be billed twice.
    if (row.fork_session_id != null && message.time_created < row.time_created) {
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
      // `default` is OpenCode's "no variant chosen", not a recorded effort.
      if (model.variant != null && model.variant !== "default") {
        efforts.push(model.variant);
      }
      const usage = openCodeUsage(data.tokens, "disjoint");
      if (usage != null) {
        totals = addTokenUsage(totals, usage);
        sawUsage = true;
      }
      const { blocks, results } = assistantContent(data.content, servers);
      emit(
        "assistant",
        raw,
        {
          sourceUuid: message.id,
          model: model.id,
          stopReason: data.error != null ? "error" : asString(data.finish),
          timestamp,
          usage,
        },
        blocks,
      );
      for (const result of results) {
        emit("tool", result.raw, { timestamp: result.timestamp ?? timestamp }, [result.block]);
      }
    } else if (typ === "compaction") {
      const model = modelRef(data.model);
      const usage = openCodeUsage(data.tokens, "disjoint");
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
          model: model.id,
          stopReason: status === "failed" ? "error" : null,
          timestamp,
          usage,
        },
        [block(0, "text", { text })],
      );
    } else if (typ === "shell") {
      // A shell row is the user running a command, not a model tool call, so
      // it is user text and never a tool_use.
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
    // Read by inferSubagent in ingest as the parent's source session id.
    rawMeta.parentSessionId = row.parent_id;
  }
  if (contextWindow != null) {
    // src/context-window.ts treats this key as an explicit window for any tool.
    rawMeta.model_context_window = contextWindow;
  }
  if (switches.length > 0) {
    rawMeta.switches = switches;
  }
  if (forkRowsSkipped > 0) {
    rawMeta.fork_rows_skipped = forkRowsSkipped;
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
    value = JSON.parse(message.data) as Json;
  } catch (error) {
    issues.push({
      code: "unparsed_line",
      lineNo: message.seq,
      error: error instanceof Error ? error.message : String(error),
      rawLine: message.data,
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
      if (text !== "") {
        blocks.push(block(blocks.length, "thinking", { text }));
      }
    } else if (type === "tool") {
      const id = asString(get(item, "id"));
      const name = asString(get(item, "name")) ?? "unknown";
      const state = get(item, "state");
      const status = asString(get(state, "status"));
      const call = block(blocks.length, "tool_use", {
        toolName: normalizeOpenCodeToolName(name, servers),
        toolUseId: id,
        toolInput: get(state, "input"),
      });
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
          timestamp: isoFromMillis(asInteger(get(get(item, "time"), "completed"))),
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

/** OpenCode 2.x runs MCP tools (and some built-ins) from a JavaScript program
 * passed to this tool, recording each call it made in
 * `state.metadata.toolCalls`. */
const CODE_EXECUTION_TOOL = "execute";

/** Namespace of OpenCode's own tools inside an `execute` program. */
const OPENCODE_NAMESPACE = "opencode";

/** One inner call per `metadata.toolCalls` entry, in recorded order. An entry
 * names `<server>.<tool>` for an MCP tool, where `<server>` is already
 * sanitized by OpenCode (`McpTool.namespace`, the same replacement as
 * `sanitizeMcpName`), so the namespace alone decides MCP and no config lookup
 * is needed; `opencode.<tool>` and un-namespaced names (`search`) are OpenCode
 * built-ins and keep their recorded name. Any other namespace counts as MCP. */
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
  // Sanitized like OpenCode's direct registrations, so one server's direct
  // and code-mode calls share an `mcp_server`.
  return `mcp__${sanitizeMcpName(namespace)}__${sanitizeMcpName(tool.slice(dot + 1))}`;
}

export function parseModelJson(value: string | null): Json | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as Json;
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
