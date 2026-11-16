import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "..", "fixtures", "hermes");

export function hermesFixtureSql(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

export function buildHermesDb(dbPath: string, scripts: readonly string[]): void {
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.transaction(() => {
      for (const sql of [hermesFixtureSql("schema.sql"), ...scripts]) {
        db.exec(sql);
      }
    })();
  } finally {
    db.close();
  }
}

export function buildHermesFixtureDb(dbPath: string, names: readonly string[]): void {
  buildHermesDb(
    dbPath,
    names.map((name) => hermesFixtureSql(name)),
  );
}
