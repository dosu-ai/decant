import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { refreshDerivedMetadata } from "../src/derived.ts";
import { upsertSession } from "../src/ingest.ts";
import { setSessionUserState } from "../src/session-user-state.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import {
  aggregateEconomicsVectors,
  computeSessionEconomicsVectors,
  economicsVectorMatchesFilter,
  materializeMissingSessionEconomics,
  refreshSessionCosts,
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

  test("attributes Codex exec programs to their inner tools, not all to context", () => {
    const at = (s: number) => `2026-09-29T20:00:${String(s).padStart(2, "0")}.000Z`;
    const exec = (id: string, s: number, program: string) =>
      JSON.stringify({
        type: "response_item",
        timestamp: at(s),
        payload: { type: "custom_tool_call", name: "exec", call_id: id, input: program },
      });
    const output = (id: string, s: number, text: string) =>
      JSON.stringify({
        type: "response_item",
        timestamp: at(s),
        payload: { type: "custom_tool_call_output", call_id: id, output: text },
      });
    const lines = [
      '{"type":"session_meta","timestamp":"2026-09-29T20:00:00.000Z","payload":{"id":"sess-codex-exec","cwd":"/w","originator":"codex_exec","cli_version":"0.159.0","source":"exec","model_provider":"openai"}}',
      '{"type":"turn_context","timestamp":"2026-09-29T20:00:01.000Z","payload":{"cwd":"/w","model":"gpt-6.1-sol","effort":"low"}}',
      '{"type":"response_item","timestamp":"2026-09-29T20:00:02.000Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix add() in calc.py"}]}}',
      exec("c1", 3, 'text(await tools.exec_command({cmd:"cat calc.py"}));'),
      output("c1", 4, "def add(a, b):\n    return a - b\n"),
      exec(
        "c2",
        10,
        'const patch = "*** Begin Patch\\n*** Update File: calc.py\\n@@\\n-    return a - b\\n+    return a + b\\n*** End Patch";\ntext(await tools.apply_patch(patch));',
      ),
      output("c2", 11, "Done. 1 file changed."),
      exec("c3", 14, 'text(await tools.exec_command({cmd:"python3 -m pytest -q"}));'),
      output("c3", 18, "1 passed"),
      '{"type":"event_msg","timestamp":"2026-09-29T20:00:19.000Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9000,"cached_input_tokens":6000,"output_tokens":300,"reasoning_output_tokens":0,"total_tokens":9300}}}}',
      '{"type":"response_item","timestamp":"2026-09-29T20:00:20.000Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixed add() and the test passes."}]}}',
    ];
    const db = freshDb();
    const sessionId = upsertSession(
      db,
      parseCodexSession("sess-codex-exec", `${lines.join("\n")}\n`, new Map()),
      "/x/exec.jsonl",
      1,
      2,
      "codex",
    );
    const economics = tokenEconomicsForSession(db, sessionId);
    const bucket = (name: string) => economics?.buckets.find((row) => row.bucket === name);
    expect(bucket("context")?.tool_calls).toBe(1);
    expect(bucket("code")?.tool_calls).toBe(2);
    expect(bucket("code")?.active_ms).toBeGreaterThan(0);
    // The patch is the first edit, so the session is not all orientation.
    expect(bucket("code")?.phases?.implementation.estimated_cost_usd).toBeGreaterThan(0);
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
    expect(scoped?.totals.context_window_tokens).toBe(
      economics.totals.context_window_tokens + billedInput,
    );
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
    // to the bucket.
    const bucketSum = economics.buckets.reduce((sum, row) => sum + row.active_ms, 0);
    expect(bucketSum).toBe(economics.totals.active_ms);
    for (const row of economics.buckets) {
      const { orientation, implementation } = row.phases as NonNullable<typeof row.phases>;
      expect(orientation.active_ms).toBeGreaterThanOrEqual(0);
      expect(implementation.active_ms).toBeGreaterThanOrEqual(0);
      expect(orientation.active_ms + implementation.active_ms).toBe(row.active_ms);
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

  test("keeps output with no visible block in generation and reconciles to the session cost", () => {
    const db = freshDb();
    const content = [
      '{"type":"user","uuid":"u1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"user","content":"hi"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"2026-05-01T10:00:05.000Z","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":100000,"output_tokens":20000}}}',
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-blockless-output", `${content}\n`),
      "/x/blockless.jsonl",
      1,
      2,
    );
    const stored = (
      db.query("SELECT estimated_cost_usd FROM session WHERE id = ?1").get(sessionId) as {
        estimated_cost_usd: number;
      }
    ).estimated_cost_usd;
    expect(stored).toBeCloseTo(0.6, 12);
    for (const economics of [tokenEconomics(db), tokenEconomicsForSession(db, sessionId)]) {
      expect(economics?.totals.estimated_cost_usd).toBeCloseTo(stored, 12);
      expect(economics?.totals.generation_tokens).toBe(20_000);
      const communicating = economics?.buckets.find((row) => row.bucket === "communicating");
      expect(communicating?.generation_tokens).toBe(20_000);
      expect(communicating?.phases?.orientation.generation_tokens).toBe(20_000);
    }
    db.close();
  });

  test("splits a response journaled as one record per block across all of its blocks", () => {
    const db = freshDb();
    // Claude Code writes thinking, text, and the tool call as separate records that
    // share the API message id; the 1000 output tokens cover all three.
    const usage = '"usage":{"input_tokens":10,"output_tokens":1000}';
    const content = [
      '{"type":"user","uuid":"u1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"user","content":"fix it"}}',
      `{"type":"assistant","uuid":"a1","parentUuid":"u1","requestId":"req1","timestamp":"2026-05-01T10:00:05.000Z","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"thinking","thinking":"","signature":"sig"}],${usage}}}`,
      `{"type":"assistant","uuid":"a2","parentUuid":"a1","requestId":"req1","timestamp":"2026-05-01T10:00:06.000Z","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"${"x".repeat(400)}"}],${usage}}}`,
      `{"type":"assistant","uuid":"a3","parentUuid":"a2","requestId":"req1","timestamp":"2026-05-01T10:00:07.000Z","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"a.ts","old_string":"${"a".repeat(200)}","new_string":"b"}}],${usage}}}`,
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("sess-split-response", `${content}\n`),
      "/x/split.jsonl",
      1,
      2,
    );
    const economics = tokenEconomicsForSession(db, sessionId);
    const gen = (bucket: string) =>
      economics?.buckets.find((row) => row.bucket === bucket)?.generation_tokens ?? 0;
    expect(economics?.totals.generation_tokens).toBe(1000);
    // The text and the edit keep their visible size; only the rest is planning.
    expect(gen("communicating")).toBeCloseTo(100, 6);
    expect(gen("code")).toBeGreaterThan(50);
    expect(gen("planning")).toBeCloseTo(1000 - gen("communicating") - gen("code"), 6);
    expect(gen("planning")).toBeLessThan(900);
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
    refreshDerivedMetadata(db);
    expect(
      aggregateEconomicsVectors(computeSessionEconomicsVectors(db)).totals.generation_tokens,
    ).toBeGreaterThan(0);
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

    db.query(
      "UPDATE session_economics SET vector_json = json_remove(vector_json, '$.buckets.context.generation') WHERE session_id = ?1",
    ).run(sessionId);
    expect(materializeMissingSessionEconomics(db)).toBe(1);
    const repaired = db
      .query("SELECT vector_json FROM session_economics WHERE session_id = ?1")
      .get(sessionId) as { vector_json: string };
    expect(
      (
        JSON.parse(repaired.vector_json) as {
          buckets: { context: { generation: number } };
        }
      ).buckets.context.generation,
    ).toBeNumber();
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

  test("charges messages from other agents to context and skips harness records", () => {
    const at = (s: number) => `2026-09-29T21:00:${String(s).padStart(2, "0")}.000Z`;
    const report = "Message Type: MESSAGE\nSender: /root/reviewer\nPayload:\nNo issues found.";
    const toolOutput = "spawned /root/reviewer";
    const lines = [
      `{"type":"session_meta","timestamp":"${at(0)}","payload":{"id":"sess-codex-agents","cwd":"/w","originator":"codex_exec","cli_version":"0.159.0","source":"exec","model_provider":"openai"}}`,
      `{"type":"turn_context","timestamp":"${at(0)}","payload":{"cwd":"/w","model":"gpt-6.1-sol","effort":"low"}}`,
      `{"type":"response_item","timestamp":"${at(0)}","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Review the branch"}]}}`,
      JSON.stringify({
        type: "response_item",
        timestamp: at(2),
        payload: { type: "function_call", name: "spawn_agent", call_id: "s1", arguments: "{}" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: at(3),
        payload: { type: "function_call_output", call_id: "s1", output: toolOutput },
      }),
      // A record type the parser keeps as role "other" but the model never sees.
      JSON.stringify({
        type: "response_item",
        timestamp: at(30),
        payload: { type: "ghost_snapshot", ghost_commit: { id: "abc" } },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: at(63),
        payload: {
          type: "agent_message",
          author: "/root/reviewer",
          recipient: "/root",
          internal_chat_message_metadata_passthrough: { route: "x".repeat(400) },
          content: [{ type: "input_text", text: report }],
        },
      }),
      `{"type":"event_msg","timestamp":"${at(64)}","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":4000,"cached_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":0,"total_tokens":4040}}}}`,
      `{"type":"response_item","timestamp":"${at(65)}","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The reviewer found no issues."}]}}`,
    ];
    const db = freshDb();
    upsertSession(
      db,
      parseCodexSession("sess-codex-agents", `${lines.join("\n")}\n`, new Map()),
      "/x/agents.jsonl",
      1,
      2,
      "codex",
    );
    // Archive totals, which keep window volume in content bytes.
    const economics = tokenEconomics(db);
    const bucket = (name: string) => economics?.buckets.find((row) => row.bucket === name);
    // The 60s wait for the reviewer's report is delegated work, read as input;
    // the harness record in the middle neither takes time nor splits the gap.
    expect(bucket("context")?.active_ms).toBe(63_000);
    expect(bucket("communicating")?.active_ms).toBe(2_000);
    expect(economics?.totals.waiting_on_user_ms).toBe(0);
    // The report's text, not its routing metadata, joins the tool output as input.
    const context = bucket("context");
    expect((context?.context_window_tokens ?? 0) - (context?.generation_tokens ?? 0)).toBeCloseTo(
      (toolOutput.length + report.length) / 4,
      9,
    );
    db.close();
  });

  test("charges time before an attached image to the user's turn", () => {
    const content = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-29T09:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5-5",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: "Send me a screenshot." }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-09-29T09:02:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Here." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "A".repeat(4000) },
            },
          ],
        },
      }),
    ].join("\n");
    const db = freshDb();
    upsertSession(
      db,
      parseClaudeSession("sess-image", `${content}\n`),
      "/x/image.jsonl",
      1,
      2,
      "img",
    );
    const economics = tokenEconomics(db);
    expect(economics.totals.waiting_on_user_ms).toBe(120_000);
    expect(economics.totals.active_ms).toBe(0);
    db.close();
  });

  test("charges the wait for a question's answer to the user, not the agent", () => {
    const line = (value: object) => JSON.stringify(value);
    const content = [
      line({
        type: "user",
        timestamp: "2026-09-29T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Plan the migration." }] },
      }),
      line({
        type: "assistant",
        timestamp: "2026-09-29T10:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5-5",
          usage: { input_tokens: 10, output_tokens: 20 },
          content: [
            {
              type: "tool_use",
              id: "q1",
              name: "AskUserQuestion",
              input: { questions: [{ question: "Which database?" }] },
            },
          ],
        },
      }),
      line({
        type: "user",
        timestamp: "2026-09-29T10:01:32.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "q1", content: "Postgres" }],
        },
      }),
      line({
        type: "assistant",
        timestamp: "2026-09-29T10:01:35.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5-5",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: "Going with Postgres." }],
        },
      }),
    ].join("\n");
    const db = freshDb();
    upsertSession(db, parseClaudeSession("sess-ask", `${content}\n`), "/x/ask.jsonl", 1, 2, "ask");
    const economics = tokenEconomics(db);
    // 90s from the question to the answer is the user deciding.
    expect(economics.totals.waiting_on_user_ms).toBe(90_000);
    // The question (2s) and the reply (3s) are the agent communicating.
    expect(economics.totals.active_ms).toBe(5_000);
    expect(economics.buckets.find((row) => row.bucket === "communicating")?.active_ms).toBe(5_000);
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

  test("archive-wide economics excludes archived trees while exact session reads remain available", () => {
    const db = freshDb();
    const rootId = upsertSession(
      db,
      parseClaudeSession("economics-archive-root", fixture("claude", "enriched.jsonl")),
      "/x/economics-archive-root.jsonl",
      1,
      2,
      "archive-root",
    );
    const childId = upsertSession(
      db,
      parseCodexSession("economics-archive-child", fixture("codex", "enriched.jsonl"), new Map()),
      "/x/economics-archive-child.jsonl",
      1,
      2,
      "archive-child",
    );
    const visibleId = upsertSession(
      db,
      parseClaudeSession("economics-visible", fixture("claude", "enriched.jsonl")),
      "/x/economics-visible.jsonl",
      1,
      2,
      "visible",
    );
    db.query(
      `UPDATE session
       SET is_subagent = 1, parent_session_id = ?1
       WHERE id = ?2`,
    ).run(rootId, childId);

    const exactBeforeArchive = tokenEconomicsForSession(db, rootId);
    const aggregateBeforeArchive = tokenEconomics(db);
    expect(computeSessionEconomicsVectors(db).map((vector) => vector.id)).toEqual([
      rootId,
      childId,
      visibleId,
    ]);

    expect(setSessionUserState(db, rootId, "archived")).toBe(true);

    const visibleVectors = computeSessionEconomicsVectors(db);
    expect(visibleVectors.map((vector) => vector.id)).toEqual([visibleId]);
    expect(tokenEconomics(db)).toEqual(aggregateEconomicsVectors(visibleVectors));
    expect(tokenEconomics(db).totals.estimated_cost_usd).toBeLessThan(
      aggregateBeforeArchive.totals.estimated_cost_usd,
    );
    expect(tokenEconomicsForSession(db, rootId)).toEqual(exactBeforeArchive);
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

describe("refreshSessionCosts", () => {
  function seeded(): Database {
    const db = freshDb();
    upsertSession(
      db,
      parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
      "/x/claude.jsonl",
      1,
      2,
    );
    return db;
  }

  test("takes no write lock when every cost is current", () => {
    const db = seeded();
    const path = (db.query("PRAGMA database_list").get() as { file: string }).file;
    const writer = new Database(path, { strict: true });
    writer.exec("BEGIN IMMEDIATE;");
    try {
      db.exec("PRAGMA busy_timeout = 0;");
      expect(refreshSessionCosts(db)).toBe(0);
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
    db.close();
  });

  test("repairs a stale session total and its cached activity cost together", () => {
    const db = seeded();
    const before = db
      .query(
        "SELECT s.estimated_cost_usd AS cost, e.vector_json FROM session s JOIN session_economics e ON e.session_id = s.id",
      )
      .get() as { cost: number; vector_json: string };
    const vector = JSON.parse(before.vector_json) as { input_cost: number; output_cost: number };
    expect(before.cost).toBeGreaterThan(0);
    db.query("UPDATE session SET estimated_cost_usd = 0").run();
    db.query("UPDATE session_economics SET vector_json = ?1").run(
      JSON.stringify({ ...vector, input_cost: 0, output_cost: 0 }),
    );

    expect(refreshSessionCosts(db)).toBe(1);

    const after = db
      .query(
        "SELECT s.estimated_cost_usd AS cost, e.vector_json FROM session s JOIN session_economics e ON e.session_id = s.id",
      )
      .get() as { cost: number; vector_json: string };
    expect(after.cost).toBe(before.cost);
    expect(JSON.parse(after.vector_json)).toMatchObject({
      input_cost: vector.input_cost,
      output_cost: vector.output_cost,
    });
    expect(refreshSessionCosts(db)).toBe(0);
    db.close();
  });
});

describe("archive aggregation", () => {
  const part = (generation: number, context_window: number) => ({
    generation,
    context_window,
    tool_calls: 1,
    touched: generation + context_window > 0,
    generation_orientation: 0,
    context_window_orientation: 0,
    active_ms: 1000,
    active_ms_orientation: 0,
  });
  const vector = (id: number, cost: number, context: number, code: number) => ({
    id,
    started_at: "2026-09-29T00:00:00Z",
    input_cost: cost,
    output_cost: 0,
    billed_input_tokens: 0,
    waiting_on_user_ms: 0,
    buckets: {
      context: part(0, context),
      planning: part(0, 0),
      code: part(0, code),
      communicating: part(0, 0),
    },
  });

  test("splits each session's cost by its own activity before summing", () => {
    // A $9 session that is all context and a $1 session that is all code, with
    // the cheap one carrying most of the window volume.
    const expensive = vector(1, 9, 100, 0);
    const cheap = vector(2, 1, 0, 900);
    const total = aggregateEconomicsVectors([expensive, cheap]);
    const cost = Object.fromEntries(total.buckets.map((b) => [b.bucket, b.estimated_cost_usd]));
    expect(cost.context).toBeCloseTo(9, 10);
    expect(cost.code).toBeCloseTo(1, 10);
    expect(total.totals.estimated_cost_usd).toBeCloseTo(10, 10);
    const alone = [expensive, cheap].map((v) => aggregateEconomicsVectors([v]));
    for (const bucket of ["context", "planning", "code", "communicating"] as const) {
      const summed = alone.reduce(
        (sum, e) => sum + (e.buckets.find((b) => b.bucket === bucket)?.estimated_cost_usd ?? 0),
        0,
      );
      expect(cost[bucket]).toBeCloseTo(summed, 10);
    }
  });

  test("charges cost with no activity weight so buckets reconcile to the session", () => {
    // Input and output priced, but nothing recorded to weight them by.
    const idle = { ...vector(1, 0.3, 0, 0), output_cost: 0.3 };
    for (const bucket of ["context", "planning", "code", "communicating"] as const) {
      idle.buckets[bucket] = { ...part(0, 0), tool_calls: 0, active_ms: 0 };
    }
    const economics = aggregateEconomicsVectors([idle]);
    const row = (name: string) => economics.buckets.find((b) => b.bucket === name);
    expect(economics.totals.estimated_cost_usd).toBeCloseTo(0.6, 12);
    expect(row("context")?.estimated_cost_usd).toBeCloseTo(0.3, 12);
    expect(row("communicating")?.estimated_cost_usd).toBeCloseTo(0.3, 12);
    expect(row("context")?.sessions).toBe(1);
    // With no recorded edit, the whole run is orientation.
    expect(economics.totals.phases?.orientation.estimated_cost_usd).toBeCloseTo(0.6, 12);
    expect(economics.totals.phases?.implementation.estimated_cost_usd).toBe(0);

    // Output with no generation follows the window's phase split.
    const windowOnly = vector(2, 0, 30, 0);
    windowOnly.output_cost = 0.4;
    windowOnly.buckets.context.context_window_orientation = 10;
    const split = aggregateEconomicsVectors([windowOnly]);
    const communicating = split.buckets.find((b) => b.bucket === "communicating");
    expect(communicating?.estimated_cost_usd).toBeCloseTo(0.4, 12);
    expect(communicating?.phases?.orientation.estimated_cost_usd).toBeCloseTo(0.4 / 3, 12);
    expect(split.totals.estimated_cost_usd).toBeCloseTo(0.4, 12);
  });

  test("rounds each total once and apportions it to rows and phases", () => {
    const even = (amount: number, orientation: number) => ({
      generation: amount,
      context_window: amount,
      tool_calls: 0,
      touched: true,
      generation_orientation: orientation,
      context_window_orientation: orientation,
      active_ms: amount,
      active_ms_orientation: orientation,
    });
    const halves = vector(1, 1, 0, 0);
    for (const bucket of ["context", "planning", "code", "communicating"] as const) {
      halves.buckets[bucket] = even(1.5, 0.75);
    }
    const economics = aggregateEconomicsVectors([halves]);
    const { totals } = economics;
    // Four rows of 1.5 are 6 in all; rounding each row first would report 8.
    expect(totals.generation_tokens).toBe(6);
    // Window is context volume plus the generation folded into it: 4 x 3.
    expect(totals.context_window_tokens).toBe(12);
    expect(totals.active_ms).toBe(6);
    for (const key of ["generation_tokens", "context_window_tokens", "active_ms"] as const) {
      expect(economics.buckets.reduce((sum, row) => sum + row[key], 0)).toBe(totals[key]);
      for (const row of economics.buckets) {
        const phases = row.phases as NonNullable<typeof row.phases>;
        expect(phases.orientation[key] + phases.implementation[key]).toBe(row[key]);
      }
      const phases = totals.phases as NonNullable<typeof totals.phases>;
      expect(phases.orientation[key] + phases.implementation[key]).toBe(totals[key]);
    }
    expect(economics.buckets.map((row) => row.generation_tokens)).toEqual([2, 2, 1, 1]);

    // One token split evenly across phases shows as one token, not one per phase.
    const single = vector(2, 1, 0, 0);
    single.buckets.context = even(1, 0.5);
    const context = aggregateEconomicsVectors([single]).buckets.find(
      (row) => row.bucket === "context",
    );
    expect(context?.generation_tokens).toBe(1);
    expect(
      (context?.phases?.orientation.generation_tokens ?? 0) +
        (context?.phases?.implementation.generation_tokens ?? 0),
    ).toBe(1);
  });
});
