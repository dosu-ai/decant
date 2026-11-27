import { isPriceable } from "../cost.ts";
import { linkageIssues } from "../diagnostics.ts";
import {
  asBoolean,
  asInteger,
  asString,
  byteLength,
  canonicalJson,
  get,
  hasKey,
  isObject,
} from "../json.ts";
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
import {
  block,
  contentText,
  countUnknownInRecord,
  nullRecord,
  ownGet,
  parseJsonLine,
  unknownTypeIssues,
} from "./shared.ts";

const TITLE_META = new Set(["summary", "ai-title"]);

const IGNORED_JOURNAL_META = new Set([
  "agent-name",
  "agent-setting",
  // Request-shape logging (Claude Code, November 2026): cache-control and
  // digest bookkeeping for each API call. None carries a `usage` object, so
  // skipping them loses no tokens or cost.
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "atis-latch",
  "bridge-session",
  "cost-state",
  "fork-context-ref",
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
  "relocated",
  "session-owner",
  "tools-used",
  "world_state",
  "worktree-state",
]);
// Claude Code versions artifact ledgers by name (artifact-autoreact-ledger,
// artifact-comment-monitor, ...); all of them are harness state.
const IGNORED_JOURNAL_PREFIXES = ["artifact-"];

const CHARS_PER_TOKEN = 4;

interface TurnAcc {
  output: number;
  visible: number;
  hasThinking: boolean;
}

type ReasoningTurns = Map<string, TurnAcc>;

export interface ClaudeParseOptions {
  sourcePath?: string;
  sidecarMeta?: Json;
}

export interface ClaudeBilledEntry {
  seq: number;
  output: number;
  usage: TokenUsage;
}

export interface ClaudeStepperState {
  sourceSessionId: string;
  rootSourceSessionId: string | null;
  pathIndicatesSubagent: boolean;
  sawSidechainRecord: boolean;
  sawMainRecord: boolean;
  agentId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  sessionModel: string | null;
  reasoningEfforts: string[];
  resultTotals: TokenUsage | null;
  messageTotals: TokenUsage;
  startedAt: string | null;
  endedAt: string | null;
  promptTitle: string | null;
  metadataTitle: string | null;
  customTitle: string | null;
  seq: number;
  modelCounts: Record<string, number>;
  billed: Record<string, ClaudeBilledEntry>;
  turns: Record<string, TurnAcc>;
  settledEstReasoningTokens: number;
  settledHasThinking: boolean;
  unknownTypes: Record<string, { count: number; firstLine: number }>;
  sidecarMeta: Json | null;
}

export interface ClaudeLineStepResult {
  message?: NormalizedMessage;
  requestId?: string | null;
  unbilledPrevious?: {
    seq: number;
    requestId: string;
    usage: TokenUsage;
  };
}

export function createClaudeStepper(
  sourceSessionId: string,
  options: ClaudeParseOptions = {},
): ClaudeStepperState {
  return {
    sourceSessionId,
    rootSourceSessionId: null,
    pathIndicatesSubagent: isSubagentPath(options.sourcePath) || isObject(options.sidecarMeta),
    sawSidechainRecord: false,
    sawMainRecord: false,
    agentId: agentIdFromPath(options.sourcePath),
    cwd: null,
    gitBranch: null,
    cliVersion: null,
    sessionModel: null,
    reasoningEfforts: [],
    resultTotals: null,
    messageTotals: emptyUsage(),
    startedAt: null,
    endedAt: null,
    promptTitle: null,
    metadataTitle: null,
    customTitle: null,
    seq: 0,
    modelCounts: nullRecord<number>(),
    billed: nullRecord<ClaudeBilledEntry>(),
    turns: nullRecord<TurnAcc>(),
    settledEstReasoningTokens: 0,
    settledHasThinking: false,
    unknownTypes: nullRecord<{ count: number; firstLine: number }>(),
    sidecarMeta: options.sidecarMeta ?? null,
  };
}

export function compactClaudeStepper(
  state: ClaudeStepperState,
  maxRecent: number,
  onEvictRequestId: (requestId: string) => void,
): void {
  const turnKeys = Object.keys(state.turns);
  if (turnKeys.length > maxRecent) {
    const evictCount = turnKeys.length - maxRecent;
    for (let i = 0; i < evictCount; i += 1) {
      const key = turnKeys[i];
      if (key == null) continue;
      const turn = ownGet(state.turns, key);
      if (turn != null) {
        if (turn.hasThinking) {
          state.settledHasThinking = true;
          state.settledEstReasoningTokens += turnReasoningTokens(turn);
        }
        delete state.turns[key];
        if (!key.startsWith("\0seq")) {
          onEvictRequestId(key);
        }
      }
    }
  }
  const billedKeys = Object.keys(state.billed);
  if (billedKeys.length > maxRecent) {
    const evictCount = billedKeys.length - maxRecent;
    for (let i = 0; i < evictCount; i += 1) {
      const key = billedKeys[i];
      if (key == null) continue;
      delete state.billed[key];
      onEvictRequestId(key);
    }
  }
}

function addUsageInto(target: TokenUsage, delta: TokenUsage, sign: 1 | -1): void {
  target.input += sign * delta.input;
  target.output += sign * delta.output;
  target.cacheRead += sign * delta.cacheRead;
  target.cacheCreation += sign * delta.cacheCreation;
  target.cacheCreation1h += sign * delta.cacheCreation1h;
  target.reasoning += sign * delta.reasoning;
}

function noteModelCount(counts: Record<string, number>, model: string | null): void {
  if (model != null) {
    counts[model] = (ownGet(counts, model) ?? 0) + 1;
  }
}

export function stepClaudeLine(
  state: ClaudeStepperState,
  line: string,
  lineNo: number,
  issues: ParsedSession["issues"],
): ClaudeLineStepResult {
  const value = parseJsonLine(line, lineNo, issues);
  if (value === undefined) {
    return {};
  }

  const typ = stringAt(value, "type") ?? "";
  state.rootSourceSessionId ??= stringAt(value, "sessionId", "session_id");
  if (asBoolean(get(value, "isSidechain")) === true) {
    state.sawSidechainRecord = true;
  } else if (typ === "user" || typ === "assistant" || typ === "system") {
    state.sawMainRecord = true;
  }
  state.agentId ??= stringAt(value, "agentId", "agent_id");
  const timestamp = stringAt(value, "timestamp");
  if (timestamp != null) {
    state.startedAt ??= timestamp;
    state.endedAt = timestamp;
  }
  state.cwd ??= stringAt(value, "cwd");
  state.gitBranch ??= stringAt(value, "gitBranch", "git_branch");
  state.cliVersion ??= stringAt(value, "version", "cli_version");
  state.sessionModel ??= stringAt(get(value, "message"), "model") ?? stringAt(value, "model");
  const effort = recordedReasoningEffort(get(value, "effort"));
  if (effort != null && !state.reasoningEfforts.includes(effort)) {
    state.reasoningEfforts.push(effort);
  }

  if (typ === "user") {
    const message = parseUser(value, state.seq);
    if (state.promptTitle == null && message.role === "user") {
      const text = firstText(message);
      if (text != null) {
        state.promptTitle = truncate(text, 120);
      }
    }
    state.seq += 1;
    noteModelCount(state.modelCounts, message.model);
    return { message };
  }

  if (typ === "assistant") {
    const rawMessage = parseAssistant(value, state.seq);
    const requestId = assistantRequestId(value);
    const turnKey = requestId ?? `\0seq${state.seq}`;
    state.turns[turnKey] = accumulateReasoning(ownGet(state.turns, turnKey), rawMessage);

    let message = rawMessage;
    let unbilledPrevious: ClaudeLineStepResult["unbilledPrevious"];
    if (message.usage != null && requestId != null) {
      const previous = ownGet(state.billed, requestId);
      if (previous == null) {
        state.billed[requestId] = {
          seq: message.seq,
          output: message.usage.output,
          usage: { ...message.usage },
        };
        addUsageInto(state.messageTotals, message.usage, 1);
      } else if (message.usage.output <= previous.output) {
        message = { ...message, usage: null };
      } else {
        unbilledPrevious = {
          seq: previous.seq,
          requestId,
          usage: { ...previous.usage },
        };
        addUsageInto(state.messageTotals, previous.usage, -1);
        addUsageInto(state.messageTotals, message.usage, 1);
        state.billed[requestId] = {
          seq: message.seq,
          output: message.usage.output,
          usage: { ...message.usage },
        };
      }
    } else if (message.usage != null) {
      addUsageInto(state.messageTotals, message.usage, 1);
    }
    state.seq += 1;
    noteModelCount(state.modelCounts, message.model);
    return { message, requestId, unbilledPrevious };
  }

  if (typ === "system") {
    const message = simpleMessage(value, "system", state.seq);
    state.seq += 1;
    return { message };
  }

  if (typ === "result") {
    state.resultTotals = parseUsage(get(value, "usage")) ?? state.resultTotals;
    return {};
  }

  if (typ === "custom-title") {
    const renamed = stringAt(value, "customTitle", "title");
    if (renamed != null && renamed.trim() !== "") {
      state.customTitle = truncate(renamed, 120);
    }
    return {};
  }

  if (TITLE_META.has(typ)) {
    if (state.metadataTitle == null) {
      const metaTitle = stringAt(value, "summary", "title");
      if (metaTitle != null) {
        state.metadataTitle = truncate(metaTitle, 120);
      }
    }
    return {};
  }

  if (
    !IGNORED_JOURNAL_META.has(typ) &&
    !IGNORED_JOURNAL_PREFIXES.some((prefix) => typ.startsWith(prefix))
  ) {
    countUnknownInRecord(state.unknownTypes, typ, lineNo);
    const message = simpleMessage(value, "other", state.seq);
    state.seq += 1;
    return { message };
  }

  return {};
}

export function claudeSessionFromState(
  state: ClaudeStepperState,
  messages: NormalizedMessage[] = [],
  isArchived = false,
): NormalizedSession {
  const totals = state.resultTotals ?? state.messageTotals;
  const turns = Object.values(state.turns);
  let estReasoningTokens = state.settledEstReasoningTokens + reasoningEstimate(turns);
  if (state.resultTotals != null) {
    estReasoningTokens = Math.min(estReasoningTokens, state.resultTotals.output);
  }
  const anyThinking = state.settledHasThinking || turns.some((turn) => turn.hasThinking);

  const model = primaryModelFromCounts(state.modelCounts) ?? state.sessionModel;
  const meta = isObject(state.sidecarMeta) ? state.sidecarMeta : {};
  const spawnToolUseId = asString(meta.toolUseId);
  const agentType =
    asString(meta.subagent_type) ?? asString(meta.subagentType) ?? asString(meta.agentType);
  const spawnDepth = asInteger(meta.spawnDepth);
  const isSubagent =
    state.pathIndicatesSubagent || (state.sawSidechainRecord && !state.sawMainRecord);
  const rawMeta: Json = {
    sessionId: state.rootSourceSessionId,
    isSubagent,
    agentId: state.agentId,
    agentType,
    spawnToolUseId,
    spawnDepth,
  };
  const effortLevels = reasoningEffortLevels(state.reasoningEfforts);

  return {
    tool: "claude_code",
    sourceSessionId: state.sourceSessionId,
    projectPath: state.cwd,
    title: state.customTitle ?? state.promptTitle ?? state.metadataTitle,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    model,
    reasoningEffort: summarizeReasoningEfforts(effortLevels),
    reasoningEffortLevels: effortLevels,
    cliVersion: state.cliVersion,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    isArchived,
    isSubagent,
    rootSourceSessionId: state.rootSourceSessionId,
    spawnToolUseId,
    agentId: state.agentId,
    agentType,
    spawnDepth,
    rawMeta,
    totals,
    estReasoningTokens,
    reasoningSource: anyThinking ? "inferred" : "none",
    messages,
  };
}

export function claudeUnknownTypeIssues(state: ClaudeStepperState): ParsedSession["issues"] {
  return unknownTypeIssues(new Map(Object.entries(state.unknownTypes)), 'kept as role "other"');
}

export function parseClaudeSession(
  sourceSessionId: string,
  content: string,
  options: ClaudeParseOptions = {},
): ParsedSession {
  const state = createClaudeStepper(sourceSessionId, options);
  const messages: NormalizedMessage[] = [];
  const issues: ParsedSession["issues"] = [];

  for (const [index, line] of content.split(/\n/).entries()) {
    const step = stepClaudeLine(state, line, index + 1, issues);
    if (step.unbilledPrevious != null) {
      const prev = messages[step.unbilledPrevious.seq];
      if (prev != null) {
        messages[step.unbilledPrevious.seq] = { ...prev, usage: null };
      }
    }
    if (step.message != null) {
      messages.push(step.message);
    }
  }

  issues.push(...claudeUnknownTypeIssues(state));
  const normalized = claudeSessionFromState(state, messages);
  issues.push(...linkageIssues(normalized));

  return { session: normalized, issues };
}

/** Journal content blocks can repeat a message's full usage without a request
 * id, and the API message id still names the request. */
function assistantRequestId(value: Json): string | null {
  return stringAt(value, "requestId", "request_id") ?? stringAt(get(value, "message"), "id");
}

function accumulateReasoning(turn: TurnAcc | undefined, message: NormalizedMessage): TurnAcc {
  const acc = turn ?? { output: 0, visible: 0, hasThinking: false };
  acc.output = Math.max(acc.output, message.usage?.output ?? 0);
  for (const block of message.blocks) {
    if (block.blockType === "thinking") {
      acc.hasThinking = true;
    } else if (block.blockType === "text") {
      acc.visible += byteLength(block.text ?? "");
    } else if (block.blockType === "tool_use" && block.toolInput !== undefined) {
      acc.visible += byteLength(canonicalJson(block.toolInput));
    }
  }
  return acc;
}

function turnReasoningTokens(turn: TurnAcc): number {
  return turn.hasThinking
    ? Math.max(0, turn.output - Math.trunc(turn.visible / CHARS_PER_TOKEN))
    : 0;
}

function reasoningEstimate(turns: Iterable<TurnAcc>): number {
  let tokens = 0;
  for (const turn of turns) {
    tokens += turnReasoningTokens(turn);
  }
  return tokens;
}

export function inferredReasoningTokens(
  records: Iterable<Json>,
  resultRecordOutputTokens: number,
): number {
  const turns: ReasoningTurns = new Map();
  let index = 0;
  for (const record of records) {
    const key = assistantRequestId(record) ?? `\0record${index}`;
    turns.set(key, accumulateReasoning(turns.get(key), parseAssistant(record, index)));
    index += 1;
  }
  return Math.min(reasoningEstimate(turns.values()), resultRecordOutputTokens);
}

function truncate(value: string, max: number): string {
  return preview(value.trim(), max);
}

function firstText(message: NormalizedMessage): string | null {
  return message.blocks.find((block) => block.blockType === "text")?.text ?? null;
}

function primaryModelFromCounts(counts: Record<string, number>): string | null {
  let best: { model: string; count: number } | null = null;
  for (const [model, count] of Object.entries(counts)) {
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
        blocks.push(
          block(ordinal, "tool_result", {
            toolUseId: asString(get(item, "tool_use_id")),
            toolResult: contentText(get(item, "content")),
            isError: asBoolean(get(item, "is_error")),
          }),
        );
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
        blocks.push(block(ordinal, "thinking", { text: asString(get(item, "thinking")) }));
      } else if (blockType === "tool_use") {
        blocks.push(
          block(ordinal, "tool_use", {
            toolName: asString(get(item, "name")),
            toolUseId: asString(get(item, "id")),
            toolInput: hasKey(item, "input") ? get(item, "input") : undefined,
          }),
        );
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

function textBlock(ordinal: number, text: string): NormalizedBlock {
  return block(ordinal, "text", { text });
}

function otherBlock(ordinal: number, item: Json): NormalizedBlock {
  return block(ordinal, "other", { text: canonicalJson(item) });
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
