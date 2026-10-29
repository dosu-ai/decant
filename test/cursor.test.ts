import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { discover, discoverSourcePaths, sync } from "../src/ingest.ts";
import { listSessions } from "../src/query.ts";
import { parseCursorSession, readCursorSource } from "../src/sources/cursor.ts";
import { totals } from "../src/stats.ts";
import { buildCursorChat } from "./cursor-fixture.ts";

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
