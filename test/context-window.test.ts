import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextWindowForSession,
  inferClaudeContextWindowTokens,
  materializeMissingContextWindows,
} from "../src/context-window.ts";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { getSession, listSessions } from "../src/query.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-context-window-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshDb(): Database {
  dbCounter += 1;
  return openDb(join(workDir, `ctx-${dbCounter}.db`));
}

const BASE = {
  sessionId: "sess-ctx",
  cwd: "/Users/dev/proj",
  gitBranch: "main",
  version: "2.1.0",
};

function record(value: Record<string, unknown>): string {
  return JSON.stringify({ ...BASE, ...value });
}

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): Record<string, number> {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

// Synthetic session: growing context, a duplicate streamed line sharing a
// requestId, one auto-compaction with metadata, and sidechain turns that must
// stay out of the main-thread curve. Inline (not under fixtures/) so the
// golden fixture inventory stays untouched.
const CONTEXT_FIXTURE = [
  record({
    type: "user",
    uuid: "u1",
    parentUuid: null,
    timestamp: "2026-05-03T10:00:00.000Z",
    message: { role: "user", content: "Start the big refactor" },
  }),
  record({
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    requestId: "req-1",
    timestamp: "2026-05-03T10:01:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: "tool_use",
      usage: usage(20, 100, 0, 40_000),
      content: [
        { type: "text", text: "Scanning the tree." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/Users/dev/proj/a.ts" } },
      ],
    },
  }),
  // Streamed duplicate of the same API call: lower output, same requestId, so
  // the parser keeps usage only on the line above.
  record({
    type: "assistant",
    uuid: "a1b",
    parentUuid: "u1",
    requestId: "req-1",
    timestamp: "2026-05-03T10:01:01.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: null,
      usage: usage(20, 40, 0, 40_000),
      content: [{ type: "text", text: "Scanning" }],
    },
  }),
  record({
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    timestamp: "2026-05-03T10:01:30.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }],
    },
  }),
  record({
    type: "assistant",
    uuid: "a2",
    parentUuid: "u2",
    requestId: "req-2",
    timestamp: "2026-05-03T10:02:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: "end_turn",
      usage: usage(10, 800, 40_500, 30_000),
      content: [{ type: "text", text: "Done reading; starting the refactor." }],
    },
  }),
  record({
    type: "system",
    uuid: "s1",
    parentUuid: "a2",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    level: "info",
    logicalParentUuid: "a2",
    compactMetadata: { trigger: "auto", preTokens: 70_510 },
    timestamp: "2026-05-03T10:03:00.000Z",
  }),
  record({
    type: "user",
    uuid: "cs1",
    parentUuid: "s1",
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    timestamp: "2026-05-03T10:03:10.000Z",
    message: {
      role: "user",
      content:
        "This session is being continued from a previous conversation. Summary: refactor is underway.",
    },
  }),
  record({
    type: "user",
    uuid: "u3",
    parentUuid: "cs1",
    timestamp: "2026-05-03T10:03:40.000Z",
    message: { role: "user", content: "Now add the watch-mode flag we discussed" },
  }),
  record({
    type: "assistant",
    uuid: "a3",
    parentUuid: "u3",
    requestId: "req-3",
    timestamp: "2026-05-03T10:04:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: "end_turn",
      usage: usage(5, 300, 0, 12_000),
      content: [{ type: "text", text: "Continuing after compaction." }],
    },
  }),
  record({
    type: "user",
    uuid: "sc1",
    parentUuid: null,
    isSidechain: true,
    timestamp: "2026-05-03T10:05:00.000Z",
    message: { role: "user", content: "explore the auth flows" },
  }),
  record({
    type: "assistant",
    uuid: "sc2",
    parentUuid: "sc1",
    isSidechain: true,
    requestId: "req-sc",
    timestamp: "2026-05-03T10:05:10.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-7",
      stop_reason: "end_turn",
      usage: usage(5, 50, 500_000, 0),
      content: [{ type: "text", text: "Two flows found." }],
    },
  }),
].join("\n");

function seeded(): { db: Database; sessionId: number } {
  const db = freshDb();
  upsertSession(db, parseClaudeSession("sess-ctx", CONTEXT_FIXTURE), "/ctx.jsonl", 1, 2, "h");
  const sessionId = listSessions(db)[0]?.id ?? 0;
  return { db, sessionId };
}

describe("contextWindowForSession", () => {
  test("uses published model limits for Claude sessions whose logs omit the window", () => {
    for (const model of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-mythos-preview",
      "us.anthropic.claude-opus-4-8-v1:0",
    ]) {
      expect(inferClaudeContextWindowTokens(model, 50_000)).toBe(1_000_000);
    }
    for (const model of [
      "claude-sonnet-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-5",
      "claude-opus-4-60",
      null,
    ]) {
      expect(inferClaudeContextWindowTokens(model, 50_000)).toBe(200_000);
    }
    expect(inferClaudeContextWindowTokens("claude-sonnet-4-5", 250_000)).toBe(1_000_000);
  });

  test("builds the per-call series with dedupe, compaction, and sidechain exclusion", () => {
    const { db, sessionId } = seeded();
    const timeline = contextWindowForSession(db, sessionId);
    expect(timeline).not.toBeNull();
    expect(timeline?.tool).toBe("claude_code");

    expect(timeline?.points.map((point) => point.context_tokens)).toEqual([40_020, 70_510, 12_005]);
    expect(timeline?.points.map((point) => point.seq)).toEqual([1, 4, 8]);
    // Machine-generated compact summaries are continuations, not user turns.
    expect(timeline?.points.map((point) => point.turn)).toEqual([1, 1, 2]);
    expect(timeline?.turn_count).toBe(2);
    expect(timeline?.points[0]).toEqual({
      seq: 1,
      timestamp: "2026-05-03T10:01:00.000Z",
      turn: 1,
      context_tokens: 40_020,
      input_tokens: 20,
      cache_read_tokens: 0,
      cache_creation_tokens: 40_000,
      output_tokens: 100,
    });

    expect(timeline?.compactions).toEqual([
      {
        seq: 5,
        timestamp: "2026-05-03T10:03:00.000Z",
        trigger: "auto",
        pre_tokens: 70_510,
        post_tokens: 12_005,
      },
    ]);
    expect(timeline?.points[2]?.seq).toBe(8);

    expect(timeline?.window_tokens).toBe(1_000_000);
    expect(timeline?.window_inferred).toBe(true);
    expect(timeline?.peak_tokens).toBe(70_510);
    expect(timeline?.peak_pct).toBeCloseTo(70_510 / 1_000_000, 6);
    db.close();
  });

  test("falls back to neighboring points when compactMetadata is missing", () => {
    const db = freshDb();
    const content = readFileSync(
      join(import.meta.dir, "..", "fixtures", "claude", "enriched.jsonl"),
      "utf8",
    );
    upsertSession(db, parseClaudeSession("sess-claude-enr", content), "/enr.jsonl", 1, 2, "h");
    const sessionId = listSessions(db)[0]?.id ?? 0;

    const timeline = contextWindowForSession(db, sessionId);
    expect(timeline?.points.map((point) => [point.seq, point.context_tokens])).toEqual([
      [1, 1000],
      [3, 1200],
    ]);
    // Command wrappers and interruption markers are not turns (enrich parity).
    expect(timeline?.points.map((point) => point.turn)).toEqual([1, 1]);
    expect(timeline?.turn_count).toBe(1);
    // Boundary carries no compactMetadata: pre falls back to the last point
    // before it, and there is no non-sidechain call after it.
    expect(timeline?.compactions).toEqual([
      {
        seq: 7,
        timestamp: "2026-05-03T10:12:50.000Z",
        trigger: null,
        pre_tokens: 1200,
        post_tokens: null,
      },
    ]);
    expect(timeline?.window_tokens).toBe(1_000_000);
    db.close();
  });

  test("infers the extended 1M window once usage exceeds the 200k baseline", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, started_at, is_subagent)
      VALUES (1, 'claude_code', 'big-window', '2026-07-01T00:00:00Z', 0);
      INSERT INTO message(id, session_id, seq, role, timestamp,
                          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw)
      VALUES (1, 1, 0, 'assistant', '2026-07-01T00:01:00Z', 12, 900, 950000, 3000, '{}');
    `);

    const timeline = contextWindowForSession(db, 1);
    expect(timeline?.window_tokens).toBe(1_000_000);
    expect(timeline?.window_inferred).toBe(true);
    expect(timeline?.peak_tokens).toBe(953_012);
    expect(timeline?.peak_pct).toBeCloseTo(0.953012, 6);
    db.close();
  });

  test("sessions without per-message usage return no points and no window", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, started_at, is_subagent)
      VALUES (1, 'codex', 'codex-session', '2026-07-01T00:00:00Z', 0);
      INSERT INTO message(id, session_id, seq, role, raw)
      VALUES (1, 1, 0, 'assistant', '{}'), (2, 1, 1, 'user', '{}');
    `);

    const timeline = contextWindowForSession(db, 1);
    expect(timeline).toEqual({
      session_id: 1,
      tool: "codex",
      window_tokens: null,
      window_inferred: false,
      peak_tokens: 0,
      peak_pct: null,
      turn_count: 0,
      points: [],
      compactions: [],
    });
    db.close();
  });

  test("treats sidechain rows as the primary thread of a standalone subagent", () => {
    const db = freshDb();
    const content = [
      record({
        type: "user",
        uuid: "su1",
        parentUuid: null,
        isSidechain: true,
        timestamp: "2026-05-03T10:00:00.000Z",
        message: { role: "user", content: "Inspect the parser" },
      }),
      record({
        type: "assistant",
        uuid: "sa1",
        parentUuid: "su1",
        isSidechain: true,
        requestId: "subagent-req-1",
        timestamp: "2026-05-03T10:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          stop_reason: "end_turn",
          usage: usage(10, 40, 80_000, 10_000),
          content: [{ type: "text", text: "The parser is sound." }],
        },
      }),
    ].join("\n");
    const parsed = parseClaudeSession("agent-context", content, {
      sourcePath: "/tmp/project/session/subagents/agent-context.jsonl",
    });
    expect(parsed.session.isSubagent).toBe(true);
    upsertSession(db, parsed, "/agent-context.jsonl", 1, 2, "h");
    const sessionId = listSessions(db, { includeSubagents: true })[0]?.id ?? 0;

    const timeline = contextWindowForSession(db, sessionId);
    expect(timeline?.points.map((point) => point.context_tokens)).toEqual([90_010]);
    expect(timeline?.points.map((point) => point.turn)).toEqual([1]);
    expect(timeline?.turn_count).toBe(1);
    expect(
      db.query("SELECT turn_count, peak_context_tokens FROM session WHERE id = ?1").get(sessionId),
    ).toEqual({ turn_count: 1, peak_context_tokens: 90_010 });
    expect(getSession(db, sessionId)?.messages[1]).toMatchObject({
      role: "assistant",
      is_sidechain: true,
      context_tokens: 90_010,
    });
    db.close();
  });

  test("returns null for an unknown session", () => {
    const { db } = seeded();
    expect(contextWindowForSession(db, 999_999)).toBeNull();
    db.close();
  });
});

function codexLine(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function codexTokenCount(
  timestamp: string,
  total: Record<string, number>,
  last: Record<string, number>,
): string {
  return codexLine({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last, model_context_window: 258_400 },
    },
  });
}

// Codex rollout with per-request token_count readings (including one that must
// walk back past a tool row), a compacted record, and the paired
// context_compacted event that carries no data.
const CODEX_FIXTURE = [
  codexLine({
    type: "session_meta",
    timestamp: "2026-06-01T09:00:00.000Z",
    payload: {
      id: "sess-codex-ctx",
      cwd: "/Users/dev/proj",
      cli_version: "0.130.0",
      source: "cli",
    },
  }),
  codexLine({
    type: "turn_context",
    timestamp: "2026-06-01T09:00:01.000Z",
    payload: { model: "gpt-5.2", cwd: "/Users/dev/proj" },
  }),
  codexLine({
    type: "response_item",
    timestamp: "2026-06-01T09:00:02.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the flaky test" }],
    },
  }),
  codexLine({
    type: "response_item",
    timestamp: "2026-06-01T09:00:03.000Z",
    payload: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Look at the failing spec." }],
    },
  }),
  codexLine({
    type: "response_item",
    timestamp: "2026-06-01T09:00:04.000Z",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Reading the test file." }],
    },
  }),
  codexTokenCount(
    "2026-06-01T09:00:05.000Z",
    {
      input_tokens: 30_000,
      cached_input_tokens: 25_000,
      output_tokens: 500,
      reasoning_output_tokens: 100,
      total_tokens: 30_500,
    },
    {
      input_tokens: 30_000,
      cached_input_tokens: 25_000,
      output_tokens: 500,
      reasoning_output_tokens: 100,
      total_tokens: 30_500,
    },
  ),
  codexLine({
    type: "response_item",
    timestamp: "2026-06-01T09:00:06.000Z",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "c1",
      arguments: '{"cmd":"bun test"}',
    },
  }),
  codexLine({
    type: "response_item",
    timestamp: "2026-06-01T09:00:07.000Z",
    payload: { type: "function_call_output", call_id: "c1", output: "1 fail" },
  }),
  codexTokenCount(
    "2026-06-01T09:00:08.000Z",
    {
      input_tokens: 74_000,
      cached_input_tokens: 64_000,
      output_tokens: 1_300,
      reasoning_output_tokens: 300,
      total_tokens: 75_300,
    },
    {
      input_tokens: 42_000,
      cached_input_tokens: 39_000,
      output_tokens: 800,
      reasoning_output_tokens: 200,
      total_tokens: 42_800,
    },
  ),
  codexLine({
    type: "compacted",
    timestamp: "2026-06-01T09:00:09.000Z",
    payload: { message: "Summary: the flaky spec is timing-dependent.", replacement_history: [] },
  }),
  codexLine({
    type: "event_msg",
    timestamp: "2026-06-01T09:00:09.500Z",
    payload: { type: "context_compacted" },
  }),
  codexLine({
    type: "response_item",
    timestamp: "2026-06-01T09:00:10.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Continue with the fix" }],
    },
  }),
  codexLine({
    type: "response_item",
    timestamp: "2026-06-01T09:00:11.000Z",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Applying the deterministic clock." }],
    },
  }),
  codexTokenCount(
    "2026-06-01T09:00:12.000Z",
    {
      input_tokens: 86_000,
      cached_input_tokens: 73_000,
      output_tokens: 1_800,
      reasoning_output_tokens: 350,
      total_tokens: 87_800,
    },
    {
      input_tokens: 12_000,
      cached_input_tokens: 9_000,
      output_tokens: 500,
      reasoning_output_tokens: 50,
      total_tokens: 12_500,
    },
  ),
].join("\n");

describe("contextWindowForSession (codex)", () => {
  test("builds the series from token_count readings with an explicit window", () => {
    const db = freshDb();
    upsertSession(
      db,
      parseCodexSession("sess-codex-ctx", CODEX_FIXTURE, new Map()),
      "/cx.jsonl",
      1,
      2,
      "h",
    );
    const sessionId = listSessions(db)[0]?.id ?? 0;

    const timeline = contextWindowForSession(db, sessionId);
    expect(timeline?.tool).toBe("codex");
    expect(timeline?.window_tokens).toBe(258_400);
    expect(timeline?.window_inferred).toBe(false);
    expect(timeline?.points.map((point) => [point.seq, point.context_tokens])).toEqual([
      [2, 30_000],
      [3, 42_000],
      [7, 12_000],
    ]);
    expect(timeline?.points[0]).toMatchObject({
      turn: 1,
      input_tokens: 5_000,
      cache_read_tokens: 25_000,
      cache_creation_tokens: 0,
      output_tokens: 500,
    });
    expect(timeline?.points.map((point) => point.turn)).toEqual([1, 1, 2]);
    expect(timeline?.turn_count).toBe(2);
    expect(timeline?.peak_tokens).toBe(42_000);
    expect(timeline?.compactions).toEqual([
      {
        seq: 5,
        timestamp: "2026-06-01T09:00:09.000Z",
        trigger: null,
        pre_tokens: 42_000,
        post_tokens: 12_000,
      },
    ]);
    db.close();
  });

  test("exposes the codex compacted record as a boundary message with its summary", () => {
    const db = freshDb();
    upsertSession(
      db,
      parseCodexSession("sess-codex-ctx", CODEX_FIXTURE, new Map()),
      "/cx.jsonl",
      1,
      2,
      "h",
    );
    const sessionId = listSessions(db)[0]?.id ?? 0;

    const messages = getSession(db, sessionId)?.messages ?? [];
    const boundary = messages.find((message) => message.is_compact_boundary);
    expect(boundary).toMatchObject({
      seq: 5,
      role: "system",
      compact_trigger: null,
      compact_pre_tokens: null,
    });
    expect(boundary?.blocks[0]?.text).toBe("Summary: the flaky spec is timing-dependent.");
    db.close();
  });

  test("does not apply Claude window inference when Codex omits its explicit window", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO session(id, tool, source_session_id, started_at, is_subagent, raw_meta)
      VALUES (1, 'codex', 'codex-unknown-window', '2026-07-01T00:00:00Z', 0, '{}');
      INSERT INTO message(id, session_id, seq, role, timestamp,
                          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw)
      VALUES (1, 1, 0, 'assistant', '2026-07-01T00:01:00Z',
              10000, 500, 200000, 0, '{}');
    `);

    const timeline = contextWindowForSession(db, 1);
    expect(timeline?.peak_tokens).toBe(210_000);
    expect(timeline?.window_tokens).toBeNull();
    expect(timeline?.window_inferred).toBe(false);
    expect(timeline?.peak_pct).toBeNull();
    db.close();
  });
});

describe("context-window rollups", () => {
  test("materializes window, peak, and compaction count on the session row at ingest", () => {
    const { db, sessionId } = seeded();
    const row = db
      .query(
        `SELECT context_window_tokens, peak_context_tokens, compaction_count
         FROM session WHERE id = ?1`,
      )
      .get(sessionId);
    expect(row).toEqual({
      context_window_tokens: 1_000_000,
      peak_context_tokens: 70_510,
      compaction_count: 1,
    });
    expect(db.query("SELECT turn_count FROM session WHERE id = ?1").get(sessionId)).toEqual({
      turn_count: 2,
    });
    db.close();
  });

  test("backfills rollups and corrected turn counts for pre-v11 sessions", () => {
    const { db, sessionId } = seeded();
    db.exec(
      `UPDATE session
       SET context_window_tokens = NULL, peak_context_tokens = NULL, turn_count = 99`,
    );
    expect(materializeMissingContextWindows(db)).toBe(1);
    const row = db
      .query("SELECT peak_context_tokens, turn_count FROM session WHERE id = ?1")
      .get(sessionId);
    expect(row).toEqual({ peak_context_tokens: 70_510, turn_count: 2 });
    db.close();
  });

  test("summaries expose the rollups", () => {
    const { db } = seeded();
    const summary = listSessions(db)[0];
    expect(summary).toMatchObject({
      context_window_tokens: 1_000_000,
      peak_context_tokens: 70_510,
      compaction_count: 1,
    });
    db.close();
  });
});

describe("getSession per-turn context fields", () => {
  test("exposes seq, context tokens, and compaction flags on MessageView", () => {
    const { db, sessionId } = seeded();
    const detail = getSession(db, sessionId);
    expect(detail).not.toBeNull();
    const messages = detail?.messages ?? [];
    expect(messages).toHaveLength(11);
    expect(messages.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(messages[1]).toMatchObject({
      role: "assistant",
      context_tokens: 40_020,
      output_tokens: 100,
      is_sidechain: false,
      is_compact_boundary: false,
      is_compact_summary: false,
    });
    // Deduped streamed line: usage was nulled by the parser.
    expect(messages[2]).toMatchObject({ role: "assistant", context_tokens: null });
    expect(messages[5]).toMatchObject({
      role: "system",
      is_compact_boundary: true,
      compact_trigger: "auto",
      compact_pre_tokens: 70_510,
      context_tokens: null,
    });
    expect(messages[6]).toMatchObject({ role: "user", is_compact_summary: true });
    expect(messages[10]).toMatchObject({
      role: "assistant",
      is_sidechain: true,
      context_tokens: 500_005,
    });

    db.exec(`
      UPDATE message
      SET input_tokens = 0, cache_read_tokens = 0, cache_creation_tokens = 0
      WHERE session_id = ${sessionId} AND seq = 1
    `);
    expect(getSession(db, sessionId)?.messages[1]?.context_tokens).toBeNull();
    db.close();
  });
});
