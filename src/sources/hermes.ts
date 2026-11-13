// Hermes Agent (NousResearch/hermes-agent) keeps every session in one SQLite
// file, `<HERMES_HOME>/state.db`: a `sessions` row with session-level token
// totals, `messages` rows in OpenAI chat shape, and per-model usage in
// `session_model_usage`. `src/sources/hermes-store.ts` reads the rows; this
// parser turns one session's rows into a `ParsedSession` and does no I/O.
import { linkageIssues } from "../diagnostics.ts";
import { asString, canonicalJson, get, isObject, type JsonObject } from "../json.ts";
import {
  emptyUsage,
  type Issue,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type NormalizedSession,
  type ParsedSession,
  type Role,
  type TokenUsage,
} from "../model.ts";
import { preview } from "../tools.ts";
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

/** One `sessions` row as `HermesStore.loadSession` reads it. A column the
 * database predates reads as null. */
export interface HermesSessionRow {
  id: string;
  /** Epoch seconds. */
  started_at: number | null;
  /** The surface that started the session: `cli`, `tui`, `telegram`, ... */
  source: string | null;
  model: string | null;
  model_config: string | null;
  title: string | null;
  parent_session_id: string | null;
  ended_at: number | null;
  end_reason: string | null;
  cwd: string | null;
  git_branch: string | null;
  git_repo_root: string | null;
  message_count: number | null;
  tool_call_count: number | null;
  api_call_count: number | null;
  /** Uncached input. Hermes subtracts cache reads and writes from a
   * provider's prompt total (`normalize_usage` in agent/usage_pricing.py). */
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  billing_provider: string | null;
  billing_mode: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  cost_status: string | null;
  profile_name: string | null;
  archived: number | null;
  /** The parent's `end_reason`, which tells a subagent from a compression,
   * reset, or `/branch` continuation. */
  parent_end_reason: string | null;
  parent_ended_at: number | null;
}

/** One `messages` row. `content` is text, or `\0json:` followed by JSON for
 * multimodal parts; `tool_calls` is a JSON array in OpenAI chat shape. */
export interface HermesMessageRow {
  id: number;
  role: string;
  /** Epoch seconds. */
  timestamp: number | null;
  content: string | number | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  token_count: number | null;
  finish_reason: string | null;
  reasoning: string | null;
  reasoning_content: string | null;
  /** 1 for the live context. 0 with `compacted` 1 is history an in-place
   * compaction archived; 0 with `compacted` 0 was removed by a rewind or
   * edit. Null in a database that predates the columns. */
  active: number | null;
  compacted: number | null;
  /** 1 on the summary a compaction wrote in place of the turns it archived. */
  _compressed_summary: number | null;
  display_kind: string | null;
  /** Durable per-occurrence ID; a protected-tail copy keeps its original's. */
  message_uid: string | null;
}

/** One `session_model_usage` row: a session's usage under one model and
 * billing route. */
export interface HermesModelUsageRow {
  model: string | null;
  billing_provider: string | null;
  billing_mode: string | null;
  task: string | null;
  api_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  cost_status: string | null;
}

/** Per-model usage in Decant's terms, kept in `raw_meta.modelUsage` and read
 * by `deriveModelUsage`, because Hermes records usage per session and model,
 * never per message. */
interface ModelUsageEntry {
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Hermes's prefix for structured `content` (`_CONTENT_JSON_PREFIX`). */
const CONTENT_JSON_PREFIX = "\u0000json:";

/** Parent end reasons that make a child a continuation of one conversation
 * rather than a subagent run (`_ephemeral_child_sql` in hermes_state_common.py). */
const RESET_END_REASONS = new Set([
  "session_reset",
  "session_switch",
  "idle",
  "daily",
  "suspended",
  "resume_pending_expired",
]);

const KNOWN_ROLES = new Set(["user", "assistant", "system", "tool"]);

export function parseHermesSession(
  row: HermesSessionRow,
  rows: readonly HermesMessageRow[],
  modelUsageRows: readonly HermesModelUsageRow[],
): ParsedSession {
  const issues: Issue[] = [];
  const unknownTypes: UnknownTypes = new Map();
  const messages: NormalizedMessage[] = [];
  const { kept, rewound, archived, copies } = displayRows(rows);
  let firstUserText: string | null = null;
  let lastTimestamp: string | null = null;

  for (const message of kept) {
    const timestamp = isoFromSeconds(message.timestamp);
    if (timestamp != null) {
      lastTimestamp = timestamp;
    }
    const raw = rawRecord(message);
    const content = decodeContent(message, issues);
    const known = KNOWN_ROLES.has(message.role);
    if (!known) {
      countUnknown(unknownTypes, message.role, message.id);
    }
    // A compaction summary is machine-written, whatever role Hermes stored it
    // under, so it is a system row that marks the compaction, not a turn.
    const summary = message._compressed_summary === 1;
    const role: Role = summary ? "system" : known ? (message.role as Role) : "other";
    const blocks: NormalizedBlock[] = [];
    if (role === "assistant") {
      const thinking = message.reasoning_content ?? message.reasoning;
      if (thinking != null && thinking.trim() !== "") {
        blocks.push(block(blocks.length, "thinking", { text: thinking }));
      }
      blocks.push(...contentBlocks(content, blocks.length));
      blocks.push(...toolUseBlocks(message, blocks.length, issues, unknownTypes));
    } else if (role === "tool") {
      blocks.push(
        block(0, "tool_result", {
          toolUseId: toolCallId(message.tool_call_id),
          toolName: message.tool_name == null ? null : normalizeHermesToolName(message.tool_name),
          toolResult: contentText(content),
        }),
      );
    } else {
      blocks.push(...contentBlocks(content, 0));
    }
    if (
      firstUserText == null &&
      role === "user" &&
      typeof content === "string" &&
      content.trim() !== ""
    ) {
      firstUserText = content;
    }
    messages.push({
      seq: messages.length,
      sourceUuid: message.message_uid ?? String(message.id),
      parentSourceUuid: null,
      role,
      // Hermes does not record which model answered a given message; the
      // session's per-model usage carries the split instead.
      model: null,
      stopReason: message.finish_reason,
      timestamp,
      usage: null,
      raw,
      blocks,
    });
  }
  issues.push(...unknownTypeIssues(unknownTypes, 'kept as role "other"'));

  const usage = sessionUsage(row, modelUsageRows);
  const isSubagent = isSubagentRun(row);
  const model = row.model ?? usage.dominantModel;

  const rawMeta: JsonObject = {
    session: sessionMeta(row),
    hermesModelUsage: modelUsageRows.map((entry) => ({ ...entry })),
  };
  if (usage.modelUsage.length > 0) {
    rawMeta.modelUsage = usage.modelUsage.map((entry) => ({ ...entry }));
  }
  if (isSubagent && row.parent_session_id != null) {
    // Read by inferSubagent in ingest as the parent's source session ID.
    rawMeta.parentSessionId = row.parent_session_id;
  }
  if (rewound > 0) {
    rawMeta.rewound_rows_skipped = rewound;
  }
  if (archived > 0) {
    rawMeta.compacted_rows = archived;
  }
  if (copies > 0) {
    rawMeta.copied_rows_merged = copies;
  }

  const normalized: NormalizedSession = {
    tool: "hermes",
    sourceSessionId: row.id,
    projectPath: row.cwd,
    title: row.title ?? (firstUserText == null ? null : preview(firstUserText.trim(), 120)),
    cwd: row.cwd,
    gitBranch: row.git_branch,
    model,
    reasoningEffort: null,
    reasoningEffortLevels: [],
    cliVersion: null,
    startedAt: isoFromSeconds(row.started_at) ?? messages[0]?.timestamp ?? null,
    endedAt: isoFromSeconds(row.ended_at) ?? lastTimestamp,
    isArchived: row.archived === 1,
    isSubagent,
    rootSourceSessionId: isSubagent ? row.parent_session_id : null,
    spawnToolUseId: null,
    agentId: isSubagent ? row.id : null,
    agentType: null,
    spawnDepth: null,
    rawMeta,
    totals: usage.totals,
    estReasoningTokens: 0,
    reasoningSource: usage.reported ? "reported" : "none",
    messages,
  };
  issues.push(...linkageIssues(normalized));
  return { session: normalized, issues };
}

/** Hermes registers an MCP tool as `mcp_<server>_<tool>`, with dashes and
 * dots in either part replaced by underscores (website/docs/user-guide/
 * features/mcp.md), so the boundary between server and tool is not recorded.
 * The name is split at the first underscore after the prefix: a server whose
 * own name holds an underscore keeps the rest of its name in the tool part. */
export function normalizeHermesToolName(name: string): string {
  const match = /^mcp_([^_]+)_(.+)$/.exec(name);
  return match == null ? name : `mcp__${match[1]}__${match[2]}`;
}

/** The rows Hermes shows for a session: live rows plus history an in-place
 * compaction archived, without rows a rewind or edit removed. A compaction
 * re-inserts its protected tail as new live rows, so a row and its copy are
 * merged on Hermes's own display identity, keeping the live copy at the
 * original's position (`_display_rows_sql` in hermes_state_timeline.py). */
function displayRows(rows: readonly HermesMessageRow[]): {
  kept: HermesMessageRow[];
  rewound: number;
  archived: number;
  copies: number;
} {
  const groups = new Map<string, { first: number; chosen: HermesMessageRow }>();
  let rewound = 0;
  let archived = 0;
  for (const row of rows) {
    const active = row.active == null || row.active === 1;
    if (!active && row.compacted !== 1) {
      rewound += 1;
      continue;
    }
    if (!active) {
      archived += 1;
    }
    const key = displayIdentity(row);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, { first: row.id, chosen: row });
    } else if (preferred(row, group.chosen)) {
      group.chosen = row;
    }
  }
  const kept = [...groups.values()].sort((a, b) => a.first - b.first).map((group) => group.chosen);
  const visible = rows.length - rewound;
  return { kept, rewound, archived, copies: visible - kept.length };
}

function displayIdentity(row: HermesMessageRow): string {
  if (row.message_uid != null) {
    return JSON.stringify(["uid", row.role, row.message_uid, row.timestamp]);
  }
  return JSON.stringify([
    row.role,
    row.content,
    row.timestamp,
    row.tool_call_id,
    row.tool_calls,
    row.tool_name,
  ]);
}

/** A live row beats an archived one, then the newer row wins. */
function preferred(candidate: HermesMessageRow, current: HermesMessageRow): boolean {
  const candidateActive = candidate.active == null || candidate.active === 1;
  const currentActive = current.active == null || current.active === 1;
  if (candidateActive !== currentActive) {
    return candidateActive;
  }
  return candidate.id > current.id;
}

/** The row as stored, with structured content decoded so the archive keeps
 * it as JSON rather than a sentinel-prefixed string. */
function rawRecord(row: HermesMessageRow): JsonObject {
  const raw: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    raw[key] = value as Json;
  }
  if (typeof row.tool_calls === "string") {
    try {
      raw.tool_calls = parseSourceJson(row.tool_calls);
    } catch {
      // Kept as the stored string; toolUseBlocks reports it.
    }
  }
  if (typeof row.content === "string" && row.content.startsWith(CONTENT_JSON_PREFIX)) {
    try {
      raw.content = parseSourceJson(row.content.slice(CONTENT_JSON_PREFIX.length));
    } catch {
      raw.content = row.content.slice(CONTENT_JSON_PREFIX.length);
    }
  }
  return raw;
}

function decodeContent(row: HermesMessageRow, issues: Issue[]): Json | undefined {
  const content = row.content;
  if (content == null) {
    return undefined;
  }
  if (typeof content === "number") {
    return String(content);
  }
  if (!content.startsWith(CONTENT_JSON_PREFIX)) {
    return content;
  }
  const text = content.slice(CONTENT_JSON_PREFIX.length);
  try {
    return parseSourceJson(text);
  } catch (error) {
    // Hermes falls back to the raw string too; the structure is what is lost.
    issues.push({
      code: "unparsed_line",
      lineNo: row.id,
      error: `message content: ${jsonProblem(error)}`,
      rawLine: diagnosticRawLine(error, text),
    });
    return text;
  }
}

/** Text and image parts of OpenAI chat content. */
function contentBlocks(content: Json | undefined, start: number): NormalizedBlock[] {
  if (content === undefined || content === null) {
    return [];
  }
  if (typeof content === "string") {
    return content === "" ? [] : [block(start, "text", { text: content })];
  }
  const parts = Array.isArray(content) ? content : [content];
  const blocks: NormalizedBlock[] = [];
  for (const part of parts) {
    const ordinal = start + blocks.length;
    if (typeof part === "string") {
      if (part !== "") {
        blocks.push(block(ordinal, "text", { text: part }));
      }
      continue;
    }
    const type = asString(get(part, "type"));
    const text = asString(get(part, "text"));
    if (text != null && (type == null || type === "text" || type.endsWith("_text"))) {
      blocks.push(block(ordinal, "text", { text }));
    } else if (type === "image_url" || type === "input_image" || type === "image") {
      blocks.push(block(ordinal, "image"));
    } else {
      blocks.push(block(ordinal, "other", { text: canonicalJson(part) }));
    }
  }
  return blocks;
}

function toolUseBlocks(
  row: HermesMessageRow,
  start: number,
  issues: Issue[],
  unknownTypes: UnknownTypes,
): NormalizedBlock[] {
  if (row.tool_calls == null || row.tool_calls === "") {
    return [];
  }
  let calls: Json;
  try {
    calls = parseSourceJson(row.tool_calls);
  } catch (error) {
    issues.push({
      code: "unparsed_line",
      lineNo: row.id,
      error: `tool calls: ${jsonProblem(error)}`,
      rawLine: diagnosticRawLine(error, row.tool_calls),
    });
    return [];
  }
  const blocks: NormalizedBlock[] = [];
  for (const call of Array.isArray(calls) ? calls : [calls]) {
    if (!isObject(call)) {
      countUnknown(unknownTypes, "tool_call.non_object", row.id);
      continue;
    }
    const fn = isObject(call.function) ? call.function : null;
    const name = asString(fn?.name) ?? asString(call.name);
    if (name == null) {
      countUnknown(unknownTypes, "tool_call.unnamed", row.id);
      continue;
    }
    blocks.push(
      block(start + blocks.length, "tool_use", {
        toolName: normalizeHermesToolName(name),
        toolUseId: toolCallId(asString(call.call_id) ?? asString(call.id)),
        toolInput: toolInput(fn?.arguments ?? call.arguments ?? call.input),
      }),
    );
  }
  return blocks;
}

/** Chat Completions arguments are a JSON string; a value that does not parse
 * is kept as the string the model wrote. */
function toolInput(value: Json | undefined): Json | undefined {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return parseSourceJson(value);
  } catch {
    return value;
  }
}

/** A Codex Responses bridge ID is `call_id|response_item_id`; the call ID is
 * what pairs a result with its call (`coalesce_tool_call_id`). */
function toolCallId(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed.split("|", 1)[0]?.trim() || trimmed;
}

/** A child is a subagent run unless its parent ended for a compression,
 * reset, or `/branch`, which continue one conversation under a new ID. */
function isSubagentRun(row: HermesSessionRow): boolean {
  if (row.parent_session_id == null) {
    return false;
  }
  const parentEnd = row.parent_end_reason;
  if (parentEnd === "compression" || (parentEnd != null && RESET_END_REASONS.has(parentEnd))) {
    return false;
  }
  if (get(parseJsonObject(row.model_config), "_branched_from") != null) {
    return false;
  }
  return !(
    parentEnd === "branched" &&
    row.started_at != null &&
    row.parent_ended_at != null &&
    row.started_at >= row.parent_ended_at
  );
}

interface SessionUsage {
  totals: TokenUsage;
  modelUsage: ModelUsageEntry[];
  dominantModel: string | null;
  reported: boolean;
}

/** Session totals from the `sessions` row, split by model from
 * `session_model_usage`. Usage the per-model rows do not cover (a database
 * from before Hermes kept them) is charged to the session's model, so the
 * split always sums to the totals. If the rows add up to more than the
 * session row, the rows are taken as the totals. */
function sessionUsage(
  row: HermesSessionRow,
  modelUsageRows: readonly HermesModelUsageRow[],
): SessionUsage {
  const sessionTotals: TokenUsage = {
    ...emptyUsage(),
    input: count(row.input_tokens),
    output: count(row.output_tokens),
    cacheRead: count(row.cache_read_tokens),
    cacheCreation: count(row.cache_write_tokens),
  };
  const byModel = new Map<string, ModelUsageEntry>();
  const summed = emptyUsage();
  let summedReasoning = 0;
  let requests = 0;
  for (const entry of modelUsageRows) {
    const model = entry.model ?? "";
    const prior = byModel.get(model) ?? {
      model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    prior.requests += count(entry.api_call_count);
    prior.input += count(entry.input_tokens);
    prior.output += count(entry.output_tokens);
    prior.cacheRead += count(entry.cache_read_tokens);
    prior.cacheCreation += count(entry.cache_write_tokens);
    byModel.set(model, prior);
    summed.input += count(entry.input_tokens);
    summed.output += count(entry.output_tokens);
    summed.cacheRead += count(entry.cache_read_tokens);
    summed.cacheCreation += count(entry.cache_write_tokens);
    summedReasoning += count(entry.reasoning_tokens);
    requests += count(entry.api_call_count);
  }

  const residual = {
    input: sessionTotals.input - summed.input,
    output: sessionTotals.output - summed.output,
    cacheRead: sessionTotals.cacheRead - summed.cacheRead,
    cacheCreation: sessionTotals.cacheCreation - summed.cacheCreation,
  };
  const covered = Object.values(residual).every((value) => value >= 0);
  let totals: TokenUsage;
  if (byModel.size === 0 || covered) {
    totals = sessionTotals;
    totals.reasoning = Math.max(count(row.reasoning_tokens), summedReasoning);
    if (byModel.size > 0 && Object.values(residual).some((value) => value > 0)) {
      const model = row.model ?? "";
      const prior = byModel.get(model) ?? {
        model,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
      };
      prior.requests += Math.max(0, count(row.api_call_count) - requests);
      prior.input += residual.input;
      prior.output += residual.output;
      prior.cacheRead += residual.cacheRead;
      prior.cacheCreation += residual.cacheCreation;
      byModel.set(model, prior);
    }
  } else {
    totals = { ...summed, reasoning: summedReasoning };
  }
  totals.reasoning = Math.min(totals.reasoning, totals.output);

  const modelUsage = [...byModel.values()].sort(
    (a, b) => b.requests - a.requests || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  );
  const dominantModel = modelUsage.find((entry) => entry.model !== "")?.model ?? null;
  const reported =
    count(row.api_call_count) > 0 ||
    requests > 0 ||
    totals.input + totals.output + totals.cacheRead + totals.cacheCreation > 0;
  return { totals, modelUsage, dominantModel, reported };
}

/** The session row as Hermes stored it, with `model_config` parsed. The
 * system prompt is not read. */
function sessionMeta(row: HermesSessionRow): JsonObject {
  const meta: JsonObject = {};
  for (const [key, value] of Object.entries(row)) {
    meta[key] = value as Json;
  }
  meta.model_config = parseJsonObject(row.model_config) ?? row.model_config;
  return meta;
}

function parseJsonObject(text: string | null): JsonObject | null {
  if (text == null) {
    return null;
  }
  try {
    const value = parseSourceJson(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function isoFromSeconds(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
