import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSync } from "@logtape/logtape";
import { closeDb, openDb } from "../src/db.ts";
import { discover, discoverSourcePaths, type IngestConfig, sync } from "../src/ingest.ts";
import { configureLogging } from "../src/logging.ts";
import { listSessions } from "../src/query.ts";
import { CursorBlobProblem, parseCursorSession, readCursorSource } from "../src/sources/cursor.ts";
import { totals } from "../src/stats.ts";
import { buildCursorChat, writeCursorStore } from "./cursor-fixture.ts";

/** Commits one more message to a store the way Cursor does: a new message
 * blob, a new root listing every message, and the meta row pointing at it. */
function appendCursorMessage(writer: Database, record: object): void {
  const meta = writer.query("SELECT key, value FROM meta LIMIT 1").get() as {
    key: string;
    value: string;
  };
  const storeMeta = JSON.parse(Buffer.from(meta.value, "hex").toString("utf8"));
  const oldRoot = (
    writer.query("SELECT data FROM blobs WHERE id = ?1").get(storeMeta.latestRootBlobId) as {
      data: Uint8Array;
    }
  ).data;
  const data = new TextEncoder().encode(JSON.stringify(record));
  const id = createHash("sha256").update(data).digest();
  const root = Buffer.concat([Buffer.from(oldRoot), Buffer.from([0x0a, 0x20]), id]);
  const rootId = createHash("sha256").update(root).digest("hex");
  writer.transaction(() => {
    writer.prepare("INSERT INTO blobs(id, data) VALUES (?1, ?2)").run(id.toString("hex"), data);
    writer.prepare("INSERT INTO blobs(id, data) VALUES (?1, ?2)").run(rootId, root);
    writer
      .prepare("UPDATE meta SET value = ?2 WHERE key = ?1")
      .run(
        meta.key,
        Buffer.from(JSON.stringify({ ...storeMeta, latestRootBlobId: rootId })).toString("hex"),
      );
  })();
}

function captureLogs<T>(run: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  configureLogging({ level: "info", write: (line) => lines.push(line) });
  try {
    return { result: run(), lines };
  } finally {
    resetSync();
  }
}

function cursorCase(): { root: string; cursorDir: string; chatDir: string; config: IngestConfig } {
  const root = mkdtempSync(join(tmpdir(), "decant-cursor-test-"));
  const cursorDir = join(root, "cursor");
  const chatDir = join(cursorDir, "workspace", "chat");
  buildCursorChat(chatDir);
  const config = { claudeDir: join(root, "claude"), codexDir: join(root, "codex"), cursorDir };
  return { root, cursorDir, chatDir, config };
}

const workDir = mkdtempSync(join(tmpdir(), "decant-cursor-fixture-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));
const sampleChat = join(workDir, "sample");
buildCursorChat(sampleChat);
const storePath = join(sampleChat, "store.db");

describe("Cursor source", () => {
  test("reads and normalizes the synthetic Cursor CLI store", () => {
    const source = readCursorSource(storePath);
    const parsed = parseCursorSession("fallback", source);

    expect(parsed.issues).toEqual([]);
    expect(parsed.session).toMatchObject({
      tool: "cursor",
      sourceSessionId: "cursor-synthetic-session",
      projectPath: "/Users/dev/cursor-demo",
      title: "Inspect the demo project",
      model: "cursor-test-model",
      startedAt: "2025-07-14T10:30:00.000Z",
      endedAt: "2025-07-14T10:31:00.000Z",
      reasoningSource: "none",
      totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 },
    });
    expect(parsed.session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(parsed.session.messages.flatMap((message) => message.blocks)).toMatchObject([
      { blockType: "text", text: "Inspect the demo project." },
      { blockType: "thinking", text: "I will inspect the requested file." },
      { blockType: "tool_use", toolName: "read_file", toolUseId: "call-1" },
      { blockType: "tool_result", toolName: "read_file", toolUseId: "call-1" },
      { blockType: "thinking", text: null },
      { blockType: "text", text: "The demo exports a greeting." },
    ]);
  });

  test("reads a WAL store from a directory it cannot write to", () => {
    // A read-only mount, as in the Docker image: a normal read-only open of a
    // WAL store must create its -shm file there and fails.
    const chatDir = join(workDir, "read-only");
    buildCursorChat(chatDir);
    const store = join(chatDir, "store.db");
    const writer = new Database(store);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.close();
    chmodSync(chatDir, 0o555);
    try {
      expect(readCursorSource(store).records).toHaveLength(4);
    } finally {
      chmodSync(chatDir, 0o755);
    }
  });

  test("a store locked by a writer fails and is retried, not read unlocked", () => {
    const root = mkdtempSync(join(tmpdir(), "decant-cursor-test-"));
    const cursorDir = join(root, "cursor");
    const chatDir = join(cursorDir, "workspace", "chat");
    buildCursorChat(chatDir);
    const store = join(chatDir, "store.db");
    const config = { claudeDir: join(root, "claude"), codexDir: join(root, "codex"), cursorDir };
    const writer = new Database(store);
    const db = openDb(join(root, "archive.db"));
    try {
      // A rollback-journal writer mid-transaction may already have written
      // pages to store.db; the immutable fallback would read them unlocked.
      writer.exec("PRAGMA journal_mode = DELETE; PRAGMA cache_size = 1; BEGIN EXCLUSIVE");
      writer.prepare("INSERT INTO blobs(id, data) VALUES ('pending', zeroblob(200000))").run();
      expect(() => readCursorSource(store)).toThrow("database is locked");
      expect(sync(db, config)).toMatchObject({ ingested: 0, failed: 1 });
      writer.exec("ROLLBACK");
      expect(sync(db, config)).toMatchObject({ ingested: 1, failed: 0 });
    } finally {
      writer.close();
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a read-only WAL store with unread commits fails instead of dropping them", () => {
    const { root, chatDir, config } = cursorCase();
    const live = join(root, "live");
    buildCursorChat(live);
    // Snapshot a store while its writer holds it open, as a read-only mount of
    // a running chat sees it: the newest commits exist only in the -wal, and
    // there is no -shm.
    const writer = new Database(join(live, "store.db"));
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    appendCursorMessage(writer, { id: "wal-1", role: "user", content: [] });
    appendCursorMessage(writer, { id: "wal-2", role: "assistant", content: [] });
    copyFileSync(join(live, "store.db"), join(chatDir, "store.db"));
    copyFileSync(join(live, "store.db-wal"), join(chatDir, "store.db-wal"));
    writer.close();
    const store = join(chatDir, "store.db");
    const db = openDb(join(root, "archive.db"));
    chmodSync(chatDir, 0o555);
    try {
      expect(() => readCursorSource(store)).toThrow("unread WAL data");
      const { result, lines } = captureLogs(() => sync(db, config));
      expect(result).toMatchObject({ ingested: 0, failed: 1 });
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        "event.name": "decant.ingest.source_read_failed",
        "error.message":
          "Cursor store has unread WAL data that a read-only open cannot see; " +
          "mount the chats directory read-write or close the chat in Cursor",
      });
      // Nothing is recorded, so the store is not mistaken for current.
      expect(db.query("SELECT count(*) AS n FROM ingest_source").get()).toEqual({ n: 0 });
      expect(sync(db, config)).toMatchObject({ ingested: 0, failed: 1 });
      chmodSync(chatDir, 0o755);
      expect(sync(db, config)).toMatchObject({ ingested: 1, failed: 0 });
      expect(db.query("SELECT message_count FROM session").get()).toEqual({ message_count: 6 });
    } finally {
      chmodSync(chatDir, 0o755);
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a same-size rewrite within the same second is still a change", () => {
    const { root, chatDir, config } = cursorCase();
    const metaPath = join(chatDir, "meta.json");
    const at = (path: string, seconds: number) => utimesSync(path, seconds, seconds);
    const db = openDb(join(root, "archive.db"));
    try {
      at(join(chatDir, "store.db"), 1_800_000_000.1);
      at(metaPath, 1_800_000_000.1);
      expect(sync(db, config)).toMatchObject({ ingested: 1 });
      // Same byte count, same whole-second mtime: only the sub-second mtime
      // tells the two apart.
      const meta = readFileSync(metaPath, "utf8");
      writeFileSync(metaPath, meta.replace("cursor-demo", "cursor-DEMO"));
      at(metaPath, 1_800_000_000.6);
      expect(sync(db, config)).toMatchObject({ ingested: 1, skipped: 0 });
      expect(db.query("SELECT cwd FROM session").get()).toEqual({ cwd: "/Users/dev/cursor-DEMO" });
      expect(sync(db, config)).toMatchObject({ ingested: 0, skipped: 1 });
      // A row recorded before per-file signatures re-ingests once, then skips.
      db.exec("UPDATE ingest_source SET hash = NULL");
      expect(sync(db, config)).toMatchObject({ ingested: 1 });
      expect(sync(db, config)).toMatchObject({ ingested: 0, skipped: 1 });
    } finally {
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("read failures never quote store content in errors or logs", () => {
    const { root, chatDir, config } = cursorCase();
    // An unquoted word is one a JSON syntax error quotes back.
    const secret = "zebrasecret4417";
    const store = join(chatDir, "store.db");
    rmSync(store);
    const db = new Database(store, { create: true });
    db.exec(
      "CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta(key TEXT, value TEXT)",
    );
    db.prepare("INSERT INTO meta VALUES ('agent', ?1)").run(
      Buffer.from(`{"name": ${secret}}`).toString("hex"),
    );
    db.close();
    const archive = openDb(join(root, "archive.db"));
    try {
      const { result, lines } = captureLogs(() => sync(archive, config));
      expect(result).toMatchObject({ failed: 1 });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(secret);
      expect(() => readCursorSource(store)).toThrow("Cursor store metadata is not valid JSON");

      // meta.json can change between discovery and the read.
      writeFileSync(join(chatDir, "meta.json"), `{"title": ${secret}}`);
      let message = "";
      try {
        readCursorSource(store);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toContain(secret);
      expect(message).toBe("Cursor meta.json is not valid JSON");
    } finally {
      closeDb(archive);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a store whose agent ID changes keeps one session", () => {
    const { root, chatDir, config } = cursorCase();
    const db = openDb(join(root, "archive.db"));
    try {
      expect(sync(db, config)).toMatchObject({ ingested: 1 });
      const fixture = JSON.parse(
        readFileSync(
          join(import.meta.dir, "..", "fixtures", "cursor", "sample", "store.json"),
          "utf8",
        ),
      );
      rmSync(join(chatDir, "store.db"));
      writeCursorStore(
        join(chatDir, "store.db"),
        { ...fixture.store, agentId: "cursor-renamed-session" },
        fixture.records,
      );
      // Force the re-read regardless of how the change signature compares.
      db.exec("UPDATE ingest_source SET size = -1, hash = NULL");
      expect(sync(db, config)).toMatchObject({ ingested: 1, failed: 0 });
      expect(db.query("SELECT source_session_id FROM session").all()).toEqual([
        { source_session_id: "cursor-renamed-session" },
      ]);
      expect(totals(db)).toMatchObject({ sessions: 1, messages: 4 });
    } finally {
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing and TEXT message blobs become diagnostics", () => {
    const { root, chatDir } = cursorCase();
    const store = join(chatDir, "store.db");
    const db = new Database(store);
    // One message blob gone, another rewritten as TEXT.
    const ids = (db.query("SELECT id FROM blobs ORDER BY rowid").all() as { id: string }[]).map(
      (row) => row.id,
    );
    db.prepare("DELETE FROM blobs WHERE id = ?1").run(ids[0] as string);
    db.prepare("UPDATE blobs SET data = CAST(data AS TEXT) WHERE id = ?1").run(ids[1] as string);
    db.close();
    try {
      const parsed = parseCursorSession("blobs", readCursorSource(store));
      expect(parsed.issues.map(({ code, lineNo, error }) => ({ code, lineNo, error }))).toEqual([
        {
          code: "unparsed_line",
          lineNo: 1,
          error: "Cursor message blob is missing from the store",
        },
        {
          code: "unknown_record_type",
          lineNo: 2,
          error: "Cursor message blob is stored as TEXT rather than BLOB; read as UTF-8",
        },
      ]);
      expect(parsed.session.messages.map((message) => message.sourceUuid)).toEqual([
        "assistant-1",
        "tool-1",
        "assistant-2",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-array content and unknown roles become content-free diagnostics", () => {
    const parsed = parseCursorSession("shapes", {
      fileMeta: { schemaVersion: 1 },
      storeMeta: {},
      records: [
        { id: "a", role: "user", content: { text: "private words" } },
        { id: "b", role: "narrator", content: [] },
        { id: "c", role: "private words here", content: [] },
        { id: "d", role: "system", content: "You are a synthetic helper." },
        new CursorBlobProblem("invalid_json", "{not json"),
      ],
    });
    expect(parsed.issues.map(({ code, lineNo, error }) => ({ code, lineNo, error }))).toEqual([
      {
        code: "unparsed_line",
        lineNo: 1,
        error: "Cursor message content is not an array; message kept without content",
      },
      { code: "unparsed_line", lineNo: 5, error: "Cursor message blob is not valid JSON" },
      {
        code: "unknown_record_type",
        lineNo: 2,
        error: 'unknown Cursor message role "narrator" on 1 message(s); kept as role "other"',
      },
      {
        code: "unknown_record_type",
        lineNo: 3,
        error: 'unknown Cursor message role "<unrecognized>" on 1 message(s); kept as role "other"',
      },
    ]);
    expect(parsed.session.messages.map((message) => message.role)).toEqual([
      "user",
      "other",
      "other",
      "system",
    ]);
    expect(parsed.session.messages[3]?.blocks).toMatchObject([
      { blockType: "text", text: "You are a synthetic helper." },
    ]);
  });

  test("turns malformed and unknown message content into diagnostics", () => {
    const parsed = parseCursorSession("diagnostics", {
      fileMeta: { schemaVersion: 1 },
      storeMeta: {},
      records: [
        "bad",
        { role: "assistant", content: [{ type: "future-block", value: 1 }, "bad-block"] },
      ],
    });
    expect(parsed.issues.map((issue) => issue.code)).toEqual([
      "unparsed_line",
      "unknown_record_type",
      "unknown_record_type",
    ]);
    expect(parsed.issues.map((issue) => issue.error)).toContain(
      'unknown record type "<non-object>" on 1 line(s); ignored',
    );
  });

  test("out-of-range meta.json timestamps read as absent instead of throwing", () => {
    const parsed = parseCursorSession("timestamps", {
      fileMeta: { schemaVersion: 1, createdAtMs: 1e20, updatedAtMs: -1e20 },
      storeMeta: {},
      records: [],
    });
    expect(parsed.session).toMatchObject({ startedAt: null, endedAt: null });
  });

  test("preserves Cursor subagent lineage metadata", () => {
    const parsed = parseCursorSession("child", {
      fileMeta: { schemaVersion: 1, isSubagent: true },
      storeMeta: {
        agentId: "cursor-child",
        subagentInfo: {
          parentAgentId: "cursor-parent",
          rootParentAgentId: "cursor-root",
          toolCallId: "spawn-call",
          typeName: "researcher",
        },
      },
      records: [],
    });
    expect(parsed.session).toMatchObject({
      isSubagent: true,
      rootSourceSessionId: "cursor-root",
      spawnToolUseId: "spawn-call",
      agentId: "cursor-child",
      agentType: "researcher",
    });
  });

  test("discovers, ingests, queries, and then skips an unchanged Cursor store", () => {
    const root = mkdtempSync(join(tmpdir(), "decant-cursor-test-"));
    const cursorDir = join(root, "cursor");
    const chatDir = join(cursorDir, "workspace", "chat");
    buildCursorChat(chatDir);
    const config = {
      claudeDir: join(root, "claude"),
      codexDir: join(root, "codex"),
      cursorDir,
    };
    const db = openDb(join(root, "archive.db"));
    try {
      expect(discover(config)).toEqual([
        { tool: "cursor", path: join(chatDir, "store.db"), archived: false },
      ]);
      expect(sync(db, config)).toMatchObject({ scanned: 1, ingested: 1, failed: 0, issues: 0 });
      expect(
        db
          .query(
            `SELECT tool, source_session_id, message_count,
                    (SELECT count(*) FROM tool_call WHERE session_id = session.id) AS tool_call_count
               FROM session`,
          )
          .get(),
      ).toEqual({
        tool: "cursor",
        source_session_id: "cursor-synthetic-session",
        message_count: 4,
        tool_call_count: 1,
      });
      expect(listSessions(db)[0]?.usage_available).toBe(false);
      expect(totals(db)).toMatchObject({
        sessions: 1,
        usage_sessions: 0,
        input_tokens: 0,
        output_tokens: 0,
        estimated_cost_usd: 0,
      });
      expect(sync(db, config)).toMatchObject({ scanned: 1, ingested: 0, skipped: 1, failed: 0 });

      const emptyChat = join(cursorDir, "workspace", "empty");
      buildCursorChat(emptyChat);
      writeFileSync(
        join(emptyChat, "meta.json"),
        JSON.stringify({ schemaVersion: 1, hasConversation: false }),
      );
      expect(discover(config)).toHaveLength(1);
    } finally {
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only Cursor sessions without usage read as unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "decant-cursor-test-"));
    const cursorDir = join(root, "cursor");
    buildCursorChat(join(cursorDir, "workspace", "chat"));
    // This Codex fixture reports usage only as session totals, never per message.
    const codexSessions = join(root, "codex", "sessions");
    mkdirSync(codexSessions, { recursive: true });
    writeFileSync(
      join(codexSessions, "rollout-sample.jsonl"),
      readFileSync(join(import.meta.dir, "..", "fixtures", "codex", "sample.jsonl")),
    );
    const config = { claudeDir: join(root, "claude"), codexDir: join(root, "codex"), cursorDir };
    const db = openDb(join(root, "archive.db"));
    try {
      expect(sync(db, config)).toMatchObject({ ingested: 2, failed: 0 });
      const byTool = Object.fromEntries(
        listSessions(db).map((session) => [session.tool, session.usage_available]),
      );
      expect(byTool).toEqual({ codex: true, cursor: false });
      expect(totals(db)).toMatchObject({ sessions: 2, usage_sessions: 1 });
    } finally {
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unreadable store fails alone and the rest of the sync continues", () => {
    const root = mkdtempSync(join(tmpdir(), "decant-cursor-test-"));
    const cursorDir = join(root, "cursor");
    buildCursorChat(join(cursorDir, "workspace", "good"));
    const broken = join(cursorDir, "workspace", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "store.db"), "not a sqlite database");
    writeFileSync(
      join(broken, "meta.json"),
      JSON.stringify({ schemaVersion: 1, hasConversation: true }),
    );
    const config = { claudeDir: join(root, "claude"), codexDir: join(root, "codex"), cursorDir };
    const db = openDb(join(root, "archive.db"));
    try {
      expect(sync(db, config)).toMatchObject({ scanned: 2, ingested: 1, failed: 1 });
      // Nothing was recorded for the broken store, so the next sync retries it.
      expect(sync(db, config)).toMatchObject({ scanned: 2, skipped: 1, failed: 1 });
    } finally {
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a changed meta.json re-ingests the chat even when store.db is untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "decant-cursor-test-"));
    const cursorDir = join(root, "cursor");
    const chatDir = join(cursorDir, "workspace", "chat");
    buildCursorChat(chatDir);
    const config = { claudeDir: join(root, "claude"), codexDir: join(root, "codex"), cursorDir };
    const db = openDb(join(root, "archive.db"));
    try {
      expect(sync(db, config)).toMatchObject({ ingested: 1 });
      const metaPath = join(chatDir, "meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      writeFileSync(metaPath, JSON.stringify({ ...meta, title: "Renamed chat" }));
      expect(sync(db, config)).toMatchObject({ ingested: 1, skipped: 0 });
      expect(db.query("SELECT title FROM session").get()).toEqual({ title: "Renamed chat" });
    } finally {
      closeDb(db);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--path accepts a store.db file or a directory holding chats", () => {
    const root = mkdtempSync(join(tmpdir(), "decant-cursor-test-"));
    try {
      const chatDir = join(root, "workspace", "chat");
      buildCursorChat(chatDir);
      const store = join(chatDir, "store.db");
      const expected = [{ tool: "cursor" as const, path: store, archived: false }];
      expect(discoverSourcePaths([store])).toEqual(expected);
      expect(discoverSourcePaths([root])).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
