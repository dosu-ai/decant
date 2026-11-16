import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "..", "fixtures", "opencode");

export function opencodeFixtureSql(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

export function buildOpenCodeDb(dbPath: string, scripts: readonly string[]): void {
  buildWith(
    dbPath,
    [opencodeFixtureSql("schema.sql"), opencodeFixtureSql("v1/schema.sql")],
    scripts,
  );
}

export function buildOpenCodeFixtureDb(dbPath: string, names: readonly string[]): void {
  buildOpenCodeDb(
    dbPath,
    names.map((name) => opencodeFixtureSql(name)),
  );
}

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
