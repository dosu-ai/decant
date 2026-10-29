import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import type { Json } from "../src/model.ts";

const fixtureRoot = join(import.meta.dir, "..", "fixtures", "cursor");

interface CursorFixture {
  store: { [key: string]: Json };
  records: Json[];
}

/** Fixture chats under fixtures/cursor/: each directory holding a `store.json`. */
export function cursorFixtureNames(): string[] {
  return readdirSync(fixtureRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Writes a Cursor CLI chat directory (`store.db` plus `meta.json`) from
 * fixtures/cursor/<name>/. SQLite files are not committed, so parser, ingest,
 * and golden tests build the store from the fixture's text on each run. */
export function buildCursorChat(chatDir: string, name = "sample"): void {
  const fixtureDir = join(fixtureRoot, name);
  const fixture = JSON.parse(readFileSync(join(fixtureDir, "store.json"), "utf8")) as CursorFixture;
  mkdirSync(chatDir, { recursive: true });
  writeCursorStore(join(chatDir, "store.db"), fixture.store, fixture.records);
  copyFileSync(join(fixtureDir, "meta.json"), join(chatDir, "meta.json"));
}

/** Cursor keeps each message as a blob keyed by its SHA-256, lists the message
 * hashes in a protobuf root blob (field 1, 32 bytes each), and stores
 * hex-encoded JSON naming that root in its `meta` table. */
export function writeCursorStore(
  storePath: string,
  storeMeta: { [key: string]: Json },
  records: readonly Json[],
): void {
  const encodedRecords = records.map((record) => new TextEncoder().encode(canonicalJson(record)));
  const messageIds = encodedRecords.map((record) =>
    createHash("sha256").update(record).digest("hex"),
  );
  const root = Buffer.concat([
    // An unknown varint field ahead of the message list exercises
    // forward-compatible skipping, at the full 64-bit width real stores use.
    Buffer.from([0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
    ...messageIds.map((id) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")])),
  ]);
  const rootId = createHash("sha256").update(root).digest("hex");

  const db = new Database(storePath, { create: true });
  try {
    db.exec(
      "CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);",
    );
    const insertBlob = db.prepare("INSERT INTO blobs(id, data) VALUES (?1, ?2)");
    for (const [index, data] of encodedRecords.entries()) {
      insertBlob.run(messageIds[index] as string, data);
    }
    insertBlob.run(rootId, root);
    db.prepare("INSERT INTO meta(key, value) VALUES ('agent', ?1)").run(
      Buffer.from(canonicalJson({ ...storeMeta, latestRootBlobId: rootId })).toString("hex"),
    );
  } finally {
    db.close(false);
  }
}
