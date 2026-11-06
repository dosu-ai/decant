import type { DimensionRow, Summary } from "./types.ts";

/**
 * Share of prompt-side tokens served from the provider's cache:
 * cache reads / (uncached input + cache reads + cache writes). Null when the
 * scope recorded no prompt tokens at all.
 */
export function cacheHitRate(
  summary: Pick<Summary, "input_tokens" | "cache_read_tokens" | "cache_creation_tokens">,
): number | null {
  const prompt = summary.input_tokens + summary.cache_read_tokens + summary.cache_creation_tokens;
  return prompt > 0 ? summary.cache_read_tokens / prompt : null;
}

const DAY_MS = 86_400_000;

/** The range of the same length ending the day before `from`, for comparing a
 * bounded date range with the period just before it. Open ranges have none. */
export function previousRange(
  from: string | null | undefined,
  to: string | null | undefined,
): { from: string; to: string; days: number } | null {
  const start = parseDay(from);
  const end = parseDay(to);
  if (start == null || end == null || end < start) {
    return null;
  }
  const days = Math.round((end - start) / DAY_MS) + 1;
  return {
    from: formatDay(start - days * DAY_MS),
    to: formatDay(start - DAY_MS),
    days,
  };
}

export function previousPeriodLabel(days: number): string {
  return days === 1 ? "previous day" : `previous ${days} days`;
}

/** "+12% vs previous 30 days". Null when there is nothing to compare with. */
export function percentDelta(
  current: number,
  previous: number | null | undefined,
  days: number,
): string | null {
  if (previous == null || !Number.isFinite(previous) || previous <= 0) {
    return null;
  }
  const change = Math.round(((current - previous) / previous) * 100);
  const label = previousPeriodLabel(days);
  if (change === 0) {
    return `Flat vs ${label}`;
  }
  return `${change > 0 ? "+" : "−"}${Math.abs(change)}% vs ${label}`;
}

/** "+3 pts" for the change in a rate given as a 0..1 fraction; "flat" when it
 * rounds to zero. The caller names the comparison period. */
export function pointDelta(
  current: number | null,
  previous: number | null | undefined,
): string | null {
  if (current == null || previous == null) {
    return null;
  }
  const change = Math.round((current - previous) * 100);
  if (change === 0) {
    return "flat";
  }
  return `${change > 0 ? "+" : "−"}${Math.abs(change)} ${Math.abs(change) === 1 ? "pt" : "pts"}`;
}

/** The cache tile's detail: the hit rate, with its change when there is one. */
export function cacheDetail(hitRate: number | null, previousHitRate: number | null): string | null {
  if (hitRate == null) {
    return null;
  }
  const rate = `${Math.round(hitRate * 100)}% hit rate`;
  const change = pointDelta(hitRate, previousHitRate);
  return change == null ? rate : `${rate} (${change})`;
}

export const OUTCOME_ORDER = ["completed", "abandoned", "failed", "(unclassified)"] as const;

export function outcomeLabel(key: string): string {
  switch (key) {
    case "completed":
      return "Completed";
    case "abandoned":
      return "Abandoned";
    case "failed":
      return "Failed";
    case "(unclassified)":
      return "Unclassified";
    default:
      return key;
  }
}

export function outcomeDescription(key: string): string {
  switch (key) {
    case "completed":
      return "The transcript ended on an assistant reply.";
    case "abandoned":
      return "Interrupted, or ended on an unanswered prompt or between tool calls.";
    case "failed":
      return "Ended on a tool error.";
    case "(unclassified)":
      return "No main transcript to classify.";
    default:
      return "";
  }
}

/** Outcome rows in a fixed order, so the table does not reshuffle by count. */
export function orderedOutcomes(rows: readonly DimensionRow[]): DimensionRow[] {
  const rank = (key: string) => {
    const index = (OUTCOME_ORDER as readonly string[]).indexOf(key);
    return index === -1 ? OUTCOME_ORDER.length : index;
  };
  return [...rows].sort((left, right) => rank(left.key) - rank(right.key));
}

/**
 * All estimated cost in scope (abandoned and failed sessions included) divided
 * by the top-level sessions labelled completed. Null with no completions.
 */
export function costPerCompletedSession(
  totalCost: number,
  outcomes: readonly DimensionRow[],
): number | null {
  const completed = outcomes.find((row) => row.key === "completed")?.sessions ?? 0;
  return completed > 0 ? totalCost / completed : null;
}

function parseDay(value: string | null | undefined): number | null {
  if (value == null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(time) || formatDay(time) !== value ? null : time;
}

function formatDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
