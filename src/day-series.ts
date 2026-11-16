export interface DayRow {
  key: string;
  sessions: number;
  usage_sessions: number;
  estimated_cost_usd: number;
}

export type SeriesGranularity = "day" | "week";

export interface SeriesPoint {
  key: string;
  sessions: number;
  cost: number | null;
}

export interface DaySeries {
  granularity: SeriesGranularity;
  points: SeriesPoint[];
  missingUsage: number;
  observedDays: number;
}

export const WEEKLY_AFTER_DAYS = 92;

const MAX_SPAN_DAYS = 11_000;

const DAY_MS = 86_400_000;

export function buildDaySeries(
  rows: readonly DayRow[],
  range: { from?: string | null; to?: string | null } = {},
): DaySeries {
  const byDay = new Map<string, DayRow>();
  for (const row of rows) {
    if (parseDay(row.key) != null) {
      byDay.set(row.key, row);
    }
  }
  const keys = [...byDay.keys()].sort();
  const startKey = validDay(range.from) ?? keys[0];
  const endKey = validDay(range.to) ?? keys.at(-1);
  const start = startKey == null ? null : parseDay(startKey);
  const end = endKey == null ? null : parseDay(endKey);
  const span = start == null || end == null ? 0 : Math.round((end - start) / DAY_MS) + 1;
  if (start == null || span < 1 || span > MAX_SPAN_DAYS) {
    return { granularity: "day", points: [], missingUsage: 0, observedDays: 0 };
  }
  let missingUsage = 0;
  let observedDays = 0;
  const days: SeriesPoint[] = [];
  for (let index = 0; index < span; index += 1) {
    const key = formatDay(start + index * DAY_MS);
    const row = byDay.get(key);
    if (row != null) {
      observedDays += 1;
      missingUsage += Math.max(0, row.sessions - row.usage_sessions);
    }
    days.push({ key, sessions: row?.sessions ?? 0, cost: dayCost(row) });
  }
  if (span <= WEEKLY_AFTER_DAYS) {
    return { granularity: "day", points: days, missingUsage, observedDays };
  }
  return {
    granularity: "week",
    points: groupWeeks(days, byDay),
    missingUsage,
    observedDays,
  };
}

export function weekStart(key: string): string {
  const time = parseDay(key);
  if (time == null) {
    return key;
  }
  const weekday = (new Date(time).getUTCDay() + 6) % 7;
  return formatDay(time - weekday * DAY_MS);
}

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

export function isolatedPoints(values: readonly (number | null)[]): boolean[] {
  return values.map(
    (value, index) => value != null && values[index - 1] == null && values[index + 1] == null,
  );
}

function dayCost(row: DayRow | undefined): number | null {
  if (row == null) {
    return 0;
  }
  return row.sessions === 0 || row.usage_sessions > 0 ? row.estimated_cost_usd : null;
}

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
