import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "..", "fixtures", "opencode");

export function opencodeFixtureSql(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

/** Builds an OpenCode 2.x database from SQL text: the synthetic DDL first,
 * then each script in order. Used by parser, store, ingest, and golden tests. */
export function buildOpenCodeDb(dbPath: string, scripts: readonly string[]): void {
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.exec(opencodeFixtureSql("schema.sql"));
    for (const script of scripts) {
      db.exec(script);
    }
  } finally {
    db.close();
  }
}

/** Same as `buildOpenCodeDb`, for session scripts under fixtures/opencode/. */
export function buildOpenCodeFixtureDb(dbPath: string, names: readonly string[]): void {
  buildOpenCodeDb(
    dbPath,
    names.map((name) => opencodeFixtureSql(name)),
  );
}
