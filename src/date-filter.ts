export interface DateFilter {
  from?: string | null;
  to?: string | null;
}

export interface SqlFragment {
  sql: string;
  params: string[];
}

export function dateFilterFromSearch(searchParams: URLSearchParams): DateFilter {
  return {
    from: isoDate(searchParams.get("from")),
    to: isoDate(searchParams.get("to")),
  };
}

// U+10FFFF sorts after every character that can follow a date, so
// `column < date || DAY_END` keeps the whole day without date arithmetic.
export const DAY_END = "\u{10FFFF}";

/**
 * Bounds on the YYYY-MM-DD prefix of an ISO timestamp column, written as plain
 * comparisons so the column's index can serve them. Dates must be valid
 * YYYY-MM-DD strings.
 */
export function dayRangePredicate(
  column: string,
  from: string | null | undefined,
  to: string | null | undefined,
): SqlFragment {
  const clauses: string[] = [];
  const params: string[] = [];
  if (from != null) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (to != null) {
    clauses.push(`${column} < ?`);
    params.push(`${to}${DAY_END}`);
  }
  return { sql: clauses.join(" AND "), params };
}

/**
 * Bounds on the UTC day of an ISO timestamp column, so a value stored with an
 * offset counts on its UTC day. A value SQLite cannot read falls back to its
 * YYYY-MM-DD prefix. Dates must be valid YYYY-MM-DD strings.
 */
export function utcDayRangePredicate(
  column: string,
  from: string | null | undefined,
  to: string | null | undefined,
): SqlFragment {
  // An offset moves the UTC day at most one day from the prefix, so a prefix
  // range one day wider can use the column's index before the exact check.
  const day = `COALESCE(strftime('%Y-%m-%d', ${utcReadable(column)}), substr(${column}, 1, 10))`;
  const clauses: string[] = [];
  const params: string[] = [];
  // Past year 9999 (or before year 0) toISOString writes a signed six-digit
  // year, which sorts before every stored timestamp, so that bound is dropped.
  const before = from == null ? null : shiftDay(from, -1);
  const after = to == null ? null : shiftDay(to, 1);
  if (from != null) {
    if (before != null && FOUR_DIGIT_DAY.test(before)) {
      clauses.push(`${column} >= ?`);
      params.push(before);
    }
    clauses.push(`${day} >= ?`);
    params.push(from);
  }
  if (to != null) {
    if (after != null && FOUR_DIGIT_DAY.test(after)) {
      clauses.push(`${column} < ?`);
      params.push(`${after}${DAY_END}`);
    }
    clauses.push(`${day} <= ?`);
    params.push(to);
  }
  return { sql: clauses.join(" AND "), params };
}

/** `utcDays` compares UTC days; without it the stored prefix decides, which
 * is the documented analytics rule its per-day buckets share. */
export function sessionDatePredicate(
  alias: string,
  filter?: (DateFilter & { utcDays?: boolean }) | null,
): SqlFragment {
  const range = filter?.utcDays === true ? utcDayRangePredicate : dayRangePredicate;
  return range(`${alias}.started_at`, isoDate(filter?.from), isoDate(filter?.to));
}

// SQLite reads +05:30 but not +0530, which Claude records may carry.
function utcReadable(column: string): string {
  return `CASE WHEN ${column} GLOB '*T*[+-][0-9][0-9][0-9][0-9]'
    THEN substr(${column}, 1, length(${column}) - 2) || ':' || substr(${column}, -2)
    ELSE ${column} END`;
}

const FOUR_DIGIT_DAY = /^\d{4}-\d{2}-\d{2}$/;

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function whereClause(fragment: SqlFragment): string {
  return fragment.sql === "" ? "" : `WHERE ${fragment.sql}`;
}

function isoDate(value: string | null | undefined): string | null {
  if (value == null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}
