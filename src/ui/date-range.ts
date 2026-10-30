import type { DateBounds, DateRangeSelection } from "./types.ts";

export const RANGE_PRESETS = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
] as const;

export const ALL_DATE_RANGE: DateRangeSelection = { preset: "all", from: null, to: null };

// `from` and `to` are UTC calendar dates, so labels format them in UTC too.
// A local-time formatter would show the previous day west of UTC.
export const dateLabelFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

export const REVERSED_RANGE_MESSAGE = "From must be on or before To";

// Chrome reports a year typed one digit at a time as `0002`, `0020`, `0202`, so
// a date before this year is treated as still being typed, not as a bound.
const EARLIEST_PLAUSIBLE_YEAR = 1970;

export type CustomRangeCheck =
  | { status: "valid"; range: DateRangeSelection }
  | { status: "incomplete"; field: "from" | "to" }
  | { status: "reversed" };

/**
 * Decides whether the custom From and To inputs form a range worth applying.
 * `""` is a cleared, open-ended bound; `null` is a partly typed date the
 * browser reports as bad input.
 */
export function checkCustomRange(from: string | null, to: string | null): CustomRangeCheck {
  const start = plausibleBound(from);
  if (start === undefined) {
    return { status: "incomplete", field: "from" };
  }
  const end = plausibleBound(to);
  if (end === undefined) {
    return { status: "incomplete", field: "to" };
  }
  if (start != null && end != null && start > end) {
    return { status: "reversed" };
  }
  return { status: "valid", range: { preset: "custom", from: start, to: end } };
}

function plausibleBound(value: string | null): string | null | undefined {
  if (value === "") {
    return null;
  }
  const date = value == null ? null : parseIsoDate(value);
  return date != null && date.getUTCFullYear() >= EARLIEST_PLAUSIBLE_YEAR ? value : undefined;
}

export function applyDatePreset(
  key: (typeof RANGE_PRESETS)[number]["key"],
  bounds: DateBounds | null,
  now = Date.now(),
): DateRangeSelection {
  const preset = RANGE_PRESETS.find((item) => item.key === key);
  // Lookbacks end at the newest archived session so a stale archive still shows
  // data. Today means the current date even when nothing has synced yet.
  const to = key === "today" ? todayIsoDate(now) : (validIsoDate(bounds?.max) ?? todayIsoDate(now));
  if (preset == null) {
    return ALL_DATE_RANGE;
  }
  return {
    preset: key,
    from: addDays(to, -(preset.days - 1)),
    to,
  };
}

export function dateRangeQuery(range: DateRangeSelection): string {
  const params = new URLSearchParams();
  if (range.from != null) {
    params.set("from", range.from);
  }
  if (range.to != null) {
    params.set("to", range.to);
  }
  return params.toString();
}

export function withDateQuery(path: string, dateQuery: string): string {
  if (dateQuery === "") {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}${dateQuery}`;
}

export function dateRangeLabel(range: DateRangeSelection): string {
  if (range.from == null && range.to == null) {
    return "All time";
  }
  if (range.from == null) {
    return `Through ${formatDateLabel(range.to ?? "")}`;
  }
  if (range.to == null) {
    return `From ${formatDateLabel(range.from)}`;
  }
  return range.from === range.to
    ? formatDateLabel(range.from)
    : `${formatDateLabel(range.from)} to ${formatDateLabel(range.to)}`;
}

export function dateRangePresetLabel(range: DateRangeSelection): string {
  if (range.preset === "all") {
    return "All time";
  }
  if (range.preset === "custom") {
    return "Custom range";
  }
  return RANGE_PRESETS.find((preset) => preset.key === range.preset)?.label ?? "All time";
}

// The page heading wraps the range trigger to the left edge on narrower layouts,
// where a right-anchored popover would open off-screen.
export function datePopoverAlign(triggerRight: number, popoverWidth: number): "start" | "end" {
  return triggerRight - popoverWidth >= 0 ? "end" : "start";
}

export function addDays(isoDate: string, days: number): string {
  const date = parseIsoDate(isoDate) ?? new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function todayIsoDate(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Moves a Today selection onto the current UTC date, keeping any other range as is. */
export function refreshTodayRange(range: DateRangeSelection, now = Date.now()): DateRangeSelection {
  if (range.preset !== "today") {
    return range;
  }
  const today = todayIsoDate(now);
  // Returning the same object lets React skip the update when the day is unchanged.
  return range.from === today && range.to === today ? range : applyDatePreset("today", null, now);
}

export function msUntilNextUtcDay(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.getTime() - now;
}

export interface WallClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const browserWallClock: WallClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Calls `onRollover` at each UTC midnight until the returned function stops it.
 * One timer is pending at a time; each run re-arms from the clock, so a timer
 * that fires early lands on a no-op refresh and re-arms for the real boundary.
 */
export function scheduleUtcDayRollover(
  onRollover: () => void,
  clock: WallClock = browserWallClock,
): () => void {
  let timer: unknown = null;
  const arm = () => {
    timer = clock.setTimer(() => {
      onRollover();
      arm();
    }, msUntilNextUtcDay(clock.now()));
  };
  arm();
  return () => clock.clearTimer(timer);
}

export function validIsoDate(value: string | null | undefined): string | null {
  if (value == null || parseIsoDate(value) == null) {
    return null;
  }
  return value;
}

export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function formatDateLabel(value: string): string {
  const date = parseIsoDate(value);
  if (date == null) {
    return value;
  }
  return dateLabelFormatter.format(date);
}
