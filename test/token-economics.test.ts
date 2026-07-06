import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { parseCursorSession } from "../src/sources/cursor.ts";
import { tokenEconomics, tokenEconomicsForSession } from "../src/token-economics.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-token-economics-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshDb(): Database {
  dbCounter += 1;
  return openDb(join(workDir, `tokens-${dbCounter}.db`));
}

function fixture(tool: "claude" | "codex", name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", tool, name), "utf8");
}

describe("token economics", () => {
  test("allocates generation, context-window footprint, tool calls, and cost by bucket", () => {
    const db = freshDb();
    upsertSession(
      db,
      parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
      "/x/claude.jsonl",
      1,
      2,
      "claude",
    );
    upsertSession(
      db,
      parseCodexSession("sess-enr-codex", fixture("codex", "enriched.jsonl"), new Map()),
      "/x/codex.jsonl",
      1,
      2,
      "codex",
    );

    const economics = tokenEconomics(db);
    expect(economics.buckets.map((row) => row.bucket)).toEqual([
      "planning",
      "communicating",
      "context",
      "code",
    ]);
    expect(economics.totals.generation_tokens).toBeGreaterThan(0);
    expect(economics.totals.context_window_tokens).toBeGreaterThan(
      economics.totals.generation_tokens,
    );
    expect(economics.totals.estimated_cost_usd).toBeGreaterThan(0);
    expect(economics.buckets.find((row) => row.bucket === "context")?.tool_calls).toBeGreaterThan(
      0,
    );
    expect(economics.buckets.find((row) => row.bucket === "code")?.tool_calls).toBeGreaterThan(0);
    expect(economics.buckets.reduce((sum, row) => sum + row.estimated_cost_usd, 0)).toBeCloseTo(
      economics.totals.estimated_cost_usd,
      12,
    );
    db.close();
  });

  test("classifies Codex patch edits as code and read-only shell as context", () => {
    const db = freshDb();
    const sessionId = upsertSession(
      db,
      parseCodexSession("sess-enr-codex", fixture("codex", "enriched.jsonl"), new Map()),
      "/x/codex.jsonl",
      1,
      2,
      "codex",
    );

    const aggregate = tokenEconomics(db);
    expect(aggregate.buckets.find((row) => row.bucket === "code")).toMatchObject({
      tool_calls: 1,
      sessions: 1,
    });
    expect(
      aggregate.buckets.find((row) => row.bucket === "code")?.generation_tokens,
    ).toBeGreaterThan(0);
    expect(aggregate.buckets.find((row) => row.bucket === "context")).toMatchObject({
      tool_calls: 1,
      sessions: 1,
    });

    const scoped = tokenEconomicsForSession(db, sessionId);
    expect(scoped?.buckets.find((row) => row.bucket === "code")).toMatchObject({
      tool_calls: 1,
      sessions: 1,
    });
    expect(scoped?.buckets.find((row) => row.bucket === "context")).toMatchObject({
      tool_calls: 1,
      sessions: 1,
    });
    db.close();
  });

  test("classifies Codex shell build commands as code in aggregate and session economics", () => {
    const db = freshDb();
    const content = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-05-05T09:00:00.000Z",
        payload: { id: "sess-codex-shell", cwd: "/Users/dev/proj" },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-05-05T09:00:01.000Z",
        payload: { cwd: "/Users/dev/proj", model: "gpt-5.4" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-05T09:00:02.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run tests" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-05T09:00:03.000Z",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Run validation." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-05T09:00:04.000Z",
        payload: {
          type: "function_call",
          name: "shell",
          call_id: "call_shell",
          arguments: JSON.stringify({ cmd: "bun test", workdir: "/Users/dev/proj" }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-05T09:00:05.000Z",
        payload: { type: "function_call_output", call_id: "call_shell", output: "231 pass" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-05T09:00:06.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 800,
              cached_input_tokens: 100,
              output_tokens: 80,
              reasoning_output_tokens: 20,
              total_tokens: 880,
            },
          },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-05T09:00:07.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Tests pass." }],
        },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseCodexSession("sess-codex-shell", `${content}\n`, new Map()),
      "/x/codex-shell.jsonl",
      1,
      2,
      "codex-shell",
    );

    const aggregateCode = tokenEconomics(db).buckets.find((row) => row.bucket === "code");
    expect(aggregateCode).toMatchObject({ tool_calls: 1, sessions: 1 });
    expect(aggregateCode?.generation_tokens).toBeGreaterThan(0);

    const scopedCode = tokenEconomicsForSession(db, sessionId)?.buckets.find(
      (row) => row.bucket === "code",
    );
    expect(scopedCode).toMatchObject({ tool_calls: 1, sessions: 1 });
    expect(scopedCode?.generation_tokens).toBeGreaterThan(0);
    db.close();
  });

  test("date filters scope the economics rollup", () => {
    const db = freshDb();
    upsertSession(
      db,
      parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
      "/x/claude.jsonl",
      1,
      2,
      "claude",
    );
    upsertSession(
      db,
      parseCodexSession("sess-enr-codex", fixture("codex", "enriched.jsonl"), new Map()),
      "/x/codex.jsonl",
      1,
      2,
      "codex",
    );

    const scoped = tokenEconomics(db, { from: "2026-05-04", to: "2026-05-04" });
    expect(scoped.buckets.find((row) => row.bucket === "planning")?.generation_tokens).toBe(40);
    expect(scoped.totals.estimated_cost_usd).toBeGreaterThan(0);
    db.close();
  });

  test("session scope includes nested subagents", () => {
    const db = freshDb();
    const rootId = upsertSession(
      db,
      parseClaudeSession("sess-root", fixture("claude", "sample.jsonl")),
      "/x/root.jsonl",
      1,
      2,
      "root",
    );
    const childId = upsertSession(
      db,
      parseCodexSession("sess-child", fixture("codex", "enriched.jsonl"), new Map()),
      "/x/child.jsonl",
      1,
      2,
      "child",
    );
    db.query(
      `UPDATE session
       SET is_subagent = 1, parent_session_id = ?1, spawn_tool_use_id = 'toolu_agent'
       WHERE id = ?2`,
    ).run(rootId, childId);

    const scoped = tokenEconomicsForSession(db, rootId);
    expect(scoped?.totals.estimated_cost_usd).toBeCloseTo(
      tokenEconomics(db).totals.estimated_cost_usd,
      12,
    );
    expect(scoped?.buckets.some((row) => row.sessions > 1)).toBe(true);
    expect(tokenEconomicsForSession(db, 999_999)).toBeNull();
    db.close();
  });

  test("session scope classifies Cursor read-only shell calls using tool input", () => {
    const db = freshDb();
    const content = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        cwd: "/repo",
        model: "composer-2.5",
      }),
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-shell",
        tool_call: {
          shellToolCall: {
            args: { command: "git status" },
            result: { exitCode: 0 },
          },
        },
      }),
      JSON.stringify({
        type: "result",
        usage: { inputTokens: 1000, outputTokens: 100 },
      }),
    ].join("\n");
    const id = upsertSession(
      db,
      parseCursorSession("cursor-shell", content),
      "/x/cursor.jsonl",
      1,
      2,
      "cursor",
    );

    const global = tokenEconomics(db);
    const scoped = tokenEconomicsForSession(db, id);
    expect(global.buckets.find((row) => row.bucket === "context")?.tool_calls).toBe(1);
    expect(global.buckets.find((row) => row.bucket === "code")?.tool_calls).toBe(0);
    expect(scoped?.buckets.find((row) => row.bucket === "context")?.tool_calls).toBe(1);
    expect(scoped?.buckets.find((row) => row.bucket === "code")?.tool_calls).toBe(0);
    db.close();
  });
});
