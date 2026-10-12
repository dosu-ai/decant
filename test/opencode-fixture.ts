import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "..", "fixtures", "opencode");

export function opencodeFixtureSql(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

/** Builds an OpenCode 2.x database from SQL text: the 2.x DDL, the 1.x tables
 * every 2.x database also carries, then each script in order. Used by parser,
 * store, ingest, and golden tests. */
export function buildOpenCodeDb(dbPath: string, scripts: readonly string[]): void {
  buildWith(
    dbPath,
    [opencodeFixtureSql("schema.sql"), opencodeFixtureSql("v1/schema.sql")],
    scripts,
  );
}

/** Same as `buildOpenCodeDb`, for session scripts under fixtures/opencode/. */
export function buildOpenCodeFixtureDb(dbPath: string, names: readonly string[]): void {
  buildOpenCodeDb(
    dbPath,
    names.map((name) => opencodeFixtureSql(name)),
  );
}

/** A database only OpenCode 1.x ever opened: no session_v2, no kv. `1.2` is
 * the v1.2.0 table shape, before later releases added session columns. */
export function buildOpenCodeV1Db(
  dbPath: string,
  scripts: readonly string[],
  shape: "current" | "1.2" = "current",
): void {
  buildWith(
    dbPath,
    [opencodeFixtureSql(shape === "current" ? "v1/schema.sql" : "v1/schema-1.2.sql")],
    scripts,
  );
}

/** Same as `buildOpenCodeV1Db`, for session scripts under fixtures/opencode/. */
export function buildOpenCodeV1FixtureDb(
  dbPath: string,
  names: readonly string[],
  shape: "current" | "1.2" = "current",
): void {
  buildOpenCodeV1Db(
    dbPath,
    names.map((name) => opencodeFixtureSql(name)),
    shape,
  );
}

function buildWith(dbPath: string, ddl: readonly string[], scripts: readonly string[]): void {
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    for (const sql of [...ddl, ...scripts]) {
      db.exec(sql);
    }
  } finally {
    db.close();
  }
}
