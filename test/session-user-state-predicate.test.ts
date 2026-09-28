import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import {
  sessionIsUserArchivedExpression,
  sessionUserStatePredicate,
} from "../src/session-user-state.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-user-state-predicate-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshDb(): Database {
  dbCounter += 1;
  return openDb(join(workDir, `predicate-${dbCounter}.db`));
}

// The per-row correlated form this module used before the hidden set was
// precomputed. It stays here as the semantic oracle.
function oraclePredicate(alias: string, includeArchived: boolean): string {
  const hiddenStates = includeArchived ? "'deleted'" : "'archived', 'deleted'";
  return `NOT EXISTS (
    WITH RECURSIVE visibility_lineage(id, tool, source_session_id, parent_session_id) AS (
      SELECT ${alias}.id, ${alias}.tool, ${alias}.source_session_id, ${alias}.parent_session_id
      UNION
      SELECT visibility_parent.id, visibility_parent.tool,
             visibility_parent.source_session_id, visibility_parent.parent_session_id
      FROM session visibility_parent
      JOIN visibility_lineage visibility_child
        ON visibility_parent.id = visibility_child.parent_session_id
    )
    SELECT 1
    FROM visibility_lineage
    JOIN session_user_state visibility_user_state
      ON visibility_user_state.tool = visibility_lineage.tool
     AND visibility_user_state.source_session_id = visibility_lineage.source_session_id
    WHERE visibility_user_state.state IN (${hiddenStates})
  )`;
}

function oracleArchivedExpression(alias: string): string {
  return `EXISTS (
    WITH RECURSIVE archive_lineage(id, tool, source_session_id, parent_session_id) AS (
      SELECT ${alias}.id, ${alias}.tool, ${alias}.source_session_id, ${alias}.parent_session_id
      UNION
      SELECT archive_parent.id, archive_parent.tool,
             archive_parent.source_session_id, archive_parent.parent_session_id
      FROM session archive_parent
      JOIN archive_lineage archive_child
        ON archive_parent.id = archive_child.parent_session_id
    )
    SELECT 1
    FROM archive_lineage
    JOIN session_user_state archive_user_state
      ON archive_user_state.tool = archive_lineage.tool
     AND archive_user_state.source_session_id = archive_lineage.source_session_id
    WHERE archive_user_state.state = 'archived'
  )`;
}

function addSession(db: Database, id: number, tool: string, sourceId: string): void {
  db.query("INSERT INTO session(id, tool, source_session_id) VALUES (?1, ?2, ?3)").run(
    id,
    tool,
    sourceId,
  );
}

function link(db: Database, child: number, parent: number): void {
  db.query("UPDATE session SET parent_session_id = ?2, is_subagent = 1 WHERE id = ?1").run(
    child,
    parent,
  );
}

function setState(db: Database, tool: string, sourceId: string, state: string): void {
  db.query(
    `INSERT INTO session_user_state(tool, source_session_id, state, updated_at)
     VALUES (?1, ?2, ?3, datetime('now'))`,
  ).run(tool, sourceId, state);
}

function visibleIds(db: Database, predicate: string): number[] {
  return (
    db.query(`SELECT s.id FROM session s WHERE ${predicate} ORDER BY s.id`).all() as {
      id: number;
    }[]
  ).map((row) => row.id);
}

function archivedIds(db: Database, expression: string): number[] {
  return (
    db.query(`SELECT s.id FROM session s WHERE ${expression} ORDER BY s.id`).all() as {
      id: number;
    }[]
  ).map((row) => row.id);
}

describe("sessionUserStatePredicate", () => {
  test("inherits hidden states down subagent lineage and matches identity by tool", () => {
    const db = freshDb();
    // 1 archived root -> 2 -> 3 (grandchild); 4 unrelated root with a deleted child 5;
    // 6 shares 1's source id under another tool, so the state must not reach it.
    addSession(db, 1, "claude_code", "root");
    addSession(db, 2, "claude_code", "child");
    addSession(db, 3, "claude_code", "grandchild");
    addSession(db, 4, "claude_code", "other-root");
    addSession(db, 5, "claude_code", "other-child");
    addSession(db, 6, "codex", "root");
    link(db, 2, 1);
    link(db, 3, 2);
    link(db, 5, 4);
    setState(db, "claude_code", "root", "archived");
    setState(db, "claude_code", "other-child", "deleted");

    expect(visibleIds(db, sessionUserStatePredicate("s"))).toEqual([4, 6]);
    expect(visibleIds(db, sessionUserStatePredicate("s", true))).toEqual([1, 2, 3, 4, 6]);
    expect(archivedIds(db, sessionIsUserArchivedExpression("s"))).toEqual([1, 2, 3]);
    db.close();
  });

  test("terminates on a parent cycle and hides every member reachable from a hidden row", () => {
    const db = freshDb();
    addSession(db, 1, "codex", "a");
    addSession(db, 2, "codex", "b");
    addSession(db, 3, "codex", "c");
    addSession(db, 4, "codex", "clean");
    link(db, 1, 2);
    link(db, 2, 1);
    link(db, 3, 2);
    setState(db, "codex", "a", "archived");

    expect(visibleIds(db, sessionUserStatePredicate("s"))).toEqual([4]);
    expect(visibleIds(db, oraclePredicate("s", false))).toEqual([4]);
    db.close();
  });

  test("selects the same rows and archive flags as the correlated oracle on random forests", () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      const db = freshDb();
      let state = seed * 2654435761;
      const next = (): number => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
      const count = 80;
      // Ids i and i + 40 share a source id under different tools.
      const toolOf = (id: number): string =>
        Math.floor(id / 40) % 2 === 0 ? "claude_code" : "codex";
      const sourceOf = (id: number): string => `src-${id % 40}`;
      for (let id = 1; id <= count; id += 1) {
        addSession(db, id, toolOf(id), sourceOf(id));
      }
      for (let id = 1; id <= count; id += 1) {
        if (next() < 0.65) {
          link(db, id, 1 + Math.floor(next() * count));
        }
      }
      for (let id = 1; id <= count; id += 1) {
        const roll = next();
        if (roll < 0.07) {
          setState(db, toolOf(id), sourceOf(id), "archived");
        } else if (roll < 0.11) {
          setState(db, toolOf(id), sourceOf(id), "deleted");
        }
      }
      setState(db, "codex", "never-ingested", "deleted");

      for (const includeArchived of [false, true]) {
        expect(visibleIds(db, sessionUserStatePredicate("s", includeArchived))).toEqual(
          visibleIds(db, oraclePredicate("s", includeArchived)),
        );
      }
      expect(archivedIds(db, sessionIsUserArchivedExpression("s"))).toEqual(
        archivedIds(db, oracleArchivedExpression("s")),
      );
      const visible = visibleIds(db, sessionUserStatePredicate("s")).length;
      expect(visible).toBeGreaterThan(0);
      expect(visible).toBeLessThan(count);
      db.close();
    }
  });
});
