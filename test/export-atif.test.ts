import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTranscript } from "@letta-ai/trajectory";
import { openDb } from "../src/db.ts";
import { type AtifTrajectory, exportAtif } from "../src/export-atif.ts";
import { upsertSession } from "../src/ingest.ts";
import { parseAtifDocument } from "../src/sources/atif.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { parseCopilotSession } from "../src/sources/copilot.ts";
import { parseGeminiSession } from "../src/sources/gemini.ts";
import { parseOpenCodeSession } from "../src/sources/opencode.ts";
import { OpenCodeStore } from "../src/sources/opencode-store.ts";
import { parseVscodeCopilotSession } from "../src/sources/vscode-copilot.ts";
import { buildOpenCodeFixtureDb } from "./opencode-fixture.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-atif-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function freshDb(): Database {
  dbCounter += 1;
  return openDb(join(workDir, `atif-${dbCounter}.db`));
}

function fixture(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, "..", ...parts), "utf8");
}

const BASE = { sessionId: "sess-atif", cwd: "/tmp/example", gitBranch: "main", version: "2.1.0" };

function records(...values: Record<string, unknown>[]): string {
  return values.map((value) => JSON.stringify({ ...BASE, ...value })).join("\n");
}

function claudeUsage(input: number, output: number, cacheRead: number, cacheCreation: number) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

// The rules Harbor's Pydantic models enforce (src/harbor/models/trajectories/,
// ATIF-v1.7), ported so the suite runs without Python. Every model forbids
// unknown keys, so the key sets below are exhaustive.
const ROOT_KEYS = new Set([
  "schema_version",
  "session_id",
  "trajectory_id",
  "agent",
  "steps",
  "notes",
  "final_metrics",
  "continued_trajectory_ref",
  "extra",
  "subagent_trajectories",
]);
const AGENT_KEYS = new Set(["name", "version", "model_name", "tool_definitions", "extra"]);
const STEP_KEYS = new Set([
  "step_id",
  "timestamp",
  "source",
  "model_name",
  "reasoning_effort",
  "message",
  "reasoning_content",
  "tool_calls",
  "observation",
  "metrics",
  "is_copied_context",
  "llm_call_count",
  "extra",
]);
const AGENT_ONLY_STEP_KEYS = [
  "model_name",
  "reasoning_effort",
  "reasoning_content",
  "tool_calls",
  "metrics",
];
const TOOL_CALL_KEYS = new Set(["tool_call_id", "function_name", "arguments", "extra"]);
const RESULT_KEYS = new Set(["source_call_id", "content", "subagent_trajectory_ref", "extra"]);
const REF_KEYS = new Set(["trajectory_id", "session_id", "trajectory_path", "extra"]);
const METRICS_KEYS = new Set([
  "prompt_tokens",
  "completion_tokens",
  "cached_tokens",
  "cost_usd",
  "prompt_token_ids",
  "completion_token_ids",
  "logprobs",
  "extra",
]);
const FINAL_KEYS = new Set([
  "total_prompt_tokens",
  "total_completion_tokens",
  "total_cached_tokens",
  "total_cost_usd",
  "total_steps",
  "extra",
]);

function expectKeys(value: object, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${where}: unexpected key ${key}`);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTrajectory(doc: AtifTrajectory, where: string): void {
  expectKeys(doc, ROOT_KEYS, where);
  expect(doc.schema_version).toMatch(/^ATIF-v1\.[0-8]$/);
  expectKeys(doc.agent, AGENT_KEYS, `${where}.agent`);
  expect(typeof doc.agent.name).toBe("string");
  expect(typeof doc.agent.version).toBe("string");
  expect(doc.steps.length).toBeGreaterThan(0);
  doc.steps.forEach((step, index) => {
    const at = `${where}.steps[${index}]`;
    expectKeys(step, STEP_KEYS, at);
    expect(step.step_id).toBe(index + 1);
    expect(["system", "user", "agent"]).toContain(step.source);
    expect(typeof step.message).toBe("string");
    if (step.timestamp != null) {
      expect(Number.isNaN(Date.parse(step.timestamp))).toBe(false);
    }
    if (step.source !== "agent") {
      for (const key of AGENT_ONLY_STEP_KEYS) {
        expect(step).not.toHaveProperty(key);
      }
    }
    if (step.llm_call_count === 0) {
      expect(step.metrics).toBeUndefined();
      expect(step.reasoning_content).toBeUndefined();
    }
    if (step.metrics != null) {
      expectKeys(step.metrics, METRICS_KEYS, `${at}.metrics`);
    }
    const callIds = new Set<string>();
    for (const call of step.tool_calls ?? []) {
      expectKeys(call, TOOL_CALL_KEYS, `${at}.tool_calls`);
      expect(typeof call.tool_call_id).toBe("string");
      expect(typeof call.function_name).toBe("string");
      expect(isObject(call.arguments)).toBe(true);
      callIds.add(call.tool_call_id);
    }
    for (const result of step.observation?.results ?? []) {
      expectKeys(result, RESULT_KEYS, `${at}.observation`);
      if (result.source_call_id != null && !callIds.has(result.source_call_id)) {
        throw new Error(`${at}: source_call_id ${result.source_call_id} not in this step`);
      }
      for (const ref of result.subagent_trajectory_ref ?? []) {
        expectKeys(ref, REF_KEYS, `${at}.subagent_trajectory_ref`);
        expect(ref.trajectory_id).toBeTruthy();
      }
    }
  });
  expectKeys(doc.final_metrics, FINAL_KEYS, `${where}.final_metrics`);
}

/** Harbor's validator plus two document-level checks it leaves to consumers:
 * call ids unique across the document, and every embedded ref resolving
 * against the root's `subagent_trajectories`. */
function assertValidAtif(doc: AtifTrajectory): void {
  validateTrajectory(doc, "root");
  const embeddedIds = new Set<string>();
  for (const [index, sub] of (doc.subagent_trajectories ?? []).entries()) {
    validateTrajectory(sub, `subagent_trajectories[${index}]`);
    expect(sub.subagent_trajectories).toBeUndefined();
    expect(embeddedIds.has(sub.trajectory_id)).toBe(false);
    embeddedIds.add(sub.trajectory_id);
  }
  const callIds = new Set<string>();
  for (const trajectory of [doc, ...(doc.subagent_trajectories ?? [])]) {
    for (const step of trajectory.steps) {
      for (const call of step.tool_calls ?? []) {
        expect(callIds.has(`${trajectory.trajectory_id}/${call.tool_call_id}`)).toBe(false);
        callIds.add(`${trajectory.trajectory_id}/${call.tool_call_id}`);
      }
      for (const result of step.observation?.results ?? []) {
        for (const ref of result.subagent_trajectory_ref ?? []) {
          expect(embeddedIds.has(ref.trajectory_id)).toBe(true);
        }
      }
    }
  }
}

/** Letta's ATIF reader is a second, independent consumer. It requires at least
 * one user and one assistant record, so only whole conversations go through it. */
function assertLettaReads(doc: AtifTrajectory): void {
  const result = normalizeTranscript({ source: "atif", transcript: JSON.stringify(doc) });
  expect(result.records.length).toBeGreaterThan(1);
}

function exportOk(db: Database, id: number): AtifTrajectory {
  const out = exportAtif(db, id);
  if (!out.ok) {
    throw new Error(out.reason);
  }
  assertValidAtif(out.trajectory);
  return out.trajectory;
}

describe("exportAtif", () => {
  test("maps a Claude session to steps with attached observations and inclusive metrics", () => {
    const db = freshDb();
    try {
      const id = upsertSession(
        db,
        parseClaudeSession("c1", fixture("fixtures", "claude", "sample.jsonl")),
        "/synthetic/c1.jsonl",
        1,
        2,
      );
      const doc = exportOk(db, id);
      assertLettaReads(doc);
      expect(doc.schema_version).toBe("ATIF-v1.7");
      expect(doc.agent).toEqual({
        name: "claude-code",
        version: "2.1.0",
        model_name: "claude-opus-4-7",
      });
      expect(doc.steps.map((step) => step.source)).toEqual(["user", "agent", "agent"]);
      const call = doc.steps[1];
      expect(call?.reasoning_content).toBe("I should read the test file first.");
      expect(call?.tool_calls).toEqual([
        {
          tool_call_id: "toolu_1",
          function_name: "Read",
          arguments: { file_path: "/Users/dev/proj/auth_test.py" },
        },
      ]);
      // The result lives in a later user message in Decant but must sit on the
      // calling step in ATIF.
      expect(call?.observation).toEqual({
        results: [
          {
            source_call_id: "toolu_1",
            content: "def test_auth(): assert login()",
            extra: { is_error: false },
          },
        ],
      });
      // prompt = input + cache read + cache write; cached = cache read.
      expect(call?.metrics).toEqual({
        prompt_tokens: 7000,
        completion_tokens: 340,
        cached_tokens: 5000,
        extra: { cache_write_tokens: 800 },
      });
      expect(doc.final_metrics).toMatchObject({
        total_steps: 3,
        total_prompt_tokens: 14_500,
        total_completion_tokens: 460,
        total_cached_tokens: 11_000,
        extra: { total_cache_write_tokens: 800, cost_source: "decant" },
      });
      expect(doc.final_metrics.total_cost_usd).toBeGreaterThan(0);
      expect(doc.extra).toMatchObject({ exporter: "decant", cwd: "/Users/dev/proj" });
    } finally {
      db.close();
    }
  });

  test("merges one split API response into a single agent step, counting its usage once", () => {
    const db = freshDb();
    try {
      const id = upsertSession(
        db,
        parseClaudeSession("split", fixture("test", "fixtures", "claude-split-message.jsonl")),
        "/synthetic/split.jsonl",
        1,
        2,
      );
      const doc = exportOk(db, id);
      expect(doc.steps).toHaveLength(1);
      expect(doc.steps[0]).toMatchObject({
        source: "agent",
        message: "Checking",
        reasoning_content: "Check the file first.",
        metrics: { prompt_tokens: 150, completion_tokens: 200, cached_tokens: 30 },
      });
      expect(doc.steps[0]?.llm_call_count).toBeUndefined();
      expect(doc.final_metrics.extra).toMatchObject({ total_cache_write_1h_tokens: 5 });
    } finally {
      db.close();
    }
  });

  test("renames reused call ids and pairs each result with its own call", () => {
    const db = freshDb();
    try {
      const id = upsertSession(
        db,
        parseClaudeSession("reused", fixture("test", "fixtures", "reused-tool-id.jsonl")),
        "/synthetic/reused.jsonl",
        1,
        2,
      );
      const out = exportAtif(db, id);
      if (!out.ok) throw new Error(out.reason);
      assertValidAtif(out.trajectory);
      const pairs = out.trajectory.steps.flatMap((step) =>
        (step.observation?.results ?? []).map((result) => [
          result.source_call_id,
          result.content,
          result.extra?.is_error,
        ]),
      );
      expect(pairs).toEqual([
        ["reused", "read", false],
        ["reused__dup2", "bad edit", true],
      ]);
      expect(out.report.tool_call_ids_renamed).toBe(2);
    } finally {
      db.close();
    }
  });

  test("records a compaction boundary as a context_management system step", () => {
    const db = freshDb();
    try {
      const content = records(
        {
          type: "user",
          uuid: "u1",
          timestamp: "2026-05-03T10:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          requestId: "req-1",
          timestamp: "2026-05-03T10:01:00.000Z",
          message: {
            role: "assistant",
            model: "example-model",
            usage: claudeUsage(10, 20, 0, 0),
            content: [{ type: "text", text: "hi" }],
          },
        },
        {
          type: "system",
          uuid: "s1",
          parentUuid: "a1",
          subtype: "compact_boundary",
          content: "Conversation compacted",
          compactMetadata: { trigger: "auto", preTokens: 1000 },
          timestamp: "2026-05-03T10:02:00.000Z",
        },
        {
          type: "user",
          uuid: "cs1",
          parentUuid: "s1",
          isCompactSummary: true,
          timestamp: "2026-05-03T10:02:01.000Z",
          message: { role: "user", content: "Summary of the earlier work." },
        },
      );
      const id = upsertSession(
        db,
        parseClaudeSession("compact", content),
        "/synthetic/compact.jsonl",
        1,
        2,
      );
      const doc = exportOk(db, id);
      expect(doc.steps.map((step) => step.source)).toEqual(["user", "agent", "system", "user"]);
      expect(doc.steps[2]).toMatchObject({
        message: "Context compaction performed",
        extra: {
          context_management: { type: "compaction", boundary: "replace" },
          compact_trigger: "auto",
          compact_pre_tokens: 1000,
        },
      });
      expect(doc.steps[3]?.extra).toEqual({ is_compact_summary: true });
    } finally {
      db.close();
    }
  });

  test("embeds subagents in the root, links them from the spawning call, and rolls up totals", () => {
    const db = freshDb();
    try {
      const parentId = upsertSession(
        db,
        parseClaudeSession(
          "parent",
          records(
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-05-04T10:00:00.000Z",
              message: { role: "user", content: "Delegate this." },
            },
            {
              type: "assistant",
              uuid: "a1",
              parentUuid: "u1",
              requestId: "req-p1",
              timestamp: "2026-05-04T10:00:01.000Z",
              message: {
                role: "assistant",
                model: "claude-sonnet-4-6",
                usage: claudeUsage(100, 10, 0, 0),
                content: [
                  { type: "tool_use", id: "toolu_task", name: "Task", input: { prompt: "look" } },
                ],
              },
            },
            {
              type: "user",
              uuid: "u2",
              parentUuid: "a1",
              timestamp: "2026-05-04T10:00:30.000Z",
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "done" }],
              },
            },
          ),
        ),
        "/synthetic/parent.jsonl",
        1,
        2,
      );
      const childId = upsertSession(
        db,
        parseClaudeSession(
          "child",
          records(
            {
              type: "user",
              uuid: "cu1",
              timestamp: "2026-05-04T10:00:02.000Z",
              message: { role: "user", content: "look" },
            },
            {
              type: "assistant",
              uuid: "ca1",
              parentUuid: "cu1",
              requestId: "req-c1",
              timestamp: "2026-05-04T10:00:20.000Z",
              message: {
                role: "assistant",
                model: "claude-sonnet-4-6",
                usage: claudeUsage(50, 5, 0, 0),
                content: [{ type: "text", text: "found it" }],
              },
            },
          ),
        ),
        "/synthetic/child.jsonl",
        1,
        2,
      );
      db.query(
        `UPDATE session SET is_subagent = 1, parent_session_id = ?1,
         spawn_tool_use_id = 'toolu_task', agent_id = 'a1' WHERE id = ?2`,
      ).run(parentId, childId);

      const out = exportAtif(db, parentId);
      if (!out.ok) throw new Error(out.reason);
      const doc = out.trajectory;
      assertValidAtif(doc);
      expect(out.report.subagents_embedded).toBe(1);
      expect(out.report.subagents_unlinked).toBe(0);
      expect(doc.subagent_trajectories?.map((sub) => sub.trajectory_id)).toEqual(["child:a1"]);
      expect(doc.steps[1]?.observation?.results).toEqual([
        {
          source_call_id: "toolu_task",
          content: "done",
          subagent_trajectory_ref: [{ trajectory_id: "child:a1", session_id: "child" }],
        },
      ]);
      // Root totals include the embedded subagent; the subagent's are its own.
      expect(doc.final_metrics.total_prompt_tokens).toBe(150);
      expect(doc.final_metrics.extra).toMatchObject({ includes_subagents: true });
      expect(doc.subagent_trajectories?.[0]?.final_metrics.total_prompt_tokens).toBe(50);
    } finally {
      db.close();
    }
  });

  test("starts a new agent step when the model or sidechain status changes", () => {
    const db = freshDb();
    try {
      const assistant = (uuid: string, model: string, text: string, extra = {}) => ({
        type: "assistant",
        uuid,
        requestId: `req-${uuid}`,
        timestamp: "2026-05-06T10:00:01.000Z",
        ...extra,
        message: {
          role: "assistant",
          model,
          usage: claudeUsage(10, 1, 0, 0),
          content: [{ type: "text", text }],
        },
      });
      const id = upsertSession(
        db,
        parseClaudeSession(
          "transitions",
          records(
            {
              type: "user",
              uuid: "u1",
              timestamp: "2026-05-06T10:00:00.000Z",
              message: { role: "user", content: "hello" },
            },
            assistant("a1", "model-a", "from a"),
            assistant("a2", "model-b", "from b"),
            assistant("a3", "model-b", "side", { isSidechain: true }),
            assistant("a4", "model-b", "main again"),
          ),
        ),
        "/synthetic/transitions.jsonl",
        1,
        2,
      );
      const doc = exportOk(db, id);
      expect(
        doc.steps
          .filter((step) => step.source === "agent")
          .map((step) => [step.model_name, step.message, step.extra?.is_sidechain ?? false]),
      ).toEqual([
        ["model-a", "from a", false],
        ["model-b", "from b", false],
        ["model-b", "side", true],
        ["model-b", "main again", false],
      ]);
      for (const step of doc.steps.filter((step) => step.source === "agent")) {
        expect(step.metrics?.prompt_tokens).toBe(10);
      }
    } finally {
      db.close();
    }
  });

  test("links each subagent to its own occurrence of a reused spawn id, or leaves it unlinked", () => {
    const db = freshDb();
    try {
      const task = (uuid: string, at: string) => ({
        type: "assistant",
        uuid,
        requestId: `req-${uuid}`,
        timestamp: at,
        message: {
          role: "assistant",
          model: "example-model",
          content: [{ type: "tool_use", id: "reused", name: "Task", input: { prompt: uuid } }],
        },
      });
      const result = (uuid: string, at: string) => ({
        type: "user",
        uuid,
        timestamp: at,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "reused", content: `done ${uuid}` }],
        },
      });
      const parentId = upsertSession(
        db,
        parseClaudeSession(
          "spawner",
          records(
            {
              type: "user",
              uuid: "u0",
              timestamp: "2026-05-07T10:00:00.000Z",
              message: { role: "user", content: "two tasks" },
            },
            task("t1", "2026-05-07T10:01:00.000Z"),
            result("r1", "2026-05-07T10:02:00.000Z"),
            task("t2", "2026-05-07T10:03:00.000Z"),
            result("r2", "2026-05-07T10:04:00.000Z"),
          ),
        ),
        "/synthetic/spawner.jsonl",
        1,
        2,
      );
      const child = (name: string, at: string): number =>
        upsertSession(
          db,
          parseClaudeSession(
            name,
            records({
              type: "user",
              uuid: `${name}-u`,
              timestamp: at,
              message: { role: "user", content: name },
            }),
          ),
          `/synthetic/${name}.jsonl`,
          1,
          2,
        );
      const first = child("first", "2026-05-07T10:01:05.000Z");
      const second = child("second", "2026-05-07T10:03:05.000Z");
      const undated = child("undated", "2026-05-07T10:03:06.000Z");
      for (const childId of [first, second, undated]) {
        db.query(
          `UPDATE session SET is_subagent = 1, parent_session_id = ?1, spawn_tool_use_id = 'reused'
           WHERE id = ?2`,
        ).run(parentId, childId);
      }
      db.query("UPDATE session SET started_at = NULL WHERE id = ?1").run(undated);

      const out = exportAtif(db, parentId);
      if (!out.ok) throw new Error(out.reason);
      assertValidAtif(out.trajectory);
      const links = out.trajectory.steps.flatMap((step) =>
        (step.observation?.results ?? []).map((r) => [
          r.source_call_id,
          (r.subagent_trajectory_ref ?? []).map((ref) => ref.trajectory_id),
        ]),
      );
      expect(links).toEqual([
        ["reused", ["first"]],
        ["reused__dup2", ["second"]],
      ]);
      expect(out.report).toMatchObject({ subagents_embedded: 3, subagents_unlinked: 1 });
    } finally {
      db.close();
    }
  });

  test("embeds the descendants of a subagent that has nothing to export", () => {
    const db = freshDb();
    try {
      const rootId = upsertSession(
        db,
        parseClaudeSession("root", fixture("fixtures", "claude", "sample.jsonl")),
        "/synthetic/root.jsonl",
        1,
        2,
      );
      db.query(
        `INSERT INTO session(id, tool, source_session_id, is_subagent, parent_session_id, spawn_tool_use_id)
         VALUES (500, 'claude_code', 'empty-child', 1, ?1, 'toolu_1')`,
      ).run(rootId);
      const grandchildId = upsertSession(
        db,
        parseClaudeSession(
          "grandchild",
          records(
            {
              type: "user",
              uuid: "g1",
              timestamp: "2026-05-08T10:00:00.000Z",
              message: { role: "user", content: "deep work" },
            },
            {
              type: "assistant",
              uuid: "g2",
              parentUuid: "g1",
              requestId: "req-g2",
              timestamp: "2026-05-08T10:00:01.000Z",
              message: {
                role: "assistant",
                model: "claude-sonnet-4-6",
                usage: claudeUsage(40, 4, 0, 0),
                content: [{ type: "text", text: "ok" }],
              },
            },
          ),
        ),
        "/synthetic/grandchild.jsonl",
        1,
        2,
      );
      db.query("UPDATE session SET is_subagent = 1, parent_session_id = 500 WHERE id = ?1").run(
        grandchildId,
      );

      const out = exportAtif(db, rootId);
      if (!out.ok) throw new Error(out.reason);
      assertValidAtif(out.trajectory);
      expect(out.trajectory.subagent_trajectories?.map((sub) => sub.trajectory_id)).toEqual([
        "grandchild",
      ]);
      // The grandchild's spawner lives in the empty child, which has no steps.
      expect(out.report).toMatchObject({ subagents_embedded: 1, subagents_unlinked: 1 });
      expect(out.trajectory.trajectory_id).toBe("root");
      expect(out.trajectory.final_metrics.total_prompt_tokens).toBe(14_500 + 40);
    } finally {
      db.close();
    }
  });

  test("exports Codex with object arguments and injected context as system steps", () => {
    const db = freshDb();
    try {
      const injected = JSON.stringify({
        type: "response_item",
        timestamp: "2026-05-02T09:00:01.500Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }],
        },
      });
      const lines = fixture("fixtures", "codex", "sample.jsonl").trimEnd().split("\n");
      lines.splice(2, 0, injected);
      const id = upsertSession(
        db,
        parseCodexSession("cx", lines.join("\n"), new Map()),
        "/synthetic/rollout-cx.jsonl",
        1,
        2,
      );
      const doc = exportOk(db, id);
      assertLettaReads(doc);
      expect(doc.agent).toMatchObject({ name: "codex", version: "0.116.0" });
      expect(doc.steps.map((step) => step.source)).toEqual(["system", "user", "agent", "agent"]);
      expect(doc.steps[2]?.tool_calls?.[0]?.arguments).toEqual({ command: "rg TODO" });
      // Codex input_tokens includes cached input; Decant stores it net, and
      // ATIF wants it inclusive again.
      expect(doc.final_metrics).toMatchObject({
        total_prompt_tokens: 900,
        total_cached_tokens: 400,
        total_completion_tokens: 150,
        extra: { total_reasoning_tokens: 60, reasoning_source: "reported" },
      });
    } finally {
      db.close();
    }
  });

  test("exports Gemini and OpenCode sessions under Harbor's agent names", () => {
    const db = freshDb();
    try {
      const geminiId = upsertSession(
        db,
        parseGeminiSession("gemini", fixture("fixtures", "gemini", "sample.jsonl"), "/synthetic/p"),
        "/synthetic/gemini.jsonl",
        1,
        2,
      );
      const gemini = exportOk(db, geminiId);
      assertLettaReads(gemini);
      expect(gemini.agent.name).toBe("gemini-cli");

      const dir = join(workDir, "opencode-src");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "opencode.db");
      buildOpenCodeFixtureDb(path, ["sample.sql"]);
      const store = OpenCodeStore.open(path);
      const loaded = store.loadSession("ses_sample");
      if (loaded == null) throw new Error("fixture session missing");
      const parsed = parseOpenCodeSession(loaded.session, loaded.messages, {
        mcpServers: [],
        contextWindows: store.contextWindows(),
      });
      store.close();
      const opencodeId = upsertSession(db, parsed, `${path}#ses_sample`, 1, 0, "fp");
      const opencode = exportOk(db, opencodeId);
      assertLettaReads(opencode);
      expect(opencode.agent.name).toBe("opencode");
      expect(
        opencode.steps.flatMap((step) => step.observation?.results ?? []).length,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("exports Copilot CLI and VS Code Copilot Chat sessions", () => {
    const db = freshDb();
    try {
      const cliId = upsertSession(
        db,
        parseCopilotSession("copilot", fixture("fixtures", "copilot", "sample", "events.jsonl")),
        "/synthetic/copilot/events.jsonl",
        1,
        2,
      );
      expect(exportOk(db, cliId).agent.name).toBe("copilot-cli");

      const chatId = upsertSession(
        db,
        parseVscodeCopilotSession(
          "vscode",
          fixture(
            "fixtures",
            "vscode-copilot",
            "User",
            "workspaceStorage",
            "5f3e9c1a",
            "chatSessions",
            "vscode-sample-session.jsonl",
          ),
        ),
        "/synthetic/vscode-sample-session.jsonl",
        1,
        2,
      );
      expect(exportOk(db, chatId).agent.name).toBe("vscode-copilot-chat");
    } finally {
      db.close();
    }
  });

  test("reports missing sessions and sessions with nothing to export", () => {
    const db = freshDb();
    try {
      expect(exportAtif(db, 999_999)).toEqual({ ok: false, reason: "not_found" });
      db.exec(
        `INSERT INTO session(id, tool, source_session_id) VALUES (42, 'claude_code', 'empty')`,
      );
      expect(exportAtif(db, 42)).toEqual({ ok: false, reason: "no_steps" });
    } finally {
      db.close();
    }
  });

  test("leaves token totals out when the source records no usage (Cursor)", () => {
    const db = freshDb();
    try {
      db.exec(`
        INSERT INTO session(id, tool, source_session_id, cli_version)
          VALUES (7, 'cursor', 'cursor-chat', NULL);
        INSERT INTO message(id, session_id, seq, role, timestamp, raw) VALUES
          (70, 7, 0, 'user', '2026-05-05T10:00:00.000Z', '{}'),
          (71, 7, 1, 'assistant', '2026-05-05T10:00:01.000Z', '{}');
        INSERT INTO block(message_id, session_id, ordinal, type, text) VALUES
          (70, 7, 0, 'text', 'hello'),
          (71, 7, 0, 'text', 'hi');
      `);
      const doc = exportOk(db, 7);
      expect(doc.agent).toEqual({ name: "cursor-cli", version: "unknown" });
      expect(doc.final_metrics).toEqual({ total_steps: 2 });
      expect(doc.steps[1]?.metrics).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("round-trips through the ATIF import with the same token totals and agent name", () => {
    const db = freshDb();
    try {
      const id = upsertSession(
        db,
        parseClaudeSession("sample", fixture("fixtures", "claude", "sample.jsonl")),
        "/synthetic/sample.jsonl",
        1,
        2,
      );
      const doc = exportOk(db, id);
      const imported = parseAtifDocument("fallback", JSON.stringify(doc));
      const parsed = imported.sessions[0]?.parsed;
      if (parsed == null) {
        throw new Error("expected an imported root session");
      }
      const totals = parsed.session.totals;
      expect({
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheCreation: totals.cacheCreation,
      }).toEqual(
        db
          .query(
            `SELECT total_input_tokens AS input, total_output_tokens AS output,
                    total_cache_read_tokens AS cacheRead,
                    total_cache_creation_tokens AS cacheCreation
               FROM session WHERE id = ?1`,
          )
          .get(id) as { input: number; output: number; cacheRead: number; cacheCreation: number },
      );
      expect(parsed.session.sourceSessionId).toBe(doc.session_id);

      const importedId = upsertSession(db, parsed, "/synthetic/sample.atif.json", 1, 2);
      expect(exportOk(db, importedId).agent.name).toBe("claude-code");
    } finally {
      db.close();
    }
  });
});
