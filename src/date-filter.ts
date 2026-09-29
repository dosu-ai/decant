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

export function sessionDatePredicate(alias: string, filter?: DateFilter | null): SqlFragment {
  return dayRangePredicate(`${alias}.started_at`, isoDate(filter?.from), isoDate(filter?.to));
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
