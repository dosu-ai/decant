import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { cachedRead, READ_CACHE_MAX_ENTRIES, statementKey } from "../src/read-cache.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-read-cache-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshPath(): string {
  dbCounter += 1;
  return join(workDir, `read-cache-${dbCounter}.db`);
}

function counter(db: Database, key: string): { read: () => number; computed: () => number } {
  let computed = 0;
  return {
    read: () =>
      cachedRead(db, key, () => {
        computed += 1;
        return (db.query("SELECT COUNT(*) AS n FROM project").get() as { n: number }).n;
      }),
    computed: () => computed,
  };
}

describe("cachedRead", () => {
  test("reuses a value until this connection writes", () => {
    const db = openDb(freshPath());
    const projects = counter(db, "projects");
    expect(projects.read()).toBe(0);
    expect(projects.read()).toBe(0);
    expect(projects.computed()).toBe(1);

    db.exec("INSERT INTO project(path) VALUES ('/p')");
    expect(projects.read()).toBe(1);
    expect(projects.computed()).toBe(2);
    closeDb(db);
  });

  test("recomputes after another connection commits", () => {
    const path = freshPath();
    const reader = openDb(path);
    const writer = openDb(path);
    const projects = counter(reader, "projects");
    expect(projects.read()).toBe(0);

    writer.exec("INSERT INTO project(path) VALUES ('/from-sync')");
    expect(projects.read()).toBe(1);
    expect(projects.computed()).toBe(2);
    closeDb(writer);
    closeDb(reader);
  });

  test("recomputes after a schema change on this connection", () => {
    const db = openDb(freshPath());
    const projects = counter(db, "projects");
    projects.read();
    db.exec("CREATE TABLE scratch_table(id INTEGER)");
    projects.read();
    expect(projects.computed()).toBe(2);
    closeDb(db);
  });

  test("keeps separate entries per key", () => {
    const db = openDb(freshPath());
    expect(cachedRead(db, statementKey("SELECT ?", [1]), () => "one")).toBe("one");
    expect(cachedRead(db, statementKey("SELECT ?", [2]), () => "two")).toBe("two");
    expect(cachedRead(db, statementKey("SELECT ?", [1]), () => "recomputed")).toBe("one");
    expect(cachedRead(db, statementKey("SELECT ?", ["1"]), () => "string param")).toBe(
      "string param",
    );
    closeDb(db);
  });

  test("keeps entries per connection", () => {
    const path = freshPath();
    const first = openDb(path);
    const second = openDb(path);
    expect(cachedRead(first, "key", () => "first")).toBe("first");
    expect(cachedRead(second, "key", () => "second")).toBe("second");
    closeDb(second);
    closeDb(first);
  });

  test("evicts the least recently used entry past the bound", () => {
    const db = openDb(freshPath());
    for (let index = 0; index < READ_CACHE_MAX_ENTRIES; index += 1) {
      cachedRead(db, `key-${index}`, () => index);
    }
    // Touching the oldest entry makes key-1 the next eviction.
    expect(cachedRead(db, "key-0", () => -1)).toBe(0);
    cachedRead(db, "overflow", () => "overflow");

    expect(cachedRead(db, "key-0", () => -1)).toBe(0);
    expect(cachedRead(db, "key-1", () => -1)).toBe(-1);
    closeDb(db);
  });

  test("does not cache reads inside a transaction", () => {
    const db = openDb(freshPath());
    const projects = counter(db, "projects");
    db.exec("BEGIN");
    db.exec("INSERT INTO project(path) VALUES ('/rolled-back')");
    expect(projects.read()).toBe(1);
    expect(projects.read()).toBe(1);
    db.exec("ROLLBACK");
    expect(projects.computed()).toBe(2);
    expect(projects.read()).toBe(0);
    closeDb(db);
  });
});
