import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resetSync } from "@logtape/logtape";
import {
  closeDb,
  LATEST_SCHEMA_VERSION,
  openDb,
  restrictArchiveFile,
  SchemaDriftError,
} from "../src/db.ts";
import { configureLogging } from "../src/logging.ts";
import schemaSql from "../src/schema.sql" with { type: "text" };
import { buildSchemaManifest } from "../src/schema-manifest.ts";
import { sessionUserStatePredicateForDatabase } from "../src/session-user-state.ts";
import { visibleSessionPredicate } from "../src/session-visibility.ts";
import schemaV8Sql from "./fixtures/schema-v8.sql" with { type: "text" };

const workDir = mkdtempSync(join(tmpdir(), "decant-db-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshPath(): string {
  dbCounter += 1;
  return join(workDir, `archive-${dbCounter}.db`);
}

async function waitForFiles(paths: string[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${paths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function historicalArchive(path: string, version: 8 | 9 | 12 | 13 | 14): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec(schemaV8Sql);
  const mark = db.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, datetime('now'))",
  );
  for (let applied = 1; applied <= 8; applied += 1) {
    mark.run(applied);
  }
  if (version >= 9) {
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
    mark.run(9);
  }
  if (version >= 12) {
    db.exec(`
      CREATE TABLE session_economics (
        session_id INTEGER PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
        format_version INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        computed_at TEXT NOT NULL
      );
      ALTER TABLE session ADD COLUMN context_window_tokens INTEGER;
      ALTER TABLE session ADD COLUMN peak_context_tokens INTEGER;
      ALTER TABLE session ADD COLUMN total_cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0;
    `);
    mark.run(10);
    mark.run(11);
    mark.run(12);
  }
  if (version >= 13) {
    db.exec(`
      ALTER TABLE session ADD COLUMN reasoning_effort TEXT;
      ALTER TABLE session ADD COLUMN reasoning_effort_checked INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE model_pricing ADD COLUMN cache_write_1h_per_mtok REAL;
    `);
    mark.run(13);
  }
  if (version >= 14) {
    db.exec("ALTER TABLE session ADD COLUMN reasoning_effort_levels TEXT NOT NULL DEFAULT '[]'");
    mark.run(14);
  }
  mark.finalize();
  return db;
}

// Inventory of the frozen schema baseline. Shadow tables
// of block_fts are excluded; they are implementation details of FTS5.
const BASELINE_TABLES = [
  "block",
  "block_fts",
  "file_ref",
  "ingest_issue",
  "ingest_source",
  "message",
  "model_pricing",
  "project",
  "recommendation",
  "schema_migrations",
  "session",
  "session_economics",
  "session_user_state",
  "tool_call",
];
const BASELINE_TRIGGERS = ["block_ad", "block_ai", "block_au"];
const BASELINE_INDEX_COUNT = 27;

function inventory(db: Database, type: string): string[] {
  return (
    db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = ?1 AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
           AND NOT (name GLOB 'block_fts_*')
         ORDER BY name`,
      )
      .all(type) as { name: string }[]
  ).map((r) => r.name);
}

describe("openDb", () => {
  test("generated schema header agrees with LATEST_SCHEMA_VERSION", () => {
    const match = /^-- decant:schema_version=(\d+)$/m.exec(schemaSql);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(LATEST_SCHEMA_VERSION);
  });

  test("creates a fresh archive with stable connection pragmas", () => {
    const db = openDb(freshPath());
    expect((db.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    expect((db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(1);
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "wal",
    );
    expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    db.close();
  });

  test("creates the exact baseline inventory of tables, triggers, and indexes", () => {
    const db = openDb(freshPath());
    expect(inventory(db, "table")).toEqual(BASELINE_TABLES);
    expect(inventory(db, "trigger")).toEqual(BASELINE_TRIGGERS);
    expect(inventory(db, "index")).toHaveLength(BASELINE_INDEX_COUNT);
    const toolCallColumns = (
      db.query("SELECT name FROM pragma_table_info('tool_call')").all() as { name: string }[]
    ).map((column) => column.name);
    expect(toolCallColumns).toEqual(expect.arrayContaining(["input_bytes", "has_result"]));
    expect(
      db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_block_tool_use'")
        .get(),
    ).not.toBeNull();
    expect(
      (
        db.query("SELECT name FROM pragma_table_info('recommendation')").all() as { name: string }[]
      ).map((column) => column.name),
    ).toEqual(expect.arrayContaining(["impact_label", "impact_label_checked"]));
    const ftsSql = (
      db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'block_fts'")
        .get() as { sql: string }
    ).sql;
    expect(ftsSql).toContain("prefix='2 3'");
    db.close();
  });

  test("adds the ingest revision checkpoint when upgrading a v21 archive", () => {
    const path = freshPath();
    const legacy = openDb(path);
    legacy
      .query(
        `INSERT INTO ingest_source(path, tool, size, mtime, hash, status)
         VALUES ('/tmp/legacy.jsonl', 'codex', 10, 20, 'legacy-hash', 'ok')`,
      )
      .run();
    const hasRevision =
      legacy
        .query(
          `SELECT 1 FROM pragma_table_info('ingest_source')
           WHERE name = 'ingest_revision'`,
        )
        .get() != null;
    if (hasRevision) {
      legacy.exec("ALTER TABLE ingest_source DROP COLUMN ingest_revision");
    }
    legacy.exec("DELETE FROM schema_migrations WHERE version > 21");
    legacy.close();

    const migrated = openDb(path);
    expect(
      migrated
        .query(
          `SELECT name, type, "notnull" AS is_not_null, dflt_value
           FROM pragma_table_info('ingest_source')
           WHERE name = 'ingest_revision'`,
        )
        .get(),
    ).toEqual({ name: "ingest_revision", type: "INTEGER", is_not_null: 1, dflt_value: "0" });
    expect(
      migrated
        .query("SELECT ingest_revision FROM ingest_source WHERE path = '/tmp/legacy.jsonl'")
        .get(),
    ).toEqual({ ingest_revision: 0 });
    migrated.close();
  });

  test("adds the tool-call paging index when upgrading a v22 archive", () => {
    // listToolCalls orders by (timestamp DESC, id DESC). Without this index
    // SQLite sorts every tool call in a temp b-tree to return a page of fifty,
    // drawing a random `message` row per call on the way.
    const path = freshPath();
    const legacy = openDb(path);
    legacy.exec("DROP INDEX IF EXISTS idx_toolcall_timestamp");
    legacy.exec("DELETE FROM schema_migrations WHERE version > 22");
    closeDb(legacy);

    const migrated = openDb(path);
    const index = migrated
      .query(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_toolcall_timestamp'",
      )
      .get() as { sql: string } | null;
    expect(index).not.toBeNull();
    expect(index?.sql).toContain("timestamp DESC");
    expect(index?.sql).toContain("id DESC");
    closeDb(migrated);
  });

  test("serves the tool-call page order from an index rather than a sort", () => {
    // Covers the unfiltered shape only; a tool_name or project filter picks a
    // different index.
    const db = openDb(freshPath());
    const where = [
      visibleSessionPredicate("s"),
      sessionUserStatePredicateForDatabase(db, "s"),
    ].join(" AND ");
    const plan = (
      db
        .query(
          `EXPLAIN QUERY PLAN
           SELECT t.id, s.title, p.path, m.seq
           FROM tool_call t
           JOIN session s ON s.id = t.session_id
           LEFT JOIN project p ON p.id = s.project_id
           LEFT JOIN message m ON m.id = t.message_id
           WHERE ${where}
           ORDER BY t.timestamp DESC, t.id DESC
           LIMIT 50`,
        )
        .all() as { detail: string }[]
    )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("idx_toolcall_timestamp");
    expect(plan).not.toContain("TEMP B-TREE");
    closeDb(db);
  });

  test("creates durable user state keyed by source identity", () => {
    const db = openDb(freshPath());
    const columns = db
      .query(
        `SELECT name, type, "notnull" AS is_not_null, pk
         FROM pragma_table_info('session_user_state')
         ORDER BY cid`,
      )
      .all();
    expect(columns).toEqual([
      { name: "tool", type: "TEXT", is_not_null: 1, pk: 1 },
      { name: "source_session_id", type: "TEXT", is_not_null: 1, pk: 2 },
      { name: "state", type: "TEXT", is_not_null: 1, pk: 0 },
      { name: "updated_at", type: "TEXT", is_not_null: 1, pk: 0 },
    ]);
    expect(() =>
      db
        .query(
          `INSERT INTO session_user_state(tool, source_session_id, state, updated_at)
           VALUES ('codex', 'invalid-state', 'visible', datetime('now'))`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  test("records schema_migrations 1..LATEST_SCHEMA_VERSION", () => {
    const db = openDb(freshPath());
    const versions = (
      db.query("SELECT version FROM schema_migrations ORDER BY version").all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    expect(versions).toEqual(
      Array.from({ length: LATEST_SCHEMA_VERSION }, (_, index) => index + 1),
    );
    const nullTimestamps = db
      .query("SELECT COUNT(*) AS n FROM schema_migrations WHERE applied_at IS NULL")
      .get() as { n: number };
    expect(nullTimestamps.n).toBe(0);
    db.close();
  });

  test("is idempotent: reopening an existing archive changes nothing", () => {
    const path = freshPath();
    openDb(path).close();
    const db = openDb(path);
    const count = db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    expect(count.n).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  test("does not renegotiate journal mode when reopening an already-WAL archive", () => {
    const path = freshPath();
    openDb(path).close();
    const originalExec = Database.prototype.exec;
    const journalModeWrites: string[] = [];
    Database.prototype.exec = function (this: Database, sql: string) {
      if (/^\s*PRAGMA\s+journal_mode\s*=/i.test(sql)) {
        journalModeWrites.push(sql);
      }
      return originalExec.call(this, sql);
    } as Database["exec"];
    try {
      openDb(path).close();
    } finally {
      Database.prototype.exec = originalExec;
    }
    expect(journalModeWrites).toEqual([]);
  });

  test("reopens an already-WAL archive while another connection holds the write lock", () => {
    const path = freshPath();
    openDb(path).close();
    const writer = new Database(path, { strict: true });
    writer.exec("BEGIN IMMEDIATE;");
    try {
      const reopened = openDb(path);
      expect(
        (reopened.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      ).toBe("wal");
      reopened.close();
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
  });

  test("serializes two processes creating the same fresh archive", async () => {
    const dbModule = pathToFileURL(join(import.meta.dir, "..", "src", "db.ts")).href;
    const script = `
      import { existsSync, writeFileSync } from "node:fs";
      import { openDb } from ${JSON.stringify(dbModule)};
      const path = process.env.DECANT_RACE_DB;
      const ready = process.env.DECANT_RACE_READY;
      const gate = process.env.DECANT_RACE_GATE;
      if (path == null || ready == null || gate == null) throw new Error("missing race fixture");
      writeFileSync(ready, "");
      while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 1));
      openDb(path).close();
    `;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const path = freshPath();
      const gate = `${path}.go`;
      const readyPaths = [`${path}.ready-1`, `${path}.ready-2`];
      const children = readyPaths.map((ready) =>
        Bun.spawn([process.execPath, "-e", script], {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...process.env,
            DECANT_RACE_DB: path,
            DECANT_RACE_READY: ready,
            DECANT_RACE_GATE: gate,
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      try {
        await waitForFiles(readyPaths);
      } finally {
        writeFileSync(gate, "");
      }
      const exits = await Promise.all(children.map((child) => child.exited));
      const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()));
      expect({ attempt, exits, errors }).toEqual({
        attempt,
        exits: [0, 0],
        errors: ["", ""],
      });

      const db = openDb(path);
      expect(db.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: LATEST_SCHEMA_VERSION,
      });
      db.close();
    }
  });

  test("finalizes cached query statements before closing a worker-style connection", () => {
    const db = openDb(freshPath());
    const cached = db.query("SELECT 1 AS value");
    expect(cached.get()).toEqual({ value: 1 });

    closeDb(db);

    expect(() => cached.get()).toThrow(/finalized/i);
  });

  test("keeps block_fts in sync through insert, update, and delete triggers", () => {
    const db = openDb(freshPath());
    db.exec(`
      INSERT INTO session (id, tool, source_session_id) VALUES (1, 'claude', 'abc');
      INSERT INTO message (id, session_id, seq, raw) VALUES (10, 1, 0, '{}');
      INSERT INTO block (id, message_id, session_id, ordinal, type, text)
        VALUES (100, 10, 1, 0, 'text', 'porting decant to typescript');
    `);

    const match = (q: string) =>
      db
        .query(
          `SELECT b.id, bm25(block_fts) AS rank, highlight(block_fts, 0, '[', ']') AS hl
           FROM block_fts JOIN block b ON b.id = block_fts.rowid
           WHERE block_fts MATCH ?1 ORDER BY rank`,
        )
        .all(q) as { id: number; rank: number; hl: string }[];

    expect(match("typescript")).toMatchObject([{ id: 100, hl: "porting decant to [typescript]" }]);

    db.exec("UPDATE block SET text = 'nothing to see here' WHERE id = 100");
    expect(match("typescript")).toHaveLength(0);
    expect(match("nothing")).toHaveLength(1);

    db.exec("DELETE FROM block WHERE id = 100");
    expect(match("nothing")).toHaveLength(0);
    db.close();
  });

  test("enforces foreign keys on the write path", () => {
    const db = openDb(freshPath());
    expect(() =>
      db.exec("INSERT INTO message (session_id, seq, raw) VALUES (999, 0, '{}')"),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  test("rejects an archive from a newer schema than this build understands", () => {
    const path = freshPath();
    const db = openDb(path);
    db.exec(
      `INSERT INTO schema_migrations (version, applied_at)
       VALUES (${LATEST_SCHEMA_VERSION + 1}, datetime('now'))`,
    );
    db.close();
    expect(() => openDb(path)).toThrow(/newer/i);
    const reopened = new Database(path, { strict: true });
    expect(() => reopened.exec("BEGIN IMMEDIATE; ROLLBACK;")).not.toThrow();
    reopened.close();
  });

  test("migrates a v8 archive through the latest version", () => {
    const path = freshPath();
    historicalArchive(path, 8).close();

    const migrated = openDb(path);
    expect(
      (
        migrated.query("SELECT MAX(version) AS version FROM schema_migrations").get() as {
          version: number;
        }
      ).version,
    ).toBe(LATEST_SCHEMA_VERSION);
    expect(inventory(migrated, "index")).toContain("idx_session_parent");
    expect(inventory(migrated, "table")).toContain("session_economics");
    const sessionColumns = migrated
      .query("SELECT name FROM pragma_table_info('session')")
      .all() as { name: string }[];
    expect(sessionColumns.map((column) => column.name)).toContain("peak_context_tokens");
    expect(sessionColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "total_cache_creation_1h_tokens",
        "reasoning_effort",
        "reasoning_effort_levels",
        "reasoning_effort_checked",
      ]),
    );
    const pricingColumns = migrated
      .query("SELECT name FROM pragma_table_info('model_pricing')")
      .all() as { name: string }[];
    expect(pricingColumns.map((column) => column.name)).toContain("cache_write_1h_per_mtok");
    migrated.close();
  });

  test("replaying migrations from v8 is schema-equivalent to the latest baseline", () => {
    const migratedPath = freshPath();
    const legacy = historicalArchive(migratedPath, 8);
    legacy.exec(`
      INSERT INTO recommendation (
        key, kind, title, score, status, note, first_seen_at, updated_at
      ) VALUES (
        'signal:v8-preserved', 'signal', 'Preserved from v8', 7, 'open',
        'manual state', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z'
      )
    `);
    legacy.close();

    const migrated = openDb(migratedPath);
    const baseline = openDb(freshPath());
    expect(buildSchemaManifest(migrated)).toEqual(buildSchemaManifest(baseline));
    expect(
      migrated
        .query(
          `SELECT dflt_value FROM pragma_table_info('recommendation')
           WHERE name = 'impact_label_checked'`,
        )
        .get(),
    ).toEqual({ dflt_value: "0" });
    expect(
      baseline
        .query(
          `SELECT dflt_value FROM pragma_table_info('recommendation')
           WHERE name = 'impact_label_checked'`,
        )
        .get(),
    ).toEqual({ dflt_value: "1" });
    expect(
      migrated
        .query(
          `SELECT note, impact_label, impact_label_checked
           FROM recommendation WHERE key = 'signal:v8-preserved'`,
        )
        .get(),
    ).toEqual({
      note: "manual state",
      impact_label: null,
      impact_label_checked: 0,
    });
    migrated.close();
    baseline.close();
  });

  test("migrates a v9 archive to the persisted economics cache", () => {
    const path = freshPath();
    historicalArchive(path, 9).close();

    const migrated = openDb(path);
    expect(inventory(migrated, "table")).toContain("session_economics");
    expect(
      (
        migrated.query("SELECT MAX(version) AS version FROM schema_migrations").get() as {
          version: number;
        }
      ).version,
    ).toBe(LATEST_SCHEMA_VERSION);
    migrated.close();
  });

  test("migrates v19 archives to durable session user state without changing sessions", () => {
    const path = freshPath();
    const old = openDb(path);
    old.exec(`
      INSERT INTO session(id, tool, source_session_id, title)
      VALUES (1, 'codex', 'preserved-v19', 'Preserved');
      DROP TABLE session_user_state;
      DELETE FROM schema_migrations WHERE version >= 20;
    `);
    old.close();

    const migrated = openDb(path);
    expect(
      migrated.query("SELECT tool, source_session_id, title FROM session WHERE id = 1").get(),
    ).toEqual({
      tool: "codex",
      source_session_id: "preserved-v19",
      title: "Preserved",
    });
    expect(inventory(migrated, "table")).toContain("session_user_state");
    expect(
      (
        migrated.query("SELECT MAX(version) AS version FROM schema_migrations").get() as {
          version: number;
        }
      ).version,
    ).toBe(LATEST_SCHEMA_VERSION);
    migrated.close();
  });

  test("migrates archives that ran the never-committed context_compaction_count variant", () => {
    const path = freshPath();
    const old = openDb(path);
    old.exec(`
      INSERT INTO session(id, tool, source_session_id, title)
      VALUES (1, 'claude_code', 'preserved-drift', 'Preserved');
      ALTER TABLE session ADD COLUMN context_compaction_count INTEGER;
      UPDATE session SET context_compaction_count = 1 WHERE id = 1;
      DROP TABLE session_user_state;
      DELETE FROM schema_migrations WHERE version >= 19;
    `);
    old.close();

    const migrated = openDb(path);
    const baseline = openDb(freshPath());
    expect(buildSchemaManifest(migrated)).toEqual(buildSchemaManifest(baseline));
    expect(
      migrated
        .query("SELECT 1 FROM pragma_table_info('session') WHERE name = 'context_compaction_count'")
        .get(),
    ).toBeNull();
    expect(
      migrated.query("SELECT tool, source_session_id, title FROM session WHERE id = 1").get(),
    ).toEqual({
      tool: "claude_code",
      source_session_id: "preserved-drift",
      title: "Preserved",
    });
    expect(
      (
        migrated.query("SELECT MAX(version) AS version FROM schema_migrations").get() as {
          version: number;
        }
      ).version,
    ).toBe(LATEST_SCHEMA_VERSION);
    migrated.close();
    baseline.close();
  });

  test("migrates v12 archives and invalidates stale Claude context-window rollups", () => {
    const path = freshPath();
    const db = historicalArchive(path, 12);
    db.exec(`
      INSERT INTO session(
        id, tool, source_session_id, context_window_tokens, peak_context_tokens
      ) VALUES
        (1, 'claude_code', 'claude-old-rollup', 200000, 120000),
        (2, 'codex', 'codex-explicit-rollup', 258400, 120000);
    `);
    db.close();

    const migrated = openDb(path);
    expect(
      migrated
        .query(
          `SELECT tool, context_window_tokens, peak_context_tokens
           FROM session ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { tool: "claude_code", context_window_tokens: null, peak_context_tokens: null },
      { tool: "codex", context_window_tokens: 258400, peak_context_tokens: 120000 },
    ]);
    migrated.close();
  });

  test("migrates v13 effort values without changing provider labels", () => {
    const path = freshPath();
    const db = historicalArchive(path, 13);
    db.exec(`
      INSERT INTO session(
        id, tool, source_session_id, reasoning_effort, reasoning_effort_checked
      ) VALUES
        (1, 'claude_code', 'claude-max', 'max', 1),
        (2, 'codex', 'codex-max', 'max', 1),
        (3, 'codex', 'codex-ultra', 'ultra', 1),
        (4, 'codex', 'codex-mixed', 'mixed', 1);
    `);
    db.close();

    const migrated = openDb(path);
    expect(
      migrated
        .query(
          `SELECT tool, reasoning_effort, reasoning_effort_levels, reasoning_effort_checked
           FROM session ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        tool: "claude_code",
        reasoning_effort: "max",
        reasoning_effort_levels: '["max"]',
        reasoning_effort_checked: 1,
      },
      {
        tool: "codex",
        reasoning_effort: "max",
        reasoning_effort_levels: '["max"]',
        reasoning_effort_checked: 1,
      },
      {
        tool: "codex",
        reasoning_effort: "ultra",
        reasoning_effort_levels: '["ultra"]',
        reasoning_effort_checked: 1,
      },
      {
        tool: "codex",
        reasoning_effort: "mixed",
        reasoning_effort_levels: "[]",
        reasoning_effort_checked: 0,
      },
    ]);
    migrated.close();
  });

  test("repairs the v14 Claude max-to-ultra alias without changing Codex", () => {
    const path = freshPath();
    const db = historicalArchive(path, 14);
    db.exec(`
      INSERT INTO session(
        id, tool, source_session_id, reasoning_effort,
        reasoning_effort_levels, reasoning_effort_checked
      ) VALUES
        (1, 'claude_code', 'claude-max', 'ultra', '["ultra"]', 1),
        (2, 'claude_code', 'claude-mixed', 'mixed', '["high","ultra"]', 1),
        (3, 'codex', 'codex-max', 'max', '["max"]', 1),
        (4, 'codex', 'codex-ultra', 'ultra', '["ultra"]', 1);
    `);
    db.close();

    const migrated = openDb(path);
    expect(
      migrated
        .query(
          `SELECT tool, reasoning_effort, reasoning_effort_levels, reasoning_effort_checked
           FROM session ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        tool: "claude_code",
        reasoning_effort: "max",
        reasoning_effort_levels: '["max"]',
        reasoning_effort_checked: 1,
      },
      {
        tool: "claude_code",
        reasoning_effort: "mixed",
        reasoning_effort_levels: '["high","max"]',
        reasoning_effort_checked: 1,
      },
      {
        tool: "codex",
        reasoning_effort: "max",
        reasoning_effort_levels: '["max"]',
        reasoning_effort_checked: 1,
      },
      {
        tool: "codex",
        reasoning_effort: "ultra",
        reasoning_effort_levels: '["ultra"]',
        reasoning_effort_checked: 1,
      },
    ]);
    migrated.close();
  });

  test("v16 purges journal-sourced phantom sessions", () => {
    const path = join(workDir, "v16-journal.db");
    let db = openDb(path);
    db.exec(`
      INSERT INTO session (tool, source_session_id, source_path)
      VALUES ('claude_code', 'wf-journal', '/home/u/.claude/projects/p/s/subagents/workflows/wf_1/journal.jsonl');
      INSERT INTO session (tool, source_session_id, source_path, parent_session_id)
      VALUES ('claude_code', 'child-of-phantom', '/home/u/.claude/projects/p/s/subagents/agent-aa.jsonl',
              (SELECT id FROM session WHERE source_session_id = 'wf-journal'));
      INSERT INTO session (tool, source_session_id, source_path)
      VALUES ('claude_code', 'real-session', '/home/u/.claude/projects/p/s.jsonl');
      INSERT INTO message (session_id, seq, raw)
      VALUES ((SELECT id FROM session WHERE source_session_id = 'wf-journal'), 0, '{}');
      INSERT INTO ingest_source (path, tool) VALUES ('/home/u/.claude/projects/p/s/subagents/workflows/wf_1/journal.jsonl', 'claude_code');
      INSERT INTO ingest_issue (source_path, line_no, error, raw_line, created_at)
      VALUES ('/home/u/.claude/projects/p/s/subagents/workflows/wf_1/journal.jsonl', 1, 'x', '{}', datetime('now'));
      DELETE FROM schema_migrations WHERE version >= 16;
    `);
    db.close();

    db = openDb(path); // reopen: migrate() runs v16 again over the seeded rows
    const ids = (
      db.query("SELECT source_session_id FROM session ORDER BY source_session_id").all() as {
        source_session_id: string;
      }[]
    ).map((row) => row.source_session_id);
    expect(ids).toEqual(["child-of-phantom", "real-session"]);
    const orphanParent = db
      .query("SELECT parent_session_id FROM session WHERE source_session_id = 'child-of-phantom'")
      .get() as { parent_session_id: number | null };
    expect(orphanParent.parent_session_id).toBeNull();
    expect((db.query("SELECT COUNT(*) AS n FROM message").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM ingest_source").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM ingest_issue").get() as { n: number }).n).toBe(0);
    db.close();
  });

  test("v17 adds ingest_issue.code defaulting existing rows to unparsed_line", () => {
    const path = join(workDir, "v17-code.db");
    let db = openDb(path);
    db.exec(`
      INSERT INTO ingest_issue (source_path, line_no, error, raw_line, created_at)
      VALUES ('/a.jsonl', 1, 'bad', '{', datetime('now'));
      DELETE FROM schema_migrations WHERE version >= 17;
    `);
    // Simulate a pre-v17 table: drop the column the baseline now carries, and
    // the index the migration creates alongside it.
    db.exec("ALTER TABLE ingest_issue DROP COLUMN code;");
    db.exec("DROP INDEX idx_ingest_issue_source;");
    db.close();

    db = openDb(path); // reopen: migrate() runs v17 over the pre-v17 table
    const row = db.query("SELECT code FROM ingest_issue").get() as { code: string };
    expect(row.code).toBe("unparsed_line");
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?1")
        .get("idx_ingest_issue_source"),
    ).not.toBeNull();
    db.close();
  });

  test("v18 rebuilds FTS and backfills tool-call metadata", () => {
    const path = join(workDir, "v18-search-tools.db");
    let db = openDb(path);
    db.exec(`
      INSERT INTO session (id, tool, source_session_id)
      VALUES (1, 'claude_code', 'v17-session');
      INSERT INTO message (id, session_id, seq, timestamp, raw)
      VALUES
        (10, 1, 0, '2026-07-28T10:00:00.000Z', '{}'),
        (11, 1, 1, '2026-07-28T10:00:01.250Z', '{}');
      INSERT INTO block (
        id, message_id, session_id, ordinal, type, text, tool_name, tool_use_id, tool_result
      )
      VALUES
        (100, 10, 1, 0, 'tool_use', 'porting decant', 'Read', 'toolu_1', NULL),
        (101, 11, 1, 0, 'tool_result', NULL, NULL, 'toolu_1', 'done');
      INSERT INTO tool_call (
        session_id, message_id, call_block_id, result_block_id, tool_name, tool_use_id,
        input, output_preview, output_bytes, duration_ms, ordinal, timestamp
      )
      VALUES (
        1, NULL, 100, 101, 'Read', 'toolu_1',
        '{"file_path":"README.md"}', 'done', 4, NULL, 0, '2026-07-28T10:00:00.000Z'
      );

      DROP TRIGGER block_ai;
      DROP TRIGGER block_ad;
      DROP TRIGGER block_au;
      DROP TABLE block_fts;
      CREATE VIRTUAL TABLE block_fts USING fts5(
        text, tool_name, tool_input,
        content='block', content_rowid='id'
      );
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

      ALTER TABLE tool_call DROP COLUMN input_bytes;
      ALTER TABLE tool_call DROP COLUMN has_result;
      ALTER TABLE recommendation DROP COLUMN impact_label;
      DROP INDEX idx_block_tool_use;
      DELETE FROM schema_migrations WHERE version >= 18;
    `);
    db.close();

    db = openDb(path);
    const toolCall = db
      .query(
        `SELECT input_bytes, has_result, duration_ms
         FROM tool_call WHERE tool_use_id = 'toolu_1'`,
      )
      .get() as {
      input_bytes: number | null;
      has_result: number | null;
      duration_ms: number;
    };
    expect(toolCall).toEqual({
      input_bytes: 25,
      has_result: 1,
      duration_ms: 1_250,
    });
    const ftsSql = (
      db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'block_fts'")
        .get() as { sql: string }
    ).sql;
    expect(ftsSql).toContain("prefix='2 3'");
    expect(
      db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_block_tool_use'")
        .get(),
    ).not.toBeNull();
    expect(
      db
        .query("SELECT 1 FROM pragma_table_info('recommendation') WHERE name = 'impact_label'")
        .get(),
    ).not.toBeNull();
    expect(
      db
        .query(
          "SELECT 1 FROM pragma_table_info('recommendation') WHERE name = 'impact_label_checked'",
        )
        .get(),
    ).not.toBeNull();
    expect(
      (
        db.query("SELECT COUNT(*) AS n FROM block_fts WHERE block_fts MATCH 'por*'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    db.exec("UPDATE block SET text = 'prefix migration complete' WHERE id = 100");
    expect(
      (
        db.query("SELECT COUNT(*) AS n FROM block_fts WHERE block_fts MATCH 'mig*'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    db.close();
  });

  test("v19 repairs an already-recorded pre-review v18 schema without losing rows", () => {
    const path = join(workDir, "v19-recommendation-repair.db");
    let db = openDb(path);
    db.exec(`
      INSERT INTO session (id, tool, source_session_id)
      VALUES (1, 'claude_code', 'v18-pre-review');
      INSERT INTO message (id, session_id, seq, timestamp, raw)
      VALUES
        (10, 1, 0, '2026-07-29T00:00:00.000Z', '{}'),
        (11, 1, 1, '2026-07-29T00:00:01.250Z', '{}');
      INSERT INTO block (
        id, message_id, session_id, ordinal, type, tool_name, tool_use_id, tool_result
      )
      VALUES
        (100, 10, 1, 0, 'tool_use', 'Read', 'toolu_v19', NULL),
        (101, 11, 1, 0, 'tool_result', NULL, 'toolu_v19', 'done');
      INSERT INTO tool_call (
        id, session_id, message_id, call_block_id, result_block_id,
        tool_name, tool_use_id, duration_ms, ordinal, timestamp
      )
      VALUES (
        1000, 1, NULL, 100, 101,
        'Read', 'toolu_v19', NULL, 0, '2026-07-29T00:00:00.000Z'
      );
      INSERT INTO recommendation (
        key, kind, title, score, status, note, first_seen_at, updated_at
      ) VALUES (
        'signal:preserved', 'signal', 'Preserve me', 42, 'open', 'operator note',
        '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z'
      );
      ALTER TABLE recommendation DROP COLUMN impact_label_checked;
      ALTER TABLE recommendation DROP COLUMN impact_label;
      DROP INDEX idx_block_tool_use;
      DELETE FROM schema_migrations WHERE version >= 19;
    `);
    db.close();

    db = openDb(path);
    expect(db.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: LATEST_SCHEMA_VERSION,
    });
    expect(
      db
        .query(
          `SELECT key, title, note, impact_label, impact_label_checked
           FROM recommendation WHERE key = 'signal:preserved'`,
        )
        .get(),
    ).toEqual({
      key: "signal:preserved",
      title: "Preserve me",
      note: "operator note",
      impact_label: null,
      impact_label_checked: 0,
    });
    expect(
      db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_block_tool_use'")
        .get(),
    ).not.toBeNull();
    expect(db.query("SELECT message_id, duration_ms FROM tool_call WHERE id = 1000").get()).toEqual(
      {
        message_id: null,
        duration_ms: 1_250,
      },
    );
    db.close();

    expect(() => openDb(path).close()).not.toThrow();
  });

  test("v19 does not rewrite duration rows when the backfill still resolves to NULL", () => {
    const path = freshPath();
    let db = openDb(path);
    db.exec(`
      INSERT INTO session (id, tool, source_session_id)
      VALUES (1, 'claude_code', 'v19-null-duration');
      INSERT INTO message (id, session_id, seq, timestamp, raw)
      VALUES
        (10, 1, 0, '2026-07-29T00:00:01.000Z', '{}'),
        (11, 1, 1, '2026-07-29T00:00:00.000Z', '{}');
      INSERT INTO block (
        id, message_id, session_id, ordinal, type, tool_name, tool_use_id, tool_result
      )
      VALUES
        (100, 10, 1, 0, 'tool_use', 'Read', 'toolu_invalid_duration', NULL),
        (101, 11, 1, 0, 'tool_result', NULL, 'toolu_invalid_duration', 'done');
      INSERT INTO tool_call (
        id, session_id, message_id, call_block_id, result_block_id,
        tool_name, tool_use_id, duration_ms, ordinal, timestamp
      )
      VALUES (
        1000, 1, 10, 100, 101,
        'Read', 'toolu_invalid_duration', NULL, 0, '2026-07-29T00:00:01.000Z'
      );
      CREATE TABLE operator_update_audit(tool_call_id INTEGER NOT NULL);
      CREATE TRIGGER operator_duration_update
      AFTER UPDATE OF duration_ms ON tool_call
      BEGIN
        INSERT INTO operator_update_audit(tool_call_id) VALUES (new.id);
      END;
      DELETE FROM schema_migrations WHERE version >= 19;
    `);
    db.close();

    db = openDb(path);
    expect(db.query("SELECT duration_ms FROM tool_call WHERE id = 1000").get()).toEqual({
      duration_ms: null,
    });
    expect(
      (db.query("SELECT COUNT(*) AS n FROM operator_update_audit").get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  test("allows additive operator indexes with one bounded warning", () => {
    const path = freshPath();
    const db = openDb(path);
    for (let index = 0; index < 12; index += 1) {
      db.exec(`CREATE INDEX operator_extra_${index} ON session(id)`);
    }
    db.close();

    const lines: string[] = [];
    configureLogging({ level: "info", write: (line) => lines.push(line) });
    try {
      expect(() => openDb(path).close()).not.toThrow();
    } finally {
      resetSync();
    }

    expect(lines).toHaveLength(1);
    expect([...(lines[0] ?? "")].length).toBeLessThan(2_048);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "WARN",
      "event.name": "decant.schema.additive_drift",
      "schema.version": LATEST_SCHEMA_VERSION,
      "schema.drift.unexpected_objects":
        "index:operator_extra_0, index:operator_extra_1, index:operator_extra_10, " +
        "index:operator_extra_11, index:operator_extra_2, index:operator_extra_3, " +
        "index:operator_extra_4, index:operator_extra_5, and 4 more",
    });
  });

  test("keeps missing and changed owned objects fatal", () => {
    const missingPath = freshPath();
    const missing = openDb(missingPath);
    missing.exec("DROP INDEX idx_session_project");
    missing.close();
    expect(() => openDb(missingPath)).toThrow(SchemaDriftError);

    const changedPath = freshPath();
    const changed = openDb(changedPath);
    changed.exec(`
      DROP INDEX idx_session_project;
      CREATE INDEX idx_session_project ON session(tool);
    `);
    changed.close();
    expect(() => openDb(changedPath)).toThrow(SchemaDriftError);
  });

  test("preserves a migration error when rollback also fails", () => {
    const path = freshPath();
    const db = openDb(path);
    db.exec(`
      ALTER TABLE session ADD COLUMN unexpected_local_state TEXT;
      DELETE FROM schema_migrations WHERE version >= 19;
    `);
    db.close();

    const originalExec = Database.prototype.exec;
    Database.prototype.exec = function (this: Database, sql: string) {
      if (sql.trim().toUpperCase() === "ROLLBACK;") {
        throw new Error("simulated rollback failure");
      }
      return originalExec.call(this, sql);
    } as Database["exec"];
    let caught: unknown;
    try {
      openDb(path);
    } catch (error) {
      caught = error;
    } finally {
      Database.prototype.exec = originalExec;
    }

    expect(caught).toBeInstanceOf(SchemaDriftError);
    expect((caught as Error).message).toContain(
      "unexpected columns: session.unexpected_local_state",
    );
    expect((caught as Error).message).not.toContain("simulated rollback failure");
  });

  test("fails fast on owned-schema drift with one actionable error record", () => {
    const path = freshPath();
    const db = openDb(path);
    db.exec(`
      ALTER TABLE recommendation DROP COLUMN impact_label;
      ALTER TABLE session ADD COLUMN unexpected_local_state TEXT;
    `);
    db.close();

    const lines: string[] = [];
    configureLogging({ level: "info", write: (line) => lines.push(line) });
    let caught: unknown;
    try {
      openDb(path);
    } catch (error) {
      caught = error;
    } finally {
      resetSync();
    }

    expect(caught).toBeInstanceOf(SchemaDriftError);
    expect((caught as Error).message).toContain("missing columns: recommendation.impact_label");
    expect((caught as Error).message).toContain(
      "unexpected columns: session.unexpected_local_state",
    );
    expect((caught as Error).message).toContain("Back up or move the archive aside");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "ERROR",
      "event.name": "decant.schema.drift",
      "schema.version": LATEST_SCHEMA_VERSION,
      "schema.drift.missing_columns": "recommendation.impact_label",
      "schema.drift.unexpected_columns": "session.unexpected_local_state",
      "error.type": "SchemaDriftError",
      "recovery.action": "back_up_then_rebuild_from_complete_sources",
    });
  });

  test("rolls back a repair and its v19 stamp when unrelated drift remains", () => {
    const path = freshPath();
    const db = openDb(path);
    db.exec(`
      ALTER TABLE recommendation DROP COLUMN impact_label_checked;
      ALTER TABLE recommendation DROP COLUMN impact_label;
      ALTER TABLE session ADD COLUMN unexpected_local_state TEXT;
      DELETE FROM schema_migrations WHERE version >= 19;
    `);
    db.close();

    expect(() => openDb(path)).toThrow(SchemaDriftError);

    const unchanged = new Database(path, { strict: true });
    expect(unchanged.query("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 18,
    });
    expect(
      (
        unchanged.query("SELECT name FROM pragma_table_info('recommendation')").all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    ).not.toContain("impact_label");
    expect(
      unchanged
        .query("SELECT 1 FROM pragma_table_info('session') WHERE name = 'unexpected_local_state'")
        .get(),
    ).not.toBeNull();
    unchanged.close();
  });

  test("does not initialize a non-empty database without schema_migrations", () => {
    const path = freshPath();
    const db = new Database(path, { create: true, strict: true });
    db.exec("CREATE TABLE operator_data(id INTEGER PRIMARY KEY, note TEXT)");
    db.close();

    expect(() => openDb(path)).toThrow(SchemaDriftError);
    const untouched = new Database(path, { strict: true });
    expect(inventory(untouched, "table")).toEqual(["operator_data"]);
    untouched.close();
  });

  test("bounds and sanitizes adversarial schema identifiers in errors and logs", () => {
    const path = freshPath();
    const unsafeName = `operator🚀\n\u0007${"x".repeat(20_000)}`;
    const db = new Database(path, { create: true, strict: true });
    db.exec(`CREATE TABLE "${unsafeName}"(id INTEGER PRIMARY KEY)`);
    db.close();

    const lines: string[] = [];
    configureLogging({ level: "info", write: (line) => lines.push(line) });
    let caught: unknown;
    try {
      openDb(path);
    } catch (error) {
      caught = error;
    } finally {
      resetSync();
    }

    expect(caught).toBeInstanceOf(SchemaDriftError);
    const message = (caught as Error).message;
    expect([...message].length).toBeLessThan(4_096);
    expect(message).toContain("operator🚀��");
    expect(message).not.toContain("\n");
    expect(message).not.toContain(String.fromCharCode(7));
    expect(lines).toHaveLength(1);
    expect([...(lines[0] ?? "")].length).toBeLessThan(8_192);
    const record = JSON.parse(lines[0] ?? "") as Record<string, string>;
    expect(record["schema.drift.reason"]).not.toContain("\n");
    expect(record["schema.drift.reason"]).not.toContain(String.fromCharCode(7));
    expect(record["error.message"]).toBe(message);
  });

  test("reports malformed and non-contiguous migration history as schema drift", () => {
    const malformedPath = freshPath();
    const malformed = new Database(malformedPath, { create: true, strict: true });
    malformed.exec("CREATE TABLE schema_migrations(applied_at TEXT NOT NULL)");
    malformed.close();
    expect(() => openDb(malformedPath)).toThrow(/schema_migrations is malformed or unreadable/);

    const gappedPath = freshPath();
    const gapped = openDb(gappedPath);
    gapped.exec("DELETE FROM schema_migrations WHERE version = 10");
    gapped.close();
    expect(() => openDb(gappedPath)).toThrow(/schema_migrations is non-contiguous/);
  });

  test("rejects a pre-baseline archive and points at rebuilding it", () => {
    const path = freshPath();
    const db = openDb(path);
    db.exec("DELETE FROM schema_migrations WHERE version >= 8");
    db.close();
    expect(() => openDb(path)).toThrow(/rebuild/i);
  });
});

describe("schema manifest", () => {
  function manifest(defaultValue: string, triggerValue: string) {
    const db = new Database(":memory:", { strict: true });
    db.exec(`
      CREATE TABLE literal_test(id INTEGER PRIMARY KEY, value TEXT DEFAULT '${defaultValue}');
      CREATE TABLE audit(value TEXT);
      CREATE TRIGGER literal_trigger AFTER INSERT ON literal_test BEGIN
        INSERT INTO audit(value) VALUES ('${triggerValue}');
      END;
    `);
    const result = buildSchemaManifest(db);
    db.close();
    return result;
  }

  test("preserves whitespace, punctuation, quotes, and keywords inside SQL literals", () => {
    const baseline = manifest('a  b "Name" if not exists', "x, y");
    expect(manifest('a b "Name" if not exists', "x, y").fingerprint).not.toBe(baseline.fingerprint);
    expect(manifest('a  b "Name" if not exists', "x,y").fingerprint).not.toBe(baseline.fingerprint);
    expect(manifest('a  b "name" if not exists', "x, y").fingerprint).not.toBe(
      baseline.fingerprint,
    );
  });

  test("orders foreign keys directly by their typed fields", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec(`
      CREATE TABLE alpha_parent(
        first_id INTEGER NOT NULL,
        second_id INTEGER NOT NULL,
        UNIQUE(first_id, second_id)
      );
      CREATE TABLE zulu_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(
        alpha_first INTEGER,
        alpha_second INTEGER,
        zulu_id INTEGER REFERENCES zulu_parent(id),
        FOREIGN KEY(alpha_first, alpha_second)
          REFERENCES alpha_parent(first_id, second_id)
      );
    `);
    const child = buildSchemaManifest(db).objects.find((object) => object.name === "child");
    db.close();

    expect(
      child?.foreign_keys.map(({ table, from, to, sequence }) => ({
        table,
        from,
        to,
        sequence,
      })),
    ).toEqual([
      {
        table: "alpha_parent",
        from: "alpha_first",
        to: "first_id",
        sequence: 0,
      },
      {
        table: "alpha_parent",
        from: "alpha_second",
        to: "second_id",
        sequence: 1,
      },
      {
        table: "zulu_parent",
        from: "zulu_id",
        to: "id",
        sequence: 0,
      },
    ]);
  });
});

/// The archive aggregates transcripts that Claude Code and Codex keep in 0600
/// files, so it must not come out of SQLite at the default 0644.
describe("archive permissions", () => {
  function permissions(path: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, suffix] of [
      ["db", ""],
      ["wal", "-wal"],
      ["shm", "-shm"],
    ] as const) {
      const file = `${path}${suffix}`;
      if (existsSync(file)) {
        out[key] = statSync(file).mode & 0o7777;
      }
    }
    return out;
  }

  test("creates the archive and its WAL sidecars owner-only", () => {
    const path = freshPath();
    const db = openDb(path);
    // SQLite copies the database file's mode onto the -wal/-shm files it
    // creates for the schema write, so all three land at 0600.
    expect(permissions(path)).toEqual({ db: 0o600, wal: 0o600, shm: 0o600 });
    db.close();
  });

  test("tightens an archive left group- and world-readable by an earlier build", () => {
    const path = freshPath();
    openDb(path).close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) {
        chmodSync(`${path}${suffix}`, 0o644);
      }
    }

    const db = openDb(path);
    expect(permissions(path)).toEqual({ db: 0o600, wal: 0o600, shm: 0o600 });
    db.close();
  });

  test("never changes the mode through a symlink planted at an archive name", () => {
    // The -wal/-shm names do not exist yet on a fresh archive, so anyone who
    // can write to the archive's directory could otherwise point them at a
    // file of their choosing and have decant chmod that instead.
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = freshPath();
      const victim = `${path}.victim`;
      writeFileSync(victim, "not the archive");
      chmodSync(victim, 0o644);
      symlinkSync(victim, `${path}${suffix}`);

      restrictArchiveFile(`${path}${suffix}`);

      expect(statSync(victim).mode & 0o7777).toBe(0o644);
      expect(lstatSync(`${path}${suffix}`).isSymbolicLink()).toBe(true);
    }
  });

  test("stays best-effort on an absent sidecar and a non-regular path", () => {
    const path = freshPath();
    expect(() => restrictArchiveFile(`${path}-wal`)).not.toThrow();
    expect(existsSync(`${path}-wal`)).toBe(false);

    expect(() => restrictArchiveFile(workDir)).not.toThrow();
    expect(statSync(workDir).mode & 0o7777).toBe(0o700);
  });
});
