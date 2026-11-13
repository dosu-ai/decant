import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "..", "fixtures", "hermes");

export function hermesFixtureSql(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

/** Builds a Hermes `state.db` from fixtures/hermes/schema.sql and then each
 * script in order. Used by parser, store, ingest, and golden tests. */
export function buildHermesDb(dbPath: string, scripts: readonly string[]): void {
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    // One transaction, so building a fixture costs one sync to disk.
    db.transaction(() => {
      for (const sql of [hermesFixtureSql("schema.sql"), ...scripts]) {
        db.exec(sql);
      }
    })();
  } finally {
    db.close();
  }
}

/** Same as `buildHermesDb`, for session scripts under fixtures/hermes/. */
export function buildHermesFixtureDb(dbPath: string, names: readonly string[]): void {
  buildHermesDb(
    dbPath,
    names.map((name) => hermesFixtureSql(name)),
  );
}
