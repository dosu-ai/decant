import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { visibleSessionPredicate } from "../src/session-visibility.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-visibility-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("visibleSessionPredicate", () => {
  test("reads blocks by message on an archive without statistics", () => {
    // Until the first sync ends there is no sqlite_stat1. SQLite then started
    // the check from idx_block_type, reading every text block per session.
    const db = openDb(join(workDir, "plan.db"));
    try {
      expect(db.query("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'").get()).toBeNull();
      const statement = db.prepare(
        `EXPLAIN QUERY PLAN SELECT s.id FROM session s WHERE ${visibleSessionPredicate("s")}`,
      );
      const plan = (statement.all() as { detail: string }[]).map((row) => row.detail).join("\n");
      statement.finalize();
      expect(plan).toContain("visibility_block USING INDEX idx_block_message");
      expect(plan).not.toContain("idx_block_type");
    } finally {
      closeDb(db);
    }
  });
});
