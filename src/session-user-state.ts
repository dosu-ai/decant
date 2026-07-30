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

interface ProviderLineageSessionIdentity extends SessionIdentity {
  is_subagent: number;
  parent_session_id: number | null;
  spawn_tool_use_id: string | null;
  raw_meta: string | null;
}

interface ClaudeSpawnRow {
  session_id: number;
  raw_meta: string | null;
  tool_use_id: string;
}

export interface DeletedSessionLineageContext {
  rootSourceSessionId?: string | null;
  spawnToolUseId?: string | null;
  ownedSpawnToolUseIds?: readonly string[];
}

export interface SessionUserStateMutationOptions {
  /**
   * Derived writes that must commit or roll back with the state mutation.
   * The callback runs inside the same immediate transaction.
   */
  afterApply?: () => void;
}

// A reserved tool namespace keeps lineage-boundary markers from matching real
// session identities. The state table has no foreign key to session on purpose:
// deleted transcripts retain stable identities after their rows are removed.
const CLAUDE_SPAWN_TOMBSTONE_TOOL = "__decant_internal_claude_spawn__";

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

/**
 * Avoid installing the correlated recursive lineage program in rollup SQL
 * when no hidden state of the requested kind exists. Rollups call this once
 * while building each statement; the indexed one-row probe is constant work,
 * while returning `1` lets SQLite scan the session table without evaluating a
 * recursive CTE for every row.
 */
export function sessionUserStatePredicateForDatabase(
  db: Database,
  alias: string,
  includeArchived = false,
): string {
  const relevantState =
    db
      .query(
        includeArchived
          ? `SELECT 1 FROM session_user_state WHERE state = 'deleted' LIMIT 1`
          : "SELECT 1 FROM session_user_state LIMIT 1",
      )
      .get() != null;
  return relevantState ? sessionUserStatePredicate(alias, includeArchived) : "1";
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
 * Preserve a deleted lineage when a child transcript appears after its parent
 * row was physically removed. Providers carry the parent's stable source
 * identity in subagent metadata, so a parent tombstone can be inherited
 * without retaining transcript content.
 */
export function inheritDeletedSessionTombstone(
  db: Database,
  tool: string,
  sourceSessionId: string,
  parentSourceSessionId: string | null,
  context: DeletedSessionLineageContext = {},
): boolean {
  const alreadyDeleted = isDeletedSessionIdentity(db, tool, sourceSessionId);
  const inheritsDeletion =
    parentSourceSessionId != null &&
    parentSourceSessionId !== sourceSessionId &&
    isDeletedSessionIdentity(db, tool, parentSourceSessionId);
  const claudeRootSourceSessionId =
    tool === "claude_code" ? (context.rootSourceSessionId ?? null) : null;
  const inheritsClaudeSpawnDeletion =
    claudeRootSourceSessionId != null &&
    context.spawnToolUseId != null &&
    isDeletedSessionIdentity(
      db,
      CLAUDE_SPAWN_TOMBSTONE_TOOL,
      claudeSpawnTombstoneKey(claudeRootSourceSessionId, context.spawnToolUseId),
    );
  if (!alreadyDeleted && !inheritsDeletion && !inheritsClaudeSpawnDeletion) {
    return false;
  }

  upsertSessionStateIdentities(db, [{ tool, source_session_id: sourceSessionId }], "deleted");
  const ownedClaudeSpawnTombstones = claudeSpawnTombstoneIdentities(
    claudeRootSourceSessionId,
    context.ownedSpawnToolUseIds ?? [],
  );
  if (ownedClaudeSpawnTombstones.length > 0) {
    upsertSessionStateIdentities(db, ownedClaudeSpawnTombstones, "deleted");
  }
  const existingLineage = providerLineageDescendants(db, tool, sourceSessionId, {
    claudeRootSourceSessionId,
    claudeSpawnToolUseIds: context.ownedSpawnToolUseIds ?? [],
  });
  if (existingLineage.length > 0) {
    upsertSessionStateIdentities(db, existingLineage, "deleted");
    const descendantSpawnTombstones = claudeSpawnTombstonesForSessions(db, existingLineage);
    if (descendantSpawnTombstones.length > 0) {
      upsertSessionStateIdentities(db, descendantSpawnTombstones, "deleted");
    }
    deleteSessionIdentities(db, existingLineage);
  }
  return true;
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

    const selected = identities.find((identity) => identity.id === sessionId);
    if (selected == null) {
      return false;
    }
    const targets = state === "deleted" ? identities : [selected];
    upsertSessionStateIdentities(db, targets, state);

    if (state === "deleted") {
      const spawnTombstones = claudeSpawnTombstonesForSessions(db, identities);
      if (spawnTombstones.length > 0) {
        upsertSessionStateIdentities(db, spawnTombstones, "deleted");
      }
      deleteSessionIdentities(db, identities);
    }
    options.afterApply?.();
    return true;
  });
}

function upsertSessionStateIdentities(
  db: Database,
  identities: readonly Pick<SessionIdentity, "tool" | "source_session_id">[],
  state: SessionUserState,
): void {
  const upsert = db.prepare(
    `INSERT INTO session_user_state(tool, source_session_id, state, updated_at)
     VALUES (?1, ?2, ?3, datetime('now'))
     ON CONFLICT(tool, source_session_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at`,
  );
  try {
    for (const identity of identities) {
      upsert.run(identity.tool, identity.source_session_id, state);
    }
  } finally {
    upsert.finalize();
  }
}

function deleteSessionIdentities(db: Database, identities: readonly SessionIdentity[]): void {
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

/**
 * Find an already-ingested provider lineage without relying on resolved
 * session parent ids. This is used only on the rare tombstone path, where a
 * full provider-local scan is preferable to leaving an orphan because source
 * files happened to be discovered grandchild-first.
 */
function providerLineageDescendants(
  db: Database,
  tool: string,
  sourceSessionId: string,
  boundary: {
    claudeRootSourceSessionId: string | null;
    claudeSpawnToolUseIds: readonly string[];
  } = {
    claudeRootSourceSessionId: null,
    claudeSpawnToolUseIds: [],
  },
): SessionIdentity[] {
  const rows = db
    .query(
      `SELECT id, tool, source_session_id, source_path, is_subagent,
              parent_session_id, spawn_tool_use_id, raw_meta
       FROM session
       WHERE tool = ?1`,
    )
    .all(tool) as ProviderLineageSessionIdentity[];
  const byProviderParent = new Map<string, ProviderLineageSessionIdentity[]>();
  const bySessionParent = new Map<number, ProviderLineageSessionIdentity[]>();
  const byClaudeSpawnTombstone = new Map<string, ProviderLineageSessionIdentity[]>();
  for (const row of rows) {
    const providerParent = providerParentSourceSessionId(row);
    if (providerParent != null) {
      appendMapValue(byProviderParent, providerParent, row);
    }
    if (row.parent_session_id != null) {
      appendMapValue(bySessionParent, row.parent_session_id, row);
    }
    if (row.tool === "claude_code" && providerParent != null && row.spawn_tool_use_id != null) {
      appendMapValue(
        byClaudeSpawnTombstone,
        claudeSpawnTombstoneKey(providerParent, row.spawn_tool_use_id),
        row,
      );
    }
  }
  const ownedClaudeSpawnIds =
    tool === "claude_code" ? claudeSpawnToolUseIdsBySession(db) : new Map<number, string[]>();

  const found: ProviderLineageSessionIdentity[] = [];
  const seenIds = new Set<number>();
  const seenClaudeSpawnTombstones = new Set<string>();
  const pendingSources = [sourceSessionId];
  const pendingIds: number[] = [];
  const pendingClaudeSpawnTombstones = claudeSpawnTombstoneKeys(
    boundary.claudeRootSourceSessionId,
    boundary.claudeSpawnToolUseIds,
  );
  const add = (row: ProviderLineageSessionIdentity): void => {
    if (seenIds.has(row.id)) {
      return;
    }
    seenIds.add(row.id);
    found.push(row);
    pendingSources.push(row.source_session_id);
    pendingIds.push(row.id);
    const rootSourceSessionId =
      row.tool === "claude_code" ? providerParentSourceSessionId(row) : null;
    pendingClaudeSpawnTombstones.push(
      ...claudeSpawnTombstoneKeys(rootSourceSessionId, ownedClaudeSpawnIds.get(row.id) ?? []),
    );
  };
  for (const row of rows) {
    if (row.source_session_id === sourceSessionId) {
      add(row);
    }
  }
  while (
    pendingSources.length > 0 ||
    pendingIds.length > 0 ||
    pendingClaudeSpawnTombstones.length > 0
  ) {
    const parentSource = pendingSources.shift();
    if (parentSource != null) {
      for (const child of byProviderParent.get(parentSource) ?? []) {
        add(child);
      }
    }
    const parentId = pendingIds.shift();
    if (parentId != null) {
      for (const child of bySessionParent.get(parentId) ?? []) {
        add(child);
      }
    }
    const spawnTombstone = pendingClaudeSpawnTombstones.shift();
    if (spawnTombstone != null && !seenClaudeSpawnTombstones.has(spawnTombstone)) {
      seenClaudeSpawnTombstones.add(spawnTombstone);
      for (const child of byClaudeSpawnTombstone.get(spawnTombstone) ?? []) {
        add(child);
      }
    }
  }
  return found.sort((left, right) => left.id - right.id);
}

function providerParentSourceSessionId(row: ProviderLineageSessionIdentity): string | null {
  if (row.is_subagent === 0 || row.raw_meta == null) {
    return null;
  }
  let meta: unknown;
  try {
    meta = JSON.parse(row.raw_meta) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(meta)) {
    return null;
  }
  if (row.tool === "claude_code") {
    return claudeRootSourceSessionId(meta);
  }
  const source = recordValue(meta.source);
  const subagent = recordValue(source?.subagent);
  const threadSpawn = recordValue(subagent?.thread_spawn);
  return stringValue(meta.parent_thread_id) ?? stringValue(threadSpawn?.parent_thread_id);
}

function claudeSpawnTombstonesForSessions(
  db: Database,
  identities: readonly SessionIdentity[],
): Pick<SessionIdentity, "tool" | "source_session_id">[] {
  const claudeSessionIds = identities
    .filter((identity) => identity.tool === "claude_code")
    .map((identity) => identity.id);
  if (claudeSessionIds.length === 0) {
    return [];
  }
  const rows = db
    .query(
      `SELECT s.id AS session_id, s.raw_meta, b.tool_use_id
       FROM session s
       JOIN block b ON b.session_id = s.id
       WHERE s.id IN (SELECT value FROM json_each(?1))
         AND s.tool = 'claude_code'
         AND b.type = 'tool_use'
         AND b.tool_name IN ('Task', 'Agent')
         AND b.tool_use_id IS NOT NULL`,
    )
    .all(JSON.stringify(claudeSessionIds)) as ClaudeSpawnRow[];
  const tombstones = new Map<string, Pick<SessionIdentity, "tool" | "source_session_id">>();
  for (const row of rows) {
    const rootSourceSessionId = claudeRootSourceSessionIdFromRawMeta(row.raw_meta);
    if (rootSourceSessionId == null) {
      continue;
    }
    const identity = claudeSpawnTombstoneIdentity(rootSourceSessionId, row.tool_use_id);
    tombstones.set(identity.source_session_id, identity);
  }
  return [...tombstones.values()];
}

function claudeSpawnToolUseIdsBySession(db: Database): Map<number, string[]> {
  const rows = db
    .query(
      `SELECT s.id AS session_id, s.raw_meta, b.tool_use_id
       FROM session s
       JOIN block b ON b.session_id = s.id
       WHERE s.tool = 'claude_code'
         AND b.type = 'tool_use'
         AND b.tool_name IN ('Task', 'Agent')
         AND b.tool_use_id IS NOT NULL`,
    )
    .all() as ClaudeSpawnRow[];
  const bySession = new Map<number, string[]>();
  for (const row of rows) {
    appendMapValue(bySession, row.session_id, row.tool_use_id);
  }
  return bySession;
}

function claudeSpawnTombstoneIdentities(
  rootSourceSessionId: string | null,
  spawnToolUseIds: readonly string[],
): Pick<SessionIdentity, "tool" | "source_session_id">[] {
  return claudeSpawnTombstoneKeys(rootSourceSessionId, spawnToolUseIds).map((sourceSessionId) => ({
    tool: CLAUDE_SPAWN_TOMBSTONE_TOOL,
    source_session_id: sourceSessionId,
  }));
}

function claudeSpawnTombstoneKeys(
  rootSourceSessionId: string | null,
  spawnToolUseIds: readonly string[],
): string[] {
  if (rootSourceSessionId == null) {
    return [];
  }
  return [
    ...new Set(
      spawnToolUseIds
        .filter((spawnToolUseId) => spawnToolUseId !== "")
        .map((spawnToolUseId) => claudeSpawnTombstoneKey(rootSourceSessionId, spawnToolUseId)),
    ),
  ];
}

function claudeSpawnTombstoneIdentity(
  rootSourceSessionId: string,
  spawnToolUseId: string,
): Pick<SessionIdentity, "tool" | "source_session_id"> {
  return {
    tool: CLAUDE_SPAWN_TOMBSTONE_TOOL,
    source_session_id: claudeSpawnTombstoneKey(rootSourceSessionId, spawnToolUseId),
  };
}

function claudeSpawnTombstoneKey(rootSourceSessionId: string, spawnToolUseId: string): string {
  return JSON.stringify([rootSourceSessionId, spawnToolUseId]);
}

function claudeRootSourceSessionIdFromRawMeta(rawMeta: string | null): string | null {
  if (rawMeta == null) {
    return null;
  }
  let meta: unknown;
  try {
    meta = JSON.parse(rawMeta) as unknown;
  } catch {
    return null;
  }
  return isRecord(meta) ? claudeRootSourceSessionId(meta) : null;
}

function claudeRootSourceSessionId(meta: Record<string, unknown>): string | null {
  return stringValue(meta.sessionId);
}

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values == null) {
    map.set(key, [value]);
  } else {
    values.push(value);
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
