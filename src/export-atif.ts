import type { Database } from "bun:sqlite";
import { CODEX_INJECTED_PREFIXES } from "./export.ts";
import { asString, get } from "./json.ts";
import { MESSAGE_METADATA_SQL } from "./message-storage.ts";
import type { Json } from "./model.ts";
import { getSession, type SessionDetail, type SubagentDetail } from "./query.ts";
import { ATIF_AGENT_NAMES } from "./sources/atif.ts";

// ATIF (Agent Trajectory Interchange Format) emission, following Harbor's
// rfcs/0001-trajectory-format.md and the Pydantic models under
// src/harbor/models/trajectories/. One JSON document per session, with every
// descendant subagent embedded in the root's `subagent_trajectories`.
//
// v1.7 is the newest version whose features this export uses: v1.8 only adds
// audio content parts, and Letta's ATIF reader stops at v1.7.
export const ATIF_SCHEMA_VERSION = "ATIF-v1.7";

type JsonObject = Record<string, unknown>;

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: JsonObject;
}

export interface AtifSubagentRef {
  trajectory_id: string;
  session_id?: string;
  trajectory_path?: string;
}

/** A subagent session that is exported as a document of its own. */
export interface AtifSubagentTarget {
  /** The subagent's archive session id. */
  id: number;
  tool: string;
  source_session_id: string;
  /** The `trajectory_id` its own export carries. */
  trajectory_id: string;
}

export interface AtifExportOptions {
  /** Where each subagent's own document will live: a file path, a URL, or a
   * key in another store. When set, subagents are left out of this document
   * and each spawning call points at that location through ATIF's file-ref
   * form (`trajectory_path`). `final_metrics` then cover this session alone,
   * so a reader that stores every session separately counts nothing twice. */
  subagentPath?: (subagent: AtifSubagentTarget) => string;
}

export interface AtifObservationResult {
  source_call_id?: string;
  content?: string;
  subagent_trajectory_ref?: AtifSubagentRef[];
  extra?: JsonObject;
}

export interface AtifMetrics {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  extra: JsonObject;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  model_name?: string;
  message: string;
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: AtifMetrics;
  llm_call_count?: number;
  extra?: JsonObject;
}

export interface AtifFinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps: number;
  extra?: JsonObject;
}

export interface AtifTrajectory {
  schema_version: string;
  session_id: string;
  trajectory_id: string;
  agent: { name: string; version: string; model_name?: string; extra?: JsonObject };
  steps: AtifStep[];
  final_metrics: AtifFinalMetrics;
  extra: JsonObject;
  subagent_trajectories?: AtifTrajectory[];
}

export interface AtifReport {
  dropped_blocks: Record<string, number>;
  orphan_tool_results_dropped: number;
  duplicate_tool_results_dropped: number;
  tool_call_ids_synthesized: number;
  tool_call_ids_renamed: number;
  subagents_embedded: number;
  subagents_referenced: number;
  subagents_unlinked: number;
}

export type AtifExport =
  | { ok: true; trajectory: AtifTrajectory; report: AtifReport }
  | { ok: false; reason: "not_found" | "no_steps" };

interface SessionRow {
  raw_meta: string | null;
  cwd: string | null;
  git_branch: string | null;
  repo_remote: string | null;
  cli_version: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_creation_1h_tokens: number;
}

interface MessageUsageRow {
  seq: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Totals for one trajectory and everything embedded under it. Root
 * `final_metrics` include subagents, as Harbor's model describes
 * `total_cost_usd`. */
interface TreeTotals {
  usage: Usage;
  costUsd: number;
  usageAvailable: boolean;
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function addUsage(into: Usage, from: Usage): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreation += from.cacheCreation;
}

/** ATIF counts `prompt_tokens` inclusive of cached input and has no cache-write
 * field. Decant stores input net of cache reads and writes, so the prompt is
 * the same sum Decant uses for context occupancy, and the write share travels
 * in `extra` under fast-agent's key. */
function stepMetrics(usage: Usage): AtifMetrics {
  return {
    prompt_tokens: usage.input + usage.cacheRead + usage.cacheCreation,
    completion_tokens: usage.output,
    cached_tokens: usage.cacheRead,
    extra: { cache_write_tokens: usage.cacheCreation },
  };
}

function toIso(raw: string | null): string | undefined {
  if (raw == null) {
    return undefined;
  }
  const withZone = /(Z|[+-]\d{2}(?::?\d{2})?)$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** ATIF requires `arguments` to be an object. Decant stores tool input as
 * canonical JSON, so a string input arrives as a JSON string literal: Codex
 * function_call arguments are themselves serialized JSON, and custom tools
 * (exec, apply_patch) carry free text. Unwrap once, and file anything that is
 * still not an object under `input`, as Letta's Codex adapter does. */
function toolArguments(toolInput: string | null): JsonObject {
  if (toolInput == null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolInput);
  } catch {
    return { input: toolInput };
  }
  if (typeof parsed === "string") {
    try {
      const inner: unknown = JSON.parse(parsed);
      if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
        return inner as JsonObject;
      }
    } catch {
      // Free text, not serialized JSON.
    }
    return { input: parsed };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as JsonObject;
  }
  return { input: parsed };
}

function trajectoryIdFor(detail: SessionDetail): string {
  const summary = detail.summary;
  return summary.agent_id != null && summary.agent_id !== ""
    ? `${summary.source_session_id}:${summary.agent_id}`
    : summary.source_session_id;
}

interface BuildState {
  report: AtifReport;
  usedTrajectoryIds: Set<string>;
  embedded: AtifTrajectory[];
  subagentPath: AtifExportOptions["subagentPath"];
}

function newBuildState(subagentPath?: AtifExportOptions["subagentPath"]): BuildState {
  return {
    report: {
      dropped_blocks: {},
      orphan_tool_results_dropped: 0,
      duplicate_tool_results_dropped: 0,
      tool_call_ids_synthesized: 0,
      tool_call_ids_renamed: 0,
      subagents_embedded: 0,
      subagents_referenced: 0,
      subagents_unlinked: 0,
    },
    usedTrajectoryIds: new Set(),
    embedded: [],
    subagentPath,
  };
}

interface BuiltTrajectory {
  /** Null when the session has nothing to export. Its descendants are still
   * embedded in the root and its totals still roll up. */
  trajectory: AtifTrajectory | null;
  totals: TreeTotals;
}

interface CallSite {
  id: string;
  step: AtifStep;
  /** When the calling message was recorded, used to tell reused ids apart. */
  at: string | undefined;
}

export function exportAtif(
  db: Database,
  sessionId: number,
  options: AtifExportOptions = {},
): AtifExport {
  const detail = getSession(db, sessionId);
  if (detail == null) {
    return { ok: false, reason: "not_found" };
  }
  const state = newBuildState(options.subagentPath);
  const built = buildTrajectory(db, detail, state);
  if (built.trajectory == null) {
    return { ok: false, reason: "no_steps" };
  }
  if (state.embedded.length > 0) {
    built.trajectory.subagent_trajectories = state.embedded;
  }
  return { ok: true, trajectory: built.trajectory, report: state.report };
}

function uniqueTrajectoryId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}#${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function buildTrajectory(db: Database, detail: SessionDetail, state: BuildState): BuiltTrajectory {
  const summary = detail.summary;
  const id = summary.id;
  const report = state.report;
  const drop = (kind: string): void => {
    report.dropped_blocks[kind] = (report.dropped_blocks[kind] ?? 0) + 1;
  };

  const row = db
    .query(
      `SELECT raw_meta, cwd, git_branch, cli_version, total_input_tokens, total_output_tokens,
              total_cache_read_tokens, total_cache_creation_tokens, total_cache_creation_1h_tokens,
              (SELECT repo_remote FROM project WHERE id = session.project_id) AS repo_remote
       FROM session WHERE id = ?1`,
    )
    .get(id) as SessionRow | null;
  const usageBySeq = new Map<number, Usage>();
  for (const usage of db
    .query(
      `SELECT seq, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
       FROM message WHERE session_id = ?1`,
    )
    .all(id) as MessageUsageRow[]) {
    if (
      usage.input_tokens == null &&
      usage.output_tokens == null &&
      usage.cache_read_tokens == null &&
      usage.cache_creation_tokens == null
    ) {
      continue;
    }
    usageBySeq.set(usage.seq, {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_tokens ?? 0,
      cacheCreation: usage.cache_creation_tokens ?? 0,
    });
  }
  const resultStatuses = new Map(
    (
      db
        .query(`SELECT m.seq, b.ordinal, t.is_error FROM tool_call t
      JOIN block b ON b.id = t.result_block_id JOIN message m ON m.id = b.message_id
      WHERE t.session_id = ?1 AND t.is_error IS NOT NULL`)
        .all(id) as { seq: number; ordinal: number; is_error: number }[]
    ).map((status) => [`${status.seq}:${status.ordinal}`, status.is_error !== 0]),
  );
  const codex = summary.tool === "codex";
  // Codex stores developer messages under role `user`; only the raw payload
  // role tells them apart from what a person typed.
  const developerSeqs = new Set(
    codex
      ? (
          db
            .query(
              `SELECT seq FROM message m
               WHERE session_id = ?1 AND json_extract(${MESSAGE_METADATA_SQL}, '$.payload.role') = 'developer'`,
            )
            .all(id) as { seq: number }[]
        ).map((m) => m.seq)
      : [],
  );

  const steps: AtifStep[] = [];
  // One agent step per run of consecutive assistant messages: Claude splits
  // one API response across several records, and Codex writes reasoning,
  // text, and each call as separate items. A change of model or of sidechain
  // status starts a new step, so neither label covers another speaker's words.
  let agent: {
    step: AtifStep;
    model: string | null;
    sidechain: boolean;
    text: string[];
    reasoning: string[];
    usage: Usage;
    usageRows: number;
  } | null = null;
  const closeAgent = (): void => {
    if (agent == null) {
      return;
    }
    const { step, text, reasoning, usage, usageRows } = agent;
    step.message = text.join("\n\n");
    if (reasoning.length > 0) {
      step.reasoning_content = reasoning.join("\n\n");
    }
    if (usageRows > 0) {
      step.metrics = stepMetrics(usage);
      if (usageRows > 1) {
        step.llm_call_count = usageRows;
      }
    }
    agent = null;
  };
  const pushStep = (step: Omit<AtifStep, "step_id">): AtifStep => {
    const full = { step_id: steps.length + 1, ...step } as AtifStep;
    steps.push(full);
    return full;
  };

  // Call ids are unique across the document. A reused id is renamed by probing
  // `__dup<n>` upward, as the trajectory-v1 export does, and its results are
  // paired with calls in occurrence order.
  const usedCallIds = new Set<string>();
  const callsByOriginal = new Map<string, CallSite[]>();
  const resultsTaken = new Map<string, number>();
  let callSites = 0;

  const resultFor = (step: AtifStep, callId: string): AtifObservationResult | undefined =>
    step.observation?.results.find((result) => result.source_call_id === callId);

  for (const message of detail.messages) {
    const timestamp = toIso(message.timestamp);
    const sidechain = message.is_sidechain ? { is_sidechain: true } : undefined;

    if (message.role === "assistant") {
      const model = message.model == null || message.model === "" ? null : message.model;
      if (
        agent != null &&
        (agent.sidechain !== message.is_sidechain ||
          (model != null && agent.model != null && model !== agent.model))
      ) {
        closeAgent();
      }
      if (agent == null) {
        const step = pushStep({
          source: "agent",
          message: "",
          ...(timestamp == null ? {} : { timestamp }),
          ...(model == null ? {} : { model_name: model }),
          ...(sidechain == null ? {} : { extra: sidechain }),
        });
        agent = {
          step,
          model,
          sidechain: message.is_sidechain,
          text: [],
          reasoning: [],
          usage: emptyUsage(),
          usageRows: 0,
        };
      } else if (agent.model == null && model != null) {
        agent.model = model;
        agent.step.model_name = model;
      }
      const usage = usageBySeq.get(message.seq);
      if (usage != null) {
        addUsage(agent.usage, usage);
        agent.usageRows += 1;
      }
      for (const block of message.blocks) {
        const text = block.text ?? "";
        if (block.block_type === "text" && text.trim() !== "") {
          agent.text.push(text);
        } else if (block.block_type === "thinking" && text.trim() !== "") {
          agent.reasoning.push(text);
        } else if (block.block_type === "tool_use") {
          callSites += 1;
          const original = block.tool_use_id ?? `decant-${id}-${callSites}`;
          if (block.tool_use_id == null) {
            report.tool_call_ids_synthesized += 1;
          }
          let assigned = original;
          if (usedCallIds.has(assigned)) {
            let suffix = 2;
            while (usedCallIds.has(`${original}__dup${suffix}`)) {
              suffix += 1;
            }
            assigned = `${original}__dup${suffix}`;
            report.tool_call_ids_renamed += 1;
          }
          usedCallIds.add(assigned);
          const queue = callsByOriginal.get(original) ?? [];
          queue.push({ id: assigned, step: agent.step, at: timestamp });
          callsByOriginal.set(original, queue);
          agent.step.tool_calls ??= [];
          agent.step.tool_calls.push({
            tool_call_id: assigned,
            function_name:
              block.tool_name != null && block.tool_name !== "" ? block.tool_name : "unknown_tool",
            arguments: toolArguments(block.tool_input),
          });
        } else if (block.block_type === "tool_result") {
          drop("assistant_tool_result");
        } else {
          // Empty text and hidden reasoning carry nothing to export.
          drop(block.block_type);
        }
      }
      continue;
    }

    closeAgent();
    const texts: string[] = [];
    for (const block of message.blocks) {
      if (block.block_type === "tool_result") {
        const original = block.tool_use_id;
        const queue = original == null ? undefined : callsByOriginal.get(original);
        if (original == null || queue == null) {
          report.orphan_tool_results_dropped += 1;
          continue;
        }
        const taken = resultsTaken.get(original) ?? 0;
        const call = queue[taken];
        if (call == null) {
          report.duplicate_tool_results_dropped += 1;
          continue;
        }
        resultsTaken.set(original, taken + 1);
        const isError = resultStatuses.get(`${message.seq}:${block.ordinal}`);
        call.step.observation ??= { results: [] };
        call.step.observation.results.push({
          source_call_id: call.id,
          content: block.tool_result ?? "",
          ...(isError == null ? {} : { extra: { is_error: isError } }),
        });
      } else if (block.block_type === "text" && (block.text ?? "").trim() !== "") {
        texts.push(block.text ?? "");
      } else {
        drop(`${message.role}_${block.block_type}`);
      }
    }
    const text = texts.join("\n\n");
    if (message.is_compact_boundary) {
      pushStep(
        compactionStep(text, timestamp, message.compact_trigger, message.compact_pre_tokens),
      );
      continue;
    }
    if (texts.length === 0) {
      continue;
    }
    const trimmed = text.trimStart();
    const injected =
      developerSeqs.has(message.seq) ||
      (codex && CODEX_INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix)));
    if (message.role === "system" || injected) {
      pushStep({
        source: "system",
        message: text,
        ...(timestamp == null ? {} : { timestamp }),
        ...(sidechain == null ? {} : { extra: sidechain }),
      });
    } else if (message.role === "user") {
      const extra: JsonObject = { ...sidechain };
      if (message.is_compact_summary) {
        extra.is_compact_summary = true;
      }
      pushStep({
        source: "user",
        message: text,
        ...(timestamp == null ? {} : { timestamp }),
        ...(Object.keys(extra).length === 0 ? {} : { extra }),
      });
    } else {
      // `tool` and `other` prose has no ATIF speaker: attributing it to the
      // user or the agent would misstate who said it.
      drop(`${message.role}_text`);
    }
  }
  closeAgent();

  // Claimed before descendants so a child cannot take this session's id.
  const trajectoryId =
    steps.length === 0
      ? null
      : uniqueTrajectoryId(trajectoryIdFor(detail), state.usedTrajectoryIds);
  const ownUsage: Usage = {
    input: row?.total_input_tokens ?? 0,
    output: row?.total_output_tokens ?? 0,
    cacheRead: row?.total_cache_read_tokens ?? 0,
    cacheCreation: row?.total_cache_creation_tokens ?? 0,
  };
  const totals: TreeTotals = {
    usage: { ...ownUsage },
    costUsd: summary.usage_available ? summary.estimated_cost_usd : 0,
    usageAvailable: summary.usage_available,
  };

  const embeds = state.subagentPath == null;
  for (const child of detail.subagents) {
    const childDetail = getSession(db, child.summary.id);
    if (childDetail == null) {
      continue;
    }
    if (state.subagentPath != null) {
      // Build the child exactly as its own export would, without its
      // descendants: that decides whether there is a document to point at and
      // which `trajectory_id` it carries. Its report belongs to that export.
      childDetail.subagents = [];
      const own = buildTrajectory(db, childDetail, newBuildState()).trajectory;
      if (own == null) {
        continue;
      }
      const ref: AtifSubagentRef = {
        trajectory_id: own.trajectory_id,
        session_id: own.session_id,
        trajectory_path: state.subagentPath({
          id: child.summary.id,
          tool: child.summary.tool,
          source_session_id: child.summary.source_session_id,
          trajectory_id: own.trajectory_id,
        }),
      };
      if (linkSubagent(child, ref, callsByOriginal, resultFor)) {
        report.subagents_referenced += 1;
      } else {
        report.subagents_unlinked += 1;
      }
      continue;
    }
    // Keep the root read's subagent tree: it carries the depth limit and the
    // cycle guard for the whole document, which a fresh read would restart.
    childDetail.subagents = child.subagents;
    const builtChild = buildTrajectory(db, childDetail, state);
    addUsage(totals.usage, builtChild.totals.usage);
    totals.costUsd += builtChild.totals.costUsd;
    totals.usageAvailable ||= builtChild.totals.usageAvailable;
    if (builtChild.trajectory == null) {
      continue;
    }
    state.embedded.push(builtChild.trajectory);
    report.subagents_embedded += 1;
    const ref: AtifSubagentRef = {
      trajectory_id: builtChild.trajectory.trajectory_id,
      session_id: builtChild.trajectory.session_id,
    };
    if (!linkSubagent(child, ref, callsByOriginal, resultFor)) {
      report.subagents_unlinked += 1;
    }
  }

  if (trajectoryId == null) {
    return { trajectory: null, totals };
  }

  const finalMetrics: AtifFinalMetrics = { total_steps: steps.length };
  if (totals.usageAvailable) {
    finalMetrics.total_prompt_tokens =
      totals.usage.input + totals.usage.cacheRead + totals.usage.cacheCreation;
    finalMetrics.total_completion_tokens = totals.usage.output;
    finalMetrics.total_cached_tokens = totals.usage.cacheRead;
    finalMetrics.total_cost_usd = totals.costUsd;
    finalMetrics.extra = {
      total_cache_write_tokens: totals.usage.cacheCreation,
      // Decant prices with its own rate table at export time, unless the
      // source recorded a cost for a model Decant cannot price.
      cost_source: summary.cost_source,
      ...(embeds && detail.subagents.length > 0 ? { includes_subagents: true } : {}),
    };
    if (embeds && detail.subagents.length > 0 && summary.usage_available) {
      // The totals above include the subagents, so a reader that files each
      // embedded trajectory as its own session needs this one's share.
      finalMetrics.extra.session_metrics = {
        total_prompt_tokens: ownUsage.input + ownUsage.cacheRead + ownUsage.cacheCreation,
        total_completion_tokens: ownUsage.output,
        total_cached_tokens: ownUsage.cacheRead,
        total_cache_write_tokens: ownUsage.cacheCreation,
        total_cost_usd: summary.estimated_cost_usd,
      };
    }
    if (summary.reasoning_source != null && summary.reasoning_source !== "none") {
      finalMetrics.extra.total_reasoning_tokens = summary.total_reasoning_tokens;
      finalMetrics.extra.reasoning_source = summary.reasoning_source;
    }
    if ((row?.total_cache_creation_1h_tokens ?? 0) > 0) {
      finalMetrics.extra.total_cache_write_1h_tokens = row?.total_cache_creation_1h_tokens;
    }
  }

  const rootExtra: JsonObject = { exporter: "decant", decant_tool: summary.tool };
  const optional: [string, string | null][] = [
    ["title", summary.title],
    ["cwd", row?.cwd ?? null],
    ["git_branch", row?.git_branch ?? null],
    // Unlike `cwd`, this names the repository the same way on every machine.
    ["repository", row?.repo_remote ?? null],
    ["reasoning_effort", summary.reasoning_effort],
    ["agent_type", summary.agent_type],
  ];
  for (const [key, value] of optional) {
    if (value != null && value !== "") {
      rootExtra[key] = value;
    }
  }

  const trajectory: AtifTrajectory = {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: summary.source_session_id,
    trajectory_id: trajectoryId,
    agent: {
      name: agentName(summary.tool, row?.raw_meta ?? null),
      version: row?.cli_version ?? "unknown",
      ...(summary.model == null || summary.model === "" ? {} : { model_name: summary.model }),
    },
    steps,
    final_metrics: finalMetrics,
    extra: rootExtra,
  };
  return { trajectory, totals };
}

/** Harbor's name for a native source. A session imported from ATIF keeps the
 * name its producer wrote, so a round trip does not relabel it. */
function agentName(tool: string, rawMeta: string | null): string {
  if (tool === "atif") {
    let meta: Json | undefined;
    try {
      meta = rawMeta == null ? undefined : (JSON.parse(rawMeta) as Json);
    } catch {
      meta = undefined;
    }
    return asString(get(get(meta, "agent"), "name")) ?? "unknown";
  }
  return ATIF_AGENT_NAMES[tool as keyof typeof ATIF_AGENT_NAMES] ?? tool;
}

/** A Claude-style compaction boundary, in the v1.7 `context_management`
 * convention. The summary that replaces the context follows as its own user
 * step, so the boundary carries no observation of its own. */
function compactionStep(
  text: string,
  timestamp: string | undefined,
  trigger: string | null,
  preTokens: number | null,
): Omit<AtifStep, "step_id"> {
  const extra: JsonObject = { context_management: { type: "compaction", boundary: "replace" } };
  if (trigger != null) {
    extra.compact_trigger = trigger;
  }
  if (preTokens != null) {
    extra.compact_pre_tokens = preTokens;
  }
  return {
    source: "system",
    message: text === "" ? "Context compaction performed" : text,
    ...(timestamp == null ? {} : { timestamp }),
    extra,
  };
}

/** The call that spawned a child. A reused spawn id is resolved by time: the
 * latest occurrence recorded at or before the child started. Without the
 * timestamps to decide, the child stays unlinked rather than pointing at a
 * call that may not be its own. */
function spawningCall(child: SubagentDetail, calls: CallSite[] | undefined): CallSite | undefined {
  if (calls == null || calls.length === 0) {
    return undefined;
  }
  if (calls.length === 1) {
    return calls[0];
  }
  const started = toIso(child.summary.started_at);
  if (started == null || calls.some((call) => call.at == null)) {
    return undefined;
  }
  let match: CallSite | undefined;
  for (const call of calls) {
    if ((call.at ?? "") <= started) {
      match = call;
    }
  }
  return match;
}

/** Point the spawning call's observation at the subagent's trajectory. Returns
 * false when no call in the parent can be identified as the spawner. */
function linkSubagent(
  child: SubagentDetail,
  ref: AtifSubagentRef,
  callsByOriginal: Map<string, CallSite[]>,
  resultFor: (step: AtifStep, callId: string) => AtifObservationResult | undefined,
): boolean {
  const spawnId = child.spawn_tool_use_id;
  const call = spawningCall(child, spawnId == null ? undefined : callsByOriginal.get(spawnId));
  if (call == null) {
    return false;
  }
  const existing = resultFor(call.step, call.id);
  if (existing != null) {
    existing.subagent_trajectory_ref = [...(existing.subagent_trajectory_ref ?? []), ref];
  } else {
    call.step.observation ??= { results: [] };
    call.step.observation.results.push({ source_call_id: call.id, subagent_trajectory_ref: [ref] });
  }
  return true;
}
