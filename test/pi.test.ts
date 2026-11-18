import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import { closeDb, openDb } from "../src/db.ts";
import { facets, fileRefs } from "../src/enrich.ts";
import { discover, type IngestConfig, sync } from "../src/ingest.ts";
import { emptyUsage } from "../src/model.ts";
import { parsePiSession, piSessionIdFromStem } from "../src/sources/pi.ts";
import { totals as statsTotals } from "../src/stats.ts";

const workDir = realpathSync(mkdtempSync(join(tmpdir(), "decant-pi-test-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshDir(): string {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", "pi", `${name}.jsonl`), "utf8");
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const HEADER = {
  type: "session",
  version: 3,
  id: "inline-session",
  timestamp: "2026-11-03T08:00:00.000Z",
  cwd: "/decant-fixture/pi-example",
};

function usage(input: number, output: number, cost = 0): Record<string, unknown> {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function lines(...entries: unknown[]): string {
  return entries
    .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
    .join("\n");
}

function assistant(id: string, parentId: string | null, timestamp: string, fields: object): object {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-5",
      usage: usage(0, 0),
      stopReason: "stop",
      timestamp: Date.parse(timestamp),
      ...fields,
    },
  };
}

describe("parsePiSession", () => {
  test("normalizes the sample session", () => {
    const { session, issues } = parsePiSession("fallback", fixture("sample"));
    expect(issues).toEqual([]);
    expect(session).toMatchObject({
      tool: "pi",
      sourceSessionId: "5a1e0000-0000-4000-8000-000000000001",
      cwd: "/decant-fixture/pi-example",
      projectPath: "/decant-fixture/pi-example",
      title: "Greeting rename",
      model: "gpt-5.4",
      reasoningEffort: "mixed",
      reasoningEffortLevels: ["medium", "high"],
      startedAt: "2026-11-01T10:00:00.000Z",
      endedAt: "2026-11-01T10:04:16.000Z",
      reasoningSource: "reported",
      totals: {
        input: 14640,
        output: 815,
        cacheRead: 18600,
        cacheCreation: 3000,
        cacheCreation1h: 1000,
        reasoning: 140,
      },
    });
    expect(session.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "other",
      "user",
      "assistant",
      "tool",
      "assistant",
      "system",
      "other",
      "system",
      "user",
      "assistant",
    ]);
  });

  test("keeps every branch in file order with its tree links", () => {
    const { session } = parsePiSession("fallback", fixture("sample"));
    const branchUser = session.messages.find((message) => message.sourceUuid === "a0000017");
    expect(branchUser?.parentSourceUuid).toBe("a0000016");
    const summary = session.messages.find((message) => message.sourceUuid === "a0000016");
    expect(summary).toMatchObject({
      role: "system",
      parentSourceUuid: "a000000a",
      model: "gpt-5.4",
      usage: { input: 3000, output: 100 },
      blocks: [{ blockType: "text", text: "Tried adding a farewell file on another branch." }],
    });
  });

  test("maps content blocks, tool calls, and results", () => {
    const { session } = parsePiSession("fallback", fixture("sample"));
    const byId = new Map(session.messages.map((message) => [message.sourceUuid, message]));
    expect(byId.get("a0000005")?.blocks).toMatchObject([
      { blockType: "thinking", text: "I should read the file first." },
      {
        blockType: "tool_use",
        toolName: "read",
        toolUseId: "call_read_1",
        toolInput: { path: "hello.txt" },
      },
    ]);
    expect(byId.get("a0000005")?.usage).toEqual({
      input: 1200,
      output: 80,
      cacheRead: 0,
      cacheCreation: 3000,
      cacheCreation1h: 1000,
      reasoning: 20,
    });
    expect(byId.get("a0000009")?.blocks).toMatchObject([
      {
        blockType: "tool_result",
        toolUseId: "call_bash_1",
        toolResult: "example-check: command not found",
        isError: true,
      },
    ]);
    expect(byId.get("a000000c")?.blocks).toMatchObject([
      { blockType: "text", text: "$ cat hello.txt\nhi world" },
    ]);
    expect(byId.get("a000000f")?.blocks).toMatchObject([
      { blockType: "text", text: "Now add a farewell line." },
      { blockType: "image", text: "image/png" },
    ]);
    expect(byId.get("a0000010")?.blocks[0]).toMatchObject({ blockType: "thinking", text: "" });
    expect(byId.get("a0000012")?.stopReason).toBe("aborted");
  });

  test("counts compactions, interruptions, errors, and turns", () => {
    const { session } = parsePiSession("fallback", fixture("sample"));
    expect(facets(session)).toMatchObject({
      turnCount: 3,
      compactionCount: 1,
      interruptionCount: 1,
      errorCount: 1,
      thinkingBlockCount: 2,
    });
  });

  test("records file references from read, edit, and write", () => {
    const { session } = parsePiSession("fallback", fixture("sample"));
    expect(fileRefs(session).map((ref) => [ref.relPath, ref.operation])).toEqual([
      ["hello.txt", "read"],
      ["hello.txt", "edit"],
      ["farewell.txt", "write"],
    ]);
  });

  test("reports malformed lines and unknown entry types and roles without stopping", () => {
    const { session, issues } = parsePiSession(
      "fallback",
      lines(
        HEADER,
        "{not json",
        { type: "future_entry", id: "x1", parentId: null, timestamp: HEADER.timestamp },
        { type: "future_entry", id: "x2", parentId: "x1", timestamp: HEADER.timestamp },
        {
          type: "message",
          id: "x3",
          parentId: "x2",
          timestamp: HEADER.timestamp,
          message: { role: "futureRole", content: "hello", timestamp: 0 },
        },
        { type: "label", id: "x4", parentId: "x3", timestamp: HEADER.timestamp, targetId: "x3" },
      ),
    );
    expect(issues.map((issue) => [issue.code, issue.lineNo, issue.error])).toEqual([
      ["unparsed_line", 2, "record is not valid JSON"],
      ["unknown_record_type", 3, 'unknown record type "future_entry" on 2 line(s); ignored'],
      ["unknown_record_type", 5, 'unknown record type "message:futureRole" on 1 line(s); ignored'],
    ]);
    expect(session.messages).toMatchObject([
      { role: "other", blocks: [{ blockType: "text", text: "hello" }] },
    ]);
  });

  test("flags a tool result with no matching call", () => {
    const { issues } = parsePiSession(
      "fallback",
      lines(HEADER, {
        type: "message",
        id: "r1",
        parentId: null,
        timestamp: "2026-11-03T08:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "missing-call",
          toolName: "read",
          content: [{ type: "text", text: "hello" }],
          isError: false,
          timestamp: 0,
        },
      }),
    );
    expect(issues.map((issue) => issue.code)).toEqual(["orphan_tool_result"]);
  });

  test("counts nested tool usage and lists the calls a tool made", () => {
    const { session } = parsePiSession(
      "fallback",
      lines(
        HEADER,
        assistant("n1", null, "2026-11-03T08:00:02.000Z", {
          content: [{ type: "toolCall", id: "call_run", name: "run_script", arguments: {} }],
          usage: usage(100, 10),
          stopReason: "toolUse",
        }),
        {
          type: "message",
          id: "n2",
          parentId: "n1",
          timestamp: "2026-11-03T08:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call_run",
            toolName: "run_script",
            content: [{ type: "text", text: "done" }],
            usage: usage(50, 5),
            nestedCalls: {
              complete: true,
              calls: [
                { id: "inner-1", name: "read", arguments: { path: "a.txt" }, status: "ok" },
                { id: "inner-2", name: "bash", status: "error" },
              ],
            },
            isError: false,
            timestamp: 0,
          },
        },
      ),
    );
    expect(session.totals).toMatchObject({ input: 150, output: 15 });
    expect(session.messages[0]?.blocks[0]?.innerToolCalls).toEqual([
      {
        toolName: "read",
        toolUseId: "call_run#inner-1",
        toolInput: { path: "a.txt" },
        isError: false,
      },
      { toolName: "bash", toolUseId: "call_run#inner-2", toolInput: undefined, isError: true },
    ]);
  });

  test("names the lowest thinking level none and reads a version 1 session without ids", () => {
    const { session, issues } = parsePiSession(
      "2026-11-03T08-00-00-000Z_legacy-id",
      lines(
        { type: "session", timestamp: HEADER.timestamp, cwd: HEADER.cwd },
        { type: "thinking_level_change", timestamp: HEADER.timestamp, thinkingLevel: "off" },
        {
          type: "message",
          timestamp: "2026-11-03T08:00:01.000Z",
          message: { role: "user", content: "hello", timestamp: 0 },
        },
      ),
    );
    expect(issues).toEqual([]);
    expect(session).toMatchObject({
      sourceSessionId: "2026-11-03T08-00-00-000Z_legacy-id",
      reasoningEffort: "none",
      title: "hello",
    });
    expect(session.messages[0]).toMatchObject({ sourceUuid: null, parentSourceUuid: null });
  });

  test("takes the session id from the file name when the header has none", () => {
    expect(piSessionIdFromStem("2026-11-03T08-00-00-000Z_abc-123")).toBe("abc-123");
    expect(piSessionIdFromStem("no-separator")).toBe("no-separator");
  });

  test("dates a message from its entry, or from the message when the entry has no timestamp", () => {
    const { session } = parsePiSession(
      "fallback",
      lines(HEADER, {
        type: "message",
        id: "t1",
        parentId: null,
        message: { role: "user", content: "hello", timestamp: Date.parse("2026-11-03T08:00:09Z") },
      }),
    );
    expect(session.messages[0]?.timestamp).toBe("2026-11-03T08:00:09.000Z");
  });
});

describe("Pi forks", () => {
  test("a fork keeps the copied transcript but bills only its own requests", () => {
    const { session, issues } = parsePiSession("fallback", fixture("forked"));
    expect(issues).toEqual([]);
    expect(session.messages.map((message) => message.sourceUuid)).toEqual([
      "a0000003",
      "a0000004",
      "a0000005",
      "a0000006",
      "b0000001",
      "b0000002",
      "b0000003",
      "b0000004",
    ]);
    const copiedReply = session.messages.find((message) => message.sourceUuid === "a0000005");
    expect(copiedReply?.usage).toBeNull();
    expect(session.totals).toEqual({
      input: 460,
      output: 62,
      cacheRead: 8400,
      cacheCreation: 0,
      cacheCreation1h: 0,
      reasoning: 0,
    });
    expect(session.rawMeta).toMatchObject({ copiedUsageEntries: 1 });
  });

  test("a session that is not a fork bills every entry, even one dated before its header", () => {
    const { session } = parsePiSession(
      "fallback",
      lines(
        HEADER,
        assistant("e1", null, "2026-11-03T07:59:59.000Z", { usage: usage(100, 10) }),
        assistant("e2", "e1", "2026-11-03T08:00:05.000Z", { usage: usage(200, 20) }),
      ),
    );
    expect(session.totals).toMatchObject({ input: 300, output: 30 });
  });

  test("a fork bills an entry written after the fork", () => {
    const fork = { ...HEADER, parentSession: "/decant-fixture/pi-example/original.jsonl" };
    const { session } = parsePiSession(
      "fallback",
      lines(
        fork,
        assistant("c1", null, "2026-11-03T07:00:00.000Z", { usage: usage(100, 10) }),
        assistant("c2", "c1", "2026-11-03T08:00:05.000Z", { usage: usage(200, 20) }),
      ),
    );
    expect(session.totals).toMatchObject({ input: 200, output: 20 });
  });

  test("a fork bills an entry whose time it cannot read rather than dropping it", () => {
    const fork = { ...HEADER, parentSession: "/decant-fixture/pi-example/original.jsonl" };
    const undated = {
      type: "message",
      id: "d1",
      parentId: null,
      timestamp: "not a time",
      message: { role: "assistant", content: [], model: "claude-sonnet-5", usage: usage(100, 10) },
    };
    const { session } = parsePiSession("fallback", lines(fork, undated));
    expect(session.totals).toMatchObject({ input: 100, output: 10 });
  });
});

describe("Pi ingest", () => {
  const PROJECT = "--decant-fixture-pi-example--";

  function stage(dir: string, names: string[]): IngestConfig & { piDir: string } {
    const piDir = join(dir, "pi", "agent", "sessions");
    for (const name of names) {
      write(join(piDir, PROJECT, `2026-11-01T10-00-00-000Z_${name}.jsonl`), fixture(name));
    }
    return { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex"), piDir };
  }

  function open(dir: string): Database {
    return openDb(join(dir, "archive.db"));
  }

  test("resolves the sessions directory from Pi's own environment variable", () => {
    const env = { DECANT_PI_DIR: "", PI_CODING_AGENT_DIR: "" };
    expect(resolveConfig({ env, homeDir: "/home/example" }).piDir).toBe(
      "/home/example/.pi/agent/sessions",
    );
    expect(
      resolveConfig({ env: { PI_CODING_AGENT_DIR: "~/agents/pi" }, homeDir: "/home/example" })
        .piDir,
    ).toBe("/home/example/agents/pi/sessions");
    expect(
      resolveConfig({
        env: { DECANT_PI_DIR: "/elsewhere", PI_CODING_AGENT_DIR: "/ignored" },
        homeDir: "/home/example",
      }).piDir,
    ).toBe("/elsewhere");
  });

  test("discovers session files and classifies an explicit path as Pi", () => {
    const dir = freshDir();
    const config = stage(dir, ["sample"]);
    const file = join(config.piDir, PROJECT, "2026-11-01T10-00-00-000Z_sample.jsonl");
    expect(discover(config)).toEqual([{ tool: "pi", path: file, archived: false }]);
    expect(discover({ ...config, sourcePaths: [file] })).toEqual([
      { tool: "pi", path: file, archived: false },
    ]);
    const { piDir: _relocated, ...withoutPiDir } = config;
    expect(discover({ ...withoutPiDir, sourcePaths: [file] })).toEqual([
      { tool: "pi", path: file, archived: false },
    ]);
  });

  test("ingests sessions with per-model cost and source filtering", () => {
    const dir = freshDir();
    const config = stage(dir, ["sample", "forked"]);
    const db = open(dir);

    expect(sync(db, config)).toMatchObject({ scanned: 2, ingested: 2, issues: 0, failed: 0 });
    expect(sync(db, config)).toMatchObject({ scanned: 2, ingested: 0, skipped: 2 });

    const sample = db
      .query(
        `SELECT id, tool, model, title, total_input_tokens, total_output_tokens,
                total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens,
                estimated_cost_usd, compaction_count, interruption_count, error_count, turn_count
           FROM session WHERE source_session_id = '5a1e0000-0000-4000-8000-000000000001'`,
      )
      .get() as Record<string, number | string> & { id: number };
    expect(sample).toMatchObject({
      tool: "pi",
      model: "gpt-5.4",
      title: "Greeting rename",
      total_input_tokens: 14640,
      total_output_tokens: 815,
      total_cache_read_tokens: 18600,
      total_cache_creation_tokens: 3000,
      total_reasoning_tokens: 140,
      compaction_count: 1,
      interruption_count: 1,
      error_count: 1,
      turn_count: 3,
    });

    expect(
      db
        .query(
          `SELECT model, requests, input_tokens, output_tokens, cache_read_tokens,
                  cache_creation_tokens, cache_creation_1h_tokens
             FROM session_model_usage WHERE session_id = ?1 ORDER BY model`,
        )
        .all(sample.id),
    ).toEqual([
      {
        model: "claude-sonnet-5",
        requests: 5,
        input_tokens: 1740,
        output_tokens: 210,
        cache_read_tokens: 18600,
        cache_creation_tokens: 3000,
        cache_creation_1h_tokens: 1000,
      },
      {
        model: "gpt-5.4",
        requests: 4,
        input_tokens: 12900,
        output_tokens: 605,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_creation_1h_tokens: 0,
      },
    ]);

    const pricing = defaultPricing();
    const expectedCost =
      estimateCost(
        "claude-sonnet-5",
        {
          ...emptyUsage(),
          input: 1740,
          output: 210,
          cacheRead: 18600,
          cacheCreation: 3000,
          cacheCreation1h: 1000,
        },
        pricing,
      ) + estimateCost("gpt-5.4", { ...emptyUsage(), input: 12900, output: 605 }, pricing);
    expect(expectedCost).toBeGreaterThan(0);
    expect(sample.estimated_cost_usd).toBeCloseTo(expectedCost, 10);

    expect(statsTotals(db, { source: "pi" }).sessions).toBe(2);
    closeDb(db);
  });

  test("uses Pi's recorded cost for a model Decant cannot price", () => {
    const dir = freshDir();
    const piDir = join(dir, "pi", "agent", "sessions");
    write(
      join(piDir, PROJECT, "2026-11-03T08-00-00-000Z_local.jsonl"),
      lines(
        HEADER,
        assistant("l1", null, "2026-11-03T08:00:02.000Z", {
          provider: "example-provider",
          model: "example-local-model",
          usage: usage(1000, 100, 0.0125),
        }),
        {
          type: "usage",
          id: "l2",
          parentId: "l1",
          timestamp: "2026-11-03T08:00:03.000Z",
          kind: "future_kind",
          provider: "example-provider",
          model: "example-local-model",
          usage: usage(10, 0, 0.0005),
        },
      ),
    );
    const db = open(dir);
    sync(db, { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex"), piDir });
    const row = db
      .query("SELECT model, estimated_cost_usd, total_input_tokens FROM session")
      .get() as { model: string; estimated_cost_usd: number; total_input_tokens: number };
    expect(row).toMatchObject({ model: "example-local-model", total_input_tokens: 1010 });
    expect(row.estimated_cost_usd).toBeCloseTo(0.013, 10);
    closeDb(db);
  });
});
