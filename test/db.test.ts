import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SCHEMA_VERSION, openDb } from "../src/db.ts";
import schemaSql from "../src/schema.sql" with { type: "text" };

const workDir = mkdtempSync(join(tmpdir(), "decant-db-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshPath(): string {
  dbCounter += 1;
  return join(workDir, `archive-${dbCounter}.db`);
}

// Inventory of the frozen v10 baseline. Shadow tables
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
const BASELINE_INDEX_COUNT = 24;

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
  });

  test("migrates a v8 archive through v10", () => {
    const path = freshPath();
    const db = new Database(path, { create: true, strict: true });
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE session(id INTEGER PRIMARY KEY, tool TEXT NOT NULL, source_session_id TEXT NOT NULL);
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
    ).toBe(10);
    expect(inventory(migrated, "index")).toContain("idx_session_parent");
    expect(inventory(migrated, "table")).toContain("session_economics");
    migrated.close();
  });

  test("migrates a v9 archive to the persisted economics cache", () => {
    const path = freshPath();
    const db = new Database(path, { create: true, strict: true });
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE session(id INTEGER PRIMARY KEY, tool TEXT NOT NULL, source_session_id TEXT NOT NULL);
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
    ).toBe(10);
    migrated.close();
  });

  test("rejects a pre-baseline archive and points at rebuilding it", () => {
    const path = freshPath();
    const db = openDb(path);
    db.exec("DELETE FROM schema_migrations WHERE version >= 8");
    db.close();
    expect(() => openDb(path)).toThrow(/rebuild/i);
  });
});
