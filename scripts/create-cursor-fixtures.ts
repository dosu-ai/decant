import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import type { Json } from "../src/model.ts";

const fixtureDir = join(import.meta.dir, "..", "fixtures", "cursor", "sample");
mkdirSync(fixtureDir, { recursive: true });
const storePath = join(fixtureDir, "store.db");
rmSync(storePath, { force: true });

const records: Json[] = [
  { id: "user-1", role: "user", content: [{ type: "text", text: "Inspect the demo project." }] },
  {
    id: "assistant-1",
    role: "assistant",
    content: [
      { type: "reasoning", text: "I will inspect the requested file." },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        args: { path: "/Users/dev/cursor-demo/src/index.ts" },
      },
    ],
  },
  {
    id: "tool-1",
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        result: "export const greeting = 'hello';",
      },
    ],
  },
  {
    id: "assistant-2",
    role: "assistant",
    content: [
      { type: "redacted-reasoning", data: "synthetic-redacted" },
      { type: "text", text: "The demo exports a greeting." },
    ],
  },
];

const encodedRecords = records.map((record) => new TextEncoder().encode(canonicalJson(record)));
const messageIds = encodedRecords.map((record) =>
  createHash("sha256").update(record).digest("hex"),
);
const root = Buffer.concat([
  // Unknown varint metadata exercises forward-compatible protobuf skipping,
  // including the full 64-bit width used by some real Cursor stores.
  Buffer.from([0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]),
  ...messageIds.map((id) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")])),
]);
const rootId = createHash("sha256").update(root).digest("hex");
const storeMeta = {
  agentId: "cursor-synthetic-session",
  latestRootBlobId: rootId,
  name: "Inspect the demo project",
  mode: "agent",
  createdAt: 1_752_489_000_000,
  lastUsedModel: "cursor-test-model",
};

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
    Buffer.from(canonicalJson(storeMeta)).toString("hex"),
  );
} finally {
  db.close(false);
}

writeFileSync(
  join(fixtureDir, "meta.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      hasConversation: true,
      cwd: "/Users/dev/cursor-demo",
      createdAtMs: 1_752_489_000_000,
      updatedAtMs: 1_752_489_060_000,
    },
    null,
    2,
  )}\n`,
);
