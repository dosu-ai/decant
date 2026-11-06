/**
 * Continuous daily (or weekly) series for the "per day" charts.
 *
 * `/api/stats/by-dimension?dim=day` returns only days that had sessions.
 * Plotted as-is on a category axis, a month with no sessions shrinks to
 * nothing and two bars months apart sit side by side. The series here covers
 * every UTC day from the start of the range to its end.
 *
 * A day with no sessions has a real zero. A day whose sessions all lack usage
 * data (Cursor CLI) has an unknown cost, so its cost is null and charts leave
 * a gap there.
 */

export interface DayRow {
  key: string;
  sessions: number;
  usage_sessions: number;
  estimated_cost_usd: number;
}

export type SeriesGranularity = "day" | "week";

export interface SeriesPoint {
  /** First UTC day the point covers (YYYY-MM-DD). */
  key: string;
  sessions: number;
  /** Estimated cost; null when every session in the point lacks usage data. */
  cost: number | null;
}

export interface DaySeries {
  granularity: SeriesGranularity;
  points: SeriesPoint[];
  /** Top-level sessions left out of the cost because they lack usage data. */
  missingUsage: number;
  /** Days in the input that had data. Zero means every point is padding, so a
   * chart should say "no data" rather than draw a flat line. */
  observedDays: number;
}

/** Past this many days one bar per day is too thin to read, so points become
 * weeks. Ninety days, the longest preset, still draws daily. */
export const WEEKLY_AFTER_DAYS = 92;

/** A range longer than this (about thirty years) is treated as malformed. */
const MAX_SPAN_DAYS = 11_000;

const DAY_MS = 86_400_000;

export function buildDaySeries(
  rows: readonly DayRow[],
  range: { from?: string | null; to?: string | null } = {},
): DaySeries {
  const byDay = new Map<string, DayRow>();
  let missingUsage = 0;
  for (const row of rows) {
    if (parseDay(row.key) == null) {
      continue;
    }
    byDay.set(row.key, row);
    missingUsage += Math.max(0, row.sessions - row.usage_sessions);
  }
  const keys = [...byDay.keys()].sort();
  const startKey = validDay(range.from) ?? keys[0];
  const endKey = validDay(range.to) ?? keys.at(-1);
  const start = startKey == null ? null : parseDay(startKey);
  const end = endKey == null ? null : parseDay(endKey);
  if (start == null || end == null || end < start) {
    return { granularity: "day", points: [], missingUsage, observedDays: byDay.size };
  }
  const span = Math.round((end - start) / DAY_MS) + 1;
  if (span > MAX_SPAN_DAYS) {
    return { granularity: "day", points: [], missingUsage, observedDays: byDay.size };
  }
  const days: SeriesPoint[] = [];
  for (let index = 0; index < span; index += 1) {
    const key = formatDay(start + index * DAY_MS);
    const row = byDay.get(key);
    days.push({ key, sessions: row?.sessions ?? 0, cost: dayCost(row) });
  }
  if (span <= WEEKLY_AFTER_DAYS) {
    return { granularity: "day", points: days, missingUsage, observedDays: byDay.size };
  }
  return {
    granularity: "week",
    points: groupWeeks(days, byDay),
    missingUsage,
    observedDays: byDay.size,
  };
}

/** The Monday (UTC) that starts the ISO week holding `key`. */
export function weekStart(key: string): string {
  const time = parseDay(key);
  if (time == null) {
    return key;
  }
  const weekday = (new Date(time).getUTCDay() + 6) % 7;
  return formatDay(time - weekday * DAY_MS);
}

/** Fill a per-day value array (aligned to `days`) across the same range a
 * DaySeries covers, then sum it into the series' points. */
export function alignToSeries(
  series: DaySeries,
  days: readonly string[],
  values: readonly number[],
): number[] {
  const byDay = new Map<string, number>();
  for (const [index, day] of days.entries()) {
    byDay.set(day, values[index] ?? 0);
  }
  if (series.granularity === "day") {
    return series.points.map((point) => byDay.get(point.key) ?? 0);
  }
  const byWeek = new Map<string, number>();
  for (const [day, value] of byDay) {
    const week = weekStart(day);
    byWeek.set(week, (byWeek.get(week) ?? 0) + value);
  }
  return series.points.map((point) => byWeek.get(point.key) ?? 0);
}

/**
 * Points a line chart cannot draw: a known value with no known neighbour has
 * no segment to sit on once gaps are left unconnected, so it needs a marker.
 * A one-point series is the simplest case.
 */
export function isolatedPoints(values: readonly (number | null)[]): boolean[] {
  return values.map(
    (value, index) => value != null && values[index - 1] == null && values[index + 1] == null,
  );
}

function dayCost(row: DayRow | undefined): number | null {
  if (row == null) {
    return 0;
  }
  // Rows count top-level sessions only; a day holding just subagent runs has
  // sessions === 0 and a real cost.
  return row.sessions === 0 || row.usage_sessions > 0 ? row.estimated_cost_usd : null;
}

/**
 * A week sums the known cost of its days that had sessions. It is unknown when
 * it had sessions and none of them recorded usage: the idle days around them
 * must not turn that unknown into $0. A week with no sessions at all is a
 * real zero.
 */
function groupWeeks(
  days: readonly SeriesPoint[],
  observed: ReadonlyMap<string, DayRow>,
): SeriesPoint[] {
  const weeks: { point: SeriesPoint; observed: boolean; known: boolean }[] = [];
  for (const day of days) {
    const key = weekStart(day.key);
    let week = weeks.at(-1);
    if (week?.point.key !== key) {
      week = { point: { key, sessions: 0, cost: 0 }, observed: false, known: false };
      weeks.push(week);
    }
    week.point.sessions += day.sessions;
    if (observed.has(day.key)) {
      week.observed = true;
      if (day.cost != null) {
        week.known = true;
        week.point.cost = (week.point.cost ?? 0) + day.cost;
      }
    }
  }
  return weeks.map(({ point, observed: hadSessions, known }) =>
    hadSessions && !known ? { ...point, cost: null } : point,
  );
}

function validDay(value: string | null | undefined): string | null {
  return value != null && parseDay(value) != null ? value : null;
}

function parseDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(time) || formatDay(time) !== value ? null : time;
}

function formatDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
