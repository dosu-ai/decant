// Token mapping shared by the OpenCode readers. OpenCode's tokens object is
// {input, output, reasoning, cache:{read, write}, total?}. `input` never
// includes cached tokens. Whether `output` includes `reasoning` depends on the
// release that wrote the row: up to 1.3.15 it did (and OpenCode then charged
// reasoning a second time); from 1.3.16 on, and in 2.x, it does not
// (anomalyco/opencode packages/opencode/src/session/index.ts getUsage).
import { isObject, type JsonObject } from "../json.ts";
import { emptyUsage, type Json, type TokenUsage } from "../model.ts";

export type ReasoningOverlap = "disjoint" | "included";

type Version = readonly [number, number, number];

const DISJOINT_SINCE: Version = [1, 3, 16];

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
 * created the session does. An unparseable version is treated as current. */
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
