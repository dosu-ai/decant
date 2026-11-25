import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { contextWindowForSession } from "../src/context-window.ts";
import { closeDb, LATEST_SCHEMA_VERSION, openDb } from "../src/db.ts";
import { EconomicsCache } from "../src/economics-cache.ts";
import { tryIncrementalIngest } from "../src/incremental-ingest.ts";
import {
  INGEST_PIPELINE_REVISION,
  type IngestConfig,
  type SyncReport,
  sync,
} from "../src/ingest.ts";
import { getSession, search } from "../src/query.ts";
import { ReadConnection } from "../src/read-connection.ts";
import { regenerate as regenerateRecommendations } from "../src/recommendations.ts";
import { ReaderStatistics } from "../src/server/reader-statistics.ts";
import {
  applyWatchEvent,
  createSyncCoordinator,
  syncNow,
  syncStatus,
  workerSyncRunner,
} from "../src/server/sync.ts";
import { setSessionUserState } from "../src/session-user-state.ts";
import {
  bumpSyncStateGeneration,
  committedEconomicsWrites,
  markSyncStateCleared,
  readSyncStateGeneration,
  SYNC_STATE_RECOMMENDATIONS_CLEARED,
  SYNC_STATE_RECOMMENDATIONS_PENDING,
  SYNC_STATE_RECOMMENDATIONS_REFRESH_SEQ,
} from "../src/sync-state.ts";
import { tokenEconomics } from "../src/token-economics.ts";
import { SyncStatusStore } from "../src/watch.ts";
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

describe("Sol review regression coverage (F1-F13)", () => {
  test("F1: concurrent writer advancing checkpoint does not duplicate appended messages", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f1.jsonl");
    writeFileSync(file, claudeTurn("c-f1", 1, "req-1"));

    const dbA = openDb(dbPath);
    const dbB = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(dbA, config).ingested).toBe(1);
      const prior = dbA
        .query("SELECT size, mtime, session_id FROM ingest_source WHERE path = ?1")
        .get(file) as { size: number; mtime: number; session_id: number };

      appendFileSync(file, claudeTurn("c-f1", 2, "req-2"));
      const stats = statSync(file);

      // Connection B commits the append first while A still holds stale prior metadata.
      expect(sync(dbB, config).ingested).toBe(1);

      const fd = openSync(file, "r");
      try {
        const res = tryIncrementalIngest({
          db: dbA,
          fd,
          stats,
          sourcePath: file,
          tool: "claude_code",
          archived: false,
          priorSize: prior.size,
          priorMtime: prior.mtime,
          priorSessionId: prior.session_id,
          ingestRevision: INGEST_PIPELINE_REVISION,
          expectedRevision: INGEST_PIPELINE_REVISION,
          sidecarMeta: null,
          codexTitles: new Map(),
        });
        expect(res.kind).toBe("skipped");
      } finally {
        closeSync(fd);
      }

      expect(sync(freshDb, config).ingested).toBe(1);
      assertDatabaseIntegrity(dbA);
      expect(captureCanonicalSnapshot(dbA)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(dbA);
      closeDb(dbB);
      closeDb(freshDb);
    }
  });

  test("F2: same-size rewrite outside sampled prefix regions with newer mtime re-parses and updates FTS", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f2.jsonl");
    const padA = "A".repeat(45_000);
    const padB = "B".repeat(45_000);
    const makeLine = (seq: number, body: string) =>
      `${JSON.stringify({
        type: "user",
        uuid: `u-${seq}`,
        sessionId: "c-f2",
        cwd: "/home/dev/work/app",
        timestamp: `2026-11-01T10:00:${String(seq).padStart(2, "0")}.000Z`,
        message: { role: "user", content: body },
      })}\n`;
    const middleBefore = "OLD_TOKEN_UNIQ_0001";
    const middleAfter = "NEW_TOKEN_UNIQ_9999";
    const before =
      makeLine(1, padA) +
      makeLine(2, `middle ${middleBefore} ${"C".repeat(10_000)}`) +
      makeLine(3, padB) +
      makeLine(4, padA) +
      makeLine(5, padB);
    const after = before.replace(middleBefore, middleAfter);
    expect(Buffer.byteLength(before)).toBe(Buffer.byteLength(after));
    expect(Buffer.byteLength(before)).toBeGreaterThan(180_000);

    writeFileSync(file, before);
    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);
      expect(search(db, middleBefore).length).toBeGreaterThan(0);

      writeFileSync(file, after);
      const bumped = new Date(Date.now() + 5_000);
      utimesSync(file, bumped, bumped);

      expect(sync(db, config).ingested).toBe(1);
      expect(search(db, middleAfter).length).toBeGreaterThan(0);
      expect(search(db, middleBefore).length).toBe(0);

      expect(sync(freshDb, config).ingested).toBe(1);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("F3: targeted watch candidatePaths enforces source root rules and skips symlinks", () => {
    const { dir, dbPath, config } = freshCase();
    const nonTranscript = join(config.codexDir, "sessions", "non-transcript.jsonl");
    writeFileSync(nonTranscript, claudeTurn("should-not-ingest", 1, "req-1"));

    const outside = join(dir, "outside.jsonl");
    writeFileSync(outside, claudeTurn("outside-symlink", 1, "req-2"));
    const linked = join(config.claudeDir, "proj", "linked.jsonl");
    symlinkSync(outside, linked);

    const db = openDb(dbPath);
    try {
      const report = sync(db, config, undefined, undefined, {
        candidatePaths: [nonTranscript, linked],
        deferDerivedRefresh: true,
      });
      expect(report.scanned).toBe(0);
      expect(report.ingested).toBe(0);
      expect((db.query("SELECT COUNT(*) AS n FROM session").get() as { n: number }).n).toBe(0);
    } finally {
      closeDb(db);
    }
  });

  test("F4: cross-session billed_request transfer updates both sessions in EconomicsCache and rejects stale dataVersion", async () => {
    const { dbPath, config } = freshCase();
    const original = join(config.claudeDir, "proj", "c-orig.jsonl");
    const branch = join(config.claudeDir, "proj", "c-branch.jsonl");
    const sharedAssistant = (sessionId: string, forkedFrom?: string) =>
      `${JSON.stringify({
        type: "user",
        uuid: `u-${sessionId}`,
        sessionId,
        cwd: "/home/dev/work/app",
        timestamp: forkedFrom != null ? "2026-11-01T10:05:00.000Z" : "2026-11-01T10:00:00.000Z",
        ...(forkedFrom != null ? { forkedFrom: { sessionId: forkedFrom } } : {}),
        message: { role: "user", content: "Shared turn" },
      })}\n${JSON.stringify({
        type: "assistant",
        uuid: `a-${sessionId}`,
        requestId: "req-shared-1",
        sessionId,
        cwd: "/home/dev/work/app",
        timestamp: "2026-11-01T10:00:02.000Z",
        ...(forkedFrom != null ? { forkedFrom: { sessionId: forkedFrom } } : {}),
        message: {
          id: "msg_shared_f4",
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: "text", text: "Answer" }],
        },
      })}\n`;

    writeFileSync(branch, sharedAssistant("c-branch", "c-orig"));
    const db = openDb(dbPath);
    try {
      expect(sync(db, config).ingested).toBe(1);
      const cache = new EconomicsCache({ dbPath, db });
      try {
        const before = await cache.get();
        expect(before).toEqual(tokenEconomics(db));

        writeFileSync(original, sharedAssistant("c-orig"));
        const changed: number[] = [];
        const versionBefore = cache.dataVersion();
        const report = sync(db, config, undefined, undefined, {
          onSessionChanged: (id) => changed.push(id),
        });
        expect(report.ingested).toBe(1);
        expect(new Set(changed).size).toBe(2);

        cache.refreshSessions(changed, versionBefore);
        expect(await cache.get()).toEqual(tokenEconomics(db));

        // Passing a mismatched expectedDataVersion must trigger invalidation instead of masking external writes.
        cache.refreshSessions(changed, (versionBefore ?? 0) - 999);
        await cache.settled();
        expect(await cache.get()).toEqual(tokenEconomics(db));
      } finally {
        cache.dispose();
        await cache.settled();
      }
    } finally {
      closeDb(db);
    }
  });

  test("F5 & F8: Codex model switch and usage restamp keep checkpoint model_usage and context_window in sync", () => {
    const { dir, dbPath, config } = freshCase();
    const codexFile = join(
      config.codexDir,
      "sessions",
      "2026",
      "11",
      "01",
      "rollout-2026-11-01T10-00-00-cx-f5f8.jsonl",
    );
    writeFileSync(
      codexFile,
      `${JSON.stringify({
        timestamp: "2026-11-01T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-f5f8", cwd: "/home/dev/work/app", cli_version: "0.2.0" },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "One" }],
        },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
            last_token_usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
          },
        },
      })}\n`,
    );

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      // Restamp previous assistant from 1000 -> 10 input tokens and switch model to gpt-5.4-mini.
      appendFileSync(
        codexFile,
        `${JSON.stringify({
          timestamp: "2026-11-01T10:00:04.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4-mini" },
        })}\n${JSON.stringify({
          timestamp: "2026-11-01T10:00:05.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                output_tokens: 50,
                cached_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 50,
                cached_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
            },
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);

      // Follow with a compaction + unrelated user message to verify checkpoint stays exact.
      appendFileSync(
        codexFile,
        `${JSON.stringify({
          timestamp: "2026-11-01T10:00:06.000Z",
          type: "event_msg",
          payload: { type: "context_compacted" },
        })}\n${JSON.stringify({
          timestamp: "2026-11-01T10:00:07.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Follow up" }],
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

  test("F6: deferred derived work persists across connection close and final-file cancel is honored", () => {
    const { dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f6.jsonl");
    writeFileSync(file, claudeTurn("c-f6", 1, "req-1"));

    // 1. Cancel during final progress must return cancelled: true and skip recommendations.
    const db1 = openDb(dbPath);
    const cancel = { aborted: false };
    try {
      const report = sync(db1, config, cancel, (p) => {
        if (p.scanned >= p.total && p.total > 0) {
          cancel.aborted = true;
        }
      });
      expect(report.ingested).toBe(1);
      expect(report.cancelled).toBe(true);
      expect((db1.query("SELECT COUNT(*) AS n FROM recommendation").get() as { n: number }).n).toBe(
        0,
      );
    } finally {
      closeDb(db1);
    }

    // 2. Reopen on a fresh connection and run a full sync that ingests 0 new files: pending recommendations must still run.
    const db2 = openDb(dbPath);
    try {
      const report = sync(db2, config);
      expect(report.ingested).toBe(0);
      expect(report.skipped).toBe(1);
      expect(
        (db2.query("SELECT COUNT(*) AS n FROM recommendation").get() as { n: number }).n,
      ).toBeGreaterThan(0);
    } finally {
      closeDb(db2);
    }
  });

  test("F7: SyncCoordinator queues manual or disjoint runs instead of coalescing onto a narrower watch run", async () => {
    const { dbPath, config } = freshCase();
    const fullConfig = { ...config, dbPath } as Config;
    const gate = Promise.withResolvers<void>();
    const calls: (readonly string[] | undefined)[] = [];
    const coordinator = createSyncCoordinator(async (_cfg, _cancel, _onProgress, syncOpts) => {
      calls.push(syncOpts?.candidatePaths);
      if (calls.length === 1) {
        await gate.promise;
      }
      return {
        scanned: syncOpts?.candidatePaths?.length ?? 99,
        ingested: 1,
        skipped: 0,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: false,
      } satisfies SyncReport;
    });

    try {
      const watchHandle = coordinator.runWithOwnership(fullConfig, undefined, undefined, {
        candidatePaths: ["/a.jsonl"],
        deferDerivedRefresh: true,
      });
      const manualHandle = coordinator.runWithOwnership(
        fullConfig,
        undefined,
        undefined,
        undefined,
      );
      expect(manualHandle.owned).toBe(true);
      gate.resolve();
      const [watchReport, manualReport] = await Promise.all([
        watchHandle.promise,
        manualHandle.promise,
      ]);
      expect(watchReport.scanned).toBe(1);
      expect(manualReport.scanned).toBe(99);
      expect(calls).toEqual([["/a.jsonl"], undefined]);
    } finally {
      await coordinator.close();
    }
  });

  test("F9: Claude streaming replacement changing message.id releases old billed_request claim", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f9.jsonl");
    writeFileSync(file, claudeTurn("c-f9", 1, "req-1", 40));

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      appendFileSync(
        file,
        `${JSON.stringify({
          type: "assistant",
          uuid: "a-1-replace",
          requestId: "req-1",
          sessionId: "c-f9",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:05.000Z",
          message: {
            id: "msg_req-1_DIFFERENT_ID",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            usage: {
              input_tokens: 101,
              output_tokens: 120,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 0,
            },
            content: [{ type: "text", text: "Replaced with different message.id" }],
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

  test("F10: late Claude thinking block for response outside 16-response window updates economics", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f10.jsonl");
    let content = "";
    for (let i = 1; i <= 20; i += 1) {
      content += claudeTurn("c-f10", i, `req-${i}`, 400);
    }
    writeFileSync(file, content);

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      // Append a thinking block for msg_req-1 (20 responses ago) without increasing usage.
      appendFileSync(
        file,
        `${JSON.stringify({
          type: "assistant",
          uuid: "a-1-late-think",
          requestId: "req-1",
          sessionId: "c-f10",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:05:00.000Z",
          message: {
            id: "msg_req-1",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: null,
            usage: {
              input_tokens: 101,
              output_tokens: 400,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 0,
            },
            content: [{ type: "thinking", thinking: "Deep thought about response 1" }],
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

  test("F11: tool_result before tool_use in same delta matches fresh ingest and true orphans increment report.issues", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f11.jsonl");
    writeFileSync(file, claudeTurn("c-f11", 1, "req-1"));

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      appendFileSync(
        file,
        `${JSON.stringify({
          type: "user",
          uuid: "u-res-first",
          sessionId: "c-f11",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:05.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu-out-of-order", content: "ok" }],
          },
        })}\n${JSON.stringify({
          type: "assistant",
          uuid: "a-call-second",
          requestId: "req-2",
          sessionId: "c-f11",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:06.000Z",
          message: {
            id: "msg_req-2",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 20 },
            content: [
              {
                type: "tool_use",
                id: "tu-out-of-order",
                name: "Read",
                input: { file_path: "/tmp/a" },
              },
            ],
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
      expect(
        (
          db
            .query("SELECT COUNT(*) AS n FROM ingest_issue WHERE code = 'orphan_tool_result'")
            .get() as { n: number }
        ).n,
      ).toBe(0);

      // Now append a genuine orphan tool_result and verify report.issues counts it.
      appendFileSync(
        file,
        `${JSON.stringify({
          type: "user",
          uuid: "u-true-orphan",
          sessionId: "c-f11",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:07.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tu-missing", content: "orphan" }],
          },
        })}\n`,
      );
      const rep = sync(db, config);
      expect(rep.ingested).toBe(1);
      expect(rep.issues).toBe(1);
      expect(rep.issuesByCode.orphan_tool_result).toBe(1);
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("F12: prototype-property IDs like constructor and toString do not crash incremental ingest", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f12.jsonl");
    writeFileSync(file, claudeTurn("c-f12", 1, "req-1"));

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);
      appendFileSync(
        file,
        `${JSON.stringify({
          type: "assistant",
          uuid: "a-proto",
          requestId: "toString",
          sessionId: "c-f12",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:05.000Z",
          message: {
            id: "msg_toString",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "tool_use",
            usage: { input_tokens: 100, output_tokens: 20 },
            content: [
              { type: "tool_use", id: "constructor", name: "Read", input: { file_path: "/tmp/x" } },
            ],
          },
        })}\n${JSON.stringify({
          type: "user",
          uuid: "u-proto",
          sessionId: "c-f12",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:06.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "constructor", content: "ok" }],
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

  test("F13: Pi checkpoint bounds piToolUses and resolves older anchors from SQLite", () => {
    const { dir, dbPath, config } = freshCase();
    const piFile = join(config.piDir ?? "", "--work--", "2026-11-01T10-00-00-000Z_pi-f13.jsonl");
    let lines = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-f13",
      timestamp: "2026-11-01T10:00:00.000Z",
      cwd: "/home/dev/work/app",
    })}\n`;
    for (let i = 1; i <= 70; i += 1) {
      lines += `${JSON.stringify({
        type: "message",
        id: `m-${i}`,
        timestamp: `2026-11-01T10:01:${String(i % 60).padStart(2, "0")}.000Z`,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stopReason: "toolUse",
          usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
          content: [
            {
              type: "toolCall",
              id: `pi-call-${i}`,
              name: "execute",
              arguments: { code: `run(${i})` },
            },
          ],
        },
      })}\n`;
    }
    writeFileSync(piFile, lines);

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      // Append a nested call referencing pi-call-1 (evicted past the 64-call window).
      appendFileSync(
        piFile,
        `${JSON.stringify({
          type: "message",
          id: "m-res-1",
          timestamp: "2026-11-01T10:03:00.000Z",
          message: {
            role: "toolResult",
            toolCallId: "pi-call-1",
            toolName: "execute",
            content: [{ type: "text", text: "done" }],
            nestedCalls: {
              calls: [
                {
                  id: "inner-1",
                  name: "Read",
                  arguments: { path: "src/index.ts" },
                  status: "ok",
                },
              ],
            },
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);
      expect(
        (
          db
            .query("SELECT COUNT(*) AS n FROM tool_call WHERE tool_use_id = 'pi-call-1#inner-1'")
            .get() as { n: number }
        ).n,
      ).toBe(1);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("F13 (round 2): evicted Pi anchor lookup orders by message seq and block ordinal after in-place rewrite", () => {
    const { dir, dbPath, config } = freshCase();
    const piFile = join(
      config.piDir ?? "",
      "--work--",
      "2026-11-01T10-00-00-000Z_pi-f13-order.jsonl",
    );
    const header = `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-f13-order",
      timestamp: "2026-11-01T10:00:00.000Z",
      cwd: "/home/dev/work/app",
    })}\n`;
    const makeCall = (id: string, callId: string, sec: number, arg: string) =>
      `${JSON.stringify({
        type: "message",
        id,
        timestamp: `2026-11-01T10:${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}.000Z`,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stopReason: "toolUse",
          usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: "toolCall", id: callId, name: "execute", arguments: { code: arg } }],
        },
      })}\n`;
    let tail = makeCall("m-dup-1", "dup-call", 2, "second");
    for (let i = 1; i <= 70; i += 1) {
      tail += makeCall(`m-evict-${i}`, `evict-${i}`, 10 + i, `run(${i})`);
    }
    // Initial write: seq 0 and seq 1 both have toolCall id "dup-call".
    writeFileSync(piFile, header + makeCall("m-dup-0", "dup-call", 1, "first-v1") + tail);

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      // Rewrite seq 0 in place with a second block so seq 0's tool_use block gets a higher block.id than seq 1.
      const rewrittenSeq0 = `${JSON.stringify({
        type: "message",
        id: "m-dup-0",
        timestamp: "2026-11-01T10:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          stopReason: "toolUse",
          usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
          content: [
            { type: "text", text: "Extra prefix text" },
            { type: "toolCall", id: "dup-call", name: "execute", arguments: { code: "first-v2" } },
          ],
        },
      })}\n`;
      writeFileSync(piFile, header + rewrittenSeq0 + tail);
      const bumped = new Date(Date.now() + 5_000);
      utimesSync(piFile, bumped, bumped);
      expect(sync(db, config).ingested).toBe(1);

      // Verify seq 0 block.id is indeed higher than seq 1 block.id.
      const orderRows = db
        .query(
          `SELECT m.seq, b.id AS block_id
             FROM block b JOIN message m ON m.id = b.message_id
            WHERE b.tool_use_id = 'dup-call' AND b.type = 'tool_use'
            ORDER BY m.seq`,
        )
        .all() as { seq: number; block_id: number }[];
      expect(orderRows).toHaveLength(2);
      expect(orderRows[0]?.block_id).toBeGreaterThan(orderRows[1]?.block_id ?? 0);

      // Append a nested call for the evicted "dup-call": must attach to seq 1 (not seq 0).
      appendFileSync(
        piFile,
        `${JSON.stringify({
          type: "message",
          id: "m-res-dup",
          timestamp: "2026-11-01T10:05:00.000Z",
          message: {
            role: "toolResult",
            toolCallId: "dup-call",
            toolName: "execute",
            content: [{ type: "text", text: "done" }],
            nestedCalls: {
              calls: [
                {
                  id: "inner-dup",
                  name: "Read",
                  arguments: { path: "src/app.ts" },
                  status: "ok",
                },
              ],
            },
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);
      const attached = db
        .query(
          `SELECT m.seq
             FROM tool_call tc JOIN message m ON m.id = tc.message_id
            WHERE tc.tool_use_id = 'dup-call#inner-dup'`,
        )
        .get() as { seq: number } | null;
      expect(attached?.seq).toBe(1);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("F1 (round 2): atomic file replacement conflict forces reopen instead of writing stale fd", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f1-atomic.jsonl");
    const tmpFile = join(config.claudeDir, "proj", "c-f1-atomic.tmp");
    writeFileSync(file, claudeTurn("c-f1-atomic", 1, "req-1"));

    const dbA = openDb(dbPath);
    const dbB = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(dbA, config).ingested).toBe(1);
      const prior = dbA
        .query("SELECT size, mtime, session_id FROM ingest_source WHERE path = ?1")
        .get(file) as { size: number; mtime: number; session_id: number };

      // Append turn 2 to inode 1 and hold an open fd on inode 1.
      appendFileSync(file, claudeTurn("c-f1-atomic", 2, "req-2"));
      const staleFd = openSync(file, "r");
      const staleStats = statSync(file);

      try {
        // Atomically replace path with inode 2 containing 3 turns, and commit via connection B.
        writeFileSync(
          tmpFile,
          claudeTurn("c-f1-atomic", 1, "req-1") +
            claudeTurn("c-f1-atomic", 2, "req-2") +
            claudeTurn("c-f1-atomic", 3, "req-3"),
        );
        renameSync(tmpFile, file);
        expect(sync(dbB, config).ingested).toBe(1);

        // Stale writer attempting incremental ingest with old fd must get "conflict", not "fallback".
        const res = tryIncrementalIngest({
          db: dbA,
          fd: staleFd,
          stats: staleStats,
          sourcePath: file,
          tool: "claude_code",
          archived: false,
          priorSize: prior.size,
          priorMtime: prior.mtime,
          priorSessionId: prior.session_id,
          ingestRevision: INGEST_PIPELINE_REVISION,
          expectedRevision: INGEST_PIPELINE_REVISION,
          sidecarMeta: null,
          codexTitles: new Map(),
        });
        expect(res.kind).toBe("conflict");
      } finally {
        closeSync(staleFd);
      }

      // Subsequent sync on dbA sees the 3-turn file and preserves all 6 messages.
      expect(sync(dbA, config).skipped).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);
      expect(
        (dbA.query("SELECT message_count FROM session LIMIT 1").get() as { message_count: number })
          .message_count,
      ).toBe(6);
      assertDatabaseIntegrity(dbA);
      expect(captureCanonicalSnapshot(dbA)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(dbA);
      closeDb(dbB);
      closeDb(freshDb);
    }
  });

  test("F3 (round 2): targeted watch accepts valid POSIX filenames containing backslashes", () => {
    if (process.platform === "win32") {
      return;
    }
    const { dbPath, config } = freshCase();
    const bsDir = join(config.claudeDir, "proj\\with\\backslash");
    mkdirSync(bsDir, { recursive: true });
    const file = join(bsDir, "c-bs.jsonl");
    writeFileSync(file, claudeTurn("c-bs", 1, "req-1"));

    const db = openDb(dbPath);
    try {
      const report = sync(db, config, undefined, undefined, {
        candidatePaths: [file],
        deferDerivedRefresh: true,
      });
      expect(report.scanned).toBe(1);
      expect(report.ingested).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  test("F4 (round 2): EconomicsCache detects external writer committing after priorDataVersion capture", async () => {
    const { dbPath, config } = freshCase();
    const fileA = join(config.claudeDir, "proj", "c-f4a.jsonl");
    const fileB = join(config.claudeDir, "proj", "c-f4b.jsonl");
    writeFileSync(fileA, claudeTurn("c-f4a", 1, "req-a1", 100));
    writeFileSync(fileB, claudeTurn("c-f4b", 1, "req-b1", 100));

    const readerDb = openDb(dbPath);
    const workerDb = openDb(dbPath);
    const externalDb = openDb(dbPath);
    try {
      expect(sync(workerDb, config).ingested).toBe(2);
      const cache = new EconomicsCache({ dbPath, db: readerDb });
      try {
        const initial = await cache.get();
        expect(initial).toEqual(tokenEconomics(readerDb));

        // Capture priorDataVersion before both worker sync and concurrent external write.
        const versionBefore = cache.dataVersion();
        const writesBefore = committedEconomicsWrites(workerDb);
        const changed: number[] = [];

        appendFileSync(fileA, claudeTurn("c-f4a", 2, "req-a2", 80));
        expect(
          sync(workerDb, config, undefined, undefined, {
            candidatePaths: [fileA],
            deferDerivedRefresh: true,
            onSessionChanged: (id) => changed.push(id),
          }).ingested,
        ).toBe(1);
        const ownWrites = committedEconomicsWrites(workerDb) - writesBefore;

        // Separate external connection commits fileB AFTER versionBefore was captured.
        appendFileSync(fileB, claudeTurn("c-f4b", 2, "req-b2", 120));
        expect(
          sync(externalDb, config, undefined, undefined, {
            candidatePaths: [fileB],
            deferDerivedRefresh: true,
          }).ingested,
        ).toBe(1);

        // Partial refresh must detect the external economics_seq bump and rebuild to 400.
        cache.refreshSessions(changed, versionBefore, ownWrites);
        await cache.settled();
        const after = await cache.get();
        expect(after).toEqual(tokenEconomics(readerDb));
        expect(after.totals.generation_tokens).toBe(400);
      } finally {
        cache.dispose();
        await cache.settled();
      }
    } finally {
      closeDb(readerDb);
      closeDb(workerDb);
      closeDb(externalDb);
    }
  });

  test("F6 (round 2): overlapping writer during recommendation refresh preserves pending generation", () => {
    const { dir, dbPath, config } = freshCase();
    const fileA = join(config.claudeDir, "proj", "c-f6a.jsonl");
    const fileB = join(config.claudeDir, "proj", "c-f6b.jsonl");
    writeFileSync(fileA, claudeTurn("c-f6a", 1, "req-1"));

    const dbA = openDb(dbPath);
    const dbB = openDb(dbPath);
    const dbC = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(dbA, config, undefined, undefined, { deferDerivedRefresh: true }).ingested).toBe(
        1,
      );
      const genBefore = readSyncStateGeneration(dbA, SYNC_STATE_RECOMMENDATIONS_PENDING);
      expect(genBefore).toBeGreaterThan(0);

      // Writer 1 runs recommendations on state before Writer 2 commits.
      regenerateRecommendations(dbA);

      // Writer 2 commits a file with malformed JSONL lines while Writer 1's refresh is finishing.
      writeFileSync(
        fileB,
        `${claudeTurn("c-f6b", 1, "req-2")}{not valid json\n{also broken\n{still broken\n`,
      );
      expect(
        sync(dbB, config, undefined, undefined, {
          candidatePaths: [fileB],
          deferDerivedRefresh: true,
        }).ingested,
      ).toBe(1);

      // Writer 1 clears only up to the generation it read before refreshing.
      markSyncStateCleared(dbA, SYNC_STATE_RECOMMENDATIONS_CLEARED, genBefore);

      // A subsequent zero-ingest sync must still see Writer 2's higher generation and refresh recommendations.
      const zeroSync = sync(dbC, config);
      expect(zeroSync.ingested).toBe(0);

      expect(sync(freshDb, config).ingested).toBe(2);
      const actual = dbC.query("SELECT key, detail, score FROM recommendation ORDER BY key").all();
      const expected = freshDb
        .query("SELECT key, detail, score FROM recommendation ORDER BY key")
        .all();
      expect(actual).toEqual(expected);
    } finally {
      closeDb(dbA);
      closeDb(dbB);
      closeDb(dbC);
      closeDb(freshDb);
    }
  });

  test("F8 (round 2): uppercase <COMMAND-NAME> matches case-insensitive SQLite LIKE after Codex restamp", () => {
    const { dir, dbPath, config } = freshCase();
    const codexFile = join(
      config.codexDir,
      "sessions",
      "2026",
      "11",
      "01",
      "rollout-2026-11-01T10-00-00-cx-f8-case.jsonl",
    );
    writeFileSync(
      codexFile,
      `${JSON.stringify({
        timestamp: "2026-11-01T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-f8-case", cwd: "/home/dev/work/app", cli_version: "0.2.0" },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<COMMAND-NAME>/clear</COMMAND-NAME>" }],
        },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Real prompt 1" }],
        },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Reply 1" }],
        },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
            last_token_usage: {
              input_tokens: 1000,
              output_tokens: 50,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
          },
        },
      })}\n`,
    );

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      // Restamp forces rebuildContextWindowFoldFromDb.
      appendFileSync(
        codexFile,
        `${JSON.stringify({
          timestamp: "2026-11-01T10:00:06.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 500,
                output_tokens: 50,
                cached_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
              last_token_usage: {
                input_tokens: 500,
                output_tokens: 50,
                cached_input_tokens: 0,
                reasoning_output_tokens: 0,
              },
            },
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);

      // Follow-up user turn increments from the rebuilt fold.
      appendFileSync(
        codexFile,
        `${JSON.stringify({
          timestamp: "2026-11-01T10:00:07.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Real prompt 2" }],
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);

      const turnCount = (
        db.query("SELECT turn_count FROM session LIMIT 1").get() as { turn_count: number }
      ).turn_count;
      expect(turnCount).toBe(2);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("F9 (round 2): single append replacing Claude requestId A -> A -> B releases stale claim A", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f9-aab.jsonl");
    writeFileSync(file, claudeTurn("c-f9-aab", 1, "req-1", 40));

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      // Replace req-1 twice in the same append: first keeping msg_req-1 (A), then switching to msg_req-1_B (B).
      appendFileSync(
        file,
        `${JSON.stringify({
          type: "assistant",
          uuid: "a-1-r1",
          requestId: "req-1",
          sessionId: "c-f9-aab",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:05.000Z",
          message: {
            id: "msg_req-1",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: null,
            usage: { input_tokens: 101, output_tokens: 80 },
            content: [{ type: "text", text: "Intermediate A" }],
          },
        })}\n${JSON.stringify({
          type: "assistant",
          uuid: "a-1-r2",
          requestId: "req-1",
          sessionId: "c-f9-aab",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:06.000Z",
          message: {
            id: "msg_req-1_B",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            usage: { input_tokens: 101, output_tokens: 120 },
            content: [{ type: "text", text: "Final B" }],
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);

      const claims = db
        .query("SELECT request_id FROM billed_request ORDER BY request_id")
        .all() as { request_id: string }[];
      expect(claims).toEqual([{ request_id: "msg_req-1_B" }]);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("F15: existing schema v32 archive without sync_state upgrades cleanly to v33", () => {
    const { dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f15.jsonl");
    writeFileSync(file, claudeTurn("c-f15", 1, "req-1"));

    // Initialize and downgrade schema to the v32 shape (before sync_state existed).
    const initial = openDb(dbPath);
    closeDb(initial);
    const raw = new Database(dbPath);
    try {
      raw.exec("DROP TABLE sync_state;");
      raw.exec("DELETE FROM schema_migrations WHERE version = 33;");
    } finally {
      raw.close();
    }

    const upgraded = openDb(dbPath);
    try {
      const latest = upgraded.query("SELECT MAX(version) AS v FROM schema_migrations").get() as {
        v: number;
      };
      expect(latest.v).toBe(LATEST_SCHEMA_VERSION);
      expect(
        upgraded
          .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'")
          .get(),
      ).not.toBeNull();
      expect(sync(upgraded, config).ingested).toBe(1);
      assertDatabaseIntegrity(upgraded);
    } finally {
      closeDb(upgraded);
    }
  });

  test("F16: finishing watch run keeps syncStatus.in_progress true while queued manual run is active", async () => {
    const { dbPath, config } = freshCase();
    const fullConfig = { ...config, dbPath } as Config;
    const db = openDb(dbPath);
    const economics = new EconomicsCache({ dbPath, db });
    const watchGate = Promise.withResolvers<void>();
    const manualGate = Promise.withResolvers<void>();
    const manualStarted = Promise.withResolvers<void>();
    let runCount = 0;
    const coordinator = createSyncCoordinator(async () => {
      runCount += 1;
      if (runCount === 1) {
        await watchGate.promise;
      } else {
        manualStarted.resolve();
        await manualGate.promise;
      }
      return {
        scanned: 1,
        ingested: 0,
        skipped: 1,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: false,
      } satisfies SyncReport;
    });

    try {
      const store = new SyncStatusStore();
      const watchPromise = workerSyncRunner(
        fullConfig,
        store,
        { aborted: false },
        () => {},
        coordinator.runWithOwnership,
        { candidatePaths: ["/only-one.jsonl"], deferDerivedRefresh: true },
      );

      // Manual sync queues behind the narrow watch run.
      const manualPromise = syncNow(
        fullConfig,
        economics,
        coordinator.run,
        coordinator.runWithOwnership,
      );

      // Watch finishes; coordinator immediately starts queued manual run.
      watchGate.resolve();
      const watchRes = await watchPromise;
      await manualStarted.promise;
      expect("report" in watchRes).toBe(true);
      if ("report" in watchRes) {
        applyWatchEvent(
          { type: "sync", reason: "watch", report: watchRes.report, status: store.snapshot() },
          economics,
          coordinator.isBusy,
        );
      }

      // Manual run is still blocked on manualGate, so status must remain in_progress.
      expect(coordinator.isBusy()).toBe(true);
      expect(syncStatus.in_progress).toBe(true);

      manualGate.resolve();
      await manualPromise;
      expect(coordinator.isBusy()).toBe(false);
      expect(syncStatus.in_progress).toBe(false);
    } finally {
      economics.dispose();
      await economics.settled();
      await coordinator.close();
      closeDb(db);
    }
  });

  test("F17: replacing a misfiled Codex session reports the deleted ID so EconomicsCache drops its stale vector", async () => {
    const { dbPath, config } = freshCase();
    const codexFile = join(
      config.codexDir,
      "sessions",
      "2026",
      "11",
      "01",
      "rollout-2026-11-01T10-00-00-cx-fork-f17.jsonl",
    );
    const makeCodex = (metaPayload: Record<string, unknown>, outputTokens: number) =>
      `${JSON.stringify({
        timestamp: "2026-11-01T10:00:00.000Z",
        type: "session_meta",
        payload: metaPayload,
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer" }],
        },
      })}\n${JSON.stringify({
        timestamp: "2026-11-01T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              output_tokens: outputTokens,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
            last_token_usage: {
              input_tokens: 100,
              output_tokens: outputTokens,
              cached_input_tokens: 0,
              reasoning_output_tokens: 0,
            },
          },
        },
      })}\n`;

    const otherCodexFile = join(
      config.codexDir,
      "sessions",
      "2026",
      "11",
      "01",
      "rollout-2026-11-01T10-00-01-cx-other-f17.jsonl",
    );
    writeFileSync(
      codexFile,
      makeCodex({ id: "cx-parent-f17", cwd: "/home/dev/work/app", cli_version: "0.2.0" }, 40),
    );
    writeFileSync(
      otherCodexFile,
      makeCodex({ id: "cx-other-f17", cwd: "/home/dev/work/app", cli_version: "0.2.0" }, 10),
    );

    const readerDb = openDb(dbPath);
    const workerDb = openDb(dbPath);
    try {
      expect(sync(workerDb, config).ingested).toBe(2);
      const oldSessionId = (
        readerDb
          .query("SELECT id FROM session WHERE source_session_id = 'cx-parent-f17'")
          .get() as { id: number }
      ).id;
      const cache = new EconomicsCache({ dbPath, db: readerDb });
      try {
        const before = await cache.get();
        expect(before).toEqual(tokenEconomics(readerDb));
        expect(before.totals.generation_tokens).toBe(50);

        // Replace with forked child session whose parent_thread_id matches the misfiled parent.
        writeFileSync(
          codexFile,
          makeCodex(
            {
              id: "cx-child-f17",
              parent_thread_id: "cx-parent-f17",
              cwd: "/home/dev/work/app",
              cli_version: "0.2.0",
            },
            200,
          ),
        );
        const bumped = new Date(Date.now() + 5_000);
        utimesSync(codexFile, bumped, bumped);

        const versionBefore = cache.dataVersion();
        const writesBefore = committedEconomicsWrites(workerDb);
        const changed: number[] = [];
        expect(
          sync(workerDb, config, undefined, undefined, {
            onSessionChanged: (id) => changed.push(id),
          }).ingested,
        ).toBe(1);
        const ownWrites = committedEconomicsWrites(workerDb) - writesBefore;
        const newSessionId = (
          readerDb
            .query("SELECT id FROM session WHERE source_session_id = 'cx-child-f17'")
            .get() as { id: number }
        ).id;
        expect(newSessionId).not.toBe(oldSessionId);
        expect(changed).toContain(oldSessionId);
        expect(changed).toContain(newSessionId);

        cache.refreshSessions(changed, versionBefore, ownWrites);
        await cache.settled();
        const after = await cache.get();
        expect(after).toEqual(tokenEconomics(readerDb));
        expect(after.totals.generation_tokens).toBe(210);
      } finally {
        cache.dispose();
        await cache.settled();
      }
    } finally {
      closeDb(readerDb);
      closeDb(workerDb);
    }
  });

  test("F1 (round 3): same-size atomic replacement with newer mtime rejects stale incremental append", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f1-r3.jsonl");
    const tmpFile = join(config.claudeDir, "proj", "c-f1-r3.tmp");
    const original = claudeTurn("c-f1-r3", 1, "req-1");
    writeFileSync(file, original);

    const dbA = openDb(dbPath);
    const dbB = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(dbA, config).ingested).toBe(1);
      const prior = dbA
        .query("SELECT size, mtime, session_id FROM ingest_source WHERE path = ?1")
        .get(file) as { size: number; mtime: number; session_id: number };

      // Append turn 2 to inode 1 and capture fd + stats for stale writer A.
      appendFileSync(file, claudeTurn("c-f1-r3", 2, "req-2"));
      const staleFd = openSync(file, "r");
      const staleStats = statSync(file);

      try {
        // Atomically replace path with the original 2-message content and a newer mtime, then sync via B.
        writeFileSync(tmpFile, original);
        const newer = new Date(Date.now() + 5_000);
        utimesSync(tmpFile, newer, newer);
        renameSync(tmpFile, file);
        expect(sync(dbB, config).ingested).toBe(1);

        // Writer A must detect the conflict (mtime and inode moved) and refuse to commit 4 messages.
        const res = tryIncrementalIngest({
          db: dbA,
          fd: staleFd,
          stats: staleStats,
          sourcePath: file,
          tool: "claude_code",
          archived: false,
          priorSize: prior.size,
          priorMtime: prior.mtime,
          priorSessionId: prior.session_id,
          ingestRevision: INGEST_PIPELINE_REVISION,
          expectedRevision: INGEST_PIPELINE_REVISION,
          sidecarMeta: null,
          codexTitles: new Map(),
        });
        expect(res.kind).toBe("conflict");
      } finally {
        closeSync(staleFd);
      }

      expect(
        (dbA.query("SELECT message_count FROM session LIMIT 1").get() as { message_count: number })
          .message_count,
      ).toBe(2);
      expect(sync(freshDb, config).ingested).toBe(1);
      assertDatabaseIntegrity(dbA);
      expect(captureCanonicalSnapshot(dbA)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(dbA);
      closeDb(dbB);
      closeDb(freshDb);
    }
  });

  test("F6 (round 3): regenerateRecommendations bumps refresh seq and clears pending atomically", () => {
    const { dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f6-r3.jsonl");
    writeFileSync(file, claudeTurn("c-f6-r3", 1, "req-1"));

    const db = openDb(dbPath);
    try {
      expect(sync(db, config, undefined, undefined, { deferDerivedRefresh: true }).ingested).toBe(
        1,
      );
      const pendingBefore = readSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_PENDING);
      const refreshBefore = readSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_REFRESH_SEQ);
      expect(pendingBefore).toBeGreaterThan(0);

      regenerateRecommendations(db);
      expect(readSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_CLEARED)).toBe(pendingBefore);
      expect(readSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_REFRESH_SEQ)).toBe(
        refreshBefore + 1,
      );

      // Verify a concurrent stale writer blocked behind BEGIN IMMEDIATE cannot overwrite newer recommendations.
      const blocker = openDb(dbPath);
      try {
        blocker.exec("BEGIN IMMEDIATE;");
        // Simulate B completing a newer refresh inside the lock, raising refresh_seq and writing a sentinel row.
        bumpSyncStateGeneration(blocker, SYNC_STATE_RECOMMENDATIONS_PENDING);
        const newerGen = readSyncStateGeneration(blocker, SYNC_STATE_RECOMMENDATIONS_PENDING);
        bumpSyncStateGeneration(blocker, SYNC_STATE_RECOMMENDATIONS_REFRESH_SEQ);
        markSyncStateCleared(blocker, SYNC_STATE_RECOMMENDATIONS_CLEARED, newerGen);
        blocker
          .query(
            `UPDATE recommendation
                SET status = 'open', status_source = NULL, detail = 'newer-writer-result'
              WHERE kind = 'catalog' AND key = (SELECT key FROM recommendation WHERE kind = 'catalog' LIMIT 1)`,
          )
          .run();
        blocker.exec("COMMIT;");
      } finally {
        closeDb(blocker);
      }

      // A zero-ingest sync sees pending === cleared and preserves the newer refresh result.
      expect(sync(db, config).ingested).toBe(0);
      const kept = db
        .query("SELECT COUNT(*) AS n FROM recommendation WHERE detail = 'newer-writer-result'")
        .get() as { n: number };
      expect(kept.n).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  test("F8 (round 3): embedded NUL before <COMMAND-NAME> matches SQLite LIKE turn count", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f8-nul.jsonl");
    writeFileSync(file, claudeTurn("c-f8-nul", 1, "req-1"));

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      appendFileSync(
        file,
        `${JSON.stringify({
          type: "user",
          uuid: "u-nul-2",
          sessionId: "c-f8-nul",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:05.000Z",
          message: { role: "user", content: "visible\u0000<COMMAND-NAME>/clear" },
        })}\n${JSON.stringify({
          type: "assistant",
          uuid: "a-nul-2",
          requestId: "req-2",
          sessionId: "c-f8-nul",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T10:00:06.000Z",
          message: {
            id: "msg_req-2",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: "end_turn",
            usage: { input_tokens: 120, output_tokens: 40 },
            content: [{ type: "text", text: "Reply after NUL prompt" }],
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);

      const session = db.query("SELECT id, turn_count FROM session LIMIT 1").get() as {
        id: number;
        turn_count: number;
      };
      const timeline = contextWindowForSession(db, session.id);
      const lastPointTurn = timeline?.points.at(-1)?.turn;
      expect(session.turn_count).toBe(2);
      expect(lastPointTurn).toBe(2);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("F17 (round 3): tombstoned ATIF replacement removes child and refreshes EconomicsCache via syncNow", async () => {
    const { dir, dbPath, config } = freshCase();
    const atifDir = join(dir, "atif");
    mkdirSync(atifDir, { recursive: true });
    const fullConfig = { ...config, atifDir, dbPath } as Config;
    const deletedDoc = join(atifDir, "deleted.atif.json");
    const liveDoc = join(atifDir, "live.atif.json");

    writeFileSync(
      deletedDoc,
      JSON.stringify({
        schema_version: "ATIF-v1.7",
        trajectory_id: "atif-tomb-root",
        agent: { name: "example-agent", version: "1.0.0", model_name: "gpt-5.4" },
        steps: [
          { step_id: 1, source: "user", message: "Delete me" },
          {
            step_id: 2,
            source: "agent",
            message: "Gone",
            metrics: { prompt_tokens: 10, completion_tokens: 5 },
          },
        ],
      }),
    );
    writeFileSync(
      liveDoc,
      JSON.stringify({
        schema_version: "ATIF-v1.7",
        trajectory_id: "atif-live-root",
        agent: { name: "example-agent", version: "1.0.0", model_name: "gpt-5.4" },
        steps: [
          {
            step_id: 1,
            source: "agent",
            message: "",
            tool_calls: [{ tool_call_id: "call-1", function_name: "Agent", arguments: {} }],
            observation: {
              results: [
                {
                  source_call_id: "call-1",
                  subagent_trajectory_ref: [{ trajectory_id: "atif-child-f17" }],
                },
              ],
            },
          },
        ],
        subagent_trajectories: [
          {
            schema_version: "ATIF-v1.7",
            trajectory_id: "atif-child-f17",
            agent: { name: "example-agent", version: "1.0.0", model_name: "gpt-5.4" },
            steps: [
              { step_id: 1, source: "user", message: "Work" },
              {
                step_id: 2,
                source: "agent",
                message: "Done",
                metrics: { prompt_tokens: 100, completion_tokens: 50 },
              },
            ],
          },
        ],
      }),
    );

    const db = openDb(dbPath);
    const economics = new EconomicsCache({ dbPath, db });
    const coordinator = createSyncCoordinator(undefined, {
      readDataVersion: () => economics.dataVersion(),
    });
    try {
      await syncNow(fullConfig, economics, coordinator.run, coordinator.runWithOwnership);
      await economics.settled();
      const tombId = (
        db.query("SELECT id FROM session WHERE source_session_id = 'atif-tomb-root'").get() as {
          id: number;
        }
      ).id;
      expect(setSessionUserState(db, tombId, "deleted")).toBe(true);
      rmSync(deletedDoc);
      economics.invalidate();
      await economics.settled();
      expect((await economics.get()).totals.generation_tokens).toBe(50);

      // Rewrite liveDoc to use the deleted root identity and drop the embedded child.
      writeFileSync(
        liveDoc,
        JSON.stringify({
          schema_version: "ATIF-v1.7",
          trajectory_id: "atif-tomb-root",
          agent: { name: "example-agent", version: "1.0.0", model_name: "gpt-5.4" },
          steps: [{ step_id: 1, source: "user", message: "Now tombstoned" }],
        }),
      );
      const bumped = new Date(Date.now() + 5_000);
      utimesSync(liveDoc, bumped, bumped);

      const res = await syncNow(
        fullConfig,
        economics,
        coordinator.run,
        coordinator.runWithOwnership,
      );
      const report = (await res.json()) as SyncReport;
      expect(report.ingested).toBe(0);
      await economics.settled();
      const after = await economics.get();
      expect(after).toEqual(tokenEconomics(db));
      expect(after.totals.generation_tokens).toBe(0);
    } finally {
      economics.dispose();
      await economics.settled();
      await coordinator.close();
      closeDb(db);
    }
  });

  test("F18: unlinking an ATIF child from an archived parent refreshes EconomicsCache via real sync worker", async () => {
    const { dir, dbPath, config } = freshCase();
    const atifDir = join(dir, "atif");
    mkdirSync(atifDir, { recursive: true });
    const fullConfig = { ...config, atifDir, dbPath } as Config;
    const parentDoc = join(atifDir, "parent.atif.json");
    const childDoc = join(atifDir, "child.atif.json");

    writeFileSync(
      parentDoc,
      JSON.stringify({
        schema_version: "ATIF-v1.7",
        trajectory_id: "atif-parent-f18",
        agent: { name: "example-agent", version: "1.0.0", model_name: "gpt-5.4" },
        steps: [
          {
            step_id: 1,
            source: "agent",
            message: "",
            tool_calls: [{ tool_call_id: "call-c", function_name: "Agent", arguments: {} }],
            observation: {
              results: [
                {
                  source_call_id: "call-c",
                  subagent_trajectory_ref: [
                    { trajectory_id: "atif-child-f18", trajectory_path: "child.atif.json" },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    writeFileSync(
      childDoc,
      JSON.stringify({
        schema_version: "ATIF-v1.7",
        trajectory_id: "atif-child-f18",
        agent: { name: "example-agent", version: "1.0.0", model_name: "gpt-5.4" },
        steps: [
          { step_id: 1, source: "user", message: "Subtask" },
          {
            step_id: 2,
            source: "agent",
            message: "Subtask done",
            metrics: { prompt_tokens: 100, completion_tokens: 50 },
          },
        ],
      }),
    );

    const db = openDb(dbPath);
    const economics = new EconomicsCache({ dbPath, db });
    const coordinator = createSyncCoordinator(undefined, {
      readDataVersion: () => economics.dataVersion(),
    });
    try {
      await syncNow(fullConfig, economics, coordinator.run, coordinator.runWithOwnership);
      await economics.settled();
      const parentId = (
        db.query("SELECT id FROM session WHERE source_session_id = 'atif-parent-f18'").get() as {
          id: number;
        }
      ).id;
      expect(setSessionUserState(db, parentId, "archived")).toBe(true);
      economics.invalidate();
      await economics.settled();
      expect((await economics.get()).totals.generation_tokens).toBe(0);

      // Remove parent's reference to child so resolveSubagentParents clears child's parent_session_id.
      writeFileSync(
        parentDoc,
        JSON.stringify({
          schema_version: "ATIF-v1.7",
          trajectory_id: "atif-parent-f18",
          agent: { name: "example-agent", version: "1.0.0", model_name: "gpt-5.4" },
          steps: [{ step_id: 1, source: "user", message: "No longer spawns child" }],
        }),
      );
      const bumped = new Date(Date.now() + 5_000);
      utimesSync(parentDoc, bumped, bumped);

      await syncNow(fullConfig, economics, coordinator.run, coordinator.runWithOwnership);
      await economics.settled();
      const after = await economics.get();
      expect(after).toEqual(tokenEconomics(db));
      expect(after.totals.generation_tokens).toBe(50);
    } finally {
      economics.dispose();
      await economics.settled();
      await coordinator.close();
      closeDb(db);
    }
  });

  test("F19: bumping INGEST_PIPELINE_REVISION and CHECKPOINT_VERSION re-derives prior revision archives", () => {
    const { dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f19.jsonl");
    writeFileSync(file, claudeTurn("c-f19", 1, "req-1"));

    const db = openDb(dbPath);
    try {
      expect(sync(db, config).ingested).toBe(1);
      // Simulate an archive written by the previous ingest revision with a stale turn_count.
      db.query("UPDATE ingest_source SET ingest_revision = ?1").run(INGEST_PIPELINE_REVISION - 1);
      db.query("UPDATE session SET turn_count = 99").run();

      const rep = sync(db, config);
      expect(rep.ingested).toBe(1);
      expect(
        (db.query("SELECT turn_count FROM session LIMIT 1").get() as { turn_count: number })
          .turn_count,
      ).toBe(1);
    } finally {
      closeDb(db);
    }
  });

  test("F1 (final): same-inode same-size in-place rewrite advancing high-res mtime within the same second conflicts", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f1-inplace.jsonl");
    const turn1 = claudeTurn("c-f1-inplace", 1, "req-1");
    const turn2Old = claudeTurn("c-f1-inplace", 2, "req-2", 40, "OLDTOKEN");
    const turn2New = claudeTurn("c-f1-inplace", 2, "req-2", 40, "NEWTOKEN");
    expect(Buffer.byteLength(turn2Old)).toBe(Buffer.byteLength(turn2New));

    writeFileSync(file, turn1);
    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);
      const prior = db
        .query("SELECT size, mtime, session_id FROM ingest_source WHERE path = ?1")
        .get(file) as { size: number; mtime: number; session_id: number };

      // Append OLDTOKEN, pin mtime to sec + 100ms, and open fd before in-place rewrite.
      appendFileSync(file, turn2Old);
      const baseSec = Math.floor(Date.now() / 1000) + 2;
      const t1 = new Date(baseSec * 1000 + 100);
      utimesSync(file, t1, t1);
      const fd = openSync(file, "r");
      const stats = statSync(file);
      const statsBig = statSync(file, { bigint: true });

      try {
        // Rewrite the exact same inode to the exact same byte length with NEWTOKEN at sec + 500ms (same whole second!).
        writeFileSync(file, turn1 + turn2New);
        const t2 = new Date(baseSec * 1000 + 500);
        utimesSync(file, t2, t2);

        const res = tryIncrementalIngest({
          db,
          fd,
          stats,
          mtimeNs: statsBig.mtimeNs,
          ctimeNs: statsBig.ctimeNs,
          sourcePath: file,
          tool: "claude_code",
          archived: false,
          priorSize: prior.size,
          priorMtime: prior.mtime,
          priorSessionId: prior.session_id,
          ingestRevision: INGEST_PIPELINE_REVISION,
          expectedRevision: INGEST_PIPELINE_REVISION,
          sidecarMeta: null,
          codexTitles: new Map(),
        });
        expect(res.kind).toBe("conflict");
      } finally {
        closeSync(fd);
      }

      // Reopening via normal sync ingests NEWTOKEN and matches a fresh ingest.
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);
      expect(search(db, "NEWTOKEN").length).toBeGreaterThan(0);
      expect(search(db, "OLDTOKEN").length).toBe(0);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("F1 (concurrent rewrite): concurrent writer committing OLD before in-place rewrite to NEW within same second still returns conflict with liveChanged", async () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-f1-concurrent-rewrite.jsonl");
    const turn1 = claudeTurn("c-f1-concurrent-rewrite", 1, "req-1");
    const turn2Old = claudeTurn("c-f1-concurrent-rewrite", 2, "req-2", 40, "OLDTEXT1");
    const turn2New = claudeTurn("c-f1-concurrent-rewrite", 2, "req-2", 40, "NEWTEXT2");
    expect(Buffer.byteLength(turn2Old)).toBe(Buffer.byteLength(turn2New));

    writeFileSync(file, turn1);
    const dbA = openDb(dbPath);
    const dbB = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(dbA, config).ingested).toBe(1);
      const prior = dbA
        .query("SELECT size, mtime, session_id FROM ingest_source WHERE path = ?1")
        .get(file) as { size: number; mtime: number; session_id: number };

      appendFileSync(file, turn2Old);
      const baseSec = Math.floor(Date.now() / 1000) + 2;
      const t1 = new Date(baseSec * 1000 + 100);
      utimesSync(file, t1, t1);

      // Sync A opens fd on OLDTEXT1 before B commits or rewrite occurs.
      const fdA = openSync(file, "r");
      const statsA = statSync(file);
      const statsABig = statSync(file, { bigint: true });

      try {
        // Sync B commits OLDTEXT1 (same size + whole second as A's stats).
        expect(sync(dbB, config).ingested).toBe(1);

        // File is rewritten in place to NEWTEXT2 advancing mtime by 400ms within the same second.
        writeFileSync(file, turn1 + turn2New);
        const t2 = new Date(baseSec * 1000 + 500);
        utimesSync(file, t2, t2);

        // Sync A must NOT take the early "skipped" return; it must detect the live file changed.
        const res = tryIncrementalIngest({
          db: dbA,
          fd: fdA,
          stats: statsA,
          mtimeNs: statsABig.mtimeNs,
          ctimeNs: statsABig.ctimeNs,
          sourcePath: file,
          tool: "claude_code",
          archived: false,
          priorSize: prior.size,
          priorMtime: prior.mtime,
          priorSessionId: prior.session_id,
          ingestRevision: INGEST_PIPELINE_REVISION,
          expectedRevision: INGEST_PIPELINE_REVISION,
          sidecarMeta: null,
          codexTitles: new Map(),
        });
        expect(res).toEqual({ kind: "conflict", liveChanged: true });
      } finally {
        closeSync(fdA);
      }

      // Verify full sync via live-file-paused retry in sync() itself: force B to commit OLDTEXT1
      // while A is blocked in BEGIN IMMEDIATE, rewrite in place to NEWTEXT2, then let A retry.
      const blocker = openDb(dbPath);
      try {
        // Reset archive to turn1, append OLDTEXT1, let B commit OLDTEXT1, then rewrite to NEWTEXT2
        // and verify sync(dbA) with a live file rewritten during sync retries past coarse skip.
        const file2 = join(config.claudeDir, "proj", "c-f1-retry-bypass.jsonl");
        const r1 = claudeTurn("c-f1-retry-bypass", 1, "req-1");
        const r2Old = claudeTurn("c-f1-retry-bypass", 2, "req-2", 40, "OLDVAL99");
        const r2New = claudeTurn("c-f1-retry-bypass", 2, "req-2", 40, "NEWVAL99");
        writeFileSync(file2, r1);
        expect(sync(dbB, config).ingested).toBe(1);
        appendFileSync(file2, r2Old);
        const sec2 = Math.floor(Date.now() / 1000) + 4;
        const s1 = new Date(sec2 * 1000 + 100);
        utimesSync(file2, s1, s1);

        // Interleave via a short write lock on blocker: while dbA enters sync and blocks on BEGIN IMMEDIATE,
        // wait: sync is synchronous on the same thread, so verify the retry loop directly using a worker
        // that holds BEGIN IMMEDIATE while committing OLDVAL99 and rewriting NEWVAL99 before releasing!
        const workerScript = `
          import { Database } from "bun:sqlite";
          import { writeFileSync, utimesSync } from "node:fs";
          self.onmessage = ({ data }) => {
            const wdb = new Database(data.dbPath);
            wdb.exec("PRAGMA busy_timeout = 5000;");
            wdb.exec("BEGIN IMMEDIATE;");
            self.postMessage("locked");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
            // Rewrite file in place BEFORE releasing the SQLite write lock so sync(dbA) sees both the commit and the rewrite.
            wdb.query("UPDATE ingest_source SET size = ?1, mtime = ?2 WHERE path = ?3").run(data.size, data.mtimeSec, data.file);
            writeFileSync(data.file, data.newContent);
            const t2 = new Date(data.mtimeSec * 1000 + 500);
            utimesSync(data.file, t2, t2);
            wdb.exec("COMMIT;");
            wdb.close();
            self.postMessage("done");
          };
        `;
        const blobUrl = URL.createObjectURL(
          new Blob([workerScript], { type: "application/javascript" }),
        );
        const w = new Worker(blobUrl);
        const locked = Promise.withResolvers<void>();
        const done = Promise.withResolvers<void>();
        w.onmessage = (ev) => {
          if (ev.data === "locked") locked.resolve();
          if (ev.data === "done") done.resolve();
        };
        const stOld = statSync(file2);
        w.postMessage({
          dbPath,
          file: file2,
          size: stOld.size,
          mtimeSec: sec2,
          newContent: r1 + r2New,
        });
        await locked.promise;
        // sync(dbA) reads OLDVAL99 before blocking on BEGIN IMMEDIATE, worker commits + rewrites NEWVAL99,
        // then sync(dbA) unblocks, hits conflict_live, bypasses coarse skip, and ingests NEWVAL99!
        const rep = sync(dbA, config, undefined, undefined, { candidatePaths: [file2] });
        await done.promise;
        w.terminate();
        URL.revokeObjectURL(blobUrl);

        expect(rep.ingested).toBe(1);
        expect(search(dbA, "NEWVAL99").length).toBeGreaterThan(0);
        expect(search(dbA, "OLDVAL99").length).toBe(0);
      } finally {
        closeDb(blocker);
      }

      expect(sync(freshDb, config).ingested).toBeGreaterThan(0);
      assertDatabaseIntegrity(dbA);
    } finally {
      closeDb(dbA);
      closeDb(dbB);
      closeDb(freshDb);
    }
  });

  test("seenResponseKeys Bloom filter stays unsaturated on large sessions while still catching late response repeats", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-bloom-scale.jsonl");
    let content = "";
    for (let i = 1; i <= 250; i += 1) {
      content += claudeTurn("c-bloom-scale", i, `req-${i}`, 40);
    }
    writeFileSync(file, content);

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      // Append 20 distinct turns: economics fold must stay valid (not saturate Bloom and disable itself).
      for (let i = 251; i <= 270; i += 1) {
        appendFileSync(file, claudeTurn("c-bloom-scale", i, `req-${i}`, 40));
        expect(sync(db, config).ingested).toBe(1);
      }
      const cpRow = db
        .query("SELECT state_blob FROM ingest_checkpoint WHERE path = ?1")
        .get(file) as { state_blob: Uint8Array } | null;
      if (cpRow == null) {
        throw new Error("expected checkpoint row");
      }
      const parsedCp = JSON.parse(
        new TextDecoder().decode(Bun.zstdDecompressSync(cpRow.state_blob)),
      ) as { economics: { valid: boolean } };
      expect(parsedCp.economics.valid).toBe(true);

      // Now append a late thinking block for msg_req-1 (270 turns back) and verify it still triggers rematerialization.
      appendFileSync(
        file,
        `${JSON.stringify({
          type: "assistant",
          uuid: "a-1-late-bloom",
          requestId: "req-1",
          sessionId: "c-bloom-scale",
          cwd: "/home/dev/work/app",
          timestamp: "2026-11-01T11:30:00.000Z",
          message: {
            id: "msg_req-1",
            role: "assistant",
            model: "claude-sonnet-4-6",
            stop_reason: null,
            usage: {
              input_tokens: 101,
              output_tokens: 40,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 0,
            },
            content: [{ type: "thinking", thinking: "Late thinking after 270 turns" }],
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
