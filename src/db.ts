import { Database } from "bun:sqlite";
import schemaSql from "./schema.sql" with { type: "text" };

/// Highest schema version this build understands. src/schema.sql is the
/// effective DDL with migrations 1..LATEST_SCHEMA_VERSION already applied
/// and is now the frozen baseline, so a fresh archive is created in one step
/// and stamped with the full migration history.
export const LATEST_SCHEMA_VERSION = 10;

/**
 * Open (or create) a decant archive and guarantee it is at
 * LATEST_SCHEMA_VERSION. The connection comes back in WAL mode with foreign
 * keys enforced and a busy timeout set.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA journal_mode = WAL;");
  // Memory-map reads: archives grow to multiple GB and large scans (FTS, block
  // aggregation) measure 2-7x faster via mmap than via pread on such files.
  db.exec("PRAGMA mmap_size = 1073741824;");
  try {
    ensureSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function ensureSchema(db: Database): void {
  const hasMigrations = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();

  if (!hasMigrations) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(schemaSql);
      const mark = db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, datetime('now'))",
      );
      for (let version = 1; version <= LATEST_SCHEMA_VERSION; version += 1) {
        mark.run(version);
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
    return;
  }

  const current =
    (db.query("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null }).v ??
    0;
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `archive schema version ${current} is newer than this build supports ` +
        `(${LATEST_SCHEMA_VERSION}); upgrade decant`,
    );
  }
  if (current < 8) {
    throw new Error(
      `archive schema version ${current} predates this build's baseline ` +
        "(8); rebuild the archive: delete it and re-ingest " +
        "(ingest is idempotent over the source directories)",
    );
  }
  if (current < LATEST_SCHEMA_VERSION) {
    migrate(db, current);
  }
}

function migrate(db: Database, current: number): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (current < 9) {
      db.exec(`
        ALTER TABLE session ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE session ADD COLUMN parent_session_id INTEGER REFERENCES session(id);
        ALTER TABLE session ADD COLUMN spawn_tool_use_id TEXT;
        ALTER TABLE session ADD COLUMN agent_id TEXT;
        ALTER TABLE session ADD COLUMN agent_type TEXT;
        ALTER TABLE session ADD COLUMN spawn_depth INTEGER;
        CREATE INDEX idx_session_parent ON session(parent_session_id);
        CREATE INDEX idx_session_spawn_tooluse ON session(spawn_tool_use_id);
      `);
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (9, datetime('now'))",
      ).run();
    }
    if (current < 10) {
      db.exec(`
        CREATE TABLE session_economics (
          session_id INTEGER PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
          format_version INTEGER NOT NULL,
          vector_json TEXT NOT NULL,
          computed_at TEXT NOT NULL
        );
      `);
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (10, datetime('now'))",
      ).run();
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
