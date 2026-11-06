import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { byDimension, totals } from "../src/stats.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-stats-rollups-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshDb(): Database {
  dbCounter += 1;
  return openDb(join(workDir, `rollups-${dbCounter}.db`));
}

describe("repository and outcome rollups", () => {
  function seedRepos(db: Database): void {
    db.exec(`
      INSERT INTO project(id, path, is_worktree, root_path, root_source) VALUES
        (1, '/code/app', 0, '/code/app', 'self'),
        (2, '/code/app-worktrees/fix-1', 1, '/code/app', 'git'),
        (3, '/code/lib', 0, '/code/lib', 'self'),
        (4, '/code/orphan-wt', 1, '/code/gone', 'git');
      INSERT INTO session(id, tool, source_session_id, project_id, model, started_at,
                          estimated_cost_usd, outcome, is_subagent, parent_session_id) VALUES
        (1, 'claude_code', 'a', 1, 'claude-sonnet-4-5', '2026-02-01T10:00:00.000Z', 1.0, 'completed', 0, NULL),
        (2, 'claude_code', 'b', 2, 'claude-sonnet-4-5', '2026-02-01T11:00:00.000Z', 2.0, 'abandoned', 0, NULL),
        (3, 'claude_code', 'c', 3, 'claude-sonnet-4-5', '2026-02-02T09:00:00.000Z', 4.0, NULL, 0, NULL),
        (4, 'claude_code', 'd', 4, 'claude-sonnet-4-5', '2026-02-02T09:30:00.000Z', 8.0, 'completed', 0, NULL),
        (5, 'claude_code', 'e', 2, 'claude-sonnet-4-5', '2026-02-03T00:30:00.000Z', 16.0, NULL, 1, 2),
        (6, 'claude_code', 'f', 2, 'claude-sonnet-4-5', '2026-02-03T00:40:00.000Z', 32.0, 'completed', 1, 5);
    `);
  }

  test("repo groups worktrees under their root and keeps unknown roots", () => {
    const db = freshDb();
    seedRepos(db);
    const rows = byDimension(db, "repo");
    expect(rows.map((row) => [row.key, row.sessions, row.estimated_cost_usd])).toEqual([
      ["/code/app", 2, 1 + 2 + 16 + 32],
      ["/code/gone", 1, 8],
      ["/code/lib", 1, 4],
    ]);
    expect(totals(db, { repo: "/code/app" })).toMatchObject({
      sessions: 2,
      estimated_cost_usd: 51,
    });
    expect(totals(db, { project: "/code/app" })).toMatchObject({ sessions: 1 });
    db.close();
  });

  test("outcome charges nested subagents to their top-level session", () => {
    const db = freshDb();
    seedRepos(db);
    const rows = byDimension(db, "outcome");
    expect(rows.map((row) => [row.key, row.sessions, row.estimated_cost_usd])).toEqual([
      ["completed", 2, 1 + 8],
      ["(unclassified)", 1, 4],
      ["abandoned", 1, 2 + 16 + 32],
    ]);
    // An unlabelled top-level session keeps its subagents unclassified too,
    // whatever their own labels say.
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, project_id, model, started_at,
                          estimated_cost_usd, outcome, is_subagent, parent_session_id) VALUES
        (7, 'claude_code', 'g', 3, 'claude-sonnet-4-5', '2026-02-02T10:00:00.000Z', 64.0, 'completed', 1, 3),
        (8, 'claude_code', 'h', 3, 'claude-sonnet-4-5', '2026-02-02T10:00:00.000Z', 128.0, 'failed', 1, NULL);
    `);
    const withOrphans = byDimension(db, "outcome");
    expect(withOrphans.find((row) => row.key === "(unclassified)")?.estimated_cost_usd).toBe(
      4 + 64,
    );
    // A subagent whose parent is missing keeps its own label.
    expect(withOrphans.find((row) => row.key === "failed")).toMatchObject({
      sessions: 0,
      estimated_cost_usd: 128,
    });
    db.exec("DELETE FROM session WHERE id IN (7, 8)");
    // The date filter keeps the subagents and drops their parent; they still
    // count under the parent's label.
    const filtered = byDimension(db, "outcome", { from: "2026-02-03", to: "2026-02-03" });
    expect(filtered.map((row) => [row.key, row.sessions, row.estimated_cost_usd])).toEqual([
      ["abandoned", 0, 48],
    ]);
    db.close();
  });
});
