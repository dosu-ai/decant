import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import {
  aggregateEconomicsVectors,
  computeSessionEconomicsVectors,
  economicsVectorMatchesFilter,
  materializeMissingSessionEconomics,
  SESSION_ECONOMICS_FORMAT_VERSION,
  tokenEconomics,
  tokenEconomicsForSession,
} from "../src/token-economics.ts";

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
      "context",
      "planning",
      "code",
      "communicating",
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

  test("splits each bucket into orientation/implementation phases that sum to the whole", () => {
    const db = freshDb();
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
      "/x/claude.jsonl",
      1,
      2,
      "claude",
    );

    const economics = tokenEconomics(db);
    // Every bucket carries a phase split whose parts sum back to the bucket total.
    for (const row of economics.buckets) {
      expect(row.phases).toBeDefined();
      const { orientation, implementation } = row.phases as NonNullable<typeof row.phases>;
      expect(orientation.generation_tokens + implementation.generation_tokens).toBe(
        row.generation_tokens,
      );
      expect(orientation.context_window_tokens + implementation.context_window_tokens).toBe(
        row.context_window_tokens,
      );
      expect(orientation.estimated_cost_usd + implementation.estimated_cost_usd).toBeCloseTo(
        row.estimated_cost_usd,
        12,
      );
      expect(orientation.estimated_cost_usd).toBeGreaterThanOrEqual(0);
      expect(implementation.estimated_cost_usd).toBeGreaterThanOrEqual(0);
    }
    // Totals phase split sums to the run total.
    const phases = economics.totals.phases as NonNullable<typeof economics.totals.phases>;
    expect(phases).toBeDefined();
    expect(
      phases.orientation.estimated_cost_usd + phases.implementation.estimated_cost_usd,
    ).toBeCloseTo(economics.totals.estimated_cost_usd, 12);
    // The fixture reads before it edits, so some context is gathered in orientation.
    const context = economics.buckets.find((row) => row.bucket === "context");
    expect(context?.phases?.orientation.context_window_tokens).toBeGreaterThan(0);

    // The per-session path uses the same ordered allocator while retaining its
    // billed-input Window total.
    const scoped = tokenEconomicsForSession(db, sessionId);
    expect(scoped?.totals.generation_tokens).toBe(economics.totals.generation_tokens);
    const billedInput = (
      db
        .query(
          `SELECT total_input_tokens + total_cache_read_tokens + total_cache_creation_tokens AS tokens
           FROM session WHERE id = ?1`,
        )
        .get(sessionId) as { tokens: number }
    ).tokens;
    expect(
      Math.abs(
        (scoped?.totals.context_window_tokens ?? 0) -
          economics.totals.context_window_tokens -
          billedInput,
      ),
    ).toBeLessThanOrEqual(2);
    expect(scoped?.totals.estimated_cost_usd).toBe(economics.totals.estimated_cost_usd);
    expect(scoped?.buckets.every((row) => row.phases !== undefined)).toBe(true);
    db.close();
  });

  test("attributes wall-clock time to activity buckets and phases", () => {
    const db = freshDb();
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
      "/x/claude.jsonl",
      1,
      2,
      "claude",
    );

    const economics = tokenEconomics(db);
    // This synthetic fixture has one blockless system message. The four agent
    // buckets plus explicit user wait approximately reconcile to the broader
    // active_seconds chain, within rounding.
    const activeSeconds = (
      db.query("SELECT active_seconds FROM session WHERE id = ?1").get(sessionId) as {
        active_seconds: number;
      }
    ).active_seconds;
    expect(activeSeconds).toBeGreaterThan(0);
    expect(economics.totals.active_ms).toBeGreaterThan(0);
    expect(economics.totals.waiting_on_user_ms).toBe(330_000);
    expect(economics.totals.attributed_ms).toBeCloseTo(activeSeconds * 1000, -2);
    // The fixture spends 30s generating mutating tool calls and 30s executing
    // an Edit result; both portions belong to code.
    expect(economics.buckets.find((row) => row.bucket === "code")?.active_ms).toBe(60_000);

    // Buckets' time sums to the total, and each bucket's phase split sums back
    // to the bucket (rounding can drift the two rounded halves by <=1ms).
    const bucketSum = economics.buckets.reduce((sum, row) => sum + row.active_ms, 0);
    expect(bucketSum).toBe(economics.totals.active_ms);
    for (const row of economics.buckets) {
      const { orientation, implementation } = row.phases as NonNullable<typeof row.phases>;
      expect(orientation.active_ms).toBeGreaterThanOrEqual(0);
      expect(implementation.active_ms).toBeGreaterThanOrEqual(0);
      expect(
        Math.abs(orientation.active_ms + implementation.active_ms - row.active_ms),
      ).toBeLessThanOrEqual(1);
    }
    const phases = economics.totals.phases as NonNullable<typeof economics.totals.phases>;
    expect(phases.orientation.active_ms + phases.implementation.active_ms).toBe(
      economics.totals.active_ms,
    );
    // The fixture edits only after orienting, so edit time lands in implementation.
    expect(
      economics.buckets.find((row) => row.bucket === "code")?.phases?.orientation.active_ms,
    ).toBe(0);
    // The scoped result uses the same block-level allocation for generated
    // messages and time, while allocating the full billed input window.
    const scoped = tokenEconomicsForSession(db, sessionId);
    expect(scoped?.totals.active_ms).toBe(economics.totals.active_ms);
    expect(scoped?.totals.waiting_on_user_ms).toBe(economics.totals.waiting_on_user_ms);
    expect(scoped?.totals.attributed_ms).toBe(economics.totals.attributed_ms);
    expect(scoped?.buckets.find((row) => row.bucket === "code")?.active_ms).toBe(60_000);
    const communicating = scoped?.buckets.find((row) => row.bucket === "communicating");
    expect(communicating?.active_ms).toBeGreaterThan(0);
    expect(communicating?.generation_tokens).toBeGreaterThan(0);
    expect(communicating?.estimated_cost_usd).toBeGreaterThan(0);
    expect(communicating?.sessions).toBe(1);
    db.close();
  });

  test("persists versioned vectors and serves economics without scanning transcript rows", () => {
    const db = freshDb();
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
      "/x/claude.jsonl",
      1,
      2,
      "claude",
    );
    const expected = tokenEconomicsForSession(db, sessionId);
    const expectedAggregate = tokenEconomics(db);
    const stored = db
      .query(
        "SELECT format_version, json_valid(vector_json) AS valid FROM session_economics WHERE session_id = ?1",
      )
      .get(sessionId) as { format_version: number; valid: number };
    expect(stored).toEqual({ format_version: SESSION_ECONOMICS_FORMAT_VERSION, valid: 1 });

    db.exec(`
      DELETE FROM file_ref;
      DELETE FROM tool_call;
      DELETE FROM block;
      DELETE FROM message;
    `);
    expect(tokenEconomicsForSession(db, sessionId)).toEqual(expected);
    expect(tokenEconomics(db)).toEqual(expectedAggregate);
    db.close();
  });

  test("server cache warmup never falls back to an uncached transcript scan", () => {
    const db = freshDb();
    upsertSession(
      db,
      parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
      "/x/claude.jsonl",
      1,
      2,
      "claude",
    );
    db.exec("DELETE FROM session_economics");

    expect(computeSessionEconomicsVectors(db)).toEqual([]);
    expect(tokenEconomics(db).totals.generation_tokens).toBeGreaterThan(0);
    db.close();
  });

  test("backfills stale, malformed, or structurally incomplete vectors", () => {
    const db = freshDb();
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
      "/x/claude.jsonl",
      1,
      2,
      "claude",
    );
    db.query("UPDATE session_economics SET format_version = ?1 WHERE session_id = ?2").run(
      SESSION_ECONOMICS_FORMAT_VERSION - 1,
      sessionId,
    );

    expect(materializeMissingSessionEconomics(db)).toBe(1);
    expect(
      (
        db
          .query("SELECT format_version FROM session_economics WHERE session_id = ?1")
          .get(sessionId) as { format_version: number }
      ).format_version,
    ).toBe(SESSION_ECONOMICS_FORMAT_VERSION);
    expect(materializeMissingSessionEconomics(db)).toBe(0);

    db.query("UPDATE session_economics SET vector_json = '{' WHERE session_id = ?1").run(sessionId);
    expect(materializeMissingSessionEconomics(db)).toBe(1);
    expect(
      (
        db
          .query(
            "SELECT json_valid(vector_json) AS valid FROM session_economics WHERE session_id = ?1",
          )
          .get(sessionId) as { valid: number }
      ).valid,
    ).toBe(1);

    db.query(
      "UPDATE session_economics SET vector_json = json_remove(vector_json, '$.billed_input_tokens') WHERE session_id = ?1",
    ).run(sessionId);
    expect(materializeMissingSessionEconomics(db)).toBe(1);
    expect(tokenEconomicsForSession(db, sessionId)).not.toBeNull();
    db.close();
  });

  test("caps waiting on the user and keeps it out of agent activity", () => {
    const db = freshDb();
    // A blockless system message splits the raw 3600s gap for active_seconds,
    // while block-based attribution sees one gap capped at 300s.
    const content = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-06T09:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: "Ready for your response." }],
        },
      }),
      JSON.stringify({
        type: "system",
        timestamp: "2026-05-06T09:04:10.000Z",
        subtype: "compact_boundary",
        content: "Conversation compacted",
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-06T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Continue." }] },
      }),
    ].join("\n");
    upsertSession(
      db,
      parseClaudeSession("sess-idle", `${content}\n`),
      "/x/idle.jsonl",
      1,
      2,
      "idle",
    );

    const economics = tokenEconomics(db);
    expect(economics.totals.active_ms).toBe(0);
    expect(economics.totals.waiting_on_user_ms).toBe(300_000);
    expect(economics.totals.attributed_ms).toBe(300_000);
    const activeSeconds = (
      db.query("SELECT active_seconds FROM session").get() as { active_seconds: number }
    ).active_seconds;
    expect(economics.totals.attributed_ms).toBeLessThan(activeSeconds * 1000);
    db.close();
  });

  test("counts an agent run when it contributes only wall-clock activity", () => {
    const db = freshDb();
    const content = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-06T09:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "Starting." }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-06T09:00:10.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "Done." }],
        },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-time-only", `${content}\n`),
      "/x/time-only.jsonl",
      1,
      2,
      "time-only",
    );

    const economics = tokenEconomicsForSession(db, sessionId);
    expect(economics?.buckets.find((row) => row.bucket === "communicating")).toMatchObject({
      active_ms: 10_000,
      generation_tokens: 0,
      sessions: 1,
    });
    db.close();
  });

  test("weights mixed tool results and user text by their actual bytes", () => {
    const db = freshDb();
    const content = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-06T09:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-7",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            {
              type: "tool_use",
              id: "toolu_edit",
              name: "Edit",
              input: { file_path: "/x/a.ts", old_string: "a", new_string: "b" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-06T09:00:10.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_edit", content: "123456789" },
            { type: "text", text: "x" },
          ],
        },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-mixed-result", `${content}\n`),
      "/x/mixed-result.jsonl",
      1,
      2,
      "mixed-result",
    );

    const economics = tokenEconomics(db);
    expect(economics.buckets.find((row) => row.bucket === "code")?.active_ms).toBe(9_000);
    expect(economics.totals.waiting_on_user_ms).toBe(1_000);
    expect(economics.totals.attributed_ms).toBe(10_000);

    const scoped = tokenEconomicsForSession(db, sessionId);
    expect(scoped?.buckets.find((row) => row.bucket === "code")?.active_ms).toBe(9_000);
    expect(scoped?.totals.waiting_on_user_ms).toBe(1_000);
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
    expect(aggregate.buckets.find((row) => row.bucket === "code")?.active_ms).toBe(3_000);
    expect(aggregate.buckets.find((row) => row.bucket === "context")?.active_ms).toBe(2_000);

    const scoped = tokenEconomicsForSession(db, sessionId);
    expect(scoped?.buckets.find((row) => row.bucket === "code")).toMatchObject({
      tool_calls: 1,
      sessions: 1,
    });
    expect(scoped?.buckets.find((row) => row.bucket === "context")).toMatchObject({
      tool_calls: 1,
      sessions: 1,
    });
    expect(scoped?.buckets.find((row) => row.bucket === "code")?.active_ms).toBe(3_000);
    expect(scoped?.buckets.find((row) => row.bucket === "context")?.active_ms).toBe(2_000);
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
            last_token_usage: {
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
    // Persisting Codex's last_token_usage powers context-window tooltips, but
    // must not move its reported reasoning output out of planning economics.
    expect(
      tokenEconomics(db).buckets.find((row) => row.bucket === "planning")?.generation_tokens,
    ).toBe(20);
    // One second generated the call and one second executed it. The latter is
    // resolved through tool_call.result_block_id rather than defaulting to context.
    expect(aggregateCode?.active_ms).toBe(2_000);

    const scopedEconomics = tokenEconomicsForSession(db, sessionId);
    const scopedCode = scopedEconomics?.buckets.find((row) => row.bucket === "code");
    expect(scopedCode).toMatchObject({ tool_calls: 1, sessions: 1 });
    expect(scopedCode?.generation_tokens).toBeGreaterThan(0);
    expect(scopedCode?.active_ms).toBe(2_000);

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

  test("precomputed vectors reproduce tokenEconomics for any date filter", () => {
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
    // Split the sessions across days, and leave one session dateless to pin
    // the SQL NULL semantics: excluded whenever a bound is set.
    db.exec(`
      UPDATE session SET started_at = '2026-01-01T09:00:00Z' WHERE id = 1;
      UPDATE session SET started_at = NULL WHERE id = 2;
    `);

    const vectors = computeSessionEconomicsVectors(db);
    expect(vectors).toHaveLength(2);
    const filters = [
      undefined,
      { from: "2026-01-01", to: "2026-01-01" },
      { from: "2026-01-02", to: null },
      { from: null, to: "2025-12-31" },
    ] as const;
    for (const filter of filters) {
      const fromVectors = aggregateEconomicsVectors(
        vectors.filter((vector) => economicsVectorMatchesFilter(vector, filter)),
      );
      expect(fromVectors).toEqual(tokenEconomics(db, filter));
    }

    const bounded = vectors.filter((vector) =>
      economicsVectorMatchesFilter(vector, { from: "2026-01-01", to: null }),
    );
    expect(bounded.map((vector) => vector.id)).toEqual([1]);
    expect(aggregateEconomicsVectors([])).toEqual(tokenEconomics(db, { from: "2030-01-01" }));
    db.close();
  });
});
