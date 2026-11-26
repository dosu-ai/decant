import { Database } from "bun:sqlite";
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  futimesSync,
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
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { contextWindowForSession } from "../src/context-window.ts";
import { closeDb, LATEST_SCHEMA_VERSION, openDb } from "../src/db.ts";
import { EconomicsCache } from "../src/economics-cache.ts";
import {
  ANCHOR_SAMPLE_BYTES,
  computePrefixHashFromBuffer,
  extendPrefixSamples,
  MAX_CHECKPOINT_ORPHAN_RESULT_IDS,
  MAX_CHECKPOINT_UNMATCHED_CALLS,
  readSourceBuffer,
  sourceFileStats,
  tryIncrementalIngest,
} from "../src/incremental-ingest.ts";
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
  claudeUnknownTypeIssues,
  createClaudeStepper,
  stepClaudeLine,
} from "../src/sources/claude.ts";
import { codexUnknownTypeIssues, createCodexStepper, stepCodexLine } from "../src/sources/codex.ts";
import { createPiStepper, piUnknownTypeIssues, stepPiLine } from "../src/sources/pi.ts";
import { printableType } from "../src/sources/shared.ts";
import {
  bumpSyncStateGeneration,
  committedEconomicsWrites,
  markSyncStateCleared,
  readEconomicsSeq,
  readSyncStateGeneration,
  SYNC_STATE_DERIVED_CLEARED,
  SYNC_STATE_DERIVED_PENDING,
  SYNC_STATE_RECOMMENDATIONS_CLEARED,
  SYNC_STATE_RECOMMENDATIONS_PENDING,
  SYNC_STATE_RECOMMENDATIONS_REFRESH_SEQ,
} from "../src/sync-state.ts";
import { computeSessionEconomicsVectors, tokenEconomics } from "../src/token-economics.ts";
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
      const fd = openSync(file, "r");
      try {
        const stats = fstatSync(fd);
        expect(sync(dbB, config).ingested).toBe(1);

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
    writeFileSync(piFile, header + makeCall("m-dup-0", "dup-call", 1, "first-v1") + tail);

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

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

      appendFileSync(file, claudeTurn("c-f1-atomic", 2, "req-2"));
      const staleFd = openSync(file, "r");
      const staleStats = statSync(file);

      try {
        writeFileSync(
          tmpFile,
          claudeTurn("c-f1-atomic", 1, "req-1") +
            claudeTurn("c-f1-atomic", 2, "req-2") +
            claudeTurn("c-f1-atomic", 3, "req-3"),
        );
        renameSync(tmpFile, file);
        expect(sync(dbB, config).ingested).toBe(1);

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

        appendFileSync(fileB, claudeTurn("c-f4b", 2, "req-b2", 120));
        expect(
          sync(externalDb, config, undefined, undefined, {
            candidatePaths: [fileB],
            deferDerivedRefresh: true,
          }).ingested,
        ).toBe(1);

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

      regenerateRecommendations(dbA);

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

      markSyncStateCleared(dbA, SYNC_STATE_RECOMMENDATIONS_CLEARED, genBefore);

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

    const initial = openDb(dbPath);
    closeDb(initial);
    const raw = new Database(dbPath);
    try {
      raw.exec("DROP TABLE sync_state;");
      raw.exec("ALTER TABLE block DROP COLUMN tool_result_bytes;");
      raw.exec("DELETE FROM schema_migrations WHERE version > 32;");
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

      const manualPromise = syncNow(
        fullConfig,
        economics,
        coordinator.run,
        coordinator.runWithOwnership,
      );

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

      appendFileSync(file, claudeTurn("c-f1-r3", 2, "req-2"));
      const staleFd = openSync(file, "r");
      const staleStats = statSync(file);

      try {
        writeFileSync(tmpFile, original);
        const newer = new Date(Date.now() + 5_000);
        utimesSync(tmpFile, newer, newer);
        renameSync(tmpFile, file);
        expect(sync(dbB, config).ingested).toBe(1);

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
      markSyncStateCleared(
        db,
        SYNC_STATE_DERIVED_CLEARED,
        readSyncStateGeneration(db, SYNC_STATE_DERIVED_PENDING),
      );
      const pendingBefore = readSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_PENDING);
      const refreshBefore = readSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_REFRESH_SEQ);
      expect(pendingBefore).toBeGreaterThan(0);

      regenerateRecommendations(db);
      expect(readSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_CLEARED)).toBe(pendingBefore);
      expect(readSyncStateGeneration(db, SYNC_STATE_RECOMMENDATIONS_REFRESH_SEQ)).toBe(
        refreshBefore + 1,
      );

      const blocker = openDb(dbPath);
      try {
        blocker.exec("BEGIN IMMEDIATE;");
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

      appendFileSync(file, turn2Old);
      const baseSec = Math.floor(Date.now() / 1000) + 2;
      const t1 = new Date(baseSec * 1000 + 100);
      const fd = openSync(file, "r+");
      try {
        futimesSync(fd, t1, t1);
        const stats = fstatSync(fd);
        const statsBig = fstatSync(fd, { bigint: true });

        const rewritten = Buffer.from(turn1 + turn2New);
        expect(rewritten.byteLength).toBe(stats.size);
        expect(writeSync(fd, rewritten, 0, rewritten.byteLength, 0)).toBe(rewritten.byteLength);
        const t2 = new Date(baseSec * 1000 + 500);
        futimesSync(fd, t2, t2);
        const rewrittenStats = fstatSync(fd, { bigint: true });
        expect(rewrittenStats.size).toBe(statsBig.size);
        expect(rewrittenStats.mtimeNs / 1_000_000_000n).toBe(statsBig.mtimeNs / 1_000_000_000n);
        expect(rewrittenStats.mtimeNs).not.toBe(statsBig.mtimeNs);

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

      const fdA = openSync(file, "r+");
      try {
        const statsA = fstatSync(fdA);
        const statsABig = fstatSync(fdA, { bigint: true });
        expect(sync(dbB, config).ingested).toBe(1);

        const rewritten = Buffer.from(turn1 + turn2New);
        expect(rewritten.byteLength).toBe(statsA.size);
        expect(writeSync(fdA, rewritten, 0, rewritten.byteLength, 0)).toBe(rewritten.byteLength);
        const t2 = new Date(baseSec * 1000 + 500);
        futimesSync(fdA, t2, t2);
        const rewrittenStats = fstatSync(fdA, { bigint: true });
        expect(rewrittenStats.size).toBe(statsABig.size);
        expect(rewrittenStats.mtimeNs / 1_000_000_000n).toBe(statsABig.mtimeNs / 1_000_000_000n);
        expect(rewrittenStats.mtimeNs).not.toBe(statsABig.mtimeNs);

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

      const blocker = openDb(dbPath);
      try {
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

        const workerScript = `
          import { Database } from "bun:sqlite";
          import { writeFileSync, utimesSync } from "node:fs";
          self.onmessage = ({ data }) => {
            const wdb = new Database(data.dbPath);
            wdb.exec("PRAGMA busy_timeout = 5000;");
            wdb.exec("BEGIN IMMEDIATE;");
            self.postMessage("locked");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
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

  test("seenResponseKeys Bloom filter scales with full response count and still catches late response repeats", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir, "proj", "c-bloom-scale.jsonl");
    let content = "";
    for (let i = 1; i <= 3_000; i += 1) {
      content += claudeTurn("c-bloom-scale", i, `req-${i}`, 40);
    }
    writeFileSync(file, content);

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);

      const initialCpRow = db
        .query("SELECT state_blob FROM ingest_checkpoint WHERE path = ?1")
        .get(file) as { state_blob: Uint8Array } | null;
      if (initialCpRow == null) {
        throw new Error("expected checkpoint row");
      }
      const initialCp = JSON.parse(
        new TextDecoder().decode(Bun.zstdDecompressSync(initialCpRow.state_blob)),
      ) as { economics: { valid: boolean; seenResponseKeys?: { bloom?: string } } };
      expect(initialCp.economics.valid).toBe(true);
      expect(initialCp.economics.seenResponseKeys?.bloom).toBeDefined();
      expect(Buffer.from(initialCp.economics.seenResponseKeys?.bloom ?? "", "base64").length).toBe(
        32_768,
      );

      for (let i = 3_001; i <= 3_025; i += 1) {
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

      appendFileSync(
        file,
        `${JSON.stringify({
          type: "assistant",
          uuid: "a-1-late-bloom",
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
            content: [{ type: "thinking", thinking: "Late thinking after 3025 turns" }],
          },
        })}\n`,
      );
      expect(sync(db, config).ingested).toBe(1);
      const afterRepeatRow = db
        .query("SELECT state_blob FROM ingest_checkpoint WHERE path = ?1")
        .get(file) as { state_blob: Uint8Array } | null;
      if (afterRepeatRow == null) {
        throw new Error("expected checkpoint row after repeat");
      }
      const afterRepeatCp = JSON.parse(
        new TextDecoder().decode(Bun.zstdDecompressSync(afterRepeatRow.state_blob)),
      ) as { economics: { valid: boolean } };
      expect(afterRepeatCp.economics.valid).toBe(false);
      expect(sync(freshDb, config).ingested).toBe(1);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });
});

describe("holistic audit regressions", () => {
  test("a Codex spawn_agent result appended after its child was ingested links the child on a targeted watch sync", () => {
    const { dbPath, config } = freshCase();
    const parentId = "33333333-3333-4333-8333-333333333333";
    const childId = "44444444-4444-4444-8444-444444444444";
    const day = join(config.codexDir as string, "sessions", "2026", "11", "01");
    const parentFile = join(day, `rollout-2026-11-01T10-00-00-${parentId}.jsonl`);
    const childFile = join(day, `rollout-2026-11-01T10-00-04-${childId}.jsonl`);
    const line = (timestamp: string, type: string, payload: unknown) =>
      `${JSON.stringify({ timestamp, type, payload })}\n`;
    writeFileSync(
      parentFile,
      line("2026-11-01T10:00:00.000Z", "session_meta", { id: parentId, cwd: "/home/dev/app" }) +
        line("2026-11-01T10:00:01.000Z", "response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Spawn a helper agent" }],
        }) +
        line("2026-11-01T10:00:02.000Z", "response_item", {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ prompt: "inspect tests" }),
          call_id: "call_spawn_late",
        }),
    );
    writeFileSync(
      childFile,
      line("2026-11-01T10:00:04.000Z", "session_meta", {
        id: childId,
        cwd: "/home/dev/app",
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
      }) +
        line("2026-11-01T10:00:05.000Z", "response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "inspect tests" }],
        }),
    );

    const db = openDb(dbPath);
    try {
      expect(sync(db, config)).toMatchObject({ ingested: 2, failed: 0 });
      const childLink = () =>
        db
          .query("SELECT is_subagent, spawn_tool_use_id FROM session WHERE source_session_id = ?1")
          .get(childId) as { is_subagent: number; spawn_tool_use_id: string | null };
      expect(childLink()).toEqual({ is_subagent: 1, spawn_tool_use_id: null });

      appendFileSync(
        parentFile,
        line("2026-11-01T10:00:03.000Z", "response_item", {
          type: "function_call_output",
          call_id: "call_spawn_late",
          output: JSON.stringify({
            agent_id: childId,
            status: "spawned",
            notes: "verbose startup context ".repeat(150),
          }),
        }),
      );
      const derivedBefore = readSyncStateGeneration(db, SYNC_STATE_DERIVED_PENDING);
      expect(
        sync(db, config, undefined, undefined, {
          candidatePaths: [parentFile],
          deferDerivedRefresh: true,
        }),
      ).toMatchObject({ ingested: 1, failed: 0 });
      expect(
        db
          .query(
            "SELECT typeof(tool_result) AS kind FROM block WHERE tool_use_id = 'call_spawn_late' AND type = 'tool_result'",
          )
          .get(),
      ).toEqual({ kind: "blob" });
      expect(readSyncStateGeneration(db, SYNC_STATE_DERIVED_PENDING)).toBeGreaterThan(
        derivedBefore,
      );
      expect(childLink()).toEqual({ is_subagent: 1, spawn_tool_use_id: "call_spawn_late" });
    } finally {
      closeDb(db);
    }
  });

  test.each([
    {
      source: "claude",
      run: (lines: string[]) => {
        const state = createClaudeStepper("unknown-claude");
        const table = state.unknownTypes;
        lines.forEach((line, index) => {
          stepClaudeLine(state, line, index + 1, []);
        });
        return { sameTable: state.unknownTypes === table, issues: claudeUnknownTypeIssues(state) };
      },
    },
    {
      source: "codex",
      run: (lines: string[]) => {
        const state = createCodexStepper("unknown-codex");
        const table = state.unknownTypes;
        lines.forEach((line, index) => {
          stepCodexLine(state, line, index + 1, []);
        });
        return { sameTable: state.unknownTypes === table, issues: codexUnknownTypeIssues(state) };
      },
    },
    {
      source: "pi",
      run: (lines: string[]) => {
        const state = createPiStepper("unknown-pi");
        const table = state.unknownTypes;
        lines.forEach((line, index) => {
          stepPiLine(state, line, index + 1, []);
        });
        return { sameTable: state.unknownTypes === table, issues: piUnknownTypeIssues(state) };
      },
    },
  ])("the $source stepper counts many distinct unknown record types in place", ({ run }) => {
    const distinct = 4_000;
    const types = [
      ...Array.from({ length: distinct }, (_, index) => `mystery_${index}`),
      "not printable!",
    ];
    const record = (type: string) =>
      JSON.stringify({ type, timestamp: "2026-11-01T10:00:00.000Z", payload: {} });
    const lines = [...types, ...types, ...types.slice(0, 10)].map(record);

    const { sameTable, issues } = run(lines);

    expect(sameTable).toBe(true);
    const unknown = issues.filter((issue) => issue.code === "unknown_record_type");
    expect(unknown).toHaveLength(types.length);
    const byLabel = new Map(
      unknown.map((issue) => [/unknown record type "(.*)" on/.exec(issue.error)?.[1], issue]),
    );
    types.forEach((type, index) => {
      const issue = byLabel.get(printableType(type));
      expect(issue?.lineNo).toBe(index + 1);
      expect(issue?.error).toContain(`on ${index < 10 ? 3 : 2} line(s)`);
    });
  });

  test.each([
    {
      shape: "unresolved calls",
      calls: MAX_CHECKPOINT_UNMATCHED_CALLS + 1,
      orphans: 0,
      checkpointsAfterResult: 1,
    },
    {
      shape: "orphan results",
      calls: 1,
      orphans: MAX_CHECKPOINT_ORPHAN_RESULT_IDS + 1,
      checkpointsAfterResult: 0,
    },
  ])(
    "a session with too many $shape keeps no checkpoint and still matches a fresh ingest after a late result",
    ({ calls, orphans, checkpointsAfterResult }) => {
      const { dir, dbPath, config } = freshCase();
      const sessionId = `c-budget-${calls}-${orphans}`;
      const file = join(config.claudeDir as string, "proj", `${sessionId}.jsonl`);
      const record = (fields: Record<string, unknown>) =>
        `${JSON.stringify({ sessionId, cwd: "/home/dev/work/app", ...fields })}\n`;
      const callBlocks = Array.from({ length: calls }, (_, index) => ({
        type: "tool_use",
        id: `tu-pending-${index}`,
        name: "Read",
        input: { file_path: `/home/dev/work/app/src/file-${index}.ts` },
      }));
      const orphanBlocks = Array.from({ length: orphans }, (_, index) => ({
        type: "tool_result",
        tool_use_id: `tu-missing-${index}`,
        content: "no call",
      }));
      writeFileSync(
        file,
        record({
          type: "user",
          uuid: "u-1",
          timestamp: "2026-11-01T10:00:00.000Z",
          message: { role: "user", content: "Read every file" },
        }) +
          record({
            type: "assistant",
            uuid: "a-1",
            requestId: "req-1",
            timestamp: "2026-11-01T10:00:01.000Z",
            message: {
              id: "msg_req-1",
              role: "assistant",
              model: "claude-sonnet-4-6",
              stop_reason: "tool_use",
              usage: { input_tokens: 100, output_tokens: 20 },
              content: callBlocks,
            },
          }) +
          (orphans > 0
            ? record({
                type: "user",
                uuid: "u-orphans",
                timestamp: "2026-11-01T10:00:02.000Z",
                message: { role: "user", content: orphanBlocks },
              })
            : ""),
      );

      const db = openDb(dbPath);
      const freshDb = openDb(join(dir, "fresh.db"));
      const checkpoints = () =>
        (
          db.query("SELECT COUNT(*) AS n FROM ingest_checkpoint WHERE path = ?1").get(file) as {
            n: number;
          }
        ).n;
      try {
        expect(sync(db, config).ingested).toBe(1);
        expect(checkpoints()).toBe(0);

        appendFileSync(
          file,
          record({
            type: "user",
            uuid: "u-late",
            timestamp: "2026-11-01T10:00:05.000Z",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "tu-pending-0", content: "late output" },
              ],
            },
          }),
        );
        expect(sync(db, config).ingested).toBe(1);
        expect(checkpoints()).toBe(checkpointsAfterResult);
        expect(sync(freshDb, config).ingested).toBe(1);
        assertDatabaseIntegrity(db);
        expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
        expect(
          db
            .query(
              "SELECT output_bytes FROM tool_call WHERE tool_use_id = 'tu-pending-0' AND result_block_id IS NOT NULL",
            )
            .get(),
        ).toEqual({ output_bytes: "late output".length });
      } finally {
        closeDb(db);
        closeDb(freshDb);
      }
    },
  );

  test("a zero-ingest sweep that regenerates deferred recommendations reports the refresh", async () => {
    const { dbPath, config } = freshCase();
    const fileA = join(config.claudeDir as string, "proj", "c-rec-a.jsonl");
    const fileB = join(config.claudeDir as string, "proj", "c-rec-b.jsonl");
    writeFileSync(fileA, claudeTurn("c-rec-a", 1, "req-1"));
    const db = openDb(dbPath);
    try {
      let refreshed = 0;
      const onRecommendationsRefreshed = () => {
        refreshed += 1;
      };
      expect(sync(db, config, undefined, undefined, { onRecommendationsRefreshed }).ingested).toBe(
        1,
      );
      expect(refreshed).toBe(1);

      writeFileSync(fileB, `${claudeTurn("c-rec-b", 1, "req-2")}{not valid json\n`);
      expect(
        sync(db, config, undefined, undefined, {
          candidatePaths: [fileB],
          deferDerivedRefresh: true,
          onRecommendationsRefreshed,
        }).ingested,
      ).toBe(1);
      expect(refreshed).toBe(1);

      await Bun.sleep(5);
      const sweep = sync(db, config, undefined, undefined, {
        recommendationMinIntervalMs: 1,
        onRecommendationsRefreshed,
      });
      expect(sweep.ingested).toBe(0);
      expect(refreshed).toBe(2);

      await Bun.sleep(5);
      sync(db, config, undefined, undefined, {
        recommendationMinIntervalMs: 1,
        onRecommendationsRefreshed,
      });
      expect(refreshed).toBe(2);
    } finally {
      closeDb(db);
    }
  });

  test("a head rewrite racing an append cannot leak into the next checkpoint prefix hash", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir as string, "proj", "c-prefix-race.jsonl");
    writeFileSync(file, claudeTurn("c-prefix-race", 1, "req-1"));
    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);
      const prior = db
        .query("SELECT size, mtime, session_id FROM ingest_source WHERE path = ?1")
        .get(file) as { size: number; mtime: number; session_id: number };
      appendFileSync(file, claudeTurn("c-prefix-race", 2, "req-2"));

      const original = readFileSync(file);
      const marker = original.indexOf("Prompt 1 ");
      expect(marker).toBeGreaterThan(-1);
      const realReadSync = fs.readSync;
      let mutated = false;
      const fd = openSync(file, "r");
      const readSpy = spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
        const count = (realReadSync as (...a: unknown[]) => number)(...args);
        const position = args[4];
        if (!mutated && typeof position === "number" && position >= prior.size) {
          mutated = true;
          const writer = openSync(file, "r+");
          try {
            writeSync(writer, Buffer.from("Prompt 9 "), 0, 9, marker);
            const appended = Buffer.from(claudeTurn("c-prefix-race", 3, "req-3"));
            writeSync(writer, appended, 0, appended.length, original.length);
          } finally {
            closeSync(writer);
          }
        }
        return count;
      }) as typeof fs.readSync);
      try {
        const res = tryIncrementalIngest({
          db,
          fd,
          stats: fstatSync(fd),
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
        expect(mutated).toBe(true);
        expect(res.kind).toBe("ingested");
      } finally {
        readSpy.mockRestore();
        closeSync(fd);
      }

      sync(db, config);
      expect(sync(freshDb, config).ingested).toBe(1);
      expect(search(db, "Prompt 9").length).toBeGreaterThan(0);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("full reads stop at the stat snapshot even when a line lands after it", () => {
    const { dir } = freshCase();
    const file = join(dir, "snapshot.jsonl");
    writeFileSync(file, '{"a":1}\n');
    const fd = openSync(file, "r+");
    try {
      const stats = sourceFileStats(fstatSync(fd, { bigint: true }));
      const extra = Buffer.from('{"b":2}\n');
      writeSync(fd, extra, 0, extra.length, stats.size);
      expect(fstatSync(fd).size).toBe(stats.size + extra.length);
      const buf = readSourceBuffer(fd, stats.size);
      expect(buf?.toString("utf8")).toBe('{"a":1}\n');
    } finally {
      closeSync(fd);
    }
  });

  test("a checkpoint already past its recorded source size recovers with a full reparse", () => {
    const { dir, dbPath, config } = freshCase();
    const file = join(config.claudeDir as string, "proj", "c-ahead.jsonl");
    writeFileSync(file, claudeTurn("c-ahead", 1, "req-1") + claudeTurn("c-ahead", 2, "req-2"));
    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);
      const { size } = db.query("SELECT size FROM ingest_source WHERE path = ?1").get(file) as {
        size: number;
      };
      db.run("UPDATE ingest_source SET size = ?2 WHERE path = ?1", [file, size - 10]);
      appendFileSync(file, claudeTurn("c-ahead", 3, "req-3"));

      const report = sync(db, config);
      expect(report.ingested).toBe(1);
      expect(report.skipped).toBe(0);
      const row = db
        .query(
          `SELECT s.size AS size, c.parsed_offset AS parsed_offset
             FROM ingest_source s JOIN ingest_checkpoint c ON c.path = s.path
            WHERE s.path = ?1`,
        )
        .get(file) as { size: number; parsed_offset: number };
      expect(row.parsed_offset).toBeLessThanOrEqual(row.size);
      expect(row.size).toBe(statSync(file).size);

      expect(sync(freshDb, config).ingested).toBe(1);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("a recommendation refresh racing unsettled lineage and worktree work leaves its generation pending", () => {
    const { dir, dbPath, config } = freshCase();
    const fileA = join(config.claudeDir as string, "proj", "c-rec-race-a.jsonl");
    const fileB = join(config.claudeDir as string, "proj", "c-rec-race-b.jsonl");
    writeFileSync(fileA, claudeTurn("c-rec-race-a", 1, "req-1"));
    const dbA = openDb(dbPath);
    const dbB = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(dbA, config).ingested).toBe(1);

      writeFileSync(fileB, claudeTurn("c-rec-race-b", 1, "req-2"));
      expect(
        sync(dbB, config, undefined, undefined, {
          candidatePaths: [fileB],
          deferDerivedRefresh: true,
        }).ingested,
      ).toBe(1);
      const pending = readSyncStateGeneration(dbA, SYNC_STATE_RECOMMENDATIONS_PENDING);
      expect(readSyncStateGeneration(dbA, SYNC_STATE_DERIVED_PENDING)).toBeGreaterThan(
        readSyncStateGeneration(dbA, SYNC_STATE_DERIVED_CLEARED),
      );

      expect(regenerateRecommendations(dbA)).toBe(true);
      expect(readSyncStateGeneration(dbA, SYNC_STATE_RECOMMENDATIONS_CLEARED)).toBeLessThan(
        pending,
      );

      let refreshed = 0;
      sync(dbB, config, undefined, undefined, {
        onRecommendationsRefreshed: () => {
          refreshed += 1;
        },
      });
      expect(refreshed).toBe(1);
      expect(readSyncStateGeneration(dbB, SYNC_STATE_RECOMMENDATIONS_CLEARED)).toBe(pending);

      expect(sync(freshDb, config).ingested).toBe(2);
      const recommendations = (db: typeof dbA) =>
        db.query("SELECT key, detail, score FROM recommendation ORDER BY key").all();
      expect(recommendations(dbB)).toEqual(recommendations(freshDb));
    } finally {
      closeDb(dbA);
      closeDb(dbB);
      closeDb(freshDb);
    }
  });
});

function paddedClaudeTranscript(sessionId: string, turns: number): string {
  let out = "";
  for (let turn = 1; turn <= turns; turn++) {
    out += claudeTurn(sessionId, turn, `req-${turn}`, 40, `TOKEN${turn}AAAA ${"x".repeat(6000)}`);
  }
  return out;
}

function priorSource(
  db: Database,
  file: string,
): { size: number; mtime: number; session_id: number } {
  return db
    .query("SELECT size, mtime, session_id FROM ingest_source WHERE path = ?1")
    .get(file) as { size: number; mtime: number; session_id: number };
}

function incrementalInput(
  db: Database,
  fd: number,
  file: string,
  prior: { size: number; mtime: number; session_id: number },
): Parameters<typeof tryIncrementalIngest>[0] {
  return {
    db,
    fd,
    stats: fstatSync(fd),
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
  };
}

describe("checkpoint prefix hash samples only validated head and tail bytes", () => {
  test("extending prior samples with parsed delta bytes matches hashing the whole ingested prefix", () => {
    const sample = ANCHOR_SAMPLE_BYTES;
    const full = Buffer.alloc(sample * 4 + 123);
    for (let i = 0; i < full.length; i++) {
      full[i] = (i * 31 + 7) % 251;
    }
    for (const priorLen of [0, 1, 100, sample - 1, sample, sample + 5, sample * 2 + 9]) {
      for (const deltaLen of [0, 1, 50, sample - 1, sample, sample + 7, sample * 2]) {
        const nextLen = priorLen + deltaLen;
        const prior = {
          parsedOffset: priorLen,
          head: full.subarray(0, Math.min(sample, priorLen)),
          tail: full.subarray(Math.max(0, priorLen - sample), priorLen),
        };
        const next = extendPrefixSamples(prior, full.subarray(priorLen, nextLen));
        expect(next.parsedOffset).toBe(nextLen);
        expect(next.head.equals(full.subarray(0, Math.min(sample, nextLen)))).toBe(true);
        expect(next.tail.equals(full.subarray(Math.max(0, nextLen - sample), nextLen))).toBe(true);
      }
    }
  });

  test("a rewrite in the unsampled middle racing an append never enters the next checkpoint hash", () => {
    const { dbPath, config } = freshCase();
    const file = join(config.claudeDir as string, "proj", "c-mid-race.jsonl");
    writeFileSync(file, paddedClaudeTranscript("c-mid-race", 10));
    const db = openDb(dbPath);
    try {
      expect(sync(db, config).ingested).toBe(1);
      const prior = priorSource(db, file);
      expect(prior.size).toBeGreaterThan(ANCHOR_SAMPLE_BYTES * 3);
      appendFileSync(file, claudeTurn("c-mid-race", 11, "req-11"));
      const ingested = readFileSync(file);

      const target = Math.floor((ingested.length - 4096) / 2);
      const editAt = ingested.indexOf("xxxxxxxx", target);
      expect(editAt).toBeGreaterThan(ANCHOR_SAMPLE_BYTES);
      expect(editAt + 8).toBeLessThan(prior.size - ANCHOR_SAMPLE_BYTES);

      const realReadSync = fs.readSync;
      const reads: { start: number; end: number }[] = [];
      let mutated = false;
      const fd = openSync(file, "r+");
      let editedChunk = "";
      try {
        const readSpy = spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
          const count = (realReadSync as (...a: unknown[]) => number)(...args);
          const position = args[4];
          if (args[0] === fd && typeof position === "number") {
            reads.push({ start: position, end: position + count });
            if (!mutated && position >= prior.size) {
              mutated = true;
              writeSync(fd, Buffer.from("yyyyyyyy"), 0, 8, editAt);
              const appended = Buffer.from(claudeTurn("c-mid-race", 12, "req-12"));
              writeSync(fd, appended, 0, appended.length, ingested.length);
            }
          }
          return count;
        }) as typeof fs.readSync);
        try {
          expect(tryIncrementalIngest(incrementalInput(db, fd, file, prior)).kind).toBe("ingested");
          expect(mutated).toBe(true);
        } finally {
          readSpy.mockRestore();
        }
        const probe = Buffer.alloc(8);
        expect(fs.readSync(fd, probe, 0, 8, editAt)).toBe(8);
        editedChunk = probe.toString();
      } finally {
        closeSync(fd);
      }

      const unsampledStart = ANCHOR_SAMPLE_BYTES;
      const unsampledEnd = prior.size - ANCHOR_SAMPLE_BYTES;
      expect(reads.filter((r) => r.start < unsampledEnd && r.end > unsampledStart)).toEqual([]);

      const checkpoint = db
        .query("SELECT parsed_offset, prefix_hash FROM ingest_checkpoint WHERE path = ?1")
        .get(file) as { parsed_offset: number; prefix_hash: string };
      expect(checkpoint.parsed_offset).toBe(ingested.length);
      expect(checkpoint.prefix_hash).toBe(
        computePrefixHashFromBuffer(ingested, checkpoint.parsed_offset),
      );
      expect(editedChunk).toBe("yyyyyyyy");
    } finally {
      closeDb(db);
    }
  });

  for (const region of ["head", "tail"] as const) {
    test(`a rewrite touching the sampled ${region} during an append falls back to a full re-parse`, () => {
      const { dir, dbPath, config } = freshCase();
      const file = join(config.claudeDir as string, "proj", `c-${region}-edit.jsonl`);
      writeFileSync(file, paddedClaudeTranscript(`c-${region}-edit`, 10));
      const db = openDb(dbPath);
      const freshDb = openDb(join(dir, "fresh.db"));
      try {
        expect(sync(db, config).ingested).toBe(1);
        const prior = priorSource(db, file);
        const original = readFileSync(file);
        const token = region === "head" ? "TOKEN1AAAA" : "TOKEN10AAAA";
        const replacement = region === "head" ? "TOKEN1BBBB" : "TOKEN10BBBB";
        const at = original.indexOf(token);
        if (region === "head") {
          expect(at + token.length).toBeLessThan(ANCHOR_SAMPLE_BYTES);
        } else {
          expect(at).toBeGreaterThan(prior.size - ANCHOR_SAMPLE_BYTES);
        }
        const fd = openSync(file, "r+");
        try {
          writeSync(fd, Buffer.from(replacement), 0, replacement.length, at);
          const appended = Buffer.from(claudeTurn(`c-${region}-edit`, 11, "req-11"));
          writeSync(fd, appended, 0, appended.length, original.length);
          expect(tryIncrementalIngest(incrementalInput(db, fd, file, prior)).kind).toBe("fallback");
        } finally {
          closeSync(fd);
        }
        expect(sync(db, config).ingested).toBe(1);
        expect(search(db, replacement).length).toBeGreaterThan(0);
        expect(sync(freshDb, config).ingested).toBe(1);
        assertDatabaseIntegrity(db);
        expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
      } finally {
        closeDb(db);
        closeDb(freshDb);
      }
    });
  }
});

const V34_INGEST_REVISION = 23;

function downgradeToV34Revision23(dbPath: string, staleSql: string): void {
  const raw = new Database(dbPath);
  try {
    raw.exec(`
      DROP TRIGGER IF EXISTS block_au;
      CREATE TRIGGER block_au AFTER UPDATE ON block BEGIN
        INSERT INTO block_fts(block_fts, rowid, text, tool_name, tool_input)
        VALUES ('delete', old.id, old.text, old.tool_name, old.tool_input);
        INSERT INTO block_fts(rowid, text, tool_name, tool_input)
        VALUES (new.id, new.text, new.tool_name, new.tool_input);
      END;
      DELETE FROM schema_migrations WHERE version > 34;
    `);
    raw.query("UPDATE ingest_source SET ingest_revision = ?1").run(V34_INGEST_REVISION);
    raw.exec(staleSql);
  } finally {
    raw.close();
  }
}

describe("upgrading a v34 archive at ingest revision 23", () => {
  test("re-derives search_count for run_shell_command, powershell, and run_in_terminal calls", () => {
    expect(INGEST_PIPELINE_REVISION).toBeGreaterThan(V34_INGEST_REVISION);
    const { dir, dbPath, config } = freshCase();
    const sessionId = "c-shell-search";
    const file = join(config.claudeDir as string, "proj", `${sessionId}.jsonl`);
    const toolLine = (turn: number, name: string) =>
      `${JSON.stringify({
        type: "assistant",
        uuid: `tool-${turn}`,
        requestId: `req-tool-${turn}`,
        sessionId,
        cwd: "/home/dev/work/app",
        timestamp: `2026-11-01T10:00:0${turn}.700Z`,
        message: {
          id: `msg_tool_${turn}`,
          role: "assistant",
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            {
              type: "tool_use",
              id: `toolu_${name}`,
              name,
              input: { command: "rg needle src" },
            },
          ],
        },
      })}\n`;
    writeFileSync(
      file,
      claudeTurn(sessionId, 1, "req-1") +
        toolLine(2, "run_shell_command") +
        toolLine(3, "powershell") +
        toolLine(4, "run_in_terminal"),
    );
    const db0 = openDb(dbPath);
    try {
      expect(sync(db0, config).ingested).toBe(1);
    } finally {
      closeDb(db0);
    }
    downgradeToV34Revision23(dbPath, "UPDATE session SET search_count = 0");

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(sync(db, config).ingested).toBe(1);
      expect(sync(freshDb, config).ingested).toBe(1);
      const searchCount = (target: Database) =>
        (target.query("SELECT search_count FROM session").get() as { search_count: number })
          .search_count;
      expect(searchCount(freshDb)).toBe(3);
      expect(searchCount(db)).toBe(3);
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });

  test("links a Codex child whose spawn result was already ingested without a spawn_tool_use_id", () => {
    expect(INGEST_PIPELINE_REVISION).toBeGreaterThan(V34_INGEST_REVISION);
    const { dir, dbPath, config } = freshCase();
    const parentId = "55555555-5555-4555-8555-555555555555";
    const childId = "66666666-6666-4666-8666-666666666666";
    const day = join(config.codexDir as string, "sessions", "2026", "11", "01");
    const line = (timestamp: string, type: string, payload: unknown) =>
      `${JSON.stringify({ timestamp, type, payload })}\n`;
    writeFileSync(
      join(day, `rollout-2026-11-01T10-00-00-${parentId}.jsonl`),
      line("2026-11-01T10:00:00.000Z", "session_meta", { id: parentId, cwd: "/home/dev/app" }) +
        line("2026-11-01T10:00:01.000Z", "response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Spawn a helper agent" }],
        }) +
        line("2026-11-01T10:00:02.000Z", "response_item", {
          type: "function_call",
          name: "spawn_agent",
          arguments: JSON.stringify({ prompt: "inspect tests" }),
          call_id: "call_spawn_r23",
        }) +
        line("2026-11-01T10:00:03.000Z", "response_item", {
          type: "function_call_output",
          call_id: "call_spawn_r23",
          output: JSON.stringify({ agent_id: childId, status: "spawned" }),
        }),
    );
    writeFileSync(
      join(day, `rollout-2026-11-01T10-00-04-${childId}.jsonl`),
      line("2026-11-01T10:00:04.000Z", "session_meta", {
        id: childId,
        cwd: "/home/dev/app",
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
      }) +
        line("2026-11-01T10:00:05.000Z", "response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "inspect tests" }],
        }),
    );
    const childLink = (target: Database) =>
      target
        .query("SELECT is_subagent, spawn_tool_use_id FROM session WHERE source_session_id = ?1")
        .get(childId) as { is_subagent: number; spawn_tool_use_id: string | null };

    const db0 = openDb(dbPath);
    try {
      expect(sync(db0, config).ingested).toBe(2);
    } finally {
      closeDb(db0);
    }
    downgradeToV34Revision23(
      dbPath,
      `UPDATE session SET spawn_tool_use_id = NULL WHERE source_session_id = '${childId}'`,
    );

    const db = openDb(dbPath);
    const freshDb = openDb(join(dir, "fresh.db"));
    try {
      expect(childLink(db)).toEqual({ is_subagent: 1, spawn_tool_use_id: null });
      expect(sync(db, config).ingested).toBe(2);
      expect(sync(freshDb, config).ingested).toBe(2);
      expect(childLink(freshDb)).toEqual({ is_subagent: 1, spawn_tool_use_id: "call_spawn_r23" });
      expect(childLink(db)).toEqual(childLink(freshDb));
      assertDatabaseIntegrity(db);
      expect(captureCanonicalSnapshot(db)).toEqual(captureCanonicalSnapshot(freshDb));
    } finally {
      closeDb(db);
      closeDb(freshDb);
    }
  });
});

describe("EconomicsCache across a worker and a server connection", () => {
  test("a recommendation-only sweep moves data_version without a rebuild, and economics writes still rebuild", async () => {
    const { dbPath, config } = freshCase();
    const fileA = join(config.claudeDir as string, "proj", "c-econ-a.jsonl");
    const fileB = join(config.claudeDir as string, "proj", "c-econ-b.jsonl");
    writeFileSync(fileA, claudeTurn("c-econ-a", 1, "req-a1", 100));
    writeFileSync(fileB, claudeTurn("c-econ-b", 1, "req-b1", 60));

    const serverDb = openDb(dbPath);
    const workerDb = openDb(dbPath);
    let builds = 0;
    const cache = new EconomicsCache({
      dbPath,
      db: serverDb,
      computeVectors: (path) => {
        builds += 1;
        const reader = new Database(path, { readonly: true, strict: true });
        try {
          return Promise.resolve(computeSessionEconomicsVectors(reader));
        } finally {
          reader.close();
        }
      },
    });
    const sessionIdFor = (source: string) =>
      (
        workerDb.query("SELECT id FROM session WHERE source_session_id = ?1").get(source) as {
          id: number;
        }
      ).id;
    const expectRebuildAfter = async (write: () => void) => {
      const seqBefore = readEconomicsSeq(workerDb) ?? 0;
      const buildsBefore = builds;
      write();
      expect(readEconomicsSeq(serverDb) ?? 0).toBeGreaterThan(seqBefore);
      await cache.get();
      await cache.settled();
      expect(builds).toBe(buildsBefore + 1);
      expect(await cache.get()).toEqual(tokenEconomics(serverDb));
      expect(builds).toBe(buildsBefore + 1);
    };
    try {
      expect(sync(workerDb, config).ingested).toBe(2);
      const warmed = await cache.get();
      expect(warmed).toEqual(tokenEconomics(serverDb));
      expect(builds).toBe(1);

      const dataVersionBefore = cache.dataVersion();
      const seqBefore = readEconomicsSeq(serverDb);
      bumpSyncStateGeneration(workerDb, SYNC_STATE_RECOMMENDATIONS_PENDING);
      let refreshed = 0;
      const sweep = sync(workerDb, config, undefined, undefined, {
        onRecommendationsRefreshed: () => {
          refreshed += 1;
        },
      });
      expect(sweep.ingested).toBe(0);
      expect(refreshed).toBe(1);
      expect(cache.dataVersion()).not.toBe(dataVersionBefore);
      expect(readEconomicsSeq(serverDb)).toBe(seqBefore);
      expect(await cache.get()).toEqual(warmed);
      await cache.settled();
      expect(builds).toBe(1);
      expect(await cache.get()).toEqual(tokenEconomics(serverDb));
      expect(builds).toBe(1);

      await expectRebuildAfter(() => {
        appendFileSync(fileA, claudeTurn("c-econ-a", 2, "req-a2", 80));
        expect(sync(workerDb, config).ingested).toBe(1);
      });
      await expectRebuildAfter(() => {
        const row = workerDb
          .query("SELECT session_id, vector_json FROM session_economics WHERE session_id = ?1")
          .get(sessionIdFor("c-econ-b")) as { session_id: number; vector_json: string };
        const stale = { ...JSON.parse(row.vector_json), input_cost: 123.45 };
        workerDb
          .query("UPDATE session_economics SET vector_json = ?2 WHERE session_id = ?1")
          .run(row.session_id, JSON.stringify(stale));
        expect(sync(workerDb, config).repriced).toBe(1);
      });
      await expectRebuildAfter(() => {
        expect(setSessionUserState(workerDb, sessionIdFor("c-econ-a"), "archived")).toBe(true);
      });
      await expectRebuildAfter(() => {
        expect(setSessionUserState(workerDb, sessionIdFor("c-econ-a"), "visible")).toBe(true);
      });
      await expectRebuildAfter(() => {
        expect(setSessionUserState(workerDb, sessionIdFor("c-econ-b"), "deleted")).toBe(true);
      });
    } finally {
      cache.dispose();
      await cache.settled();
      closeDb(serverDb);
      closeDb(workerDb);
    }
  });

  test("incremental commit check preserves exact 64-bit bigint device and inode values", () => {
    const { dbPath, config } = freshCase();
    const file = join(config.claudeDir as string, "proj", "c-bigint-ino.jsonl");
    writeFileSync(file, claudeTurn("c-bigint-ino", 1, "req-1"));
    const db = openDb(dbPath);
    try {
      expect(sync(db, config).ingested).toBe(1);
      const prior = priorSource(db, file);
      appendFileSync(file, claudeTurn("c-bigint-ino", 2, "req-2"));

      const devBig = 9007199254740995n;
      const inoBig = 9007199254740993n;
      const roundedCollisionIno = 9007199254740992n;
      expect(Number(inoBig)).toBe(Number(roundedCollisionIno));

      const realStatSync = fs.statSync;
      const fd = openSync(file, "r");
      try {
        const realBig = fstatSync(fd, { bigint: true });
        const statsBig = Object.assign(Object.create(Object.getPrototypeOf(realBig)), realBig, {
          dev: devBig,
          ino: inoBig,
        });
        const projected = sourceFileStats(statsBig);
        expect(projected.dev).toBe(devBig);
        expect(projected.ino).toBe(inoBig);

        let liveIno = roundedCollisionIno;
        const statSpy = spyOn(fs, "statSync").mockImplementation(((...args: unknown[]) => {
          const result = (realStatSync as (...a: unknown[]) => unknown)(...args);
          if (args[0] === file && typeof (result as { ino?: unknown })?.ino === "bigint") {
            return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
              dev: devBig,
              ino: liveIno,
            });
          }
          return result;
        }) as typeof fs.statSync);
        try {
          const mismatch = tryIncrementalIngest({
            db,
            fd,
            stats: projected,
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
          expect(mismatch.kind).toBe("conflict");

          liveIno = inoBig;
          const match = tryIncrementalIngest({
            db,
            fd,
            stats: projected,
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
          expect(match.kind).toBe("ingested");
        } finally {
          statSpy.mockRestore();
        }
      } finally {
        closeSync(fd);
      }
    } finally {
      closeDb(db);
    }
  });
});
