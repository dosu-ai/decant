import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { EconomicsCache } from "../src/economics-cache.ts";
import { type IngestConfig, sync } from "../src/ingest.ts";
import { getSession } from "../src/query.ts";
import { ReadConnection } from "../src/read-connection.ts";
import { ReaderStatistics } from "../src/server/reader-statistics.ts";
import { tokenEconomics } from "../src/token-economics.ts";
import { assertDatabaseIntegrity, captureCanonicalSnapshot } from "./helpers/ingest-oracle.ts";

const rootDir = mkdtempSync(join(tmpdir(), "decant-incremental-unit-"));
afterAll(() => rmSync(rootDir, { recursive: true, force: true }));

let caseId = 0;
function freshCase(): { dir: string; dbPath: string; config: IngestConfig } {
  const dir = join(rootDir, `case-${++caseId}`);
  const claudeDir = join(dir, "claude");
  const codexDir = join(dir, "codex");
  const copilotDir = join(dir, "copilot");
  const piDir = join(dir, "pi");
  mkdirSync(join(claudeDir, "proj"), { recursive: true });
  mkdirSync(join(codexDir, "sessions", "2026", "11", "01"), { recursive: true });
  mkdirSync(copilotDir, { recursive: true });
  mkdirSync(join(piDir, "--work--"), { recursive: true });
  return {
    dir,
    dbPath: join(dir, "decant.db"),
    config: { claudeDir, codexDir, copilotDir, piDir },
  };
}

function claudeTurn(
  sessionId: string,
  turn: number,
  reqId: string,
  outputTokens = 40,
  extra = "",
): string {
  const sec = String(turn % 60).padStart(2, "0");
  const min = String(Math.floor(turn / 60) % 60).padStart(2, "0");
  const user = JSON.stringify({
    type: "user",
    uuid: `u-${turn}`,
    sessionId,
    cwd: "/home/dev/work/app",
    timestamp: `2026-11-01T10:${min}:${sec}.000Z`,
    message: { role: "user", content: `Prompt ${turn} ${extra}` },
  });
  const asst = JSON.stringify({
    type: "assistant",
    uuid: `a-${turn}`,
    requestId: reqId,
    sessionId,
    cwd: "/home/dev/work/app",
    timestamp: `2026-11-01T10:${min}:${sec}.500Z`,
    message: {
      id: `msg_${reqId}`,
      role: "assistant",
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100 + turn,
        output_tokens: outputTokens,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 0,
      },
      content: [
        { type: "thinking", thinking: `Thinking on turn ${turn}` },
        { type: "text", text: `Answer ${turn} ${extra}` },
      ],
    },
  });
  return `${user}\n${asst}\n`;
}

describe("incremental ingest fast path", () => {
  test("preserves existing message and block row IDs on append for Claude, Codex, and Pi", () => {
    const { dbPath, config } = freshCase();
    const claudeFile = join(config.claudeDir, "proj", "c-inc.jsonl");
    const codexFile = join(
      config.codexDir,
      "sessions",
      "2026",
      "11",
      "01",
      "rollout-2026-11-01T10-00-00-cx-inc.jsonl",
    );
    const piFile = join(config.piDir ?? "", "--work--", "2026-11-01T10-00-00-000Z_pi-inc.jsonl");

    writeFileSync(claudeFile, claudeTurn("c-inc", 1, "req-1"));
    writeFileSync(
      codexFile,
      `${JSON.stringify({
        timestamp: "2026-11-01T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-inc", cwd: "/home/dev/work/app", cli_version: "0.2.0" },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello Codex" }],
        },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi there" }],
        },
      })}\n`,
    );
    writeFileSync(
      piFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-inc",
        timestamp: "2026-11-01T10:00:00.000Z",
        cwd: "/home/dev/work/app",
      })}\n${JSON.stringify({
        type: "message",
        id: "p1",
        timestamp: "2026-11-01T10:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Hello Pi" }] },
      })}\n`,
    );

    const db = openDb(dbPath);
    try {
      const first = sync(db, config);
      expect(first.ingested).toBe(3);

      const beforeMsgs = db.query("SELECT id, session_id, seq FROM message ORDER BY id").all() as {
        id: number;
        session_id: number;
        seq: number;
      }[];
      const beforeBlocks = db
        .query("SELECT id, message_id, ordinal FROM block ORDER BY id")
        .all() as { id: number; message_id: number; ordinal: number }[];

      appendFileSync(claudeFile, claudeTurn("c-inc", 2, "req-2"));
      appendFileSync(
        codexFile,
        `${JSON.stringify({
          timestamp: "2026-11-01T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Second Codex turn" }],
          },
        })}\n`,
      );
      appendFileSync(
        piFile,
        `${JSON.stringify({
          type: "message",
          id: "p2",
          parentId: "p1",
          timestamp: "2026-11-01T10:00:05.000Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-6",
            stopReason: "stop",
            usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0 },
            content: [{ type: "text", text: "Hi from Pi" }],
          },
        })}\n`,
      );

      const second = sync(db, config);
      expect(second.ingested).toBe(3);

      const afterMsgs = db.query("SELECT id, session_id, seq FROM message ORDER BY id").all() as {
        id: number;
        session_id: number;
        seq: number;
      }[];
      const afterBlocks = db
        .query("SELECT id, message_id, ordinal FROM block ORDER BY id")
        .all() as { id: number; message_id: number; ordinal: number }[];

      expect(afterMsgs.slice(0, beforeMsgs.length)).toEqual(beforeMsgs);
      expect(afterBlocks.slice(0, beforeBlocks.length)).toEqual(beforeBlocks);
      assertDatabaseIntegrity(db);
    } finally {
      closeDb(db);
    }
  });

  test("falls back cleanly when a Claude requestId evicted from the recent window reappears", () => {
    const { dir, dbPath, config } = freshCase();
    const claudeFile = join(config.claudeDir, "proj", "c-bloom.jsonl");
    let content = "";
    for (let i = 1; i <= 75; i += 1) {
      content += claudeTurn("c-bloom", i, `req-${i}`, 50);
    }
    writeFileSync(claudeFile, content);

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      // Repeat request #1 (which was evicted past the 64-request window) with higher output_tokens.
      appendFileSync(
        claudeFile,
        `${JSON.stringify({
          type: "assistant",
          uuid: "a-1-late",
          requestId: "req-1",
          sessionId: "c-bloom",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:05:00.000Z",
          message: {
            id: "msg_req-1",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            usage: {
              input_tokens: 101,
              output_tokens: 120,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 0,
            },
            content: [{ type: "text", text: "Late streaming completion for req-1" }],
          },
        })}\n`,
      );

      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });
});

describe("in-place diff/upsert on full rebuilds", () => {
  test("preserves unchanged message and block row IDs on Copilot appends and handles truncation", () => {
    const { dir, dbPath, config } = freshCase();
    const sessionDir = join(config.copilotDir ?? "", "cop-diff");
    mkdirSync(sessionDir, { recursive: true });
    const eventsPath = join(sessionDir, "events.jsonl");
    const sample = readFileSync(
      join(import.meta.dir, "..", "fixtures", "copilot", "sample", "events.jsonl"),
      "utf8",
    )
      .trimEnd()
      .split("\n");

    writeFileSync(eventsPath, `${sample.slice(0, 6).join("\n")}\n`);
    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);
      const beforeMsgIds = (
        db.query("SELECT id FROM message ORDER BY seq").all() as { id: number }[]
      ).map((r) => r.id);
      const beforeBlockIds = (
        db.query("SELECT id FROM block ORDER BY message_id, ordinal").all() as { id: number }[]
      ).map((r) => r.id);
      expect(beforeMsgIds.length).toBeGreaterThan(0);

      writeFileSync(eventsPath, `${sample.join("\n")}\n`);
      expect(sync(db, config).ingested).toBe(1);
      const afterMsgIds = (
        db.query("SELECT id FROM message ORDER BY seq").all() as { id: number }[]
      ).map((r) => r.id);
      const afterBlockIds = (
        db.query("SELECT id FROM block ORDER BY message_id, ordinal").all() as { id: number }[]
      ).map((r) => r.id);
      expect(afterMsgIds.slice(0, beforeMsgIds.length)).toEqual(beforeMsgIds);
      expect(afterBlockIds.slice(0, beforeBlockIds.length)).toEqual(beforeBlockIds);
      assertDatabaseIntegrity(db);

      // Truncate back to the first 6 lines: must remove trailing tool_calls/blocks cleanly without FK errors.
      writeFileSync(eventsPath, `${sample.slice(0, 6).join("\n")}\n`);
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });
});

describe("serve watch & cache incremental helpers", () => {
  test("ReaderStatistics.onCompleted reloads only when sqlite_stat1 changed", () => {
    let stored = "initial-stat";
    let reloads = 0;
    const stats = new ReaderStatistics({
      stored: () => stored,
      reload: () => {
        reloads += 1;
      },
    });
    stats.onCompleted();
    expect(reloads).toBe(0);
    stored = "updated-stat";
    stats.onCompleted();
    expect(reloads).toBe(1);
    stats.onCompleted();
    expect(reloads).toBe(1);
  });

  test("EconomicsCache.refreshSessions updates in place without spawning a full rebuild", async () => {
    const { dbPath, config } = freshCase();
    const claudeFile = join(config.claudeDir, "proj", "c-econ.jsonl");
    writeFileSync(claudeFile, claudeTurn("c-econ", 1, "req-1", 40));

    const db = openDb(dbPath);
    try {
      expect(sync(db, config).ingested).toBe(1);
      const sessionId = (db.query("SELECT id FROM session LIMIT 1").get() as { id: number }).id;
      const cache = new EconomicsCache({ dbPath, db });
      try {
        const before = await cache.get();
        expect(before).toEqual(tokenEconomics(db));

        appendFileSync(claudeFile, claudeTurn("c-econ", 2, "req-2", 120));
        expect(sync(db, config).ingested).toBe(1);

        cache.refreshSessions([sessionId]);
        const after = await cache.get();
        expect(after).toEqual(tokenEconomics(db));
        expect(after.totals.generation_tokens).toBeGreaterThan(before.totals.generation_tokens);
      } finally {
        cache.dispose();
        await cache.settled();
      }
    } finally {
      closeDb(db);
    }
  });

  test("targeted watch candidatePaths ingests only the named file and defers recommendations until sweep", () => {
    const { dbPath, config } = freshCase();
    const fileA = join(config.claudeDir, "proj", "c-a.jsonl");
    const fileB = join(config.claudeDir, "proj", "c-b.jsonl");
    writeFileSync(fileA, claudeTurn("c-a", 1, "req-a1"));
    writeFileSync(fileB, claudeTurn("c-b", 1, "req-b1"));

    const db = openDb(dbPath);
    try {
      expect(sync(db, config).ingested).toBe(2);

      appendFileSync(fileA, claudeTurn("c-a", 2, "req-a2"));
      appendFileSync(fileB, claudeTurn("c-b", 2, "req-b2"));

      const changed: number[] = [];
      const targeted = sync(db, config, undefined, undefined, {
        candidatePaths: [fileA],
        deferDerivedRefresh: true,
        onSessionChanged: (id) => changed.push(id),
      });
      expect(targeted.scanned).toBe(1);
      expect(targeted.ingested).toBe(1);
      expect(changed.length).toBe(1);

      const sweep = sync(db, config);
      expect(sweep.scanned).toBe(2);
      expect(sweep.ingested).toBe(1);
      expect(sweep.skipped).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  test("materialized session reply_count, tool_call_count, and search_count match SQL fallback across appends", () => {
    const { dbPath, config } = freshCase();
    const claudeFile = join(config.claudeDir, "proj", "c-counts.jsonl");
    writeFileSync(
      claudeFile,
      `${claudeTurn("c-counts", 1, "req-1")}${JSON.stringify({
        type: "assistant",
        uuid: "a-grep",
        requestId: "req-2",
        sessionId: "c-counts",
        cwd: "/home/dev/work/app",
        timestamp: "2026-11-01T10:00:05.000Z",
        message: {
          id: "msg_req-2",
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 20 },
          content: [{ type: "tool_use", id: "tu-grep-1", name: "Grep", input: { pattern: "foo" } }],
        },
      })}\n`,
    );

    const db = openDb(dbPath);
    try {
      expect(sync(db, config).ingested).toBe(1);
      const id = (db.query("SELECT id FROM session LIMIT 1").get() as { id: number }).id;
      const before = db
        .query("SELECT reply_count, tool_call_count, search_count FROM session WHERE id = ?1")
        .get(id) as { reply_count: number; tool_call_count: number; search_count: number };
      expect(before).toEqual({ reply_count: 2, tool_call_count: 1, search_count: 1 });
      expect(getSession(db, id)?.totals).toEqual({ reply_count: 2, tool_call_count: 1 });

      appendFileSync(
        claudeFile,
        `${JSON.stringify({
          type: "assistant",
          uuid: "a-bash",
          requestId: "req-3",
          sessionId: "c-counts",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:10.000Z",
          message: {
            id: "msg_req-3",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 20 },
            content: [
              {
                type: "tool_use",
                id: "tu-bash-1",
                name: "Bash",
                input: { command: "rg needle src/ && git grep other" },
              },
            ],
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);
      const after = db
        .query("SELECT reply_count, tool_call_count, search_count FROM session WHERE id = ?1")
        .get(id) as { reply_count: number; tool_call_count: number; search_count: number };
      expect(after).toEqual({ reply_count: 3, tool_call_count: 2, search_count: 3 });
      expect(getSession(db, id)?.totals).toEqual({ reply_count: 3, tool_call_count: 2 });

      // Clear materialized columns to verify fallback matches identically.
      db.run("UPDATE session SET reply_count = NULL, tool_call_count = NULL WHERE id = ?1", [id]);
      expect(getSession(db, id)?.totals).toEqual({ reply_count: 3, tool_call_count: 2 });
    } finally {
      closeDb(db);
    }
  });

  test("ReadConnection skips reopening when sqlite_stat1 did not change", async () => {
    const { dbPath, config } = freshCase();
    const claudeFile = join(config.claudeDir, "proj", "c-rc.jsonl");
    writeFileSync(claudeFile, claudeTurn("c-rc", 1, "req-1"));
    const writer = openDb(dbPath);
    const reader = new ReadConnection(dbPath);
    try {
      expect(sync(writer, config).ingested).toBe(1);
      const firstHandle = await reader.use((db) => db);
      reader.reloadStatistics();
      const secondHandle = await reader.use((db) => db);
      expect(secondHandle).toBe(firstHandle);

      writer.exec("ANALYZE");
      reader.reloadStatistics();
      const thirdHandle = await reader.use((db) => db);
      expect(thirdHandle).not.toBe(firstHandle);
    } finally {
      reader.close();
      closeDb(writer);
    }
  });
});
