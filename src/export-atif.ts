import type { Database } from "bun:sqlite";
import { CODEX_INJECTED_PREFIXES } from "./export.ts";
import { MESSAGE_METADATA_SQL } from "./message-storage.ts";
import { getSession, type SessionDetail, type SubagentDetail } from "./query.ts";

// ATIF (Agent Trajectory Interchange Format) emission, following Harbor's
// rfcs/0001-trajectory-format.md and the Pydantic models under
// src/harbor/models/trajectories/. One JSON document per session, with every
// descendant subagent embedded in the root's `subagent_trajectories`.
//
// v1.7 is the newest version whose features this export uses: v1.8 only adds
// audio content parts, and Letta's ATIF reader stops at v1.7.
export const ATIF_SCHEMA_VERSION = "ATIF-v1.7";

const ATIF_AGENT_NAMES: Record<string, string> = {
  claude_code: "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  opencode: "opencode",
  cursor: "cursor-cli",
  copilot: "copilot-cli",
  // Harbor has no VS Code agent; this matches the trajectory-v1 label.
  vscode_copilot: "vscode-copilot-chat",
};

type JsonObject = Record<string, unknown>;

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: JsonObject;
}

export interface AtifSubagentRef {
  trajectory_id: string;
  session_id?: string;
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
  subagents_unlinked: number;
}

export type AtifExport =
  | { ok: true; trajectory: AtifTrajectory; report: AtifReport }
  | { ok: false; reason: "not_found" | "no_steps" };

interface SessionRow {
  cwd: string | null;
  git_branch: string | null;
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
}

interface BuiltTrajectory {
  trajectory: AtifTrajectory;
  totals: TreeTotals;
}

export function exportAtif(db: Database, sessionId: number): AtifExport {
  const detail = getSession(db, sessionId);
  if (detail == null) {
    return { ok: false, reason: "not_found" };
  }
  const state: BuildState = {
    report: {
      dropped_blocks: {},
      orphan_tool_results_dropped: 0,
      duplicate_tool_results_dropped: 0,
      tool_call_ids_synthesized: 0,
      tool_call_ids_renamed: 0,
      subagents_embedded: 0,
      subagents_unlinked: 0,
    },
    usedTrajectoryIds: new Set(),
    embedded: [],
  };
  const built = buildTrajectory(db, detail, state);
  if (built == null) {
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

function buildTrajectory(
  db: Database,
  detail: SessionDetail,
  state: BuildState,
): BuiltTrajectory | null {
  const summary = detail.summary;
  const id = summary.id;
  const report = state.report;
  const drop = (kind: string): void => {
    report.dropped_blocks[kind] = (report.dropped_blocks[kind] ?? 0) + 1;
  };

  const row = db
    .query(
      `SELECT cwd, git_branch, cli_version, total_input_tokens, total_output_tokens,
              total_cache_read_tokens, total_cache_creation_tokens, total_cache_creation_1h_tokens
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
  // text, and each call as separate items.
  let agent: {
    step: AtifStep;
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
  const callsByOriginal = new Map<string, { id: string; step: AtifStep }[]>();
  const resultsTaken = new Map<string, number>();
  let callSites = 0;

  const resultFor = (step: AtifStep, callId: string): AtifObservationResult | undefined =>
    step.observation?.results.find((result) => result.source_call_id === callId);

  for (const message of detail.messages) {
    const timestamp = toIso(message.timestamp);
    const sidechain = message.is_sidechain ? { is_sidechain: true } : undefined;

    if (message.role === "assistant") {
      if (agent == null) {
        const step = pushStep({
          source: "agent",
          message: "",
          ...(timestamp == null ? {} : { timestamp }),
          ...(message.model == null || message.model === "" ? {} : { model_name: message.model }),
          ...(sidechain == null ? {} : { extra: sidechain }),
        });
        agent = { step, text: [], reasoning: [], usage: emptyUsage(), usageRows: 0 };
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
          queue.push({ id: assigned, step: agent.step });
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

  if (steps.length === 0) {
    return null;
  }

  const trajectoryId = uniqueTrajectoryId(trajectoryIdFor(detail), state.usedTrajectoryIds);
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

  for (const child of detail.subagents) {
    const childDetail = getSession(db, child.summary.id);
    if (childDetail == null) {
      continue;
    }
    // Keep the root read's subagent tree: it carries the depth limit and the
    // cycle guard for the whole document, which a fresh read would restart.
    childDetail.subagents = child.subagents;
    const builtChild = buildTrajectory(db, childDetail, state);
    if (builtChild == null) {
      continue;
    }
    state.embedded.push(builtChild.trajectory);
    report.subagents_embedded += 1;
    addUsage(totals.usage, builtChild.totals.usage);
    totals.costUsd += builtChild.totals.costUsd;
    totals.usageAvailable ||= builtChild.totals.usageAvailable;
    if (!linkSubagent(child, builtChild.trajectory, callsByOriginal, resultFor)) {
      report.subagents_unlinked += 1;
    }
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
      ...(detail.subagents.length > 0 ? { includes_subagents: true } : {}),
    };
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
      name: ATIF_AGENT_NAMES[summary.tool] ?? summary.tool,
      version: row?.cli_version ?? "unknown",
      ...(summary.model == null || summary.model === "" ? {} : { model_name: summary.model }),
    },
    steps,
    final_metrics: finalMetrics,
    extra: rootExtra,
  };
  return { trajectory, totals };
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

/** Point the spawning call's observation at the embedded subagent. Returns
 * false when the parent holds no call with the recorded spawn id. */
function linkSubagent(
  child: SubagentDetail,
  embedded: AtifTrajectory,
  callsByOriginal: Map<string, { id: string; step: AtifStep }[]>,
  resultFor: (step: AtifStep, callId: string) => AtifObservationResult | undefined,
): boolean {
  const spawnId = child.spawn_tool_use_id;
  const call = spawnId == null ? undefined : callsByOriginal.get(spawnId)?.[0];
  if (call == null) {
    return false;
  }
  const ref: AtifSubagentRef = {
    trajectory_id: embedded.trajectory_id,
    session_id: embedded.session_id,
  };
  const existing = resultFor(call.step, call.id);
  if (existing != null) {
    existing.subagent_trajectory_ref = [...(existing.subagent_trajectory_ref ?? []), ref];
  } else {
    call.step.observation ??= { results: [] };
    call.step.observation.results.push({ source_call_id: call.id, subagent_trajectory_ref: [ref] });
  }
  return true;
}
