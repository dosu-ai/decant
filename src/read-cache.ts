import type { Database } from "bun:sqlite";

/** Entries kept per connection; least recently used entries go first. */
export const READ_CACHE_MAX_ENTRIES = 32;

interface ReadCache {
  version: string;
  entries: Map<string, unknown>;
}

const caches = new WeakMap<Database, ReadCache>();

/**
 * Memoizes a read-only aggregate per connection until the archive changes.
 * `data_version` moves when another connection, such as a sync worker,
 * commits. `total_changes()` moves when this connection writes rows, and
 * `schema_version` moves on DDL. Any of them empties the cache before the next
 * lookup. Callers key entries by the exact SQL and parameters they run, and
 * must treat returned values as shared and read-only.
 */
export function cachedRead<T>(db: Database, key: string, compute: () => T): T {
  // total_changes() does not rewind on ROLLBACK, so a value read inside a
  // transaction could outlive the rows it saw.
  if (db.inTransaction) {
    return compute();
  }
  const version = archiveVersion(db);
  if (version == null) {
    return compute();
  }
  let cache = caches.get(db);
  if (cache == null || cache.version !== version) {
    cache = { version, entries: new Map() };
    caches.set(db, cache);
  }
  const { entries } = cache;
  if (entries.has(key)) {
    const hit = entries.get(key) as T;
    entries.delete(key);
    entries.set(key, hit);
    return hit;
  }
  const value = compute();
  entries.set(key, value);
  if (entries.size > READ_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done !== true) {
      entries.delete(oldest.value);
    }
  }
  return value;
}

/** Cache key for a statement: its SQL text plus bound parameters. */
export function statementKey(sql: string, params: readonly unknown[]): string {
  return `${sql}\u0000${JSON.stringify(params)}`;
}

function archiveVersion(db: Database): string | null {
  try {
    // Reading schema_version opens a read transaction, which refreshes
    // data_version for commits made by other connections.
    const row = db
      .query(
        `SELECT total_changes() AS changes,
                (SELECT schema_version FROM pragma_schema_version) AS schema_version,
                (SELECT data_version FROM pragma_data_version) AS data_version`,
      )
      .get() as { changes: number; schema_version: number; data_version: number } | null;
    return row == null ? null : `${row.data_version}:${row.changes}:${row.schema_version}`;
  } catch {
    return null;
  }
}
