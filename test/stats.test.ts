import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import type { Operation } from "../src/enrich.ts";
import { upsertSession } from "../src/ingest.ts";
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

  test("totals exclude generated local-command-only sessions", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, title, started_at)
      VALUES
        (1, 'claude_code', 'command-only',
         '<local-command-caveat>Generated command context</local-command-caveat>',
         '2026-07-05T00:00:00Z'),
        (2, 'claude_code', 'human-after-command',
         '<local-command-caveat>Generated command context</local-command-caveat>',
         '2026-07-05T00:00:01Z');
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
    `);

    expect(totals(db)).toMatchObject({ sessions: 1, messages: 2 });
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
    expect(read).toMatchObject({ tool_kind: "builtin", calls: 1, errors: 0 });
    expect(toolUsage(db, true, 50)).toEqual([]);
    expect(mcpUsage(db, 50)).toEqual([]);
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
