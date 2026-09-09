import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import type { Operation } from "../src/enrich.ts";
import { upsertSession } from "../src/ingest.ts";
import { sessionUserStatePredicateForDatabase } from "../src/session-user-state.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import {
  activity,
  byDimension,
  dateBounds,
  fileHotspots,
  mcpUsage,
  modelSparklines,
  parseDimension,
  parseFileGroup,
  sessionFacets,
  todayTotals,
  toolUsage,
  totals,
} from "../src/stats.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-stats-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshDb(): Database {
  dbCounter += 1;
  return openDb(join(workDir, `stats-${dbCounter}.db`));
}

function fixture(tool: "claude" | "codex", name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", tool, name), "utf8");
}

function seeded(): Database {
  const db = freshDb();
  upsertSession(
    db,
    parseClaudeSession("sess-claude-1", fixture("claude", "sample.jsonl")),
    "/x.jsonl",
    1,
    2,
    "h",
  );
  return db;
}

function seededEnriched(): Database {
  const db = freshDb();
  upsertSession(
    db,
    parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
    "/x/claude.jsonl",
    1,
    2,
    "claude",
  );
  upsertSession(
    db,
    parseCodexSession("sess-enr-codex", fixture("codex", "enriched.jsonl"), new Map()),
    "/x/codex.jsonl",
    1,
    2,
    "codex",
  );
  return db;
}

describe("stats rollups", () => {
  test("all archive rollup modules use the database-aware visibility shortcut", () => {
    for (const file of ["token-economics.ts", "recommendations.ts", "distill.ts", "query.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
      expect(source).toContain("sessionUserStatePredicateForDatabase");
      expect(source).not.toContain('sessionUserStatePredicate("s")');
    }

    const query = readFileSync(join(import.meta.dir, "..", "src", "query.ts"), "utf8");
    const projectsStart = query.indexOf("export function listProjects(");
    const projects = query.slice(
      projectsStart,
      query.indexOf("function mapSessionSummary(", projectsStart),
    );
    expect(projects).toContain('sessionUserStatePredicateForDatabase(db, "s")');
    expect(projects).not.toContain('sessionUserStatePredicate("s")');
  });

  test("elides recursive visibility work while session user state is empty", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, started_at)
      VALUES (1, 'codex', 'visible-root', '2026-05-01T10:00:00Z');
    `);

    const emptyStatePredicate = sessionUserStatePredicateForDatabase(db, "s");
    expect(emptyStatePredicate).toBe("1");
    expect(
      JSON.stringify(
        db
          .query(`EXPLAIN QUERY PLAN SELECT s.id FROM session s WHERE ${emptyStatePredicate}`)
          .all(),
      ),
    ).not.toContain("session_user_state");
    expect(totals(db).sessions).toBe(1);

    db.exec(`
      INSERT INTO session_user_state(tool, source_session_id, state, updated_at)
      VALUES ('codex', 'visible-root', 'archived', datetime('now'));
    `);
    const populatedStatePredicate = sessionUserStatePredicateForDatabase(db, "s");
    expect(populatedStatePredicate).toContain("session_user_state");
    expect(sessionUserStatePredicateForDatabase(db, "s", true)).toBe("1");
    expect(totals(db).sessions).toBe(0);
    expect(totals(db, { includeArchived: true }).sessions).toBe(1);
    db.close();
  });

  test("file hotspots by path order by total operations", () => {
    const db = seededEnriched();
    const rows = fileHotspots(db, "path", null, 50);

    expect(rows[0]?.key).toBe("src/main.rs");
    expect([rows[0]?.reads, rows[0]?.edits]).toEqual([1, 1]);
    expect(rows[0]?.sessions).toBe(1);
    expect(rows[0]?.project).toBe("/Users/dev/proj");
    expect(rows).toHaveLength(6);
    expect(rows[0]?.last_touched_at).not.toBeNull();
    db.close();
  });

  test("file hotspots op filter keeps only that operation", () => {
    const db = seededEnriched();
    const rows = fileHotspots(db, "path", "edit" satisfies Operation, 50);
    expect(rows.map((row) => row.key)).toEqual(["nb.ipynb", "src/lib.rs", "src/main.rs"]);
    expect(rows.every((row) => row.reads === 0 && row.writes === 0)).toBe(true);
    db.close();
  });

  test("file hotspots by extension roll up languages", () => {
    const db = seededEnriched();
    const rows = fileHotspots(db, "ext", null, 50);
    const rs = rows.find((row) => row.key === "rs");
    expect([rs?.reads, rs?.edits]).toEqual([1, 2]);
    expect(rs?.sessions).toBe(2);
    expect(rs?.project).toBeNull();
    db.close();
  });

  test("parse helpers return null for unknown values", () => {
    expect(parseFileGroup("path")).toBe("path");
    expect(parseFileGroup("ext")).toBe("ext");
    expect(parseFileGroup("bogus")).toBeNull();
    expect(parseDimension("model")).toBe("model");
    expect(parseDimension("nope")).toBeNull();
  });

  test("totals roll up archive counters", () => {
    const db = seeded();
    const row = totals(db);
    expect(row.sessions).toBe(1);
    expect(row.messages).toBe(4);
    expect(row.tool_calls).toBe(1);
    expect(row.input_tokens).toBe(2700);
    db.close();
  });

  test("totals and every dimension exclude generated local-command-only sessions", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO project(id, path)
      VALUES
        (1, '/hidden-command'),
        (2, '/visible-session');
      INSERT INTO session(id, tool, source_session_id, project_id, title, model, started_at)
      VALUES
        (1, 'claude_code', 'command-only', 1,
         '<local-command-caveat>Generated command context</local-command-caveat>',
         NULL,
         '2026-07-05T00:00:00Z'),
        (2, 'claude_code', 'human-after-command', 2,
         '<local-command-caveat>Generated command context</local-command-caveat>',
         'claude-sonnet-4-5',
         '2026-07-06T00:00:01Z');
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 1, 0, 'user', '{}'),
        (2, 2, 0, 'user', '{}'),
        (3, 2, 1, 'user', '{}');
      INSERT INTO block(message_id, session_id, ordinal, type, text)
      VALUES
        (1, 1, 0, 'text', '<command-name>/exit</command-name>'),
        (2, 2, 0, 'text', '<command-name>/model</command-name>'),
        (3, 2, 0, 'text', 'Continue with my actual request');
      INSERT INTO tool_call(
        session_id, tool_kind, tool_name, mcp_server, is_error, duration_ms, ordinal
      ) VALUES
        (1, 'mcp', 'HiddenCommandTool', 'hidden', 1, 500, 0),
        (2, 'builtin', 'VisibleTool', NULL, 0, 100, 0);
    `);

    expect(totals(db)).toMatchObject({ sessions: 1, messages: 2, tool_calls: 1 });
    expect(byDimension(db, "tool")).toMatchObject([{ key: "claude_code", sessions: 1 }]);
    expect(byDimension(db, "day")).toMatchObject([{ key: "2026-07-06", sessions: 1 }]);
    expect(byDimension(db, "project")).toMatchObject([{ key: "/visible-session", sessions: 1 }]);
    expect(byDimension(db, "model")).toMatchObject([{ key: "claude-sonnet-4-5", sessions: 1 }]);
    expect(toolUsage(db, false, 50)).toMatchObject([{ tool_name: "VisibleTool", calls: 1 }]);
    expect(mcpUsage(db, 50)).toEqual([]);
    db.close();
  });

  test("every archive-wide rollup excludes user-hidden identities and descendants", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO project(id, path)
      VALUES
        (1, '/hidden'),
        (2, '/visible');
      INSERT INTO session(
        id, tool, source_session_id, project_id, model, started_at, is_subagent,
        parent_session_id, total_input_tokens, total_output_tokens, estimated_cost_usd
      )
      VALUES
        (1, 'claude_code', 'archived-root', 1, 'hidden-model', '2026-05-01T10:00:00Z',
         0, NULL, 10, 20, 1.0),
        (2, 'claude_code', 'archived-child', 1, 'hidden-model', '2026-05-01T10:01:00Z',
         1, 1, 30, 40, 2.0),
        (3, 'codex', 'deleted-root', 1, 'deleted-model', '2026-05-02T10:00:00Z',
         0, NULL, 50, 60, 3.0),
        (4, 'codex', 'visible-root', 2, 'visible-model', '2026-05-03T10:00:00Z',
         0, NULL, 70, 80, 4.0);
      INSERT INTO session_user_state(tool, source_session_id, state, updated_at)
      VALUES
        ('claude_code', 'archived-root', 'archived', datetime('now')),
        ('codex', 'deleted-root', 'deleted', datetime('now'));
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 1, 0, 'user', '{}'),
        (2, 2, 0, 'user', '{}'),
        (3, 3, 0, 'user', '{}'),
        (4, 4, 0, 'user', '{}');
      INSERT INTO tool_call(
        session_id, tool_kind, tool_name, mcp_server, is_error, duration_ms, ordinal
      )
      VALUES
        (1, 'builtin', 'HiddenRootTool', NULL, 0, 10, 0),
        (2, 'mcp', 'HiddenChildTool', 'hidden', 0, 20, 0),
        (3, 'builtin', 'DeletedTool', NULL, 0, 30, 0),
        (4, 'mcp', 'VisibleTool', 'visible', 0, 40, 0);
      INSERT INTO file_ref(session_id, path, rel_path, ext, operation)
      VALUES
        (1, '/hidden/root.ts', 'root.ts', 'ts', 'read'),
        (2, '/hidden/child.ts', 'child.ts', 'ts', 'edit'),
        (3, '/hidden/deleted.ts', 'deleted.ts', 'ts', 'write'),
        (4, '/visible/visible.ts', 'visible.ts', 'ts', 'read');
    `);

    expect(totals(db)).toMatchObject({
      sessions: 1,
      messages: 1,
      tool_calls: 1,
      input_tokens: 70,
      output_tokens: 80,
      estimated_cost_usd: 4,
    });
    expect(totals(db, { includeArchived: true })).toMatchObject({
      sessions: 2,
      messages: 3,
      tool_calls: 3,
      input_tokens: 110,
      output_tokens: 140,
      estimated_cost_usd: 7,
    });
    expect(byDimension(db, "project", { includeArchived: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "/hidden", sessions: 1 }),
        expect.objectContaining({ key: "/visible", sessions: 1 }),
      ]),
    );
    for (const dimension of ["tool", "model", "project", "day"] as const) {
      expect(byDimension(db, dimension)).toHaveLength(1);
    }
    expect(byDimension(db, "project")).toMatchObject([{ key: "/visible", sessions: 1 }]);
    expect(toolUsage(db, false, 50)).toMatchObject([{ tool_name: "VisibleTool", calls: 1 }]);
    expect(mcpUsage(db, 50)).toMatchObject([{ mcp_server: "visible", calls: 1 }]);
    expect(fileHotspots(db, "path", null, 50)).toMatchObject([{ key: "visible.ts", sessions: 1 }]);
    expect(activity(db).by_hour.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(modelSparklines(db)).toEqual({
      days: ["2026-05-03"],
      models: { "visible-model": [1] },
    });
    expect(dateBounds(db)).toEqual({ min: "2026-05-03", max: "2026-05-03" });
    db.close();
  });

  test("today totals exclude archived ancestors from every metric", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(
        id, tool, source_session_id, model, started_at, is_subagent, parent_session_id,
        total_input_tokens, total_output_tokens, estimated_cost_usd
      )
      VALUES
        (1, 'claude_code', 'today-archived-root', 'hidden-model',
         datetime('now', 'localtime'), 0, NULL, 10, 20, 1.0),
        (2, 'claude_code', 'today-archived-child', 'hidden-model',
         datetime('now', 'localtime'), 1, 1, 30, 40, 2.0),
        (3, 'codex', 'today-visible-root', 'visible-model',
         datetime('now', 'localtime'), 0, NULL, 50, 60, 3.0);
      INSERT INTO session_user_state(tool, source_session_id, state, updated_at)
      VALUES ('claude_code', 'today-archived-root', 'archived', datetime('now'));
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 1, 0, 'user', '{}'),
        (2, 2, 0, 'user', '{}'),
        (3, 3, 0, 'user', '{}');
      INSERT INTO tool_call(
        session_id, tool_kind, tool_name, is_error, duration_ms, ordinal
      )
      VALUES
        (1, 'builtin', 'HiddenRootTool', 0, 10, 0),
        (2, 'builtin', 'HiddenChildTool', 0, 20, 0),
        (3, 'builtin', 'VisibleTool', 0, 30, 0);
    `);

    expect(todayTotals(db)).toMatchObject({
      sessions: 1,
      messages: 1,
      tool_calls: 1,
      input_tokens: 50,
      output_tokens: 60,
      estimated_cost_usd: 3,
    });
    db.close();
  });

  test("date filters scope analytics rollups", () => {
    const db = seededEnriched();
    const filter = { from: "2026-05-04", to: "2026-05-04" };

    expect(totals(db, filter).sessions).toBe(1);
    expect(byDimension(db, "tool", filter)).toMatchObject([{ key: "codex", sessions: 1 }]);
    expect(modelSparklines(db, filter).days).toEqual(["2026-05-04"]);
    expect(activity(db, filter).by_weekday.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(toolUsage(db, false, 50, filter).some((row) => row.tool_name === "Read")).toBe(false);
    expect(fileHotspots(db, "path", null, 50, filter).some((row) => row.key === "nb.ipynb")).toBe(
      false,
    );

    db.close();
  });

  test("project and tool filters preserve top-level session and all-session metric semantics", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO project(id, path)
      VALUES
        (1, '/alpha'),
        (2, '/beta');
      INSERT INTO session(
        id, tool, source_session_id, project_id, started_at, is_subagent, parent_session_id,
        total_input_tokens, total_output_tokens, estimated_cost_usd
      )
      VALUES
        (1, 'claude_code', 'alpha-root', 1, '2026-05-01T10:00:00Z', 0, NULL, 10, 20, 1.0),
        (2, 'claude_code', 'alpha-subagent', 1, '2026-05-01T10:01:00Z', 1, 1, 4, 5, 0.25),
        (3, 'codex', 'alpha-codex', 1, '2026-05-02T10:00:00Z', 0, NULL, 30, 40, 2.0),
        (4, 'claude_code', 'beta-root', 2, '2026-05-03T10:00:00Z', 0, NULL, 50, 60, 4.0);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES
        (1, 1, 0, 'user', '{}'),
        (2, 1, 1, 'assistant', '{}'),
        (3, 2, 0, 'user', '{}'),
        (4, 2, 1, 'assistant', '{}'),
        (5, 2, 2, 'assistant', '{}'),
        (6, 3, 0, 'user', '{}'),
        (7, 4, 0, 'user', '{}');
    `);

    expect(totals(db, { project: "/alpha" })).toMatchObject({
      sessions: 2,
      messages: 6,
      input_tokens: 44,
      output_tokens: 65,
      estimated_cost_usd: 3.25,
    });
    expect(totals(db, { tool: "claude_code" })).toMatchObject({
      sessions: 2,
      messages: 6,
      input_tokens: 64,
      output_tokens: 85,
      estimated_cost_usd: 5.25,
    });
    expect(totals(db, { project: "/alpha", tool: "claude_code" })).toMatchObject({
      sessions: 1,
      messages: 5,
      input_tokens: 14,
      output_tokens: 25,
      estimated_cost_usd: 1.25,
    });
    expect(
      totals(db, {
        from: "2026-05-01",
        to: "2026-05-01",
        project: "/alpha",
        tool: "claude_code",
      }),
    ).toMatchObject({
      sessions: 1,
      messages: 5,
      input_tokens: 14,
      output_tokens: 25,
      estimated_cost_usd: 1.25,
    });

    const projectRows = byDimension(db, "tool", { project: "/alpha" });
    expect(projectRows).toHaveLength(2);
    expect(projectRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "claude_code",
          sessions: 1,
          input_tokens: 14,
          output_tokens: 25,
          estimated_cost_usd: 1.25,
        }),
        expect.objectContaining({
          key: "codex",
          sessions: 1,
          input_tokens: 30,
          output_tokens: 40,
          estimated_cost_usd: 2,
        }),
      ]),
    );
    expect(byDimension(db, "project", { project: "/alpha", tool: "claude_code" })).toEqual([
      expect.objectContaining({
        key: "/alpha",
        sessions: 1,
        estimated_cost_usd: 1.25,
      }),
    ]);
    db.close();
  });

  test("reasoning tokens surface in rollups", () => {
    const db = seededEnriched();
    expect(totals(db).reasoning_tokens).toBe(40);

    const byTool = byDimension(db, "tool");
    const codex = byTool.find((row) => row.key === "codex");
    const claude = byTool.find((row) => row.key === "claude_code");
    expect(codex?.reasoning_tokens).toBe(40);
    expect((codex?.reasoning_tokens ?? 0) <= (codex?.output_tokens ?? 0)).toBe(true);
    expect(claude?.reasoning_tokens).toBe(0);
    db.close();
  });

  test("by tool, day, project, and model", () => {
    const db = seeded();
    expect(byDimension(db, "tool")).toMatchObject([{ key: "claude_code", sessions: 1 }]);
    expect(byDimension(db, "day")[0]?.key).toBe("2026-05-01");
    expect(byDimension(db, "project")).toMatchObject([{ key: "/Users/dev/proj", sessions: 1 }]);
    expect(byDimension(db, "model")[0]?.key).toBe("claude-opus-4-7");
    db.close();
  });

  test("by project uses placeholder when a session has no project", () => {
    const db = freshDb();
    db.exec("INSERT INTO session(id, tool, source_session_id) VALUES (1, 'codex', 's1');");
    expect(byDimension(db, "project")[0]?.key).toBe("(none)");
    db.close();
  });

  test("tool usage and MCP usage", () => {
    const db = seeded();
    const tools = toolUsage(db, false, 50);
    const read = tools.find((tool) => tool.tool_name === "Read");
    expect(read).toMatchObject({
      tool_kind: "builtin",
      calls: 1,
      errors: 0,
      p50_ms: 1000,
      p95_ms: 1000,
      last_used_at: "2026-05-01T10:00:05.000Z",
    });
    expect(toolUsage(db, true, 50)).toEqual([]);
    expect(mcpUsage(db, 50)).toEqual([]);

    const sessionId = (
      db.query("SELECT id FROM session WHERE source_session_id = 'sess-claude-1'").get() as {
        id: number;
      }
    ).id;
    const insert = db.prepare(
      `INSERT INTO tool_call(
         session_id, tool_kind, tool_name, mcp_server, is_error, duration_ms, timestamp, ordinal
       ) VALUES (?, 'mcp', ?, 'demo', ?, ?, ?, ?)`,
    );
    for (const [index, duration] of [10, 20, 30, 40].entries()) {
      insert.run(
        sessionId,
        index % 2 === 0 ? "mcp__demo__read" : "mcp__demo__write",
        index === 3 ? 1 : 0,
        duration,
        `2026-05-01T10:00:${String(20 + index).padStart(2, "0")}.000Z`,
        index,
      );
    }
    db.query(
      `INSERT INTO tool_call(
         session_id, tool_kind, tool_name, is_error, duration_ms, timestamp, ordinal
       ) VALUES (?, 'builtin', 'NoMetadata', NULL, NULL, NULL, 10)`,
    ).run(sessionId);

    expect(mcpUsage(db, 50)).toEqual([
      {
        mcp_server: "demo",
        tools: 2,
        calls: 4,
        errors: 1,
        p50_ms: 20,
        p95_ms: 40,
        last_used_at: "2026-05-01T10:00:23.000Z",
      },
    ]);
    expect(toolUsage(db, true, 50)).toEqual([
      expect.objectContaining({
        tool_name: "mcp__demo__write",
        errors: 1,
        p50_ms: 20,
        p95_ms: 40,
      }),
    ]);
    expect(toolUsage(db, false, 50).find((row) => row.tool_name === "NoMetadata")).toMatchObject({
      p50_ms: null,
      p95_ms: null,
      last_used_at: null,
    });
    db.close();
  });

  test("ranked stat ties use stable key and name ordering", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO project(id, path) VALUES (1, '/p');
      INSERT INTO session(
        id, tool, source_session_id, project_id, model, started_at
      )
      VALUES
        (1, 'claude_code', 'z-session', 1, 'z-model', datetime('now')),
        (2, 'codex', 'a-session', 1, 'a-model', datetime('now'));
      INSERT INTO tool_call(session_id, tool_kind, tool_name, mcp_server)
      VALUES
        (1, 'builtin', 'z-tool', NULL),
        (2, 'builtin', 'a-tool', NULL),
        (1, 'mcp', 'z-call', 'z-server'),
        (2, 'mcp', 'a-call', 'a-server'),
        (1, 'mcp', 'same', NULL),
        (1, 'builtin', 'same', ''),
        (1, 'builtin', 'same', 'z-server'),
        (2, 'builtin', 'same', NULL);
    `);

    expect(byDimension(db, "model").map((row) => row.key)).toEqual(["a-model", "z-model"]);
    expect(toolUsage(db, false, 10).map((row) => row.tool_name)).toEqual([
      "a-call",
      "a-tool",
      "same",
      "same",
      "same",
      "same",
      "z-call",
      "z-tool",
    ]);
    expect(
      toolUsage(db, false, 10)
        .filter((row) => row.tool_name === "same")
        .map((row) => [row.tool_kind, row.mcp_server]),
    ).toEqual([
      ["builtin", null],
      ["builtin", ""],
      ["builtin", "z-server"],
      ["mcp", null],
    ]);
    expect(mcpUsage(db, 10).map((row) => row.mcp_server)).toEqual(["a-server", "z-server"]);
    db.close();
  });

  test("session facets return a known row or null", () => {
    const db = seededEnriched();
    const id = (
      db.query("SELECT id FROM session WHERE source_session_id = 'sess-enr-claude'").get() as {
        id: number;
      }
    ).id;
    const facets = sessionFacets(db, id);
    expect(facets?.turn_count).toBe(1);
    expect((facets?.active_seconds ?? 0) > 0).toBe(true);
    expect(sessionFacets(db, 999_999)).toBeNull();
    db.close();
  });

  test("activity histograms are padded and date bounds span sessions", () => {
    const db = seededEnriched();
    const got = activity(db);
    expect(got.by_hour).toHaveLength(24);
    expect(got.by_weekday).toHaveLength(7);
    expect(got.by_hour.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(got.timezone).toStartWith("UTC");

    const bounds = dateBounds(db);
    expect(bounds.min).toBe("2026-05-03");
    expect(bounds.max).toBe("2026-05-04");
    db.close();
  });

  test("model sparklines share a day axis and today totals are scoped", () => {
    const db = seededEnriched();
    const sparks = modelSparklines(db);
    expect(sparks.days).toEqual(["2026-05-03", "2026-05-04"]);
    for (const counts of Object.values(sparks.models)) {
      expect(counts).toHaveLength(sparks.days.length);
    }
    expect(todayTotals(db).sessions).toBe(0);
    db.close();
  });

  test("stat queries propagate database errors", () => {
    const bare = new Database(":memory:");
    expect(() => totals(bare)).toThrow();
    expect(() => mcpUsage(bare, 10)).toThrow();
    expect(() => sessionFacets(bare, 1)).toThrow();
    bare.close();
  });
});
