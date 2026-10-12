// Token mapping shared by the OpenCode readers. OpenCode's tokens object is
// {input, output, reasoning, cache:{read, write}, total?}. `input` never
// includes cached tokens. Whether `output` includes `reasoning` depends on the
// release that wrote the row: up to 1.3.15 it did for most providers (and
// OpenCode then charged reasoning a second time); from 1.3.16 on, and in 2.x,
// it does not. The recorded `total` decides when present (anomalyco/opencode
// getUsage, in packages/opencode/src/session/index.ts and, from 1.18,
// packages/opencode/src/session/session.ts).
import { asString, isObject, type JsonObject } from "../json.ts";
import { emptyUsage, type Json, type TokenUsage } from "../model.ts";
import type { OpenCodeLegacyMessageRow, OpenCodeLegacyPartRow } from "./opencode-legacy.ts";

export type ReasoningOverlap = "disjoint" | "included";

type Version = readonly [number, number, number];

const DISJOINT_SINCE: Version = [1, 3, 16];

/** Preview builds record `0.0.0-<channel>-<YYYYMMDDHHmm>` (UTC build time)
 * instead of a release number (packages/script/src/index.ts). */
const PREVIEW_VERSION = /^0\.0\.0-.+-(\d{12})$/;

/** When 1.3.16 was tagged (2026-04-06T03:44Z), in the preview stamp's format. */
const DISJOINT_SINCE_BUILD = "202604060344";

export function parseOpenCodeVersion(version: string | null): [number, number, number] | null {
  const match = version == null ? null : /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match == null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function count(value: Json | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** The provider's `total`, when recorded, decides; otherwise the release that
 * created the session does, or a preview build's date. A real 0.x release
 * predates 1.3.16; an unparseable version is treated as current. */
export function reasoningOverlap(tokens: JsonObject, version: string | null): ReasoningOverlap {
  const reasoning = count(tokens.reasoning);
  if (reasoning === 0) {
    return "disjoint";
  }
  const cache = isObject(tokens.cache) ? tokens.cache : {};
  const base = count(tokens.input) + count(tokens.output) + count(cache.read) + count(cache.write);
  const total = tokens.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    if (base + reasoning === total) {
      return "disjoint";
    }
    if (base === total) {
      return "included";
    }
  }
  const preview = version == null ? null : PREVIEW_VERSION.exec(version);
  if (preview?.[1] != null) {
    // Same-length digit strings compare in time order.
    return preview[1] < DISJOINT_SINCE_BUILD ? "included" : "disjoint";
  }
  const parsed = parseOpenCodeVersion(version);
  if (parsed == null) {
    return "disjoint";
  }
  return compareVersions(parsed, DISJOINT_SINCE) < 0 ? "included" : "disjoint";
}

/** Decant counts reasoning inside `output`. When the row already did, only
 * the reasoning that fits inside `output` is credible as reasoning. */
export function openCodeUsage(
  tokens: Json | undefined,
  overlap: ReasoningOverlap,
): TokenUsage | null {
  if (!isObject(tokens)) {
    return null;
  }
  const cache = isObject(tokens.cache) ? tokens.cache : {};
  const output = count(tokens.output);
  const reported = count(tokens.reasoning);
  const reasoning = overlap === "included" ? Math.min(reported, output) : reported;
  return {
    input: count(tokens.input),
    output: overlap === "included" ? output : output + reasoning,
    cacheRead: count(cache.read),
    cacheCreation: count(cache.write),
    cacheCreation1h: 0,
    reasoning,
  };
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    cacheCreation1h: a.cacheCreation1h + b.cacheCreation1h,
    reasoning: a.reasoning + b.reasoning,
  };
}

function mapped(tokens: JsonObject, version: string | null): TokenUsage {
  return openCodeUsage(tokens, reasoningOverlap(tokens, version)) ?? emptyUsage();
}

/** 1.x overwrites `info.tokens` with the last step's usage while summing
 * `info.cost`, so a message's usage is the sum of its step-finish parts. A
 * message with none uses `info.tokens`, unless nothing was recorded. */
export function legacyAssistantUsage(
  info: JsonObject,
  parts: readonly Json[],
  version: string | null,
): TokenUsage | null {
  let sum: TokenUsage | null = null;
  for (const part of parts) {
    if (isObject(part) && part.type === "step-finish" && isObject(part.tokens)) {
      const usage = mapped(part.tokens, version);
      sum = sum == null ? usage : addTokenUsage(sum, usage);
    }
  }
  if (sum != null) {
    return sum;
  }
  if (!isObject(info.tokens)) {
    return null;
  }
  const usage = mapped(info.tokens, version);
  const recorded = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
  const cost = typeof info.cost === "number" ? info.cost : 0;
  return recorded > 0 || cost > 0 ? usage : null;
}

/** What the 1.x tables record for one row the 2.x migrator copied. */
export interface LegacyRowUsage {
  usage: TokenUsage | null;
  modelId: string | null;
  /** The message's recorded `info.cost`, which sums its steps. */
  cost: number | null;
}

/** Per-row usage of a session OpenCode 2.x migrated, read from its 1.x copy
 * (anomalyco/opencode v2.0.27 packages/core/src/database/v1-migration.bun.ts).
 * The migrator keeps message ids, copies only `info.tokens` (the last step),
 * and folds a compaction request plus its `summary` assistant into one
 * compaction row that has the request's id and no usage. */
export interface MigratedUsage {
  /** By assistant message id, which is also the 2.x row id. */
  assistants: ReadonlyMap<string, LegacyRowUsage>;
  /** By compaction request id: the summary assistant that answered it. */
  compactions: ReadonlyMap<string, LegacyRowUsage>;
}

/** Builds `MigratedUsage` from the 1.x message rows (in OpenCode's order) and
 * their parts; only step-finish parts matter. Rows that do not parse are
 * left out, so their 2.x copies keep their own tokens. */
export function migratedUsage(
  version: string | null,
  messages: readonly Pick<OpenCodeLegacyMessageRow, "id" | "data">[],
  parts: readonly Pick<OpenCodeLegacyPartRow, "message_id" | "data">[],
): MigratedUsage {
  const partsByMessage = new Map<string, Json[]>();
  for (const part of parts) {
    const data = parseObject(part.data);
    if (data != null) {
      const list = partsByMessage.get(part.message_id) ?? [];
      list.push(data);
      partsByMessage.set(part.message_id, list);
    }
  }
  const assistants = new Map<string, LegacyRowUsage>();
  const compactions = new Map<string, LegacyRowUsage>();
  for (const message of messages) {
    const info = parseObject(message.data);
    if (info == null || info.role !== "assistant") {
      continue;
    }
    const entry: LegacyRowUsage = {
      usage: legacyAssistantUsage(info, partsByMessage.get(message.id) ?? [], version),
      modelId: asString(info.modelID),
      cost: typeof info.cost === "number" && Number.isFinite(info.cost) ? info.cost : null,
    };
    assistants.set(message.id, entry);
    const parentId = asString(info.parentID);
    // The migrator pairs a request with the first summary that answers it.
    if (info.summary === true && parentId != null && !compactions.has(parentId)) {
      compactions.set(parentId, entry);
    }
  }
  return { assistants, compactions };
}

function parseObject(text: string): JsonObject | null {
  try {
    const value = JSON.parse(text) as Json;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}
