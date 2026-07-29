import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "./db.ts";

export type SessionUserState = "archived" | "deleted";
export type SessionUserStateUpdate = SessionUserState | "visible";

interface SessionIdentity {
  id: number;
  tool: string;
  source_session_id: string;
  source_path: string | null;
}

export interface SessionUserStateMutationOptions {
  /**
   * Derived writes that must commit or roll back with the state mutation.
   * The callback runs inside the same immediate transaction.
   */
  afterApply?: () => void;
}

/**
 * SQL predicate for user-controlled visibility. Callers compose this with
 * source/session predicates and supply an internal, trusted table alias.
 */
export function sessionUserStatePredicate(alias: string, includeArchived = false): string {
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

/** SQL expression returning 1 when this row or any current ancestor is archived. */
export function sessionIsUserArchivedExpression(alias: string): string {
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

/** SQL expression returning the direct persisted state for one session row. */
export function directSessionUserStateExpression(alias: string): string {
  return `(SELECT direct_user_state.state
    FROM session_user_state direct_user_state
    WHERE direct_user_state.tool = ${alias}.tool
      AND direct_user_state.source_session_id = ${alias}.source_session_id
    LIMIT 1
  )`;
}

export function isDeletedSessionIdentity(
  db: Database,
  tool: string,
  sourceSessionId: string,
): boolean {
  return (
    db
      .query(
        `SELECT 1
         FROM session_user_state
         WHERE tool = ?1 AND source_session_id = ?2 AND state = 'deleted'
         LIMIT 1`,
      )
      .get(tool, sourceSessionId) != null
  );
}

/**
 * Apply direct user archive state, or delete a session's existing descendant
 * tree.
 *
 * Deleted rows keep source-identity tombstones while the session subtree is
 * physically removed. Archive and visible affect only the selected identity;
 * reads derive effective archive state from current ancestry. This preserves
 * an independently archived child when a parent is archived and restored.
 * Source-derived session.is_archived remains untouched.
 */
export function setSessionUserState(
  db: Database,
  sessionId: number,
  state: SessionUserStateUpdate,
  options: SessionUserStateMutationOptions = {},
): boolean {
  return withImmediateTransaction(db, () => {
    const identities = db
      .query(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM session WHERE id = ?1
           UNION
           SELECT child.id
           FROM session child
           JOIN subtree parent ON child.parent_session_id = parent.id
         )
         SELECT s.id, s.tool, s.source_session_id, s.source_path
         FROM session s
         JOIN subtree ON subtree.id = s.id
         ORDER BY s.id`,
      )
      .all(sessionId) as SessionIdentity[];
    if (identities.length === 0) {
      return false;
    }

    if (state === "visible") {
      const selected = identities.find((identity) => identity.id === sessionId);
      if (selected == null) {
        return false;
      }
      db.query(
        `DELETE FROM session_user_state
         WHERE tool = ?1 AND source_session_id = ?2`,
      ).run(selected.tool, selected.source_session_id);
      options.afterApply?.();
      return true;
    }

    const upsert = db.prepare(
      `INSERT INTO session_user_state(tool, source_session_id, state, updated_at)
       VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT(tool, source_session_id) DO UPDATE SET
         state = excluded.state,
         updated_at = excluded.updated_at`,
    );
    try {
      const selected = identities.find((identity) => identity.id === sessionId);
      if (selected == null) {
        return false;
      }
      const targets = state === "deleted" ? identities : [selected];
      for (const identity of targets) {
        upsert.run(identity.tool, identity.source_session_id, state);
      }
    } finally {
      upsert.finalize();
    }

    if (state === "deleted") {
      const ids = JSON.stringify(identities.map((identity) => identity.id));
      const sourcePaths = JSON.stringify([
        ...new Set(
          identities
            .map((identity) => identity.source_path)
            .filter((path): path is string => path != null),
        ),
      ]);
      db.query(
        `UPDATE session
         SET parent_session_id = NULL
         WHERE parent_session_id IN (SELECT value FROM json_each(?1))`,
      ).run(ids);
      db.query("DELETE FROM session WHERE id IN (SELECT value FROM json_each(?1))").run(ids);
      db.query(
        `UPDATE ingest_source
         SET session_id = NULL,
             status = 'skipped_deleted',
             error = NULL,
             last_ingested_at = datetime('now')
         WHERE path IN (SELECT value FROM json_each(?1))
           AND NOT EXISTS (
             SELECT 1 FROM session remaining_session
             WHERE remaining_session.source_path = ingest_source.path
           )`,
      ).run(sourcePaths);
      db.query(
        `DELETE FROM ingest_issue
         WHERE source_path IN (SELECT value FROM json_each(?1))
           AND NOT EXISTS (
             SELECT 1 FROM session remaining_session
             WHERE remaining_session.source_path = ingest_issue.source_path
           )`,
      ).run(sourcePaths);
    }
    options.afterApply?.();
    return true;
  });
}
