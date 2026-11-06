import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { availableSessionSources } from "../src/source-filter.ts";
import {
  activity,
  byDimension,
  dateBounds,
  fileHotspots,
  modelSparklines,
  totals,
} from "../src/stats.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-analytics-cache-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
function freshPath(): string {
  counter += 1;
  return join(workDir, `analytics-cache-${counter}.db`);
}

function seed(db: Database): void {
  db.exec(`
    INSERT INTO project(id, path) VALUES (1, '/p');
    INSERT INTO session(id, tool, source_session_id, project_id, model, started_at,
                        total_input_tokens, estimated_cost_usd) VALUES
      (1, 'claude_code', 's1', 1, 'claude-sonnet-4-5', '2026-05-01T09:00:00.000Z', 10, 1.5),
      (2, 'codex', 's2', 1, 'gpt-5', '2026-05-02T15:00:00.000Z', 20, 2.5);
    INSERT INTO file_ref(session_id, path, rel_path, ext, operation)
      VALUES (1, '/p/a.ts', 'a.ts', 'ts', 'read');
  `);
}

/** Every cached aggregate, read the way the routes read it. */
function readAll(db: Database) {
  return {
    totals: totals(db),
    model: byDimension(db, "model"),
    day: byDimension(db, "day"),
    activity: activity(db),
    sparklines: modelSparklines(db),
    files: fileHotspots(db, "path", null, 25),
    bounds: dateBounds(db),
    sources: availableSessionSources(db),
  };
}

describe("cached analytics aggregates", () => {
  test("repeat reads match and follow writes on this and other connections", () => {
    const path = freshPath();
    const db = openDb(path);
    seed(db);
    const first = readAll(db);
    expect(readAll(db)).toEqual(first);
    expect(first.totals.sessions).toBe(2);

    // A write on the same connection moves total_changes().
    db.exec(`INSERT INTO session(id, tool, source_session_id, project_id, model, started_at)
             VALUES (3, 'gemini', 's3', 1, 'gemini-2.5-pro', '2026-05-03T08:00:00.000Z')`);
    const afterLocal = readAll(db);
    expect(afterLocal.totals.sessions).toBe(3);
    expect(afterLocal.day.map((row) => row.key)).toContain("2026-05-03");
    expect(afterLocal.sources.map((row) => row.key)).toContain("gemini_cli");
    expect(afterLocal.bounds.max).toBe("2026-05-03");

    // A commit on another connection moves data_version.
    const writer = openDb(path);
    writer.exec(`INSERT INTO session(id, tool, source_session_id, project_id, model, started_at)
                 VALUES (4, 'codex', 's4', 1, 'gpt-5', '2026-05-04T08:00:00.000Z')`);
    closeDb(writer);
    const afterOther = readAll(db);
    expect(afterOther.totals.sessions).toBe(4);
    expect(afterOther.sparklines.days).toContain("2026-05-04");
    closeDb(db);
  });

  test("callers cannot change a cached result", () => {
    const db = openDb(freshPath());
    seed(db);
    const first = readAll(db);
    first.totals.sessions = -1;
    first.model.reverse();
    const firstModel = first.model[0];
    if (firstModel != null) {
      firstModel.sessions = -1;
    }
    first.activity.by_hour.fill(-1);
    first.sparklines.days.push("nope");
    for (const counts of Object.values(first.sparklines.models)) {
      counts.fill(-1);
    }
    const fileRow = first.files[0];
    if (fileRow != null) {
      fileRow.reads = -1;
    }
    first.bounds.max = "nope";
    const second = readAll(db);
    expect(second.totals.sessions).toBe(2);
    expect(second.model.every((row) => row.sessions >= 0)).toBe(true);
    expect(second.activity.by_hour.every((count) => count >= 0)).toBe(true);
    expect(second.sparklines.days).not.toContain("nope");
    expect(
      Object.values(second.sparklines.models).every((counts) => counts.every((n) => n >= 0)),
    ).toBe(true);
    expect(second.files[0]?.reads).toBe(1);
    expect(second.bounds.max).toBe("2026-05-02");
    closeDb(db);
  });
});
