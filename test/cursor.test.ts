import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { discover, sync } from "../src/ingest.ts";
import { listSessions } from "../src/query.ts";
import { parseCursorSession, readCursorSource } from "../src/sources/cursor.ts";
import { totals } from "../src/stats.ts";

const storePath = join(import.meta.dir, "..", "fixtures", "cursor", "sample", "store.db");

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
      'unknown Cursor content type "<non-object>" in 1 block(s); ignored',
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
    mkdirSync(chatDir, { recursive: true });
    copyFileSync(storePath, join(chatDir, "store.db"));
    copyFileSync(join(dirname(storePath), "meta.json"), join(chatDir, "meta.json"));
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
      mkdirSync(emptyChat, { recursive: true });
      copyFileSync(storePath, join(emptyChat, "store.db"));
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
});
