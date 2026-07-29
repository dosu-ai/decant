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
import {
  buildSchemaManifest,
  compareSchemaManifests,
  type SchemaDifference,
  type SchemaManifest,
} from "./schema-manifest.ts";

/// Highest schema version this build understands. src/schema.sql is the
/// effective DDL with migrations 1..LATEST_SCHEMA_VERSION already applied
/// and is now the frozen baseline, so a fresh archive is created in one step
/// and stamped with the full migration history.
export const LATEST_SCHEMA_VERSION = 20;

const logger = getDecantLogger("db");
let expectedSchemaManifest: SchemaManifest | null = null;
const SQLITE_BUSY_RETRY_SIGNAL = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

export class SchemaDriftError extends Error {
  readonly code = "schema_drift";

  constructor(
    message: string,
    readonly expectedFingerprint: string,
    readonly actualFingerprint: string,
    readonly differences: SchemaDifference,
  ) {
    super(message);
    this.name = "SchemaDriftError";
  }
}

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
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA synchronous = NORMAL;");
    negotiateWalMode(db);
    // Memory-map reads: archives grow to multiple GB and large scans (FTS, block
    // aggregation) measure 2-7x faster via mmap than via pread on such files.
    db.exec("PRAGMA mmap_size = 1073741824;");
    ensureSchema(db);
  } catch (error) {
    closeDb(db);
    throw error;
  }
  return db;
}

function negotiateWalMode(db: Database): void {
  try {
    const current = db.query("PRAGMA journal_mode;").get() as {
      journal_mode?: unknown;
    } | null;
    if (typeof current?.journal_mode === "string" && current.journal_mode.toLowerCase() === "wal") {
      return;
    }
  } catch {
    // Fall through to the write pragma, which retains the bounded contention
    // retry and surfaces any persistent failure.
  }

  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (error) {
      if (!isSqliteContention(error) || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(
        SQLITE_BUSY_RETRY_SIGNAL,
        0,
        0,
        Math.min(10, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function isSqliteContention(error: unknown): boolean {
  const code =
    typeof error === "object" && error != null && "code" in error
      ? String((error as { code?: unknown }).code).toUpperCase()
      : "";
  return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

function ensureSchema(db: Database): void {
  const hasMigrations = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();

  if (!hasMigrations) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      // A second opener can observe the same empty schema before either takes
      // the write lock. Re-check under the lock so only one creates the
      // baseline; the waiter validates what won the race instead of replaying
      // CREATE TABLE statements over it.
      if (hasTable(db, "schema_migrations")) {
        const versions = readMigrationHistory(db);
        const current = versions.at(-1) ?? 0;
        if (current > LATEST_SCHEMA_VERSION) {
          throw new Error(
            `archive schema version ${current} is newer than this build supports ` +
              `(${LATEST_SCHEMA_VERSION}); upgrade Decant`,
          );
        }
        if (current < 8) {
          throw new Error(
            `archive schema version ${current} predates this build's baseline ` +
              "(8); back up or move the archive aside before rebuilding it because " +
              "manual recommendation state and source-pruned sessions may exist only in the database; " +
              "then re-ingest from the source directories",
          );
        }
        assertVersionSequence(db, versions, current);
        if (current === LATEST_SCHEMA_VERSION) {
          assertSchemaMatchesBaseline(db);
        }
        db.exec("COMMIT;");
        if (current < LATEST_SCHEMA_VERSION) {
          migrate(db, current);
        }
        return;
      }
      const existingObjects = schemaObjectNames(db);
      if (existingObjects.length > 0) {
        throwSchemaDrift(
          db,
          `schema_migrations is missing from a non-empty database (${summarize(existingObjects)})`,
        );
      }
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
      assertSchemaMatchesBaseline(db);
      assertContiguousMigrationHistory(db, LATEST_SCHEMA_VERSION);
      db.exec("COMMIT;");
    } catch (error) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // A concurrent initializer may have committed before handing a
        // lower-version winner to migrate(); never mask that later error with
        // "cannot rollback - no transaction is active".
      }
      throw error;
    }
    return;
  }

  const versions = readMigrationHistory(db);
  const current = versions.at(-1) ?? 0;
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `archive schema version ${current} is newer than this build supports ` +
        `(${LATEST_SCHEMA_VERSION}); upgrade Decant`,
    );
  }
  if (current < 8) {
    throw new Error(
      `archive schema version ${current} predates this build's baseline ` +
        "(8); back up or move the archive aside before rebuilding it because " +
        "manual recommendation state and source-pruned sessions may exist only in the database; " +
        "then re-ingest from the source directories",
    );
  }
  assertVersionSequence(db, versions, current);
  if (current < LATEST_SCHEMA_VERSION) {
    migrate(db, current);
    return;
  }
  assertSchemaMatchesBaseline(db);
}

function migrate(db: Database, current: number): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    // Another process may have completed the migration while this connection
    // waited for SQLite's write lock. Re-read under the lock so each version is
    // applied and stamped at most once.
    const lockedVersions = readMigrationHistory(db);
    const lockedCurrent = lockedVersions.at(-1) ?? 0;
    if (lockedCurrent > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `archive schema version ${lockedCurrent} is newer than this build supports ` +
          `(${LATEST_SCHEMA_VERSION}); upgrade Decant`,
      );
    }
    if (lockedCurrent < 8) {
      throw new Error(
        `archive schema version ${lockedCurrent} predates this build's baseline ` +
          "(8); back up or move the archive aside before rebuilding it because " +
          "manual recommendation state and source-pruned sessions may exist only in the database; " +
          "then re-ingest from the source directories",
      );
    }
    assertVersionSequence(db, lockedVersions, lockedCurrent);
    current = lockedCurrent;
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
    if (current < 19) {
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
      if (
        hasTable(db, "tool_call") &&
        hasColumn(db, "tool_call", "duration_ms") &&
        hasTable(db, "block") &&
        hasTable(db, "message")
      ) {
        // The final v18 review also taught the duration backfill to fall back
        // to tool_call.timestamp when old rows have no linked call message.
        // Archives that stamped the earlier v18 need that repair replayed.
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
            AND result_block_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM block AS result_block
              JOIN message AS result_message ON result_message.id = result_block.message_id
              LEFT JOIN message AS call_message ON call_message.id = tool_call.message_id
              WHERE result_block.id = tool_call.result_block_id
                AND result_message.timestamp IS NOT NULL
                AND COALESCE(call_message.timestamp, tool_call.timestamp) IS NOT NULL
                AND julianday(result_message.timestamp) >=
                  julianday(COALESCE(call_message.timestamp, tool_call.timestamp))
            );
        `);
      }
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (19, datetime('now'))",
      ).run();
    }
    if (current < 20) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_user_state (
          tool TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('archived', 'deleted')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (tool, source_session_id)
        );
      `);
      db.query(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (20, datetime('now'))",
      ).run();
    }
    assertSchemaMatchesBaseline(db);
    assertContiguousMigrationHistory(db, LATEST_SCHEMA_VERSION);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration failure if SQLite already aborted or closed
      // the transaction, or if rollback itself encounters a secondary error.
    }
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

function readMigrationHistory(db: Database): number[] {
  try {
    return (
      db.query("SELECT version, applied_at FROM schema_migrations ORDER BY version").all() as {
        version: number;
        applied_at: string;
      }[]
    ).map((row) => row.version);
  } catch {
    throwSchemaDrift(db, "schema_migrations is malformed or unreadable");
  }
}

function assertVersionSequence(db: Database, versions: number[], current: number): void {
  const expected = Array.from({ length: current }, (_, index) => index + 1);
  if (
    versions.length !== expected.length ||
    versions.some((version, index) => version !== expected[index])
  ) {
    throwSchemaDrift(
      db,
      `schema_migrations is non-contiguous; expected versions 1..${current}, found ${summarize(
        versions.map(String),
      )}`,
    );
  }
}

function assertContiguousMigrationHistory(db: Database, current: number): void {
  assertVersionSequence(db, readMigrationHistory(db), current);
}

function assertSchemaMatchesBaseline(db: Database): void {
  const expected = getExpectedSchemaManifest();
  const actual = buildSchemaManifest(db);
  if (actual.fingerprint === expected.fingerprint) {
    return;
  }
  const differences = compareSchemaManifests(expected, actual);
  const hasFatalDifference =
    differences.missingObjects.length > 0 ||
    differences.changedObjects.length > 0 ||
    differences.missingColumns.length > 0 ||
    differences.unexpectedColumns.length > 0;
  if (!hasFatalDifference && differences.unexpectedObjects.length > 0) {
    logger.warning("Archive includes additive operator-owned schema objects.", {
      "event.name": "decant.schema.additive_drift",
      "schema.version": LATEST_SCHEMA_VERSION,
      "schema.fingerprint.expected": expected.fingerprint,
      "schema.fingerprint.actual": actual.fingerprint,
      "schema.drift.unexpected_objects": summarize(differences.unexpectedObjects),
    });
    return;
  }
  throwSchemaDrift(
    db,
    `owned schema objects differ from the v${LATEST_SCHEMA_VERSION} baseline`,
    expected,
    actual,
  );
}

function getExpectedSchemaManifest(): SchemaManifest {
  if (expectedSchemaManifest != null) {
    return expectedSchemaManifest;
  }
  const expectedDb = new Database(":memory:", { strict: true });
  try {
    expectedDb.exec(schemaSql);
    expectedSchemaManifest = buildSchemaManifest(expectedDb);
    return expectedSchemaManifest;
  } finally {
    expectedDb.close();
  }
}

function throwSchemaDrift(
  db: Database,
  reason: string,
  expected = getExpectedSchemaManifest(),
  actual = buildSchemaManifest(db),
): never {
  const differences = compareSchemaManifests(expected, actual);
  const detail = [
    reason,
    describeDifference("missing columns", differences.missingColumns),
    describeDifference("unexpected columns", differences.unexpectedColumns),
    describeDifference("missing objects", differences.missingObjects),
    describeDifference("unexpected objects", differences.unexpectedObjects),
    describeDifference("changed objects", differences.changedObjects),
  ]
    .filter((part): part is string => part != null)
    .join("; ");
  const recovery =
    "Back up or move the archive aside before recovery because manual recommendation state and " +
    "source-pruned sessions may exist only in the database. If the source transcripts are complete, " +
    "rebuild by moving the archive aside and re-ingesting them.";
  const message = `archive schema drift at version ${LATEST_SCHEMA_VERSION}: ${detail}. ${recovery}`;
  const error = new SchemaDriftError(
    message,
    expected.fingerprint,
    actual.fingerprint,
    differences,
  );
  logger.error("Archive schema does not match this build.", {
    "event.name": "decant.schema.drift",
    "schema.version": LATEST_SCHEMA_VERSION,
    "schema.fingerprint.expected": expected.fingerprint,
    "schema.fingerprint.actual": actual.fingerprint,
    "schema.drift.reason": reason,
    "schema.drift.missing_columns": summarize(differences.missingColumns),
    "schema.drift.unexpected_columns": summarize(differences.unexpectedColumns),
    "schema.drift.missing_objects": summarize(differences.missingObjects),
    "schema.drift.unexpected_objects": summarize(differences.unexpectedObjects),
    "schema.drift.changed_objects": summarize(differences.changedObjects),
    "error.type": error.name,
    "error.message": error.message,
    "recovery.action": "back_up_then_rebuild_from_complete_sources",
  });
  throw error;
}

function schemaObjectNames(db: Database): string[] {
  return (
    db
      .query(
        `SELECT type || ':' || name AS object
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         ORDER BY type, name`,
      )
      .all() as { object: string }[]
  ).map((row) => row.object);
}

function describeDifference(label: string, values: string[]): string | null {
  return values.length === 0 ? null : `${label}: ${summarize(values)}`;
}

function summarize(values: string[], limit = 8): string {
  const shown = values.slice(0, limit).map(sanitizeDiagnosticItem);
  const suffix = values.length > limit ? `, and ${values.length - limit} more` : "";
  return truncateDiagnostic(`${shown.join(", ")}${suffix}`, 384);
}

function sanitizeDiagnosticItem(value: string): string {
  return truncateDiagnostic(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "�"), 96);
}

function truncateDiagnostic(value: string, limit: number): string {
  const characters = [...value];
  if (characters.length <= limit) {
    return value;
  }
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}
