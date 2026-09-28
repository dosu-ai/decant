import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dayRangePredicate, sessionDatePredicate } from "../src/date-filter.ts";
import { openDb } from "../src/db.ts";

const TIMESTAMPS = [
  "2024-02-28T23:59:59.999Z",
  "2024-02-29T00:00:00.000Z",
  "2024-02-29T23:59:59.999Z",
  "2024-03-01T00:00:00.000Z",
  "2024-12-31T23:59:59.999Z",
  "2025-01-01T00:00:00.000Z",
  "2025-01-01",
  "2025-01-01T00:00:00",
  "2025-01-01T00:00:00+05:30",
  "2025-01-01 10:00:00",
  "2025-01-31T12:00:00Z",
  "2025-02-01T12:00:00Z",
  "2025-01-3",
  "2025-01",
  "9999-12-31T23:59:59Z",
  "2026-07-10T16:48:51.803Z",
  "",
  null,
];

const BOUNDS = [
  "2024-02-28",
  "2024-02-29",
  "2024-03-01",
  "2024-12-31",
  "2025-01-01",
  "2025-01-31",
  "2025-02-01",
  "9999-12-31",
  "0001-01-01",
];

function matching(db: Database, where: string, params: string[]): (string | null)[] {
  return (
    db.query(`SELECT started_at FROM t WHERE ${where} ORDER BY rowid`).all(...params) as {
      started_at: string | null;
    }[]
  ).map((row) => row.started_at);
}

describe("date filter", () => {
  test("keeps the same rows as comparing the first ten characters", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(started_at TEXT)");
    for (const value of TIMESTAMPS) {
      db.query("INSERT INTO t(started_at) VALUES (?)").run(value);
    }

    for (const from of BOUNDS) {
      const range = dayRangePredicate("started_at", from, null);
      expect(matching(db, range.sql, range.params)).toEqual(
        matching(db, "substr(started_at, 1, 10) >= ?", [from]),
      );
    }
    for (const to of BOUNDS) {
      const range = dayRangePredicate("started_at", null, to);
      expect(matching(db, range.sql, range.params)).toEqual(
        matching(db, "substr(started_at, 1, 10) <= ?", [to]),
      );
    }
    for (const from of BOUNDS) {
      for (const to of BOUNDS) {
        const range = dayRangePredicate("started_at", from, to);
        expect(matching(db, range.sql, range.params)).toEqual(
          matching(db, "substr(started_at, 1, 10) >= ? AND substr(started_at, 1, 10) <= ?", [
            from,
            to,
          ]),
        );
      }
    }
    db.close();
  });

  test("includes a timestamp at midnight and at the last millisecond of the end day", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(started_at TEXT)");
    for (const value of ["2024-02-29T00:00:00.000Z", "2024-02-29T23:59:59.999Z"]) {
      db.query("INSERT INTO t(started_at) VALUES (?)").run(value);
    }
    const range = dayRangePredicate("started_at", "2024-02-29", "2024-02-29");
    expect(matching(db, range.sql, range.params)).toHaveLength(2);
    const before = dayRangePredicate("started_at", null, "2024-02-28");
    expect(matching(db, before.sql, before.params)).toHaveLength(0);
    db.close();
  });

  test("ignores invalid dates and emits no clause for an empty filter", () => {
    expect(sessionDatePredicate("s", null)).toEqual({ sql: "", params: [] });
    expect(sessionDatePredicate("s", { from: "2025-02-30", to: "nope" })).toEqual({
      sql: "",
      params: [],
    });
    const bounded = sessionDatePredicate("s", { from: "2025-01-01", to: "2025-01-31" });
    expect(bounded.sql).toBe("s.started_at >= ? AND s.started_at < ?");
    expect(bounded.params[0]).toBe("2025-01-01");
    expect(bounded.params[1]?.startsWith("2025-01-31")).toBe(true);
  });

  test("lets the session start index serve a date filter", () => {
    const db = openDb(":memory:");
    const date = sessionDatePredicate("s", { from: "2026-01-01", to: "2026-02-01" });
    const plan = (
      db
        .query(`EXPLAIN QUERY PLAN SELECT s.id FROM session s WHERE ${date.sql}`)
        .all(...date.params) as { detail: string }[]
    )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_session_started");
    db.close();
  });
});
