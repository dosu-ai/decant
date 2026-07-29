import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";
import { getDecantLogger } from "./logging.ts";
import schemaSql from "./schema.sql" with { type: "text" };

/// Highest schema version this build understands. src/schema.sql is the
/// effective DDL with migrations 1..LATEST_SCHEMA_VERSION already applied
/// and is now the frozen baseline, so a fresh archive is created in one step
/// and stamped with the full migration history.
export const LATEST_SCHEMA_VERSION = 18;

const logger = getDecantLogger("db");

/// Owner-only mode for the archive and its SQLite sidecars. The transcripts
/// decant ingests sit in 0600 files under 0700 directories; the aggregate of
/// all of them must not be readable by anyone the sources were not.
const ARCHIVE_FILE_MODE = 0o600;

/// Owner-only mode for the directory holding the archive. Applied when
/// decant creates the directory; an existing directory is left as the owner
/// configured it.
export const ARCHIVE_DIR_MODE = 0o700;

/**
 * Run a synchronous write atomically without retaining Bun's cached
 * transaction wrapper statements beyond the operation. Long-lived wrappers
 * can keep SQLite connections alive after Database.close(), so core write
 * paths use explicit transaction boundaries instead.
 */
export function withImmediateTransaction<T>(db: Database, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the operation's original failure if SQLite already aborted
      // or closed the transaction.
    }
    throw error;
  }
}

/**
 * Drop Bun's cached `db.query()` statements, then close the connection.
 *
 * `Database.query()` caches its Statement on the Database. In a short-lived
 * worker, `db.close()` can therefore defer the native close until GC; calling
 * `self.close()` immediately afterward tears down the worker while SQLite still
 * owns callbacks, producing SQLITE_MISUSE and invalid-connection-pointer
 * errors. Worker paths therefore use fresh `db.prepare()` statements and
 * finalize them at the operation boundary. Bun 1.3 also exposes
 * clearQueryCache() at runtime (its bundled declaration currently omits it), so
 * clear any route-style cached statements before asking SQLite to close.
 * `close(false)` is intentional: Bun reports SQLITE_BUSY for a clean WAL
 * connection after a large sync when forced close is requested.
 */
export function closeDb(db: Database): void {
  (
    db as Database & {
      clearQueryCache: () => void;
    }
  ).clearQueryCache();
  db.close(false);
}

/**
 * Create a missing archive file owner-only, before SQLite gets the chance to
 * create it at its default 0644.
 *
 * `O_CREAT | O_EXCL` never writes through an existing name — a symlink planted
 * at the archive path fails it with EEXIST rather than being followed — and the
 * descriptor refers to an inode this call has just made, so closing it cannot
 * drop POSIX locks another SQLite connection in this process holds.
 *
 * Silent by design: the file usually exists already, and a directory decant
 * cannot write to is SQLite's error to report, not this helper's.
 */
function createArchiveFile(path: string): void {
  try {
    closeSync(
      openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, ARCHIVE_FILE_MODE),
    );
  } catch {
    // Best effort; see the doc comment.
  }
}

/**
 * Best-effort narrow of an existing archive file — the database or one of its
 * `-wal`/`-shm` sidecars — that an older decant left group- or world-readable.
 *
 * The `lstat` gate is not a security check; the two guarantees below are. It is
 * there because closing a descriptor releases *every* POSIX lock this process
 * holds on that file, which would silently strip the locks a live SQLite
 * connection in this process depends on, so a file that is already owner-only
 * is never opened at all.
 *
 * A mode change is only ever applied to a descriptor opened with `O_NOFOLLOW`,
 * so a symlink planted at a name decant is about to touch (the sidecars do not
 * exist yet on a fresh archive) fails the open with ELOOP instead of
 * redirecting the change onto its target; and the file type and ownership are
 * re-read from that same descriptor with `fstat`, so anything swapped in after
 * the `lstat` is rejected rather than chmod-ed. `O_NONBLOCK` keeps a planted
 * FIFO from parking the open.
 *
 * Silent by design: on a fresh archive the sidecars genuinely are absent, a
 * filesystem may not carry POSIX mode bits at all, and a path that turns out to
 * belong to someone else is not decant's to touch.
 */
export function restrictArchiveFile(path: string): void {
  // Windows has neither POSIX mode bits nor O_NOFOLLOW; there is nothing safe
  // (or meaningful) to do there.
  if (typeof process.getuid !== "function" || typeof constants.O_NOFOLLOW !== "number") {
    return;
  }
  const uid = process.getuid();
  let current: Stats;
  try {
    current = lstatSync(path);
  } catch {
    return;
  }
  if (!isOwnedRegularFile(current, uid) || (current.mode & 0o7777) === ARCHIVE_FILE_MODE) {
    return;
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (isOwnedRegularFile(fstatSync(fd), uid)) {
      fchmodSync(fd, ARCHIVE_FILE_MODE);
    }
  } catch {
    // Best effort; see the doc comment.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Best effort, as above: a close that fails (EIO on a network or FUSE
        // mount) must not escape a helper the archive open path calls three
        // times before SQLite ever sees the file.
      }
    }
  }
}

/// A directory, device, FIFO, or symlink at an archive name is a plant rather
/// than an archive; extra hard links mean the same inode answers to a name
/// decant knows nothing about; and another user's file is not decant's to
/// change. None of those are things chmod should be pointed at.
function isOwnedRegularFile(stats: Stats, uid: number): boolean {
  return stats.isFile() && stats.uid === uid && stats.nlink === 1;
}

/**
 * Open (or create) a decant archive and guarantee it is at
 * LATEST_SCHEMA_VERSION. The connection comes back in WAL mode with foreign
 * keys enforced and a busy timeout set.
 */
export function openDb(path: string): Database {
  // Own the file modes before SQLite touches the path: it creates a database at
  // 0644 and then copies the database file's mode onto every -wal/-shm sidecar
  // it makes, so an archive that starts owner-only stays owner-only throughout.
  createArchiveFile(path);
  restrictArchiveFile(path);
  restrictArchiveFile(`${path}-wal`);
  restrictArchiveFile(`${path}-shm`);
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
    closeDb(db);
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
      try {
        for (let version = 1; version <= LATEST_SCHEMA_VERSION; version += 1) {
          mark.run(version);
        }
      } finally {
        mark.finalize();
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
        `(${LATEST_SCHEMA_VERSION}); upgrade Decant`,
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
    if (current < 11) {
      db.exec(`
        ALTER TABLE session ADD COLUMN context_window_tokens INTEGER;
        ALTER TABLE session ADD COLUMN peak_context_tokens INTEGER;
      `);
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (11, datetime('now'))",
      ).run();
    }
    if (current < 12) {
      if (!hasColumn(db, "session", "total_cache_creation_1h_tokens")) {
        db.exec(
          "ALTER TABLE session ADD COLUMN total_cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0",
        );
      }
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (12, datetime('now'))",
      ).run();
    }
    if (current < 13) {
      if (!hasColumn(db, "session", "reasoning_effort")) {
        db.exec("ALTER TABLE session ADD COLUMN reasoning_effort TEXT");
      }
      if (!hasColumn(db, "session", "reasoning_effort_checked")) {
        db.exec(
          "ALTER TABLE session ADD COLUMN reasoning_effort_checked INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!hasColumn(db, "model_pricing", "cache_write_1h_per_mtok")) {
        db.exec("ALTER TABLE model_pricing ADD COLUMN cache_write_1h_per_mtok REAL");
      }
      db.exec(`
        UPDATE session
        SET context_window_tokens = NULL, peak_context_tokens = NULL
        WHERE tool = 'claude_code'
      `);
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (13, datetime('now'))",
      ).run();
    }
    if (current < 14) {
      if (!hasColumn(db, "session", "reasoning_effort_levels")) {
        db.exec(
          "ALTER TABLE session ADD COLUMN reasoning_effort_levels TEXT NOT NULL DEFAULT '[]'",
        );
      }
      db.exec(`
        UPDATE session
        SET reasoning_effort_levels = CASE
          WHEN reasoning_effort IS NULL
            OR TRIM(reasoning_effort) = ''
            OR LOWER(TRIM(reasoning_effort)) = 'mixed'
          THEN '[]'
          ELSE json_array(LOWER(TRIM(reasoning_effort)))
        END;

        UPDATE session
        SET reasoning_effort_checked = 0
        WHERE LOWER(TRIM(reasoning_effort)) = 'mixed';
      `);
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (14, datetime('now'))",
      ).run();
    }
    if (current < 15) {
      // Schema v14 incorrectly relabeled Claude Code's provider-supplied `max`
      // effort as `ultra`. Only archives that were already opened by a v14
      // build need repair; older archives retain their original labels while
      // migrating directly through the corrected v14 step above.
      if (current === 14) {
        db.exec(`
          UPDATE session
          SET reasoning_effort = CASE
                WHEN LOWER(TRIM(reasoning_effort)) = 'ultra' THEN 'max'
                ELSE reasoning_effort
              END,
              reasoning_effort_levels =
                REPLACE(reasoning_effort_levels, '"ultra"', '"max"')
          WHERE tool = 'claude_code'
            AND (
              LOWER(TRIM(reasoning_effort)) = 'ultra'
              OR reasoning_effort_levels LIKE '%"ultra"%'
            );
        `);
      }
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (15, datetime('now'))",
      ).run();
    }
    if (current < 16) {
      // Claude Code's dynamic-workflow runs write orchestration journals
      // (subagents/workflows/<runId>/journal.jsonl). Builds before v16 swept
      // them up as sessions with role-"other" messages; discovery now skips
      // them, and this drops the rows those builds created. Detach children
      // first: session.parent_session_id has no ON DELETE clause.
      db.exec(`
        UPDATE session SET parent_session_id = NULL
        WHERE parent_session_id IN (
          SELECT id FROM session
          WHERE source_path LIKE '%/journal.jsonl' OR source_path LIKE '%\\journal.jsonl'
        );
        DELETE FROM session
        WHERE source_path LIKE '%/journal.jsonl' OR source_path LIKE '%\\journal.jsonl';
        DELETE FROM ingest_issue
        WHERE source_path LIKE '%/journal.jsonl' OR source_path LIKE '%\\journal.jsonl';
        DELETE FROM ingest_source
        WHERE path LIKE '%/journal.jsonl' OR path LIKE '%\\journal.jsonl';
      `);
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (16, datetime('now'))",
      ).run();
    }
    if (current < 17) {
      if (!hasColumn(db, "ingest_issue", "code")) {
        // Every pre-v17 issue row was a parse failure by construction —
        // parsers emitted issues only from JSON.parse catch blocks.
        db.exec("ALTER TABLE ingest_issue ADD COLUMN code TEXT NOT NULL DEFAULT 'unparsed_line'");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_ingest_issue_source ON ingest_issue(source_path)");
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (17, datetime('now'))",
      ).run();
    }
    if (current < 18) {
      if (hasTable(db, "block")) {
        db.exec("CREATE INDEX IF NOT EXISTS idx_block_tool_use ON block(session_id, tool_use_id)");
      }
      if (hasTable(db, "recommendation") && !hasColumn(db, "recommendation", "impact_label")) {
        db.exec("ALTER TABLE recommendation ADD COLUMN impact_label TEXT");
      }
      if (
        hasTable(db, "recommendation") &&
        !hasColumn(db, "recommendation", "impact_label_checked")
      ) {
        db.exec(
          "ALTER TABLE recommendation ADD COLUMN impact_label_checked INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (hasTable(db, "block_fts") && hasTable(db, "block")) {
        const blockCount = (db.query("SELECT COUNT(*) AS n FROM block").get() as { n: number }).n;
        logger.info("Rebuilding the full-text index for prefix search.", {
          "event.name": "decant.schema.fts_rebuild",
          "schema.version": 18,
          "block.count": blockCount,
        });
        db.exec(`
          CREATE VIRTUAL TABLE block_fts_new USING fts5(
            text, tool_name, tool_input,
            content='block', content_rowid='id',
            prefix='2 3'
          );
          DROP TRIGGER IF EXISTS block_ai;
          DROP TRIGGER IF EXISTS block_ad;
          DROP TRIGGER IF EXISTS block_au;
          DROP TABLE block_fts;
          ALTER TABLE block_fts_new RENAME TO block_fts;
          CREATE TRIGGER block_ai AFTER INSERT ON block BEGIN
            INSERT INTO block_fts(rowid, text, tool_name, tool_input)
            VALUES (new.id, new.text, new.tool_name, new.tool_input);
          END;
          CREATE TRIGGER block_ad AFTER DELETE ON block BEGIN
            INSERT INTO block_fts(block_fts, rowid, text, tool_name, tool_input)
            VALUES ('delete', old.id, old.text, old.tool_name, old.tool_input);
          END;
          CREATE TRIGGER block_au AFTER UPDATE ON block BEGIN
            INSERT INTO block_fts(block_fts, rowid, text, tool_name, tool_input)
            VALUES ('delete', old.id, old.text, old.tool_name, old.tool_input);
            INSERT INTO block_fts(rowid, text, tool_name, tool_input)
            VALUES (new.id, new.text, new.tool_name, new.tool_input);
          END;
          INSERT INTO block_fts(block_fts) VALUES('rebuild');
        `);
      }
      if (hasTable(db, "tool_call")) {
        if (!hasColumn(db, "tool_call", "input_bytes")) {
          db.exec("ALTER TABLE tool_call ADD COLUMN input_bytes INTEGER");
        }
        if (!hasColumn(db, "tool_call", "has_result")) {
          db.exec("ALTER TABLE tool_call ADD COLUMN has_result INTEGER");
        }
        db.exec(`
          UPDATE tool_call
          SET input_bytes = length(CAST(input AS BLOB))
          WHERE input_bytes IS NULL
            AND input IS NOT NULL;
          UPDATE tool_call
          SET has_result = CASE WHEN result_block_id IS NULL THEN 0 ELSE 1 END
          WHERE has_result IS NULL;
        `);
        if (
          hasColumn(db, "tool_call", "duration_ms") &&
          hasTable(db, "block") &&
          hasTable(db, "message")
        ) {
          db.exec(`
            UPDATE tool_call
            SET duration_ms = (
              SELECT CASE
                WHEN result_message.timestamp IS NOT NULL
                  AND COALESCE(call_message.timestamp, tool_call.timestamp) IS NOT NULL
                  AND julianday(result_message.timestamp) >=
                    julianday(COALESCE(call_message.timestamp, tool_call.timestamp))
                THEN CAST(ROUND(
                  (julianday(result_message.timestamp) -
                    julianday(COALESCE(call_message.timestamp, tool_call.timestamp)))
                  * 86400000
                ) AS INTEGER)
                ELSE NULL
              END
              FROM block AS result_block
              JOIN message AS result_message ON result_message.id = result_block.message_id
              LEFT JOIN message AS call_message ON call_message.id = tool_call.message_id
              WHERE result_block.id = tool_call.result_block_id
            )
            WHERE duration_ms IS NULL
              AND result_block_id IS NOT NULL;
          `);
        }
      }
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (18, datetime('now'))",
      ).run();
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function hasTable(db: Database, table: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1").get(table) !=
    null
  );
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (
    db.query("SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2 LIMIT 1").get(table, column) !=
    null
  );
}
