import type { Database } from "bun:sqlite";
import { getSession, type SessionDetail } from "./query.ts";

export function toMarkdown(detail: SessionDetail): string {
  const summary = detail.summary;
  let out = "";
  const title = summary.title ?? summary.source_session_id;
  out += `# ${title}\n\n`;
  out +=
    `- **tool:** ${summary.tool}\n` +
    `- **model:** ${summary.model ?? ""}\n` +
    `- **messages:** ${summary.message_count}\n` +
    `- **est. cost:** ${summary.usage_available ? `$${summary.estimated_cost_usd.toFixed(2)}` : "unavailable"}\n` +
    `- **started:** ${summary.started_at ?? ""}\n\n`;

  for (const message of detail.messages) {
    out += `## ${message.role.toUpperCase()}\n\n`;
    for (const block of message.blocks) {
      if (block.block_type === "text") {
        if (block.text != null) {
          out += `${block.text}\n\n`;
        }
      } else if (block.block_type === "thinking") {
        if (block.text != null) {
          out += `> _thinking:_ ${block.text}\n\n`;
        }
      } else if (block.block_type === "tool_use") {
        out += `**→ ${block.tool_name ?? ""}**\n\n`;
        out += `\`\`\`json\n${block.tool_input ?? ""}\n\`\`\`\n\n`;
      } else if (block.block_type === "tool_result") {
        out += `\`\`\`\n${block.tool_result ?? ""}\n\`\`\`\n\n`;
      } else {
        out += `_[${block.block_type}]_\n\n`;
      }
    }
  }
  return out;
}

// trajectory-v1 emission (letta-ai/trajectory schema/trajectory-v1.schema.json).
// One JSON array per session: meta first, then per-block records. Their runtime
// validator is stricter than the schema; the rules enforced here are: meta at
// index 0 exactly once, args always a serialized JSON object, globally unique
// tool-call ids, results only for calls that exist, >=1 user and >=1 assistant.

const TRAJECTORY_SOURCES: Record<string, string> = {
  claude_code: "claude-code",
  codex: "codex",
};

/** Their core.ts NOISE_PREFIXES, applied to user text so downstream consumers
 * see the cleaning trajectory-native pipelines expect. The last entry has no
 * closing ">" by design — it matches attribute forms. */
const TRAJECTORY_NOISE_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<task-notification",
];

const TRAJECTORY_ARGS_MAX = 20_000;
const TRAJECTORY_RESULT_MAX = 2_500;
const TRAJECTORY_SYNTH_BASE_MS = Date.UTC(2026, 0, 1);
const TRAJECTORY_SYNTH_STEP_SECONDS = 15;

/** decant roles with a trajectory wire equivalent. `system`/`other` messages
 * have none and are dropped whole. `tool` is in: decant files a result-only
 * message under role `tool` and a text+result message under `user`, so tool
 * results reach the wire only if both roles are walked. Both emission passes
 * filter on this so the calls registered in pass 1 are exactly what pass 2
 * emits. */
function isTrajectoryWireRole(role: string): boolean {
  return role === "user" || role === "assistant" || role === "tool";
}

function trajectoryMarker(remaining: number): string {
  return `\n… [truncated, ${remaining} more chars]`;
}

/** Marker-inclusive head-tail truncation in Unicode code points, ported from
 * trajectory's truncateText: the marker sits mid-string and counts against the
 * limit, and head takes the odd code point (head = ceil half). The marker
 * announces how many code points were dropped, so its own length depends on the
 * budget — hence the binary search for the largest budget that still fits. */
function trajectoryTruncate(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= max) {
    return { text, truncated: false };
  }
  let low = 0;
  let high = Math.min(chars.length - 1, max);
  let keep = -1;
  let marker = "";
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    const candidateMarker = trajectoryMarker(chars.length - candidate);
    if (candidate + [...candidateMarker].length <= max) {
      keep = candidate;
      marker = candidateMarker;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  if (keep < 0) {
    // Budgets too small for the descriptive marker degrade to a bare ellipsis.
    marker = [..."…"].slice(0, max).join("");
    keep = max - [...marker].length;
  }
  const headLen = Math.ceil(keep / 2);
  const tailLen = keep - headLen;
  const head = chars.slice(0, headLen).join("");
  const tail = tailLen > 0 ? chars.slice(chars.length - tailLen).join("") : "";
  return { text: `${head}${marker}${tail}`, truncated: true };
}

interface TrajectoryLeaf {
  original: string;
  current: string;
  set: (value: string) => void;
}

/** Every string leaf reachable in the args object, arrays included, each with a
 * setter that writes back into its own container. */
function trajectoryCollectLeaves(value: unknown, leaves: TrajectoryLeaf[]): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (typeof child === "string") {
        leaves.push({
          original: child,
          current: child,
          set: (next) => {
            value[index] = next;
          },
        });
      } else if (child !== null && typeof child === "object") {
        trajectoryCollectLeaves(child, leaves);
      }
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (typeof child === "string") {
      leaves.push({
        original: child,
        current: child,
        set: (next) => {
          record[key] = next;
        },
      });
    } else if (child !== null && typeof child === "object") {
      trajectoryCollectLeaves(child, leaves);
    }
  }
}

/** Shrink an over-cap args object into the cap while keeping its field
 * structure, by truncating string leaves largest-first in place. Returns the
 * serialization once it fits, or null when the overage does not live in the
 * string leaves (many small fields, or bulk in the keys) and only a `_raw` wrap
 * can help. `parsed` is mutated either way.
 *
 * Their core.ts has two of these; this follows the strictly decreasing one
 * (`shrinkObjectArgsSafely`), not the legacy loop whose hard 2 000-character
 * per-leaf floor can spin forever or return an over-cap object — the bug their
 * PARITY.md records as a 21,560-character object escaping a 20,000 cap. Two
 * things make termination unconditional here: a leaf no longer than the marker
 * cannot shrink usefully, so shrinking stops rather than retrying it, and an
 * iteration that shortens nothing gives up instead of looping. */
function trajectoryShrinkLeaves(parsed: object, limit: number): string | null {
  const leaves: TrajectoryLeaf[] = [];
  trajectoryCollectLeaves(parsed, leaves);
  const markerFloor = [...trajectoryMarker(0)].length;
  let serialized = JSON.stringify(parsed);
  while ([...serialized].length > limit) {
    let largest: TrajectoryLeaf | undefined;
    let largestLen = 0;
    for (const leaf of leaves) {
      const length = [...leaf.current].length;
      if (length > largestLen) {
        largest = leaf;
        largestLen = length;
      }
    }
    if (largest == null || largestLen <= markerFloor) {
      return null;
    }
    // Cut only as much of the biggest leaf as the overage needs, so an object
    // barely over the cap keeps nearly all of its content. The overage is
    // measured on the serialized form and the leaf in code points, and escaping
    // makes those differ, so a gentle cut can fail to shrink the serialization
    // at all; halving always shrinks it for a leaf longer than the marker, and
    // is the fallback whenever the gentle cut does not land. Truncating from the
    // leaf's original text keeps the marker's dropped-count honest across
    // repeated passes over the same leaf.
    const before = [...serialized].length;
    const halved = Math.floor(largestLen / 2);
    const gentle = Math.max(halved, Math.min(largestLen - 1, largestLen - (before - limit) - 1));
    let shrank = false;
    for (const target of gentle > halved ? [gentle, halved] : [halved]) {
      const { text } = trajectoryTruncate(largest.original, target);
      largest.set(text);
      largest.current = text;
      serialized = JSON.stringify(parsed);
      if ([...serialized].length < before) {
        shrank = true;
        break;
      }
    }
    if (!shrank) {
      return null;
    }
  }
  return serialized;
}

/** Serialize tool args as a JSON object string within the cap. Non-object args
 * are reshaped to {"_raw": <string>} (their tool_arguments_reshaped move). An
 * over-cap object keeps its field structure by shrinking its string leaves, and
 * degrades to a truncated {"_raw": ...} wrap only if that cannot reach the
 * cap. */
function trajectoryArgs(toolInput: string | null, report: TrajectoryReport): string {
  let parsed: unknown;
  try {
    parsed = toolInput == null ? {} : JSON.parse(toolInput);
  } catch {
    parsed = undefined;
  }
  const isPlainObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  const serialized = isPlainObject ? JSON.stringify(parsed) : null;
  if (serialized != null && [...serialized].length <= TRAJECTORY_ARGS_MAX) {
    return serialized;
  }
  if (serialized != null) {
    const shrunk = trajectoryShrinkLeaves(parsed as object, TRAJECTORY_ARGS_MAX);
    if (shrunk != null) {
      report.tool_args_wrapped += 1;
      return shrunk;
    }
  }
  report.tool_args_wrapped += 1;
  // `serialized` predates any leaf shrinking, so the wrap carries the original.
  const raw = serialized ?? toolInput ?? "";
  // Budget for {"_raw":""} scaffolding + escaping: truncate the payload, then
  // shrink until the serialized wrapper fits (escaping can expand length).
  let budget = TRAJECTORY_ARGS_MAX - 12;
  let wrapped: string;
  do {
    const { text } = trajectoryTruncate(raw, Math.max(2, budget));
    wrapped = JSON.stringify({ _raw: text });
    budget = Math.floor(budget / 2);
  } while ([...wrapped].length > TRAJECTORY_ARGS_MAX && budget > 2);
  return wrapped;
}

interface TrajectorySessionRow {
  cwd: string | null;
  git_branch: string | null;
}

export interface TrajectoryReport {
  dropped_blocks: Record<string, number>;
  noise_user_records_dropped: number;
  orphan_tool_results_dropped: number;
  duplicate_tool_results_dropped: number;
  tool_call_ids_synthesized: number;
  tool_call_ids_renamed: number;
  tool_args_wrapped: number;
  tool_results_truncated: number;
  timestamps_filled: number;
}

export type TrajectoryExport =
  | { ok: true; records: unknown[]; report: TrajectoryReport }
  | { ok: false; reason: "not_found" | "missing_user_records" | "missing_assistant_records" };

export function exportTrajectory(db: Database, sessionId: number): TrajectoryExport {
  const detail = getSession(db, sessionId);
  if (detail == null) {
    return { ok: false, reason: "not_found" };
  }
  const row = db
    .query("SELECT cwd, git_branch FROM session WHERE id = ?1")
    .get(sessionId) as TrajectorySessionRow | null;

  const report: TrajectoryReport = {
    dropped_blocks: {},
    noise_user_records_dropped: 0,
    orphan_tool_results_dropped: 0,
    duplicate_tool_results_dropped: 0,
    tool_call_ids_synthesized: 0,
    tool_call_ids_renamed: 0,
    tool_args_wrapped: 0,
    tool_results_truncated: 0,
    timestamps_filled: 0,
  };
  const drop = (kind: string): void => {
    report.dropped_blocks[kind] = (report.dropped_blocks[kind] ?? 0) + 1;
  };

  // Pass 1: assign globally unique call ids in appearance order. A name already
  // taken is renamed by probing `__dup<n>` upward until the candidate is unused
  // (their core.ts move): a fixed `__dup2` would collide when the source itself
  // contains an id that already looks like one of our renames. Each original id
  // keeps a queue of the names it was assigned, so pass 2 reads the strings back
  // instead of recomputing a suffix it can no longer predict.
  const assignedByOriginal = new Map<string, string[]>();
  const usedIds = new Set<string>();
  let callSites = 0;
  for (const message of detail.messages) {
    if (!isTrajectoryWireRole(message.role)) {
      continue;
    }
    for (const block of message.blocks) {
      if (block.block_type !== "tool_use") {
        continue;
      }
      callSites += 1;
      const original = block.tool_use_id ?? `decant-${sessionId}-${callSites}`;
      if (block.tool_use_id == null) {
        report.tool_call_ids_synthesized += 1;
      }
      let assigned = original;
      if (usedIds.has(assigned)) {
        let suffix = 2;
        while (usedIds.has(`${original}__dup${suffix}`)) {
          suffix += 1;
        }
        assigned = `${original}__dup${suffix}`;
        report.tool_call_ids_renamed += 1;
      }
      usedIds.add(assigned);
      const queue = assignedByOriginal.get(original) ?? [];
      queue.push(assigned);
      assignedByOriginal.set(original, queue);
    }
  }

  // Pass 2: emit records.
  const records: unknown[] = [];
  const callTaken = new Map<string, number>(); // original id -> calls emitted
  const resultTaken = new Map<string, number>(); // original id -> results consumed
  const answered = new Set<string>(); // assigned ids with a result already
  let lastTimestamp: string | null = null;
  let synthIndex = 0;
  // Their library always emits Date#toISOString() output; normalize source
  // timestamps the same way. Unparseable values count as missing and are
  // filled (last-seen, then session start, then their synthetic-base ladder).
  const toIsoZ = (raw: string | null): string | null => {
    if (raw == null) {
      return null;
    }
    // Bare ±hh is a valid ISO-8601 offset: recognize it so we never corrupt
    // it with an appended Z. (Bun's Date cannot parse bare ±hh either way, so
    // such stamps still fall through to the fill ladder — but as themselves.)
    const withZone = /(Z|[+-]\d{2}(?::?\d{2})?)$/.test(raw) ? raw : `${raw}Z`;
    const date = new Date(withZone);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  // Counts filled timestamps per emitted record: dropped blocks never ask.
  const timestampFor = (raw: string | null): string => {
    const normalized = toIsoZ(raw);
    if (normalized != null) {
      lastTimestamp = normalized;
      return normalized;
    }
    report.timestamps_filled += 1;
    if (lastTimestamp != null) {
      return lastTimestamp;
    }
    const started = toIsoZ(detail.summary.started_at);
    if (started != null) {
      lastTimestamp = started;
      return started;
    }
    synthIndex += 1;
    return new Date(
      TRAJECTORY_SYNTH_BASE_MS + synthIndex * TRAJECTORY_SYNTH_STEP_SECONDS * 1000,
    ).toISOString();
  };

  let userCount = 0;
  let assistantCount = 0;
  let callEmit = 0;
  for (const message of detail.messages) {
    if (!isTrajectoryWireRole(message.role)) {
      if (message.blocks.length > 0) {
        drop(`${message.role}_message`);
      }
      continue;
    }
    const timestamp = (): string => timestampFor(message.timestamp);
    for (const block of message.blocks) {
      const text = block.text ?? "";
      const hasText = text.trim() !== "";
      if (block.block_type === "text" && hasText) {
        if (message.role === "user") {
          const trimmed = text.trimStart();
          if (TRAJECTORY_NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
            report.noise_user_records_dropped += 1;
            continue;
          }
          records.push({ role: "user", content: text, timestamp: timestamp() });
          userCount += 1;
        } else if (message.role === "assistant") {
          records.push({ role: "assistant", content: text, timestamp: timestamp() });
          assistantCount += 1;
        } else {
          // Prose on a `tool`-role message has no wire equivalent: speaking it
          // as either party would misattribute it.
          drop(`${message.role}_text`);
        }
      } else if (block.block_type === "thinking" && hasText) {
        records.push({ role: "reasoning", content: text, timestamp: timestamp() });
      } else if (block.block_type === "tool_use") {
        callEmit += 1;
        const original = block.tool_use_id ?? `decant-${sessionId}-${callEmit}`;
        const emitted = callTaken.get(original) ?? 0;
        callTaken.set(original, emitted + 1);
        const assigned = assignedByOriginal.get(original)?.[emitted] ?? original;
        const name =
          block.tool_name != null && block.tool_name !== "" ? block.tool_name : "unknown_tool";
        records.push({
          role: "assistant",
          content: null,
          tool_calls: [{ id: assigned, name, args: trajectoryArgs(block.tool_input, report) }],
          timestamp: timestamp(),
        });
        assistantCount += 1;
      } else if (block.block_type === "tool_result") {
        const original = block.tool_use_id;
        const queue = original == null ? undefined : assignedByOriginal.get(original);
        if (original == null || queue == null) {
          report.orphan_tool_results_dropped += 1;
          continue;
        }
        const taken = resultTaken.get(original) ?? 0;
        // Pair with the call this result answers by position, reading back the
        // name pass 1 assigned it. Queues are never empty, so the index holds.
        const assigned = queue[Math.min(taken, queue.length - 1)] ?? original;
        if (answered.has(assigned) && taken >= queue.length) {
          report.duplicate_tool_results_dropped += 1;
          continue;
        }
        resultTaken.set(original, taken + 1);
        answered.add(assigned);
        const { text: content, truncated } = trajectoryTruncate(
          block.tool_result ?? "",
          TRAJECTORY_RESULT_MAX,
        );
        if (truncated) {
          report.tool_results_truncated += 1;
        }
        records.push({ role: "tool", tool_call_id: assigned, content, timestamp: timestamp() });
      } else {
        // Empty text/thinking land here too: no wire content, so they are
        // dropped and counted under their own block type.
        drop(block.block_type);
      }
    }
  }

  if (userCount === 0) {
    return { ok: false, reason: "missing_user_records" };
  }
  if (assistantCount === 0) {
    return { ok: false, reason: "missing_assistant_records" };
  }

  const meta: Record<string, string> = {
    role: "meta",
    source: TRAJECTORY_SOURCES[detail.summary.tool] ?? detail.summary.tool,
  };
  if (row?.cwd != null && row.cwd !== "") {
    meta.cwd = row.cwd;
  }
  if (row?.git_branch != null && row.git_branch !== "") {
    meta.git_branch = row.git_branch;
  }
  if (detail.summary.model != null && detail.summary.model !== "") {
    meta.model = detail.summary.model;
  }
  return { ok: true, records: [meta, ...records], report };
}
