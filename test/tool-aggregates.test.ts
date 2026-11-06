import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { closeDb, openDb } from "../src/db.ts";
import { listToolCalls } from "../src/query.ts";
import {
  durationRankSql,
  mcpUsage,
  NEAREST_RANK_PERCENTILES_SQL,
  nearestRankPercentiles,
  toolUsage,
} from "../src/stats.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-tool-aggregates-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshPath(): string {
  dbCounter += 1;
  return join(workDir, `tool-aggregates-${dbCounter}.db`);
}

const TOOLS: [string | null, string | null, string | null][] = [
  ["Bash", "builtin", null],
  ["Read", "builtin", null],
  ["mcp__demo__read", "mcp", "demo"],
  ["same", "builtin", null],
  ["same", "builtin", ""],
  [null, null, "legacy-server"],
  ["", "", "legacy-server"],
  ["NoDurations", "builtin", null],
];

/** Deterministic calls with repeated durations, nulls, and every tool shape. */
function seed(db: Database): void {
  db.exec(`
    INSERT INTO project(id, path) VALUES (1, '/p');
    INSERT INTO session(id, tool, source_session_id, project_id, model, started_at)
    VALUES
      (1, 'codex', 's1', 1, 'gpt-5', '2026-05-01T09:00:00.000Z'),
      (2, 'codex', 's2', 1, 'gpt-5', '2026-05-03T09:00:00.000Z'),
      (3, 'codex', 's3', 1, 'gpt-5', '2026-05-05T09:00:00.000Z');
  `);
  const insert = db.prepare(
    `INSERT INTO tool_call(
       session_id, tool_kind, tool_name, mcp_server, is_error, duration_ms, timestamp, ordinal
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let state = 7;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  for (let ordinal = 0; ordinal < 400; ordinal += 1) {
    const tool = TOOLS[ordinal % TOOLS.length];
    if (tool == null) {
      throw new Error("tool fixture index out of range");
    }
    const [name, kind, server] = tool;
    const roll = next();
    const duration =
      name === "NoDurations" || roll % 9 === 0 ? null : roll % 4 === 0 ? 250 : roll % 5000;
    insert.run(
      (ordinal % 3) + 1,
      kind,
      name,
      server,
      roll % 7 === 0 ? 1 : roll % 11 === 0 ? null : 0,
      duration,
      `2026-05-0${(ordinal % 5) + 1}T10:${String(ordinal % 60).padStart(2, "0")}:00.000Z`,
      ordinal,
    );
  }
}

interface Percentiles {
  p50_ms: number | null;
  p95_ms: number | null;
}

/** The window-function definition the routes used before the in-memory sort. */
function windowPercentiles(db: Database, where: string, params: string[]): Percentiles {
  return db
    .query(
      `WITH ranked AS (
         SELECT duration_ms, ${durationRankSql()}
         FROM tool_call t JOIN session s ON s.id = t.session_id
         WHERE t.duration_ms IS NOT NULL AND ${where}
       )
       SELECT ${NEAREST_RANK_PERCENTILES_SQL} FROM ranked`,
    )
    .get(...params) as Percentiles;
}

describe("tool aggregates", () => {
  test("nearestRankPercentiles uses nearest ranks", () => {
    expect(nearestRankPercentiles([])).toEqual({ p50_ms: null, p95_ms: null });
    expect(nearestRankPercentiles([7])).toEqual({ p50_ms: 7, p95_ms: 7 });
    expect(nearestRankPercentiles([1, 2])).toEqual({ p50_ms: 1, p95_ms: 2 });
    expect(nearestRankPercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
      p50_ms: 5,
      p95_ms: 10,
    });
  });

  test("tool usage percentiles and counts match the window-function definition", () => {
    const db = openDb(freshPath());
    seed(db);
    for (const filter of [{}, { from: "2026-05-02" }, { to: "2026-05-01" }]) {
      const rows = toolUsage(db, false, 50, filter);
      expect(rows.length).toBe(7);
      for (const row of rows) {
        const scope: string[] = [];
        const params: string[] = [row.tool_name, row.tool_kind];
        if (filter.from != null) {
          scope.push("s.started_at >= ?");
          params.push(filter.from);
        }
        if (filter.to != null) {
          scope.push("s.started_at < ?");
          params.push(`${filter.to}\u{10FFFF}`);
        }
        const where = [
          "COALESCE(t.tool_name, '') = ?",
          "COALESCE(t.tool_kind, '') = ?",
          row.mcp_server == null ? "t.mcp_server IS NULL" : "t.mcp_server = ?",
          ...scope,
        ].join(" AND ");
        const orderedParams =
          row.mcp_server == null
            ? params
            : [row.tool_name, row.tool_kind, row.mcp_server, ...params.slice(2)];
        expect({ p50_ms: row.p50_ms, p95_ms: row.p95_ms }).toEqual(
          windowPercentiles(db, where, orderedParams),
        );
        const counts = db
          .query(
            `SELECT COUNT(*) AS calls,
                    COALESCE(SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END), 0) AS errors,
                    MAX(t.timestamp) AS last_used_at
             FROM tool_call t JOIN session s ON s.id = t.session_id WHERE ${where}`,
          )
          .get(...orderedParams);
        expect({ calls: row.calls, errors: row.errors, last_used_at: row.last_used_at }).toEqual(
          counts as { calls: number; errors: number; last_used_at: string | null },
        );
      }
    }
    expect(toolUsage(db, false, 50).find((row) => row.tool_name === "NoDurations")).toMatchObject({
      p50_ms: null,
      p95_ms: null,
    });
    closeDb(db);
  });

  test("tool call summary matches the window-function definition", () => {
    const db = openDb(freshPath());
    seed(db);
    for (const [filter, where, params] of [
      [{}, "1", []],
      [{ tool: "Bash" }, "t.tool_name = ?", ["Bash"]],
      [{ server: "legacy-server" }, "t.mcp_server = ?", ["legacy-server"]],
      [
        { from: "2026-05-02", to: "2026-05-04" },
        "s.started_at >= ? AND s.started_at < ?",
        ["2026-05-02", "2026-05-04\u{10FFFF}"],
      ],
    ] as const) {
      const page = listToolCalls(db, filter);
      const counts = db
        .query(
          `SELECT COUNT(*) AS calls,
                  COALESCE(SUM(CASE WHEN t.is_error = 1 THEN 1 ELSE 0 END), 0) AS errors
           FROM tool_call t JOIN session s ON s.id = t.session_id WHERE ${where}`,
        )
        .get(...params) as { calls: number; errors: number };
      expect(page.summary).toEqual({ ...counts, ...windowPercentiles(db, where, [...params]) });
    }
    closeDb(db);
  });

  test("total matches a row count with and without row-only filters", () => {
    const db = openDb(freshPath());
    seed(db);
    const count = (where: string, ...params: (string | number)[]): number =>
      (
        db.query(`SELECT COUNT(*) AS n FROM tool_call t WHERE ${where}`).get(...params) as {
          n: number;
        }
      ).n;
    expect(listToolCalls(db).total).toBe(count("1"));
    expect(listToolCalls(db, { tool: "Read" }).total).toBe(count("t.tool_name = 'Read'"));
    expect(listToolCalls(db, { errorsOnly: true }).total).toBe(count("t.is_error = 1"));
    expect(listToolCalls(db, { minMs: 1000 }).total).toBe(count("t.duration_ms >= 1000"));
    expect(listToolCalls(db, { from: "2026-05-02" }).total).toBe(
      count("t.timestamp >= '2026-05-02'"),
    );
    expect(listToolCalls(db, { offset: 10 }).total).toBe(count("1"));
    closeDb(db);
  });

  test("cached aggregates follow writes from another connection", () => {
    const path = freshPath();
    const db = openDb(path);
    seed(db);
    const writer = openDb(path);
    const before = listToolCalls(db).summary?.calls ?? 0;
    const bashBefore = toolUsage(db, false, 50).find((row) => row.tool_name === "Bash")?.calls;
    expect(listToolCalls(db).summary?.calls).toBe(before);

    writer.exec(`
      INSERT INTO tool_call(session_id, tool_kind, tool_name, duration_ms, timestamp, ordinal)
      VALUES (1, 'builtin', 'Bash', 99999, '2026-05-09T00:00:00.000Z', 1000);
    `);
    expect(listToolCalls(db).summary?.calls).toBe(before + 1);
    expect(toolUsage(db, false, 50).find((row) => row.tool_name === "Bash")?.calls).toBe(
      (bashBefore ?? 0) + 1,
    );
    closeDb(writer);
    closeDb(db);
  });

  test("mcp usage matches the window-function SQL on random calls", () => {
    const db = openDb(freshPath());
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, model, started_at) VALUES
        (1, 'claude_code', 's1', 'claude-sonnet-4-5', '2026-01-01T00:00:00.000Z'),
        (2, 'codex', 's2', 'gpt-5', '2026-01-02T00:00:00.000Z');
    `);
    const insert = db.prepare(
      `INSERT INTO tool_call(session_id, tool_kind, tool_name, mcp_server, is_error, duration_ms, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    // The SQL mcpUsage ran before it moved its percentiles to TypeScript.
    const oracle = (limit: number) =>
      db
        .query(
          `WITH scoped AS (
             SELECT mcp_server, tool_name, is_error, duration_ms, timestamp
             FROM tool_call WHERE tool_kind = 'mcp' AND mcp_server IS NOT NULL
           ),
           ranked AS (
             SELECT mcp_server, duration_ms, ${durationRankSql("mcp_server")}
             FROM scoped WHERE duration_ms IS NOT NULL
           ),
           latency AS (
             SELECT mcp_server, ${NEAREST_RANK_PERCENTILES_SQL} FROM ranked GROUP BY mcp_server
           ),
           aggregate AS (
             SELECT mcp_server, COUNT(DISTINCT tool_name) AS tools, COUNT(*) AS calls,
                    COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0) AS errors,
                    MAX(timestamp) AS last_used_at
             FROM scoped GROUP BY mcp_server
           )
           SELECT a.mcp_server, a.tools, a.calls, a.errors, l.p50_ms, l.p95_ms, a.last_used_at
           FROM aggregate a LEFT JOIN latency l ON l.mcp_server = a.mcp_server
           ORDER BY a.calls DESC, a.mcp_server ASC
           LIMIT ?`,
        )
        .all(limit);
    // U+FFFD and U+1D538 order differently by code point and by UTF-16 unit.
    const call = fc.record({
      session: fc.integer({ min: 1, max: 2 }),
      kind: fc.constantFrom("mcp", "mcp", "builtin", null),
      server: fc.constantFrom(null, "", "linear", "dosu", "\uFFFD", "𝔸"),
      name: fc.constantFrom(null, "", "read", "write", "search"),
      isError: fc.constantFrom(null, 0, 1),
      duration: fc.option(fc.integer({ min: 0, max: 30 }), { nil: null }),
      timestamp: fc.option(
        fc
          .integer({ min: 0, max: 40 })
          .map((hour) => new Date(Date.UTC(2026, 0, 1) + hour * 3_600_000).toISOString()),
        { nil: null },
      ),
    });
    fc.assert(
      fc.property(
        fc.array(call, { maxLength: 50 }),
        fc.integer({ min: 1, max: 8 }),
        (calls, limit) => {
          db.exec("DELETE FROM tool_call");
          for (const row of calls) {
            insert.run(
              row.session,
              row.kind,
              row.name,
              row.server,
              row.isError,
              row.duration,
              row.timestamp,
            );
          }
          expect(mcpUsage(db, limit)).toEqual(oracle(limit) as never);
        },
      ),
      { numRuns: 150 },
    );
    closeDb(db);
  });

  test("callers cannot change a cached result", () => {
    const db = openDb(freshPath());
    seed(db);
    const first = toolUsage(db, false, 50);
    const firstRow = first[0];
    if (firstRow == null) {
      throw new Error("seeded tool usage must have rows");
    }
    firstRow.calls = -1;
    const summary = listToolCalls(db).summary;
    if (summary == null) {
      throw new Error("first page must carry a summary");
    }
    summary.calls = -1;
    expect(toolUsage(db, false, 50)[0]?.calls).not.toBe(-1);
    expect(listToolCalls(db).summary?.calls).not.toBe(-1);
    closeDb(db);
  });
});
