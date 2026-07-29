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
import { closeDb, LATEST_SCHEMA_VERSION, openDb, restrictArchiveFile } from "../src/db.ts";
import schemaSql from "../src/schema.sql" with { type: "text" };

const workDir = mkdtempSync(join(tmpdir(), "decant-db-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshPath(): string {
  dbCounter += 1;
  return join(workDir, `archive-${dbCounter}.db`);
}

// Inventory of the frozen v18 baseline. Shadow tables
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
  "tool_call",
];
const BASELINE_TRIGGERS = ["block_ad", "block_ai", "block_au"];
const BASELINE_INDEX_COUNT = 26;

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
    const db = new Database(path, { create: true, strict: true });
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE session(id INTEGER PRIMARY KEY, tool TEXT NOT NULL, source_session_id TEXT NOT NULL, source_path TEXT);
      CREATE TABLE model_pricing(
        model TEXT PRIMARY KEY,
        input_per_mtok REAL,
        output_per_mtok REAL,
        cache_read_per_mtok REAL,
        cache_write_per_mtok REAL,
        source TEXT,
        updated_at TEXT
      );
      CREATE TABLE ingest_source (
        path TEXT PRIMARY KEY,
        tool TEXT,
        size INTEGER,
        mtime INTEGER,
        hash TEXT,
        session_id INTEGER REFERENCES session(id) ON DELETE SET NULL,
        line_count INTEGER,
        status TEXT,
        error TEXT,
        last_ingested_at TEXT
      );
      CREATE TABLE ingest_issue (
        id INTEGER PRIMARY KEY,
        source_path TEXT,
        line_no INTEGER,
        error TEXT,
        raw_line TEXT,
        created_at TEXT
      );
    `);
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, datetime('now'))",
    );
    for (let version = 1; version <= 8; version += 1) {
      insert.run(version);
    }
    db.close();

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

  test("migrates a v9 archive to the persisted economics cache", () => {
    const path = freshPath();
    const db = new Database(path, { create: true, strict: true });
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE session(
        id INTEGER PRIMARY KEY,
        tool TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_path TEXT,
        parent_session_id INTEGER REFERENCES session(id)
      );
      CREATE TABLE model_pricing(
        model TEXT PRIMARY KEY,
        input_per_mtok REAL,
        output_per_mtok REAL,
        cache_read_per_mtok REAL,
        cache_write_per_mtok REAL,
        source TEXT,
        updated_at TEXT
      );
      CREATE TABLE ingest_source (
        path TEXT PRIMARY KEY,
        tool TEXT,
        size INTEGER,
        mtime INTEGER,
        hash TEXT,
        session_id INTEGER REFERENCES session(id) ON DELETE SET NULL,
        line_count INTEGER,
        status TEXT,
        error TEXT,
        last_ingested_at TEXT
      );
      CREATE TABLE ingest_issue (
        id INTEGER PRIMARY KEY,
        source_path TEXT,
        line_no INTEGER,
        error TEXT,
        raw_line TEXT,
        created_at TEXT
      );
    `);
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, datetime('now'))",
    );
    for (let version = 1; version <= 9; version += 1) {
      insert.run(version);
    }
    db.close();

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

  test("migrates v12 archives and invalidates stale Claude context-window rollups", () => {
    const path = freshPath();
    const db = new Database(path, { create: true, strict: true });
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE session(
        id INTEGER PRIMARY KEY,
        tool TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_path TEXT,
        parent_session_id INTEGER REFERENCES session(id),
        context_window_tokens INTEGER,
        peak_context_tokens INTEGER,
        total_cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE model_pricing(
        model TEXT PRIMARY KEY,
        input_per_mtok REAL,
        output_per_mtok REAL,
        cache_read_per_mtok REAL,
        cache_write_per_mtok REAL,
        source TEXT,
        updated_at TEXT
      );
      CREATE TABLE ingest_source (
        path TEXT PRIMARY KEY,
        tool TEXT,
        size INTEGER,
        mtime INTEGER,
        hash TEXT,
        session_id INTEGER REFERENCES session(id) ON DELETE SET NULL,
        line_count INTEGER,
        status TEXT,
        error TEXT,
        last_ingested_at TEXT
      );
      CREATE TABLE ingest_issue (
        id INTEGER PRIMARY KEY,
        source_path TEXT,
        line_no INTEGER,
        error TEXT,
        raw_line TEXT,
        created_at TEXT
      );
      INSERT INTO session(
        id, tool, source_session_id, context_window_tokens, peak_context_tokens
      ) VALUES
        (1, 'claude_code', 'claude-old-rollup', 200000, 120000),
        (2, 'codex', 'codex-explicit-rollup', 258400, 120000);
    `);
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, datetime('now'))",
    );
    for (let version = 1; version <= 12; version += 1) {
      insert.run(version);
    }
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
    const db = new Database(path, { create: true, strict: true });
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE session(
        id INTEGER PRIMARY KEY,
        tool TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_path TEXT,
        parent_session_id INTEGER REFERENCES session(id),
        reasoning_effort TEXT,
        reasoning_effort_checked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE ingest_source (
        path TEXT PRIMARY KEY,
        tool TEXT,
        size INTEGER,
        mtime INTEGER,
        hash TEXT,
        session_id INTEGER REFERENCES session(id) ON DELETE SET NULL,
        line_count INTEGER,
        status TEXT,
        error TEXT,
        last_ingested_at TEXT
      );
      CREATE TABLE ingest_issue (
        id INTEGER PRIMARY KEY,
        source_path TEXT,
        line_no INTEGER,
        error TEXT,
        raw_line TEXT,
        created_at TEXT
      );
      INSERT INTO session(
        id, tool, source_session_id, reasoning_effort, reasoning_effort_checked
      ) VALUES
        (1, 'claude_code', 'claude-max', 'max', 1),
        (2, 'codex', 'codex-max', 'max', 1),
        (3, 'codex', 'codex-ultra', 'ultra', 1),
        (4, 'codex', 'codex-mixed', 'mixed', 1);
    `);
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, datetime('now'))",
    );
    for (let version = 1; version <= 13; version += 1) {
      insert.run(version);
    }
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
    const db = new Database(path, { create: true, strict: true });
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE session(
        id INTEGER PRIMARY KEY,
        tool TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_path TEXT,
        parent_session_id INTEGER REFERENCES session(id),
        reasoning_effort TEXT,
        reasoning_effort_levels TEXT NOT NULL DEFAULT '[]',
        reasoning_effort_checked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE ingest_source (
        path TEXT PRIMARY KEY,
        tool TEXT,
        size INTEGER,
        mtime INTEGER,
        hash TEXT,
        session_id INTEGER REFERENCES session(id) ON DELETE SET NULL,
        line_count INTEGER,
        status TEXT,
        error TEXT,
        last_ingested_at TEXT
      );
      CREATE TABLE ingest_issue (
        id INTEGER PRIMARY KEY,
        source_path TEXT,
        line_no INTEGER,
        error TEXT,
        raw_line TEXT,
        created_at TEXT
      );
      INSERT INTO session(
        id, tool, source_session_id, reasoning_effort,
        reasoning_effort_levels, reasoning_effort_checked
      ) VALUES
        (1, 'claude_code', 'claude-max', 'ultra', '["ultra"]', 1),
        (2, 'claude_code', 'claude-mixed', 'mixed', '["high","ultra"]', 1),
        (3, 'codex', 'codex-max', 'max', '["max"]', 1),
        (4, 'codex', 'codex-ultra', 'ultra', '["ultra"]', 1);
    `);
    const insert = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, datetime('now'))",
    );
    for (let version = 1; version <= 14; version += 1) {
      insert.run(version);
    }
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

  test("rejects a pre-baseline archive and points at rebuilding it", () => {
    const path = freshPath();
    const db = openDb(path);
    db.exec("DELETE FROM schema_migrations WHERE version >= 8");
    db.close();
    expect(() => openDb(path)).toThrow(/rebuild/i);
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
