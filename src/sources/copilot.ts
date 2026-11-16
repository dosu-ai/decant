import { linkageIssues } from "../diagnostics.ts";
import { asInteger, asString, get, hasKey, isObject, type JsonObject } from "../json.ts";
import {
  emptyUsage,
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
  block,
  countUnknown,
  parseJsonLine,
  type UnknownTypes,
  unknownTypeIssues,
} from "./shared.ts";

const IGNORED_TYPES = new Set([
  "session.journal_link",
  "session.remote_steerable_changed",
  "session.schedule_created",
  "session.schedule_cancelled",
  "session.schedule_rearmed",
  "session.autopilot_objective_changed",
  "session.model_deselected",
  "session.mode_changed",
  "session.mode_notice_delivered",
  "session.session_limits_changed",
  "session.permissions_changed",
  "session.plan_changed",
  "session.workspace_file_changed",
  "session.handoff",
  "session.truncation",
  "session.context_changed",
  "session.context_cleared",
  "session.compaction_start",
  "session.task_complete",
  "session.completion_receipt",
  "session.fusion_route_failed",
  "session.fusion_resolved",
  "session.fusion_completed",
  "session.permission_recovery",
  "session.binary_asset",
  "session.auto_mode_resolved",
  "session.canvas.recorded",
  "session.canvas.removed",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.fusion_phase_completed",
  "assistant.fusion_phase_failed",
  "tool.user_requested",
  "tool_search.activated",
  "skill.invoked",
  "subagent.started",
  "subagent.configured",
  "subagent.completed",
  "subagent.failed",
  "subagent.selected",
  "subagent.deselected",
  "hook.start",
  "hook.end",
  "instruction.update",
  "system.notification",
  "permission.requested",
  "permission.completed",
  "permission.carriedForward",
  "permission.messageAuthorization",
  "permission.messageAuthorizationRead",
  "permission.messageAuthorizationDegraded",
  "permission.assentDetected",
  "permission.contextualAuthorization",
  "mcp.oauth_recovery_completed",
  "external_tool.requested",
  "external_tool.completed",
  "human_response.recorded",
]);

export interface CopilotModelUsage {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export type UsageSnapshot = Map<string, CopilotModelUsage>;

export interface CopilotModelUsageRow {
  model: string;
  requests: number;
  usage: TokenUsage;
}

export function parseCopilotSession(fallbackId: string, content: string): ParsedSession {
  const issues: ParsedSession["issues"] = [];
  const unknownTypes: UnknownTypes = new Map();
  const messages: NormalizedMessage[] = [];
  const toolUses = new Map<string, NormalizedBlock>();
  const reasoningSeen = new Map<string, Set<string>>();
  const seenEventIds = new Set<string>();
  const efforts: string[] = [];
  const snapshots: UsageSnapshot[] = [];
  const messageModels = new Map<string, number>();
  const callUsage = new Map<string, TokenUsage>();
  const callMessages = new Map<string, NormalizedMessage>();
  const ledger: UsageSnapshot = new Map();
  let contextWindow: number | null = null;

  let sourceSessionId: string | null = null;
  let start: JsonObject | null = null;
  let shutdown: JsonObject | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let currentModel: string | null = null;
  let cliVersion: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let firstUserText: string | null = null;
  let seq = 0;

  const push = (
    role: Role,
    record: JsonObject,
    blocks: NormalizedBlock[],
    fields: { model?: string | null; usage?: TokenUsage | null } = {},
  ): void => {
    messages.push({
      seq,
      sourceUuid: asString(record.id),
      parentSourceUuid: asString(record.parentId),
      role,
      model: fields.model ?? null,
      stopReason: null,
      timestamp: asString(record.timestamp),
      usage: fields.usage ?? null,
      raw: record,
      blocks,
    });
    seq += 1;
  };

  for (const [index, line] of content.split(/\n/).entries()) {
    const lineNo = index + 1;
    const record = parseJsonLine(line, lineNo, issues);
    if (record === undefined || !isObject(record)) {
      continue;
    }
    // Copilot never persists ephemeral events; one that reaches the file
    // anyway is a streaming fragment of a record written in full later.
    if (record.ephemeral === true) {
      continue;
    }
    const eventId = asString(record.id);
    if (eventId != null) {
      // A recovered journal can repeat a record; the first copy wins.
      if (seenEventIds.has(eventId)) {
        continue;
      }
      seenEventIds.add(eventId);
    }
    const typ = asString(record.type);
    if (typ == null) {
      continue;
    }
    const data = isObject(record.data) ? record.data : {};
    const timestamp = asString(record.timestamp);
    const reasoningKey = JSON.stringify([record.agentId ?? null, data.apiCallId ?? null]);
    if (timestamp != null) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }

    switch (typ) {
      case "session.start":
      case "session.resume": {
        if (typ === "session.start") {
          start ??= data;
          sourceSessionId ??= asString(data.sessionId);
          cliVersion ??= asString(data.copilotVersion);
          const startTime = asString(data.startTime);
          if (startTime != null && (startedAt == null || startTime < startedAt)) {
            startedAt = startTime;
          }
        }
        const context = get(data, "context");
        cwd = asString(get(context, "cwd")) ?? cwd;
        gitBranch = asString(get(context, "branch")) ?? gitBranch;
        currentModel = asString(data.selectedModel) ?? currentModel;
        collectEffort(efforts, data.reasoningEffort);
        break;
      }
      case "session.model_change": {
        if (record.agentId != null) {
          break;
        }
        currentModel = asString(data.newModel) ?? currentModel;
        collectEffort(efforts, data.reasoningEffort);
        break;
      }
      case "user.message": {
        const text = asString(data.content) ?? "";
        if (text === "") {
          break;
        }
        firstUserText ??= text;
        push("user", record, [block(0, "text", { text })]);
        break;
      }
      case "assistant.reasoning": {
        const text = asString(data.content) ?? "";
        if (text === "") {
          break;
        }
        const seen = reasoningSeen.get(reasoningKey) ?? new Set<string>();
        seen.add(text);
        reasoningSeen.set(reasoningKey, seen);
        push("assistant", record, [block(0, "thinking", { text })], {
          model: asString(data.model) ?? currentModel,
        });
        break;
      }
      case "assistant.message": {
        const model = asString(data.model) ?? currentModel;
        const blocks: NormalizedBlock[] = [];
        // The same reasoning may also arrive as its own assistant.reasoning
        // event; store it once.
        const reasoning = asString(data.reasoningText) ?? "";
        const seen = reasoningSeen.get(reasoningKey) ?? new Set<string>();
        if (reasoning !== "" && !seen.has(reasoning)) {
          seen.add(reasoning);
          reasoningSeen.set(reasoningKey, seen);
          blocks.push(block(blocks.length, "thinking", { text: reasoning }));
        }
        if (asString(data.apiCallId) == null) {
          reasoningSeen.delete(reasoningKey);
        }
        const text = asString(data.content) ?? "";
        if (text !== "") {
          blocks.push(block(blocks.length, "text", { text }));
        }
        for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
          const toolUse = toolUseBlock(blocks.length, request);
          if (toolUse == null) {
            continue;
          }
          blocks.push(toolUse);
          if (toolUse.toolUseId != null) {
            toolUses.set(toolUse.toolUseId, toolUse);
          }
        }
        const apiCallId = asString(data.apiCallId);
        const claimed = apiCallId != null && callMessages.has(apiCallId);
        const recorded = apiCallId == null || claimed ? undefined : callUsage.get(apiCallId);
        const reportedOutput = asInteger(data.outputTokens);
        if (apiCallId != null && claimed && reportedOutput != null && !callUsage.has(apiCallId)) {
          const first = callMessages.get(apiCallId);
          if (first != null) {
            first.usage = { ...emptyUsage(), output: reportedOutput };
          }
        }
        const outputTokens = claimed ? null : reportedOutput;
        if (blocks.length === 0 && outputTokens == null && recorded == null) {
          break;
        }
        if (model != null) {
          messageModels.set(model, (messageModels.get(model) ?? 0) + 1);
        }
        push("assistant", record, blocks, {
          model,
          usage:
            recorded ?? (outputTokens == null ? null : { ...emptyUsage(), output: outputTokens }),
        });
        if (apiCallId != null && !claimed) {
          callMessages.set(apiCallId, messages[messages.length - 1] as NormalizedMessage);
        }
        break;
      }
      case "tool.execution_start": {
        const toolCallId = asString(data.toolCallId);
        const known = toolCallId == null ? undefined : toolUses.get(toolCallId);
        if (known != null) {
          // The request was dated when the model finished its response; the
          // tool may have started later, after a permission prompt.
          if (timestamp != null) {
            known.calledAt = timestamp;
          }
          if (known.toolInput === undefined && data.arguments !== undefined) {
            known.toolInput = data.arguments;
          }
          break;
        }
        const toolUse = toolUseBlock(0, { ...data, name: data.toolName ?? null });
        if (toolUse == null) {
          break;
        }
        if (toolUse.toolUseId != null) {
          toolUses.set(toolUse.toolUseId, toolUse);
        }
        push("assistant", record, [toolUse], { model: asString(data.model) ?? currentModel });
        break;
      }
      case "tool.execution_complete": {
        const toolCallId = asString(data.toolCallId);
        if (toolCallId == null) {
          break;
        }
        push("tool", record, [
          block(0, "tool_result", {
            toolUseId: toolCallId,
            toolResult: toolResultText(data),
            isError: data.success === false,
          }),
        ]);
        break;
      }
      case "system.message": {
        const text = asString(data.content) ?? "";
        if (text !== "") {
          push("system", record, [block(0, "text", { text })]);
        }
        break;
      }
      case "session.compaction_complete": {
        if (data.success === false) {
          break;
        }
        const summary = asString(data.summaryContent) ?? "";
        push("system", record, summary === "" ? [] : [block(0, "text", { text: summary })]);
        break;
      }
      case "session.error":
      case "session.warning":
      case "session.info": {
        const text = asString(data.message) ?? "";
        if (text !== "") {
          push("other", record, [block(0, "text", { text })]);
        }
        break;
      }
      case "abort": {
        const reason = asString(data.reason) ?? "unknown";
        push("other", record, [block(0, "text", { text: `Aborted: ${reason}` })]);
        break;
      }
      case "session.shutdown": {
        shutdown = data;
        snapshots.push(shutdownSnapshot(data.modelMetrics));
        currentModel = asString(data.currentModel) ?? currentModel;
        break;
      }
      case "session.usage_record": {
        const usage = data.usage;
        if (!isObject(usage)) {
          break;
        }
        const apiCallId = asString(usage.apiCallId);
        if (apiCallId != null && callUsage.has(apiCallId)) {
          break;
        }
        const recordUsage = { ...usageFromMetric(usage, undefined), requests: 1 };
        const model = asString(usage.model) ?? "";
        if (record.agentId == null) {
          contextWindow = asInteger(usage.maxPromptTokens) ?? contextWindow;
        }
        const prior = ledger.get(model);
        ledger.set(model, prior == null ? recordUsage : sumCopilotUsage(prior, recordUsage));
        if (apiCallId == null) {
          break;
        }
        const converted = toDecantUsage(recordUsage);
        callUsage.set(apiCallId, converted);
        const message = callMessages.get(apiCallId);
        if (message != null) {
          message.usage = converted;
        }
        break;
      }
      case "session.usage_checkpoint": {
        snapshots.push(checkpointSnapshot(data.providerModelMetrics));
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

  const modelUsage = toModelUsageRows(
    recordsUnlessShortOfSnapshots(ledger, mergeSnapshots(snapshots)),
  );
  const totals = emptyUsage();
  if (modelUsage.length > 0) {
    for (const row of modelUsage) {
      addInto(totals, row.usage);
    }
  } else {
    for (const message of messages) {
      if (message.usage != null) {
        addInto(totals, message.usage);
      }
    }
  }
  const reasoningReported = [ledger, ...snapshots].some((snapshot) =>
    [...snapshot.values()].some((usage) => usage.reasoning > 0),
  );

  const normalized: NormalizedSession = {
    tool: "copilot",
    sourceSessionId: sourceSessionId ?? fallbackId,
    projectPath: cwd,
    title: firstUserText == null ? null : preview(firstUserText.trim(), 120),
    cwd,
    gitBranch,
    model: sessionModel(modelUsage, messageModels) ?? currentModel,
    reasoningEffort: summarizeReasoningEfforts(efforts),
    reasoningEffortLevels: reasoningEffortLevels(efforts),
    cliVersion,
    startedAt,
    endedAt,
    isArchived: false,
    isSubagent: false,
    rootSourceSessionId: null,
    spawnToolUseId: null,
    agentId: null,
    agentType: null,
    spawnDepth: null,
    rawMeta: rawMetaFrom(start, shutdown, modelUsage, contextWindow),
    totals,
    estReasoningTokens: 0,
    reasoningSource: reasoningReported ? "reported" : "none",
    messages,
  };
  issues.push(...linkageIssues(normalized));
  return { session: normalized, issues };
}

function collectEffort(efforts: string[], value: Json | undefined): void {
  const effort = asString(value);
  if (effort != null) {
    efforts.push(effort);
  }
}

function toolUseBlock(ordinal: number, request: Json): NormalizedBlock | null {
  if (!isObject(request)) {
    return null;
  }
  const server = asString(request.mcpServerName);
  const mcpTool = asString(request.mcpToolName);
  const name =
    server != null && mcpTool != null ? `mcp__${server}__${mcpTool}` : asString(request.name);
  const toolCallId = asString(request.toolCallId);
  if (name == null && toolCallId == null) {
    return null;
  }
  return block(ordinal, "tool_use", {
    toolName: name,
    toolUseId: toolCallId,
    toolInput: request.arguments,
  });
}

function toolResultText(data: JsonObject): string {
  const result = asString(get(data.result, "content"));
  if (result != null && result !== "") {
    return result;
  }
  return asString(get(data.error, "message")) ?? result ?? "";
}

function usageFromMetric(metric: Json | undefined, requests: Json | undefined): CopilotModelUsage {
  return {
    requests: Math.max(0, asInteger(get(requests, "count")) ?? 0),
    input: count(get(metric, "inputTokens")),
    output: count(get(metric, "outputTokens")),
    cacheRead: count(get(metric, "cacheReadTokens")),
    cacheWrite: count(get(metric, "cacheWriteTokens")),
    reasoning: count(get(metric, "reasoningTokens")),
  };
}

function shutdownSnapshot(metrics: Json | undefined): UsageSnapshot {
  const snapshot: UsageSnapshot = new Map();
  if (!isObject(metrics)) {
    return snapshot;
  }
  for (const [model, metric] of Object.entries(metrics)) {
    if (isObject(metric) && hasKey(metric, "usage")) {
      snapshot.set(model, usageFromMetric(metric.usage, metric.requests));
    }
  }
  return snapshot;
}

function checkpointSnapshot(metrics: Json | undefined): UsageSnapshot {
  const snapshot: UsageSnapshot = new Map();
  if (!Array.isArray(metrics)) {
    return snapshot;
  }
  for (const entry of metrics) {
    const metric = get(entry, "metrics");
    if (!isObject(metric) || !hasKey(metric, "usage")) {
      continue;
    }
    const model = asString(get(entry, "modelId")) ?? "";
    const usage = usageFromMetric(metric.usage, metric.requests);
    const prior = snapshot.get(model);
    // Two providers can serve the same model id; their usage adds up.
    snapshot.set(model, prior == null ? usage : sumCopilotUsage(prior, usage));
  }
  return snapshot;
}

/** Current Copilot builds restore usage on resume, so each snapshot is
 * cumulative. Older builds started every resumed run from zero. */
export function mergeSnapshots(snapshots: UsageSnapshot[]): UsageSnapshot {
  const banked: UsageSnapshot = new Map();
  let latest: UsageSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (latest != null && !coversEveryModel(snapshot, latest)) {
      addSnapshot(banked, latest);
    }
    latest = snapshot;
  }
  if (latest != null) {
    addSnapshot(banked, latest);
  }
  return banked;
}

function addSnapshot(into: UsageSnapshot, snapshot: UsageSnapshot): void {
  for (const [model, usage] of snapshot) {
    const prior = into.get(model);
    into.set(model, prior == null ? usage : sumCopilotUsage(prior, usage));
  }
}

function coversEveryModel(later: UsageSnapshot, earlier: UsageSnapshot): boolean {
  for (const [model, before] of earlier) {
    const after = later.get(model);
    if (
      after == null ||
      after.requests < before.requests ||
      after.input < before.input ||
      after.output < before.output ||
      after.cacheRead < before.cacheRead ||
      after.cacheWrite < before.cacheWrite ||
      after.reasoning < before.reasoning
    ) {
      return false;
    }
  }
  return true;
}

function sumCopilotUsage(a: CopilotModelUsage, b: CopilotModelUsage): CopilotModelUsage {
  return {
    requests: a.requests + b.requests,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

export function recordsUnlessShortOfSnapshots(
  ledger: UsageSnapshot,
  merged: UsageSnapshot,
): UsageSnapshot {
  return ledger.size > 0 && coversEveryModel(ledger, merged) ? ledger : merged;
}

function toDecantUsage(usage: CopilotModelUsage): TokenUsage {
  return {
    input: Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite),
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheWrite,
    cacheCreation1h: 0,
    reasoning: Math.min(usage.reasoning, usage.output),
  };
}

function toModelUsageRows(snapshot: UsageSnapshot): CopilotModelUsageRow[] {
  const rows: CopilotModelUsageRow[] = [];
  for (const [model, usage] of snapshot) {
    const converted = toDecantUsage(usage);
    if (
      usage.requests === 0 &&
      converted.input + converted.output + converted.cacheRead + converted.cacheCreation === 0
    ) {
      continue;
    }
    rows.push({ model, requests: usage.requests, usage: converted });
  }
  return rows;
}

function sessionModel(
  modelUsage: CopilotModelUsageRow[],
  messageModels: Map<string, number>,
): string | null {
  let best: { model: string; weight: number } | null = null;
  for (const row of modelUsage) {
    if (row.model !== "" && (best == null || row.usage.output > best.weight)) {
      best = { model: row.model, weight: row.usage.output };
    }
  }
  if (best != null) {
    return best.model;
  }
  for (const [model, responses] of messageModels) {
    if (best == null || responses > best.weight) {
      best = { model, weight: responses };
    }
  }
  return best?.model ?? null;
}

function rawMetaFrom(
  start: JsonObject | null,
  shutdown: JsonObject | null,
  modelUsage: CopilotModelUsageRow[],
  contextWindow: number | null,
): Json {
  const meta: JsonObject = {};
  if (contextWindow != null && contextWindow > 0) {
    meta.model_context_window = contextWindow;
  }
  if (start != null) {
    meta.start = start;
  }
  if (shutdown != null) {
    const summary: JsonObject = {};
    for (const key of [
      "shutdownType",
      "errorReason",
      "codeChanges",
      "currentModel",
      "totalApiDurationMs",
      "totalPremiumRequests",
      "totalNanoAiu",
    ]) {
      const value = shutdown[key];
      if (value !== undefined) {
        summary[key] = value;
      }
    }
    meta.shutdown = summary;
  }
  if (modelUsage.length > 0) {
    meta.modelUsage = modelUsage.map((row) => ({
      model: row.model,
      requests: row.requests,
      input: row.usage.input,
      output: row.usage.output,
      cacheRead: row.usage.cacheRead,
      cacheCreation: row.usage.cacheCreation,
      reasoning: row.usage.reasoning,
    }));
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
