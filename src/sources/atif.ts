import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { linkageIssues } from "../diagnostics.ts";
import { asBoolean, asString, assertJsonDepth, get, isObject, type JsonObject } from "../json.ts";
import {
  emptyUsage,
  type Issue,
  type Json,
  type NormalizedBlock,
  type NormalizedMessage,
  type NormalizedSession,
  type ParsedSession,
  reasoningEffortLevels,
  recordedReasoningEffort,
  summarizeReasoningEfforts,
  type TokenUsage,
  type Tool,
} from "../model.ts";
import { preview } from "../tools.ts";
import {
  block,
  contentText,
  countUnknown,
  type UnknownTypes,
  unknownTypeIssues,
} from "./shared.ts";

export const ATIF_AGENT_NAMES = {
  claude_code: "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  opencode: "opencode",
  cursor: "cursor-cli",
  copilot: "copilot-cli",
  vscode_copilot: "vscode-copilot-chat",
  hermes: "hermes",
  pi: "pi",
} as const satisfies Record<Exclude<Tool, "atif">, string>;

export function atifNativeTool(rawMeta: Json | undefined): Exclude<Tool, "atif"> | null {
  const name = asString(get(get(rawMeta, "agent"), "name"));
  for (const [tool, agentName] of Object.entries(ATIF_AGENT_NAMES)) {
    if (agentName === name) {
      return tool as Exclude<Tool, "atif">;
    }
  }
  return null;
}

const PARSER_WRITTEN_META_KEYS = new Set([
  "parentSessionId",
  "subagentFileRefs",
  "copiedContextSteps",
  "embeddedSubagents",
]);

const KNOWN_SCHEMA_VERSIONS = new Set([
  "ATIF-v1.0",
  "ATIF-v1.1",
  "ATIF-v1.2",
  "ATIF-v1.3",
  "ATIF-v1.4",
  "ATIF-v1.5",
  "ATIF-v1.6",
  "ATIF-v1.7",
  "ATIF-v1.8",
]);

/** Cache writes have no ATIF field. Producers file them under these
 * `metrics.extra` keys: fast-agent, Decant, and Harbor's OpenCode converter
 * use the first; Harbor's Claude Code converter uses Anthropic's name. */
const CACHE_WRITE_KEYS = [
  "cache_write_tokens",
  "cache_creation_input_tokens",
  "cache_write_input_tokens",
] as const;
const FINAL_CACHE_WRITE_KEYS = [
  "total_cache_write_tokens",
  "total_cache_creation_input_tokens",
  "total_cache_write_input_tokens",
] as const;
/** Reasoning is part of `completion_tokens`; Gemini names it thoughts. */
const REASONING_KEYS = ["reasoning_tokens", "thoughts_tokens"] as const;

export interface AtifParseOptions {
  sourcePath?: string;
  projectPath?: string | null;
}

export interface AtifDocumentSession {
  key: string | null;
  parsed: ParsedSession;
}

export interface ParsedAtifDocument {
  sessions: AtifDocumentSession[];
}

export interface AtifFileRef {
  path: string;
  spawnToolUseId: string | null;
}

interface Node {
  trajectory: JsonObject;
  key: string | null;
  depth: number;
  parentKey: string | null;
  spawnToolUseId: string | null;
}

export function parseAtifDocument(
  fallbackId: string,
  content: string,
  options: AtifParseOptions = {},
): ParsedAtifDocument {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    // The runtime's message can quote the token it stopped at, which may be
    // transcript text, and diagnostics never quote transcript content.
    return unreadable(fallbackId, options, "document is not valid JSON");
  }
  if (!isObject(value) || !Array.isArray(value.steps)) {
    return unreadable(fallbackId, options, "not an ATIF trajectory: `steps` is not an array");
  }

  const nodes = flatten(value);
  for (const node of nodes) {
    const { subagent_trajectories: _embedded, ...retained } = node.trajectory;
    try {
      assertJsonDepth(retained);
    } catch {
      return unreadable(fallbackId, options, "JSON nesting exceeds the depth limit");
    }
  }
  const rootId = documentId(value, fallbackId, options.sourcePath);
  const sourceIds = new Map<string | null, string>([[null, rootId]]);
  const usedIds = new Set([rootId]);
  for (const node of nodes) {
    if (node.key != null) {
      const base = node.key.startsWith(`${rootId}:`) ? node.key : `${rootId}:${node.key}`;
      let id = base;
      for (let suffix = 2; usedIds.has(id); suffix += 1) {
        id = `${base}#${suffix}`;
      }
      usedIds.add(id);
      sourceIds.set(node.key, id);
    }
  }
  const depthLimited = new Set(
    nodes.filter(
      (node) =>
        node.depth === MAX_ATIF_EMBEDDED_DEPTH &&
        Array.isArray(node.trajectory.subagent_trajectories) &&
        node.trajectory.subagent_trajectories.length > 0,
    ),
  );
  linkEmbedded(nodes);
  const embeddedIds = new Set(
    nodes.flatMap((node) => {
      const id = node.key == null ? null : asString(node.trajectory.trajectory_id);
      return id == null ? [] : [id];
    }),
  );

  const sessions = nodes.map((node) => {
    const parentId = node.key == null ? null : (sourceIds.get(node.parentKey) ?? rootId);
    return {
      key: node.key,
      parsed: parseTrajectory(node, {
        sourceSessionId: sourceIds.get(node.key) ?? rootId,
        parentSourceSessionId: parentId,
        embeddedIds,
        options,
      }),
    };
  });
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node == null) continue;
    if (depthLimited.has(node)) {
      sessions[index]?.parsed.issues.push({
        code: "unparsed_line",
        lineNo: null,
        error: "embedded trajectories exceed the depth limit",
        rawLine: null,
      });
    }
  }
  const root = sessions[0]?.parsed.session;
  for (const { parsed } of sessions.slice(1)) {
    parsed.session.cwd ??= root?.cwd ?? null;
    parsed.session.projectPath ??= root?.projectPath ?? null;
  }
  return { sessions };
}

function unreadable(
  fallbackId: string,
  options: AtifParseOptions,
  error: string,
): ParsedAtifDocument {
  const session = baseSession(fallbackId, options.projectPath ?? null);
  return {
    sessions: [
      {
        key: null,
        parsed: { session, issues: [{ code: "unparsed_line", lineNo: 1, error, rawLine: null }] },
      },
    ],
  };
}

export const MAX_ATIF_EMBEDDED_DEPTH = 128;

function flatten(root: JsonObject): Node[] {
  const nodes: Node[] = [
    { trajectory: root, key: null, depth: 0, parentKey: null, spawnToolUseId: null },
  ];
  const used = new Set<string>();
  const visit = (parent: Node): void => {
    const embedded = parent.trajectory.subagent_trajectories;
    if (!Array.isArray(embedded)) {
      return;
    }
    if (parent.depth >= MAX_ATIF_EMBEDDED_DEPTH) return;
    embedded.forEach((child, index) => {
      if (!isObject(child)) {
        return;
      }
      const base = nonEmpty(asString(child.trajectory_id)) ?? `subagent-${index + 1}`;
      let key = base;
      for (let suffix = 2; used.has(key); suffix += 1) {
        key = `${base}#${suffix}`;
      }
      used.add(key);
      const node: Node = {
        trajectory: child,
        key,
        depth: parent.depth + 1,
        parentKey: parent.key,
        spawnToolUseId: null,
      };
      nodes.push(node);
      visit(node);
    });
  };
  visit(nodes[0] as Node);
  return nodes;
}

function linkEmbedded(nodes: Node[]): void {
  const byTrajectoryId = new Map<string, Node>();
  for (const node of nodes) {
    const id = asString(node.trajectory.trajectory_id);
    if (node.key != null && id != null && !byTrajectoryId.has(id)) {
      byTrajectoryId.set(id, node);
    }
  }
  for (const node of nodes) {
    for (const step of steps(node.trajectory)) {
      if (isCopiedContext(step)) {
        continue;
      }
      for (const result of observationResults(step)) {
        for (const ref of subagentRefs(result)) {
          const id = asString(get(ref, "trajectory_id"));
          const child = id == null ? undefined : byTrajectoryId.get(id);
          if (child == null || child === node) {
            continue;
          }
          child.parentKey = node.key;
          child.spawnToolUseId = asString(result.source_call_id);
          child.depth = node.depth + 1;
        }
      }
    }
  }
}

interface TrajectoryIdentity {
  sourceSessionId: string;
  parentSourceSessionId: string | null;
  embeddedIds: ReadonlySet<string>;
  options: AtifParseOptions;
}

function documentId(root: JsonObject, fallbackId: string, sourcePath: string | undefined): string {
  const trajectoryId = nonEmpty(asString(root.trajectory_id));
  if (trajectoryId != null) {
    return trajectoryId;
  }
  const sessionId = nonEmpty(asString(root.session_id));
  if (sessionId == null) {
    return fallbackId;
  }
  const stem = sourcePath == null ? null : basename(sourcePath).replace(/(?:\.atif)?\.json$/i, "");
  return stem == null || stem === "" || stem === "trajectory" || stem === sessionId
    ? sessionId
    : `${sessionId}/${stem}`;
}

function parseTrajectory(node: Node, identity: TrajectoryIdentity): ParsedSession {
  const trajectory = node.trajectory;
  const issues: Issue[] = [];
  const unknownTypes: UnknownTypes = new Map();
  const agent = isObject(trajectory.agent) ? trajectory.agent : {};
  const extra = isObject(trajectory.extra) ? trajectory.extra : {};
  const agentModel = nonEmpty(asString(agent.model_name));

  const schemaVersion = asString(trajectory.schema_version);
  if (schemaVersion != null && !KNOWN_SCHEMA_VERSIONS.has(schemaVersion)) {
    countUnknown(unknownTypes, `schema_version ${versionLabel(schemaVersion)}`, 1);
  }

  const messages: NormalizedMessage[] = [];
  const totals = emptyUsage();
  const efforts: string[] = [];
  const sessionEffort = recordedReasoningEffort(extra.reasoning_effort as Json | undefined);
  if (sessionEffort != null) {
    efforts.push(sessionEffort);
  }
  const fileRefs: AtifFileRef[] = [];
  let sawUsage = false;
  let sawReasoning = false;
  let copied = 0;
  let firstUserText: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let model: string | null = agentModel;

  const push = (
    role: NormalizedMessage["role"],
    fields: Partial<NormalizedMessage> & { raw: Json; blocks: NormalizedBlock[] },
  ): void => {
    messages.push({
      seq: messages.length,
      sourceUuid: null,
      parentSourceUuid: null,
      role,
      model: null,
      stopReason: null,
      timestamp: null,
      usage: null,
      ...fields,
    });
  };

  for (const [index, step] of steps(trajectory).entries()) {
    const lineNo = index + 1;
    if (isCopiedContext(step)) {
      copied += 1;
      continue;
    }
    const timestamp = isoTimestamp(asString(step.timestamp));
    if (timestamp != null) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }
    const source = asString(step.source);
    const { observation, ...stepRecord } = step;

    if (source === "agent") {
      const stepModel = nonEmpty(asString(step.model_name)) ?? agentModel;
      model ??= stepModel;
      const effort = recordedReasoningEffort(step.reasoning_effort as Json | undefined);
      if (effort != null) {
        efforts.push(effort);
      }
      const blocks: NormalizedBlock[] = [];
      const reasoning = asString(step.reasoning_content);
      if (reasoning != null && reasoning.trim() !== "") {
        blocks.push(block(blocks.length, "thinking", { text: reasoning }));
      }
      messageBlocks(step.message, blocks, unknownTypes, lineNo);
      for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
        if (!isObject(call)) {
          continue;
        }
        blocks.push(
          block(blocks.length, "tool_use", {
            toolName: nonEmpty(asString(call.function_name)) ?? "unknown_tool",
            toolUseId: nonEmpty(asString(call.tool_call_id)),
            toolInput: call.arguments === undefined ? undefined : (call.arguments as Json),
          }),
        );
      }
      const usage = usageFromMetrics(step.metrics);
      if (usage != null) {
        sawUsage = true;
        sawReasoning ||= REASONING_KEYS.some((key) =>
          hasCount(get(step.metrics as Json, "extra"), key),
        );
        addUsage(totals, usage);
      }
      push("assistant", {
        model: stepModel,
        timestamp,
        usage,
        raw: stepRecord,
        blocks,
      });
    } else if (source === "user" || source === "system") {
      const blocks: NormalizedBlock[] = [];
      messageBlocks(step.message, blocks, unknownTypes, lineNo);
      if (source === "user" && firstUserText == null) {
        const text = blocks.find((b) => b.blockType === "text")?.text ?? "";
        firstUserText = text.trim() === "" ? null : text;
      }
      if (blocks.length > 0 || observation === undefined) {
        push(source, { timestamp, raw: stepRecord, blocks });
      }
    } else {
      countUnknown(unknownTypes, `step source ${valueLabel(source)}`, lineNo);
      const blocks: NormalizedBlock[] = [];
      messageBlocks(step.message, blocks, unknownTypes, lineNo);
      push("other", { timestamp, raw: stepRecord, blocks });
    }

    const results = observationResults(step);
    if (results.length > 0) {
      const blocks: NormalizedBlock[] = [];
      for (const result of results) {
        const callId = nonEmpty(asString(result.source_call_id));
        const text = contentText(result.content as Json | undefined);
        for (const ref of subagentRefs(result)) {
          const path = asString(get(ref, "trajectory_path"));
          const id = asString(get(ref, "trajectory_id"));
          if (path != null && path !== "" && (id == null || !identity.embeddedIds.has(id))) {
            fileRefs.push({
              path: resolveRef(path, identity.options.sourcePath),
              spawnToolUseId: callId,
            });
          }
        }
        if (callId != null) {
          blocks.push(
            block(blocks.length, "tool_result", {
              toolUseId: callId,
              toolResult: text,
              isError: asBoolean(get(result.extra, "is_error")),
            }),
          );
        } else if (text.trim() !== "") {
          blocks.push(block(blocks.length, "text", { text }));
        }
      }
      if (blocks.length > 0) {
        push("tool", {
          timestamp,
          raw: { step_id: step.step_id ?? null, observation: observation as Json },
          blocks,
        });
      }
    }
  }

  issues.push(...unknownTypeIssues(unknownTypes, "read as ATIF-v1.8"));

  const levels = reasoningEffortLevels(efforts);
  const session: NormalizedSession = {
    ...baseSession(identity.sourceSessionId, identity.options.projectPath ?? null),
    title:
      nonEmpty(asString(extra.title)) ??
      (firstUserText == null ? null : preview(firstUserText.trim(), 120)),
    cwd: nonEmpty(asString(extra.cwd)),
    gitBranch: nonEmpty(asString(extra.git_branch)),
    model,
    reasoningEffort: summarizeReasoningEfforts(levels),
    reasoningEffortLevels: levels,
    cliVersion: knownVersion(asString(agent.version)),
    startedAt,
    endedAt,
    rawMeta: rawMeta(trajectory, node, identity, fileRefs, copied),
    totals: sessionTotals(trajectory, sawUsage ? totals : null),
    reasoningSource: sawReasoning ? "reported" : "none",
    messages,
  };
  if (session.totals.reasoning > 0) {
    session.reasoningSource = "reported";
  }
  if (session.projectPath == null && session.cwd != null) {
    session.projectPath = session.cwd;
  }
  if (node.key != null) {
    session.isSubagent = true;
    session.rootSourceSessionId = identity.parentSourceSessionId;
    session.spawnToolUseId = node.spawnToolUseId;
    session.agentId = node.key;
    session.agentType = nonEmpty(asString(extra.agent_type)) ?? nonEmpty(asString(agent.name));
    session.spawnDepth = node.depth;
  }
  issues.push(...linkageIssues(session));
  return { session, issues };
}

function baseSession(sourceSessionId: string, projectPath: string | null): NormalizedSession {
  return {
    tool: "atif",
    sourceSessionId,
    projectPath,
    title: null,
    cwd: null,
    gitBranch: null,
    model: null,
    reasoningEffort: null,
    reasoningEffortLevels: [],
    cliVersion: null,
    startedAt: null,
    endedAt: null,
    isArchived: false,
    isSubagent: false,
    rootSourceSessionId: null,
    spawnToolUseId: null,
    agentId: null,
    agentType: null,
    spawnDepth: null,
    rawMeta: null,
    totals: emptyUsage(),
    estReasoningTokens: 0,
    reasoningSource: "none",
    messages: [],
  };
}

/** ATIF's `prompt_tokens` counts all input, cached and written included; the
 * write share only appears in `metrics.extra`. */
export function usageFromMetrics(metrics: unknown): TokenUsage | null {
  if (!isObject(metrics)) {
    return null;
  }
  const prompt = count(metrics.prompt_tokens);
  const completion = count(metrics.completion_tokens);
  const cached = count(metrics.cached_tokens);
  const extra = metrics.extra;
  const written = firstCount(extra, CACHE_WRITE_KEYS);
  const reasoning = firstCount(extra, REASONING_KEYS);
  if (prompt == null && completion == null && cached == null && written == null) {
    return null;
  }
  const cacheRead = cached ?? 0;
  const cacheCreation = written ?? 0;
  const net = (prompt ?? 0) - cacheRead - cacheCreation;
  const output = completion ?? 0;
  return {
    input: net >= 0 ? net : Math.max(0, (prompt ?? 0) - cacheRead),
    output,
    cacheRead,
    cacheCreation,
    cacheCreation1h: 0,
    reasoning: Math.min(reasoning ?? 0, output),
  };
}

function sessionTotals(trajectory: JsonObject, stepSums: TokenUsage | null): TokenUsage {
  const decant = decantSessionUsage(trajectory);
  if (decant != null) {
    if (decant.reasoning === 0 && stepSums != null) {
      decant.reasoning = Math.min(stepSums.reasoning, decant.output);
    }
    return decant;
  }
  return stepSums ?? finalMetricsUsage(trajectory) ?? emptyUsage();
}

function decantSessionUsage(trajectory: JsonObject): TokenUsage | null {
  if (get(trajectory.extra as Json | undefined, "exporter") !== "decant") {
    return null;
  }
  const final = trajectory.final_metrics;
  if (!isObject(final)) {
    return null;
  }
  const extra = isObject(final.extra) ? final.extra : {};
  const own = isObject(extra.session_metrics)
    ? extra.session_metrics
    : extra.includes_subagents === true
      ? null
      : final;
  if (own == null) {
    return null;
  }
  const writes =
    own === final ? firstCount(extra, FINAL_CACHE_WRITE_KEYS) : count(own.total_cache_write_tokens);
  return usageFromMetrics({
    prompt_tokens: own.total_prompt_tokens,
    completion_tokens: own.total_completion_tokens,
    cached_tokens: own.total_cached_tokens,
    extra: {
      cache_write_tokens: writes,
      reasoning_tokens:
        extra.reasoning_source === "reported" ? count(extra.total_reasoning_tokens) : null,
    },
  });
}

function finalMetricsUsage(trajectory: JsonObject): TokenUsage | null {
  const final = trajectory.final_metrics;
  if (!isObject(final)) {
    return null;
  }
  const embedded = Array.isArray(trajectory.subagent_trajectories)
    ? trajectory.subagent_trajectories.length
    : 0;
  if (embedded > 0) {
    return null;
  }
  return usageFromMetrics({
    prompt_tokens: final.total_prompt_tokens,
    completion_tokens: final.total_completion_tokens,
    cached_tokens: final.total_cached_tokens,
    extra: {
      cache_write_tokens: firstCount(final.extra, FINAL_CACHE_WRITE_KEYS),
      reasoning_tokens: firstCount(final.extra, ["total_reasoning_tokens"]),
    },
  });
}

function copiesIntoRawMeta(trajectoryKey: string): boolean {
  return (
    trajectoryKey !== "steps" &&
    trajectoryKey !== "subagent_trajectories" &&
    !PARSER_WRITTEN_META_KEYS.has(trajectoryKey)
  );
}

function rawMeta(
  trajectory: JsonObject,
  node: Node,
  identity: TrajectoryIdentity,
  fileRefs: AtifFileRef[],
  copied: number,
): Json {
  const meta: JsonObject = {};
  for (const [key, value] of Object.entries(trajectory)) {
    if (copiesIntoRawMeta(key) && value !== undefined) {
      meta[key] = value as Json;
    }
  }
  if (node.key != null && identity.parentSourceSessionId != null) {
    meta.parentSessionId = identity.parentSourceSessionId;
  }
  if (fileRefs.length > 0) {
    meta.subagentFileRefs = fileRefs.map((ref) => ({
      path: ref.path,
      spawnToolUseId: ref.spawnToolUseId,
    }));
  }
  if (copied > 0) {
    meta.copiedContextSteps = copied;
  }
  const embedded = trajectory.subagent_trajectories;
  if (Array.isArray(embedded) && embedded.length > 0) {
    meta.embeddedSubagents = embedded.length;
  }
  return meta;
}

function messageBlocks(
  message: unknown,
  blocks: NormalizedBlock[],
  unknownTypes: UnknownTypes,
  lineNo: number,
): void {
  if (typeof message === "string") {
    if (message.trim() !== "") {
      blocks.push(block(blocks.length, "text", { text: message }));
    }
    return;
  }
  if (!Array.isArray(message)) {
    return;
  }
  for (const part of message) {
    const type = asString(get(part as Json, "type"));
    if (type === "text") {
      const text = asString(get(part as Json, "text")) ?? "";
      if (text.trim() !== "") {
        blocks.push(block(blocks.length, "text", { text }));
      }
    } else if (type === "image") {
      blocks.push(block(blocks.length, "image", { text: mediaPath(part) }));
    } else {
      if (type !== "audio") {
        countUnknown(unknownTypes, `content part ${valueLabel(type)}`, lineNo);
      }
      blocks.push(block(blocks.length, "other", { text: mediaPath(part) }));
    }
  }
}

function mediaPath(part: unknown): string | null {
  return asString(get(get(part as Json, "source"), "path"));
}

function steps(trajectory: JsonObject): JsonObject[] {
  return Array.isArray(trajectory.steps) ? trajectory.steps.filter(isObject) : [];
}

function observationResults(step: JsonObject): JsonObject[] {
  const results = get(step.observation, "results");
  return Array.isArray(results) ? results.filter(isObject) : [];
}

function subagentRefs(result: JsonObject): Json[] {
  const refs = result.subagent_trajectory_ref;
  // v1.0 wrote a single object; every later version writes an array.
  if (Array.isArray(refs)) {
    return refs;
  }
  return isObject(refs) ? [refs] : [];
}

function isCopiedContext(step: JsonObject): boolean {
  return step.is_copied_context === true;
}

function resolveRef(path: string, sourcePath: string | undefined): string {
  if (sourcePath == null || isAbsolute(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    return path;
  }
  return join(dirname(sourcePath), path);
}

function addUsage(into: TokenUsage, from: TokenUsage): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreation += from.cacheCreation;
  into.reasoning += from.reasoning;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function hasCount(extra: Json | undefined, key: string): boolean {
  return count(get(extra, key)) != null;
}

function firstCount(extra: unknown, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = count(get(extra as Json, key));
    if (value != null) {
      return value;
    }
  }
  return null;
}

function isoTimestamp(raw: string | null): string | null {
  if (raw == null) {
    return null;
  }
  const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(raw) ? raw : `${raw}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function valueLabel(value: string | null): string {
  if (value == null) {
    return "(missing)";
  }
  return `(value ${createHash("sha256").update(value).digest("hex").slice(0, 8)})`;
}

function versionLabel(value: string): string {
  return /^ATIF-v\d{1,3}(?:\.\d{1,3}){0,2}$/.test(value) ? value : valueLabel(value);
}

function knownVersion(version: string | null): string | null {
  return version == null || version === "" || version === "unknown" ? null : version;
}

function nonEmpty(value: string | null): string | null {
  return value == null || value === "" ? null : value;
}
