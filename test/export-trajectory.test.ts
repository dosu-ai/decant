import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTranscript } from "@letta-ai/trajectory";
import { openDb } from "../src/db.ts";
import { exportTrajectory } from "../src/export.ts";
import { upsertSession } from "../src/ingest.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-trajectory-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function fixtureContent(name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", "claude", name), "utf8");
}

const Ajv2020 = (await import("ajv/dist/2020.js")).default;
const trajectorySchema = (await import("@letta-ai/trajectory/schema", {
  with: { type: "json" },
})) as { default: object };
const validateSchema = new Ajv2020().compile(trajectorySchema.default);

function assertBothLayers(records: unknown[]): void {
  expect(() => validateTranscript(records)).not.toThrow();
  expect(validateSchema(records)).toBe(true);
}

describe("exportTrajectory", () => {
  test("emits a transcript both their validator and schema accept", () => {
    const db = openDb(join(workDir, "basic.db"));
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-1", fixtureContent("sample.jsonl")),
      "/t1.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    assertBothLayers(out.records);
    const meta = out.records[0] as { role: string; source: string };
    expect(meta.role).toBe("meta");
    expect(meta.source).toBe("claude-code");
    db.close();
  });

  test("truncates long tool results marker-inclusive within 2500 code points", () => {
    const db = openDb(join(workDir, "long.db"));
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "run it" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { cmd: "make" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: `HEAD${"x".repeat(5000)}TAIL-ERROR`,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-5", lines),
      "/t5.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    assertBothLayers(out.records);
    const tool = out.records.find((r) => (r as { role?: string }).role === "tool") as {
      content: string;
    };
    expect([...tool.content].length).toBeLessThanOrEqual(2500);
    expect(tool.content.startsWith("HEAD")).toBe(true);
    expect(tool.content.endsWith("TAIL-ERROR")).toBe(true);
    expect(tool.content).toContain("… [truncated, ");
    expect(out.report.tool_results_truncated).toBe(1);
    db.close();
  });

  test("assistant tool calls carry explicit null content and one call each", () => {
    const db = openDb(join(workDir, "calls.db"));
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-2", fixtureContent("mcp.jsonl")),
      "/t2.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    const calls = out.records.filter(
      (r): r is { role: string; content: null; tool_calls: unknown[] } =>
        typeof r === "object" && r != null && "tool_calls" in r,
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.content).toBeNull();
      expect(call.tool_calls).toHaveLength(1);
    }
    db.close();
  });

  test("drops orphan results, wraps non-object args, fills missing timestamps, drops noise users", () => {
    const db = openDb(join(workDir, "repairs.db"));
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "<command-name>/model</command-name>" }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "real question" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "test-model",
          content: [
            { type: "text", text: "on it" },
            { type: "tool_use", id: "t1", name: "Bash", input: "not-an-object" },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "ghost", content: "orphan" },
          ],
        },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-3", lines),
      "/t3.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    assertBothLayers(out.records);
    expect(out.report.noise_user_records_dropped).toBe(1);
    expect(out.report.orphan_tool_results_dropped).toBe(1);
    expect(out.report.tool_args_wrapped).toBe(1);
    expect(out.report.timestamps_filled).toBeGreaterThan(0);
    const args = (
      out.records.find((r) => typeof r === "object" && r != null && "tool_calls" in r) as {
        tool_calls: { args: string }[];
      }
    ).tool_calls[0]?.args;
    expect(JSON.parse(args ?? "{}")).toHaveProperty("_raw");
    db.close();
  });

  test("renames duplicate call ids, pairs results temporally, counts dropped blocks", () => {
    const db = openDb(join(workDir, "dupes.db"));
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "   " },
            { type: "tool_use", id: "t1", name: "Bash", input: { n: 1 } },
            { type: "tool_use", id: "t1", name: "Bash", input: { n: 2 } },
            { type: "tool_use", name: "NoId", input: { n: 3 } },
            { type: "image", source: { type: "base64", data: "AAA" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "first" }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "second" }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:04.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "third" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-6", lines),
      "/t6.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    assertBothLayers(out.records);

    const callIds = out.records
      .filter((r): r is { tool_calls: { id: string }[] } => {
        return typeof r === "object" && r != null && "tool_calls" in r;
      })
      .map((r) => r.tool_calls[0]?.id);
    expect(callIds).toEqual(["t1", "t1__dup2", `decant-${sessionId}-3`]);
    expect(out.report.tool_call_ids_renamed).toBe(1);
    expect(out.report.tool_call_ids_synthesized).toBe(1);

    // Two calls, three results: each result pairs with the next unanswered call
    // in appearance order, and the surplus is dropped rather than duplicated.
    const results = out.records.filter(
      (r): r is { tool_call_id: string; content: string } =>
        typeof r === "object" && r != null && (r as { role?: string }).role === "tool",
    );
    expect(results.map((r) => [r.tool_call_id, r.content])).toEqual([
      ["t1", "first"],
      ["t1__dup2", "second"],
    ]);
    expect(out.report.duplicate_tool_results_dropped).toBe(1);

    // The empty text block and the image block carry no wire content.
    expect(out.report.dropped_blocks).toEqual({ text: 1, other: 1 });
    db.close();
  });

  test("probes past a source id that already looks like one of our renames", () => {
    const db = openDb(join(workDir, "collide.db"));
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { n: 1 } },
            { type: "tool_use", id: "t1", name: "Bash", input: { n: 2 } },
            // Renaming the line above to t1__dup2 would collide with this id.
            { type: "tool_use", id: "t1__dup2", name: "Bash", input: { n: 3 } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "first" }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "second" }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:04.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1__dup2", content: "third" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-7", lines),
      "/t7.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    assertBothLayers(out.records);

    const callIds = out.records
      .filter((r): r is { tool_calls: { id: string }[] } => {
        return typeof r === "object" && r != null && "tool_calls" in r;
      })
      .map((r) => r.tool_calls[0]?.id);
    expect(callIds).toEqual(["t1", "t1__dup2", "t1__dup2__dup2"]);
    expect(new Set(callIds).size).toBe(callIds.length);
    expect(out.report.tool_call_ids_renamed).toBe(2);

    // Results stay keyed to the call that produced them: the third result names
    // source id t1__dup2, whose own call was renamed to t1__dup2__dup2.
    const results = out.records.filter(
      (r): r is { tool_call_id: string; content: string } =>
        typeof r === "object" && r != null && (r as { role?: string }).role === "tool",
    );
    expect(results.map((r) => [r.tool_call_id, r.content])).toEqual([
      ["t1", "first"],
      ["t1__dup2", "second"],
      ["t1__dup2__dup2", "third"],
    ]);
    expect(out.report.duplicate_tool_results_dropped).toBe(0);
    db.close();
  });

  test("keeps field structure when shrinking over-cap object args", () => {
    const db = openDb(join(workDir, "bigargs.db"));
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Write",
              input: { big: "z".repeat(40000), keep: "me" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-8", lines),
      "/t8.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    assertBothLayers(out.records);

    const args = (
      out.records.find((r) => typeof r === "object" && r != null && "tool_calls" in r) as {
        tool_calls: { args: string }[];
      }
    ).tool_calls[0]?.args;
    expect(args).toBeDefined();
    expect([...(args ?? "")].length).toBeLessThanOrEqual(20000);
    const decoded = JSON.parse(args ?? "{}") as Record<string, string>;
    expect(Object.keys(decoded)).toEqual(["big", "keep"]);
    // The small field survives untouched; only the oversized leaf is truncated.
    expect(decoded.keep).toBe("me");
    expect(decoded).not.toHaveProperty("_raw");
    expect(decoded.big?.startsWith("z")).toBe(true);
    expect(decoded.big).toContain("… [truncated, ");
    expect(out.report.tool_args_wrapped).toBe(1);
    db.close();
  });

  test("falls back to a _raw wrap when the overage is structural", () => {
    const db = openDb(join(workDir, "manykeys.db"));
    // 1200 fields whose values are all shorter than the truncation marker, so no
    // leaf can shrink usefully and the cap is only reachable by wrapping.
    const input: Record<string, string> = {};
    for (let index = 0; index < 1200; index += 1) {
      input[`key${String(index).padStart(4, "0")}`] = "v".repeat(20);
    }
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Write", input }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-9", lines),
      "/t9.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    assertBothLayers(out.records);

    const args = (
      out.records.find((r) => typeof r === "object" && r != null && "tool_calls" in r) as {
        tool_calls: { args: string }[];
      }
    ).tool_calls[0]?.args;
    expect([...(args ?? "")].length).toBeLessThanOrEqual(20000);
    expect(JSON.parse(args ?? "{}")).toHaveProperty("_raw");
    expect(out.report.tool_args_wrapped).toBe(1);
    db.close();
  });

  test("refuses sessions without user or assistant records", () => {
    const db = openDb(join(workDir, "empty.db"));
    const lines = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-01T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-4", lines),
      "/t4.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    expect(out).toEqual({ ok: false, reason: "missing_user_records" });
    expect(exportTrajectory(db, 999999)).toEqual({ ok: false, reason: "not_found" });
    db.close();
  });

  test("normalizes offset timestamps and never corrupts bare ±hh offsets", () => {
    const db = openDb(join(workDir, "offsets.db"));
    const lines = [
      // No-colon four-digit offset: parseable, must normalize to the UTC instant.
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T00:00:00+0530",
        message: { role: "user", content: [{ type: "text", text: "offset question" }] },
      }),
      // Bare two-digit offset: Bun's Date cannot parse it, so it must fall
      // through to the fill ladder as-is — not get a Z appended onto the
      // offset. Either way it forward-fills from the previous record.
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T00:00:00+05",
        message: { role: "assistant", content: [{ type: "text", text: "offset answer" }] },
      }),
    ].join("\n");
    const sessionId = upsertSession(
      db,
      parseClaudeSession("traj-tz", lines),
      "/tz.jsonl",
      1,
      2,
      "h",
    );
    const out = exportTrajectory(db, sessionId);
    if (!out.ok) throw new Error(`export failed: ${out.reason}`);
    assertBothLayers(out.records);
    const [, user, assistant] = out.records as { timestamp?: string }[];
    expect(user?.timestamp).toBe("2026-06-30T18:30:00.000Z");
    expect(assistant?.timestamp).toBe("2026-06-30T18:30:00.000Z");
    expect(out.report.timestamps_filled).toBe(1);
    db.close();
  });
});
