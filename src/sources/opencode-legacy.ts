// OpenCode 1.x storage: `session`, `message`, and `part` tables. OpenCodeStore
// reads these rows read-only; they hold JSON text exactly as OpenCode wrote it,
// so a malformed `data` value reaches the parser below unchanged and becomes a
// diagnostic there.

import { linkageIssues } from "../diagnostics.ts";
import { asInteger, asString, canonicalJson, get, isObject, type JsonObject } from "../json.ts";
import {
  emptyUsage,
  type Issue,
  type Json,
  type NormalizedBlock,
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
  isoFromMillis,
  mcpServerPrefixes,
  normalizeOpenCodeToolName,
  type OpenCodeModelRef,
  type OpenCodeParseContext,
  parseModelJson,
  stepEnd,
} from "./opencode.ts";
import { addTokenUsage, legacyAssistantUsage } from "./opencode-usage.ts";
import {
  block,
  contentText,
  countUnknown,
  type UnknownTypes,
  unknownTypeIssues,
} from "./shared.ts";

/** One 1.x `session` row. Columns added after v1.2.0 (`cost`, `tokens_*`,
 * `agent`, `model`) read as NULL on older databases, because OpenCodeStore
 * projects every column through `pragma_table_info`. */
export interface OpenCodeLegacySessionRow {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  slug: string | null;
  directory: string | null;
  title: string | null;
  version: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  /** JSON `{ messageID, partID?, snapshot?, diff? }`. */
  revert: string | null;
  agent: string | null;
  /** JSON `{ id, providerID, variant? }`, 1.18+ only. */
  model: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

/** `data` is the message info minus `id` and `sessionID`. */
export interface OpenCodeLegacyMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

/** `data` is the part minus `id`, `sessionID`, and `messageID`. */
export interface OpenCodeLegacyPartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface DecodedPart {
  id: string;
  data: JsonObject;
}

interface Decoded {
  row: OpenCodeLegacyMessageRow;
  info: JsonObject;
  /** 1-based position in OpenCode's message order, used as the issue line. */
  ordinal: number;
  timestamp: string | null;
  parts: DecodedPart[];
}

type MessageFields = Partial<
  Pick<NormalizedMessage, "sourceUuid" | "model" | "stopReason" | "timestamp" | "usage">
>;

// Transport and state parts: usage comes from step-finish via
// legacyAssistantUsage; the rest add no transcript block.
const SILENT_ASSISTANT_PARTS = new Set([
  "step-start",
  "step-finish",
  "snapshot",
  "patch",
  "retry",
  "file",
  "agent",
]);
const ASSISTANT_PARTS = new Set([...SILENT_ASSISTANT_PARTS, "text", "reasoning", "tool"]);
const USER_PARTS = new Set(["text", "file", "agent", "subtask", "compaction"]);

/**
 * OpenCode 1.x session parser (`session` + `message` + `part`). Pure and
 * print-free. Emits the same shapes the 2.x parser emits for the same
 * concepts: a completed or failed tool part yields a `tool_use` on its
 * assistant message and a following `tool` message with the `tool_result`, and
 * a compaction request plus its summary become one `system` message.
 */
export function parseOpenCodeLegacySession(
  row: OpenCodeLegacySessionRow,
  messageRows: readonly OpenCodeLegacyMessageRow[],
  partRows: readonly OpenCodeLegacyPartRow[],
  context: OpenCodeParseContext,
): ParsedSession {
  const issues: Issue[] = [];
  const unknownTypes: UnknownTypes = new Map();
  const servers = mcpServerPrefixes(context.mcpServers);
  const messages: NormalizedMessage[] = [];
  const efforts: string[] = [];
  let totals = emptyUsage();
  let sawUsage = false;
  let lastModel: OpenCodeModelRef | null = null;
  let lastUserAgent: string | null = null;
  let firstUserText: string | null = null;

  // 1. Decode messages in OpenCode's order. A fork copies its parent's
  //    messages with their original time.created; 1.x has no fork column, so
  //    a message older than its session is inherited history and is skipped,
  //    or it would be billed twice.
  const decoded: Decoded[] = [];
  const byId = new Map<string, Decoded>();
  const dropped = new Set<string>();
  let forkRowsSkipped = 0;
  messageRows.forEach((message, index) => {
    const ordinal = index + 1;
    if (message.time_created < row.time_created) {
      forkRowsSkipped += 1;
      dropped.add(message.id);
      return;
    }
    const info = parseObject(message.data, ordinal, "message", issues);
    if (info == null) {
      dropped.add(message.id);
      return;
    }
    const entry: Decoded = {
      row: message,
      info,
      ordinal,
      timestamp: isoFromMillis(asInteger(get(info.time, "created")) ?? message.time_created),
      parts: [],
    };
    decoded.push(entry);
    byId.set(message.id, entry);
  });

  // 2. Attach parts (already ordered by message_id, id). Parts of skipped or
  //    unreadable messages go silently; a part with no message is reported
  //    without its data, which is transcript content.
  for (const part of partRows) {
    const owner = byId.get(part.message_id);
    if (owner == null) {
      if (!dropped.has(part.message_id)) {
        issues.push({
          code: "unparsed_line",
          lineNo: null,
          error: "part references a missing message",
          rawLine: null,
        });
      }
      continue;
    }
    const data = parseObject(part.data, owner.ordinal, "part", issues);
    if (data != null) {
      owner.parts.push({ id: part.id, data });
    }
  }

  // 3. Pair each compaction request (a user message with a compaction part)
  //    with its summary assistant, which answers it through parentID.
  const summaries = new Map<string, Decoded>();
  const pairedSummaries = new Set<string>();
  for (const entry of decoded) {
    if (entry.info.role !== "assistant" || entry.info.summary !== true) {
      continue;
    }
    const parentId = asString(entry.info.parentID);
    const request = parentId == null ? undefined : byId.get(parentId);
    if (
      parentId != null &&
      request != null &&
      request.info.role === "user" &&
      hasPart(request, "compaction") &&
      !summaries.has(parentId)
    ) {
      summaries.set(parentId, entry);
      pairedSummaries.add(entry.row.id);
    }
  }

  const emit = (role: Role, raw: Json, fields: MessageFields, blocks: NormalizedBlock[]): void => {
    messages.push({
      seq: messages.length,
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
  };

  const addToTotals = (usage: TokenUsage | null): void => {
    if (usage != null) {
      totals = addTokenUsage(totals, usage);
      sawUsage = true;
    }
  };

  const emitCompaction = (request: Decoded | null, summary: Decoded | null): void => {
    const anchor = request ?? summary;
    if (anchor == null) {
      return;
    }
    const usage =
      summary == null ? null : legacyAssistantUsage(summary.info, partData(summary), row.version);
    addToTotals(usage);
    const text = (summary?.parts ?? [])
      .filter((part) => part.data.type === "text")
      .map((part) => asString(part.data.text) ?? "")
      .filter((value) => value !== "")
      .join("\n\n");
    const marker = request?.parts.find((part) => part.data.type === "compaction")?.data;
    const raw: JsonObject = {
      ...(summary?.info ?? {}),
      id: anchor.row.id,
      type: "compaction",
      auto: marker?.auto ?? null,
      overflow: marker?.overflow ?? null,
      summary_message_id: summary?.row.id ?? null,
      parts: [...rawParts(request), ...rawParts(summary)],
    };
    emit(
      "system",
      raw,
      {
        sourceUuid: anchor.row.id,
        model: summary == null ? null : asString(summary.info.modelID),
        stopReason: summary?.info.error != null ? "error" : null,
        timestamp: anchor.timestamp,
        usage,
      },
      [block(0, "text", { text: text === "" ? "Context compacted" : text })],
    );
  };

  // 4. Emit messages in order.
  for (const entry of decoded) {
    const role = asString(entry.info.role);
    const raw: JsonObject = { ...entry.info, id: entry.row.id, parts: rawParts(entry) };
    if (role === "user") {
      countUnknownParts(entry, USER_PARTS, unknownTypes);
      lastUserAgent = asString(entry.info.agent) ?? lastUserAgent;
      if (hasPart(entry, "compaction")) {
        emitCompaction(entry, summaries.get(entry.row.id) ?? null);
        continue;
      }
      const user = userContent(entry);
      if (firstUserText == null && user.firstText != null) {
        firstUserText = user.firstText;
      }
      if (!user.onlyDerived) {
        emit("user", raw, { sourceUuid: entry.row.id, timestamp: entry.timestamp }, user.blocks);
      }
      if (user.synthetic.length > 0) {
        emit(
          "system",
          { type: "synthetic", messageID: entry.row.id, parts: user.syntheticParts },
          { timestamp: entry.timestamp },
          [block(0, "text", { text: user.synthetic.join("\n\n") })],
        );
      }
      for (const subtask of user.subtasks) {
        const agent = asString(subtask.data.agent) ?? "unknown";
        const description = asString(subtask.data.description) ?? "";
        emit(
          "system",
          { ...subtask.data, id: subtask.id, messageID: entry.row.id },
          { timestamp: entry.timestamp },
          [
            block(0, "text", {
              text:
                description === "" ? `Subtask (${agent})` : `Subtask (${agent}): ${description}`,
            }),
          ],
        );
      }
    } else if (role === "assistant") {
      countUnknownParts(entry, ASSISTANT_PARTS, unknownTypes);
      if (pairedSummaries.has(entry.row.id)) {
        continue;
      }
      if (entry.info.summary === true) {
        emitCompaction(null, entry);
        continue;
      }
      const modelId = asString(entry.info.modelID);
      const variant = asString(entry.info.variant);
      if (modelId != null) {
        lastModel = { providerID: asString(entry.info.providerID), id: modelId, variant };
      }
      // `default` is OpenCode's "no variant chosen", not a recorded effort.
      if (variant != null && variant !== "default") {
        efforts.push(variant);
      }
      const usage = legacyAssistantUsage(entry.info, partData(entry), row.version);
      addToTotals(usage);
      if (usage != null) {
        // Token economics splits the message's time and output by this count.
        raw.reasoning_tokens = usage.reasoning;
      }
      const { blocks, results } = assistantContent(entry, servers);
      const generated = isoFromMillis(messageGenerationEnd(entry)) ?? entry.timestamp;
      emit(
        "assistant",
        raw,
        {
          sourceUuid: entry.row.id,
          model: modelId,
          stopReason: entry.info.error != null ? "error" : asString(entry.info.finish),
          timestamp: generated,
          usage,
        },
        blocks,
      );
      for (const result of results) {
        emit("tool", result.raw, { timestamp: result.timestamp ?? generated }, [result.block]);
      }
    } else {
      countUnknown(unknownTypes, `role:${role ?? "(missing)"}`, entry.ordinal);
    }
  }

  // 5. Session.
  issues.push(...unknownTypeIssues(unknownTypes, "ignored"));

  const sessionModelJson = parseModelJson(row.model);
  const sessionModel: OpenCodeModelRef = {
    providerID: asString(get(sessionModelJson, "providerID")),
    id: asString(get(sessionModelJson, "id")),
    variant: asString(get(sessionModelJson, "variant")),
  };
  const model = sessionModel.id != null ? sessionModel : lastModel;
  const modelId = model?.id ?? null;
  const providerId = model?.providerID ?? null;
  const contextWindow =
    modelId != null && providerId != null
      ? (context.contextWindows.get(`${providerId}/${modelId}`) ?? null)
      : null;
  const isSubagent = row.parent_id != null;
  const directory = row.directory == null || row.directory === "" ? null : row.directory;

  const rawMeta: JsonObject = {
    format: "v1",
    id: row.id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    slug: row.slug,
    directory: row.directory,
    title: row.title,
    version: row.version,
    agent: row.agent,
    model: sessionModelJson ?? null,
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
    revert: parseModelJson(row.revert) ?? null,
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
    agentType: row.agent ?? lastUserAgent,
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

function parseObject(
  text: string,
  lineNo: number,
  kind: "message" | "part",
  issues: Issue[],
): JsonObject | null {
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch (error) {
    issues.push({
      code: "unparsed_line",
      lineNo,
      error: error instanceof Error ? error.message : String(error),
      rawLine: text,
    });
    return null;
  }
  if (!isObject(value)) {
    issues.push({
      code: "unparsed_line",
      lineNo,
      error: `${kind} data is not a JSON object`,
      rawLine: text,
    });
    return null;
  }
  return value;
}

function hasPart(entry: Decoded, type: string): boolean {
  return entry.parts.some((part) => part.data.type === type);
}

function partData(entry: Decoded): Json[] {
  return entry.parts.map((part) => part.data);
}

function rawParts(entry: Decoded | null): Json[] {
  return (entry?.parts ?? []).map((part) => ({ ...part.data, id: part.id }));
}

function countUnknownParts(
  entry: Decoded,
  known: ReadonlySet<string>,
  unknown: UnknownTypes,
): void {
  for (const part of entry.parts) {
    const type = asString(part.data.type);
    if (type == null || !known.has(type)) {
      countUnknown(unknown, `part:${type ?? "(missing)"}`, entry.ordinal);
    }
  }
}

interface UserContent {
  blocks: NormalizedBlock[];
  firstText: string | null;
  synthetic: string[];
  syntheticParts: Json[];
  subtasks: DecodedPart[];
  /** Every part is a subtask or synthetic text: OpenCode wrote the message,
   * not the user, so only its system messages are emitted. */
  onlyDerived: boolean;
}

function userContent(entry: Decoded): UserContent {
  const blocks: NormalizedBlock[] = [];
  const files: string[] = [];
  const synthetic: string[] = [];
  const syntheticParts: Json[] = [];
  const subtasks: DecodedPart[] = [];
  let firstText: string | null = null;
  let derived = 0;
  for (const part of entry.parts) {
    const type = asString(part.data.type);
    if (type === "text") {
      const text = asString(part.data.text) ?? "";
      if (part.data.synthetic === true) {
        derived += 1;
        syntheticParts.push({ ...part.data, id: part.id });
        if (text !== "") {
          synthetic.push(text);
        }
      } else if (part.data.ignored !== true && text !== "") {
        blocks.push(block(blocks.length, "text", { text }));
        if (firstText == null && text.trim() !== "") {
          firstText = text;
        }
      }
    } else if (type === "file") {
      files.push(asString(part.data.filename) ?? asString(part.data.mime) ?? "attachment");
    } else if (type === "subtask") {
      derived += 1;
      subtasks.push(part);
    }
  }
  for (const label of files) {
    blocks.push(block(blocks.length, "image", { text: label }));
  }
  return {
    blocks,
    firstText,
    synthetic,
    syntheticParts,
    subtasks,
    onlyDerived: entry.parts.length > 0 && derived === entry.parts.length,
  };
}

interface ToolResult {
  raw: Json;
  timestamp: string | null;
  block: NormalizedBlock;
}

function assistantContent(
  entry: Decoded,
  servers: readonly string[],
): { blocks: NormalizedBlock[]; results: ToolResult[] } {
  const blocks: NormalizedBlock[] = [];
  const results: ToolResult[] = [];
  for (const part of entry.parts) {
    const data = part.data;
    const type = asString(data.type);
    if (type === "text") {
      const text = asString(data.text) ?? "";
      if (text !== "") {
        blocks.push(block(blocks.length, "text", { text }));
      }
    } else if (type === "reasoning") {
      // Kept when empty: providers that hide reasoning still bill it.
      blocks.push(block(blocks.length, "thinking", { text: asString(data.text) ?? "" }));
    } else if (type === "tool") {
      const id = asString(data.callID);
      const state = data.state;
      const status = asString(get(state, "status"));
      // 1.x calls MCP tools directly as `<server>_<tool>`; there is no
      // code-mode `execute` wrapper to unpack.
      const call = block(blocks.length, "tool_use", {
        toolName: normalizeOpenCodeToolName(asString(data.tool) ?? "unknown", servers),
        toolUseId: id,
        toolInput: get(state, "input"),
      });
      // `state.time.start` is when the call started to run (its arguments
      // had streamed); a pending call has none.
      const calledAt = isoFromMillis(asInteger(get(get(state, "time"), "start")));
      if (calledAt != null) {
        call.calledAt = calledAt;
      }
      blocks.push(call);
      // Pending and running calls never finished, so they have no result.
      if (status === "completed" || status === "error") {
        const error = get(state, "error");
        results.push({
          raw: { ...data, id: part.id, messageID: entry.row.id },
          timestamp: isoFromMillis(asInteger(get(get(state, "time"), "end"))),
          block: block(0, "tool_result", {
            toolUseId: id,
            toolResult:
              status === "error"
                ? (asString(error) ?? canonicalJson(error ?? null))
                : contentText(get(state, "output")),
            isError: status === "error",
          }),
        });
      }
    }
  }
  return { blocks, results };
}

/** When a 1.x message finished generating, in epoch ms. 1.x has no
 * `streamed` time and `time.completed` waits for the message's tools, so the
 * latest part that finished streaming (a text or reasoning end, or a tool's
 * run start) marks the end, as `stepEnd` decides. */
function messageGenerationEnd(entry: Decoded): number | null {
  const ends: number[] = [];
  let untimedText = false;
  let hasTools = false;
  for (const part of entry.parts) {
    const type = asString(part.data.type);
    if (type === "tool") {
      hasTools = true;
      const start = asInteger(get(get(part.data.state, "time"), "start"));
      if (start != null) {
        ends.push(start);
      }
    } else if (type === "text" || type === "reasoning") {
      const end = asInteger(get(part.data.time, "end"));
      if (end == null) {
        untimedText = true;
      } else {
        ends.push(end);
      }
    }
  }
  return stepEnd({
    streamed: null,
    completed: asInteger(get(entry.info.time, "completed")),
    created: asInteger(get(entry.info.time, "created")) ?? entry.row.time_created,
    partEnds: ends,
    untimedText,
    hasTools,
  });
}
