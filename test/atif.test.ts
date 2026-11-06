import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Json, NormalizedSession } from "../src/model.ts";
import {
  atifNativeTool,
  type ParsedAtifDocument,
  parseAtifDocument,
  usageFromMetrics,
} from "../src/sources/atif.ts";

const fixtureDir = join(import.meta.dir, "..", "fixtures", "atif");
const trialDir = join(fixtureDir, "jobs", "synthetic-job", "trial-1", "agent");

function parseFixture(path: string): ParsedAtifDocument {
  return parseAtifDocument("fallback", readFileSync(path, "utf8"), { sourcePath: path });
}

function parse(document: Json, sourcePath = "/tmp/example/run.json"): ParsedAtifDocument {
  return parseAtifDocument("fallback", JSON.stringify(document), { sourcePath });
}

function root(document: ParsedAtifDocument): NormalizedSession {
  const first = document.sessions[0];
  if (first == null || first.key != null) {
    throw new Error("expected the root session first");
  }
  return first.parsed.session;
}

function trajectory(steps: Json[], extra: Record<string, Json> = {}): Json {
  return {
    schema_version: "ATIF-v1.7",
    session_id: "example-run",
    agent: { name: "example-agent", version: "1.0.0", model_name: "example-model" },
    steps,
    ...extra,
  };
}

describe("parseAtifDocument", () => {
  test("reads a Harbor trial: roles, call linkage, and per-step usage", () => {
    const document = parseFixture(join(trialDir, "trajectory.json"));
    expect(document.sessions).toHaveLength(1);
    const session = root(document);
    expect(session.tool).toBe("atif");
    expect(session.sourceSessionId).toBe("synthetic-trial-1");
    expect(session.model).toBe("anthropic/claude-opus-4-7");
    expect(session.cliVersion).toBe("2.0.0");
    expect(session.title).toBe("Create hello.txt containing hello.");
    expect(session.startedAt).toBe("2026-10-01T09:00:00.000Z");
    expect(session.endedAt).toBe("2026-10-01T09:00:14.000Z");
    expect(session.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);

    const first = session.messages[2];
    expect(first?.blocks.map((b) => b.blockType)).toEqual(["thinking", "text", "tool_use"]);
    expect(first?.blocks[2]).toMatchObject({
      toolName: "bash_command",
      toolUseId: "call_1",
      toolInput: { keystrokes: "echo hello > hello.txt\n" },
    });
    expect(session.messages[3]?.blocks[0]).toMatchObject({
      blockType: "tool_result",
      toolUseId: "call_1",
      toolResult: "$ echo hello > hello.txt",
    });
    // A result with no call id is environment feedback, kept as text.
    expect(session.messages[7]?.blocks.map((b) => b.blockType)).toEqual(["tool_result", "text"]);

    // prompt_tokens includes cache reads, which Decant keeps apart.
    expect(first?.usage).toEqual({
      input: 200,
      output: 80,
      cacheRead: 1000,
      cacheCreation: 0,
      cacheCreation1h: 0,
      reasoning: 20,
    });
    // Step sums, not final_metrics, which may count subagents.
    expect(session.totals).toEqual({
      input: 850,
      output: 162,
      cacheRead: 3700,
      cacheCreation: 0,
      cacheCreation1h: 0,
      reasoning: 20,
    });
    expect(session.reasoningSource).toBe("reported");
    expect(document.sessions[0]?.parsed.issues).toEqual([]);
  });

  test("records a trajectory_path subagent ref resolved beside the document", () => {
    const session = root(parseFixture(join(trialDir, "trajectory.json")));
    expect((session.rawMeta as { subagentFileRefs: Json }).subagentFileRefs).toEqual([
      {
        path: join(trialDir, "trajectory.summarization-1-summary.json"),
        spawnToolUseId: "call_2",
      },
    ]);
  });

  test("leaves copied-context steps out of the transcript and the totals", () => {
    const document = parseFixture(join(trialDir, "trajectory.summarization-1-summary.json"));
    const session = root(document);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[0]?.blocks[0]?.text).toBe("Summarize the work so far.");
    expect(session.totals.input).toBe(400);
    expect((session.rawMeta as { copiedContextSteps: number }).copiedContextSteps).toBe(2);
    // The recorded step cost stays in raw, where cost reconciliation reads it.
    expect(session.messages[1]?.raw).toMatchObject({ metrics: { cost_usd: 0.0042 } });
  });

  test("splits embedded subagents into linked sessions", () => {
    const document = parseFixture(join(fixtureDir, "embedded.atif.json"));
    expect(document.sessions.map((s) => s.key)).toEqual([null, "synthetic-embedded:helper"]);

    const parent = root(document);
    expect(parent.sourceSessionId).toBe("synthetic-embedded");
    expect(parent.title).toBe("Explain the example config");
    expect(parent.cwd).toBe("/tmp/example");
    expect(parent.projectPath).toBe("/tmp/example");
    expect(parent.gitBranch).toBe("main");
    expect(parent.reasoningEffort).toBe("high");
    expect(parent.isSubagent).toBe(false);
    // Input net of cache reads and of the cache writes kept in extra.
    expect(parent.messages[1]?.usage).toMatchObject({
      input: 500,
      cacheRead: 3000,
      cacheCreation: 1500,
      reasoning: 100,
    });
    expect(parent.totals).toMatchObject({ input: 500, output: 350, cacheRead: 5000 });

    const child = document.sessions[1]?.parsed.session;
    expect(child).toMatchObject({
      sourceSessionId: "synthetic-embedded:helper",
      isSubagent: true,
      rootSourceSessionId: "synthetic-embedded",
      spawnToolUseId: "toolu_task",
      agentId: "synthetic-embedded:helper",
      agentType: "general-purpose",
      spawnDepth: 1,
    });
    expect((child?.rawMeta as { parentSessionId?: string } | undefined)?.parentSessionId).toBe(
      "synthetic-embedded",
    );
    expect(child?.messages[2]?.blocks[0]).toMatchObject({
      toolUseId: "toolu_bash",
      isError: false,
    });
    // Neither session's raw metadata repeats the steps or the embedded array.
    expect(parent.rawMeta).not.toHaveProperty("steps");
    expect(parent.rawMeta).not.toHaveProperty("subagent_trajectories");
  });

  test("keeps media parts and reports unknown ones as format drift", () => {
    const document = parse(
      trajectory([
        {
          step_id: 1,
          source: "user",
          message: [
            { type: "text", text: "Describe these." },
            { type: "image", source: { media_type: "image/png", path: "images/example.png" } },
            { type: "audio", source: { media_type: "audio/wav", path: "audio/example.wav" } },
            { type: "video", source: { path: "clips/example.mp4" } },
          ],
        },
      ]),
    );
    expect(root(document).messages[0]?.blocks.map((b) => [b.blockType, b.text])).toEqual([
      ["text", "Describe these."],
      ["image", "images/example.png"],
      ["other", "audio/example.wav"],
      ["other", "clips/example.mp4"],
    ]);
    // Audio is a v1.8 part; only the unknown one is drift.
    expect(document.sessions[0]?.parsed.issues).toEqual([
      expect.objectContaining({
        code: "unknown_record_type",
        error: expect.stringContaining('"content part video"'),
      }),
    ]);
  });

  test("files a compaction boundary as a system message with its marker", () => {
    const parent = root(parseFixture(join(fixtureDir, "embedded.atif.json")));
    const boundary = parent.messages.find((m) => m.role === "system");
    expect(boundary?.raw).toMatchObject({
      extra: { context_management: { type: "compaction", boundary: "replace" } },
    });
  });

  test("resolves a ref to a nested embedded subagent against its own parent", () => {
    const document = parse(
      trajectory(
        [
          {
            step_id: 1,
            source: "agent",
            message: "",
            tool_calls: [{ tool_call_id: "spawn-a", function_name: "Agent", arguments: {} }],
            observation: {
              results: [
                { source_call_id: "spawn-a", subagent_trajectory_ref: [{ trajectory_id: "a" }] },
              ],
            },
          },
        ],
        {
          subagent_trajectories: [
            {
              schema_version: "ATIF-v1.7",
              trajectory_id: "a",
              agent: { name: "example-agent", version: "1.0.0" },
              steps: [
                {
                  step_id: 1,
                  source: "agent",
                  message: "",
                  tool_calls: [{ tool_call_id: "spawn-b", function_name: "Agent", arguments: {} }],
                  observation: {
                    results: [
                      {
                        source_call_id: "spawn-b",
                        subagent_trajectory_ref: { trajectory_id: "b" },
                      },
                    ],
                  },
                },
              ],
            },
            {
              schema_version: "ATIF-v1.7",
              trajectory_id: "b",
              agent: { name: "example-agent", version: "1.0.0" },
              steps: [{ step_id: 1, source: "user", message: "hello" }],
            },
          ],
        },
      ),
    );
    const [, a, b] = document.sessions.map((s) => s.parsed.session);
    expect(a).toMatchObject({
      sourceSessionId: "example-run:a",
      spawnToolUseId: "spawn-a",
      spawnDepth: 1,
    });
    // A v1.0-style single-object ref still links.
    expect(b).toMatchObject({
      sourceSessionId: "example-run:b",
      spawnToolUseId: "spawn-b",
      spawnDepth: 2,
    });
    expect((b?.rawMeta as { parentSessionId?: string } | undefined)?.parentSessionId).toBe(
      "example-run:a",
    );
  });

  test("gives duplicate embedded trajectory ids distinct keys", () => {
    const child = (message: string): Json => ({
      schema_version: "ATIF-v1.7",
      trajectory_id: "same",
      agent: { name: "example-agent", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message }],
    });
    const document = parse(trajectory([], { subagent_trajectories: [child("one"), child("two")] }));
    expect(document.sessions.map((s) => s.key)).toEqual([null, "same", "same#2"]);
  });

  test("uses final_metrics only when no step reports usage", () => {
    const final = {
      total_prompt_tokens: 1000,
      total_completion_tokens: 50,
      total_cached_tokens: 600,
      extra: { total_cache_write_tokens: 100 },
    };
    const steps = [{ step_id: 1, source: "agent", message: "done" }];
    expect(root(parse(trajectory(steps, { final_metrics: final }))).totals).toMatchObject({
      input: 300,
      output: 50,
      cacheRead: 600,
      cacheCreation: 100,
    });
    const withSubagent = trajectory(steps, {
      final_metrics: final,
      subagent_trajectories: [
        {
          schema_version: "ATIF-v1.7",
          trajectory_id: "child",
          agent: { name: "example-agent", version: "1.0.0" },
          steps: [],
        },
      ],
    });
    // Those totals would also count the embedded subagent's own session.
    expect(root(parse(withSubagent)).totals.input).toBe(0);
  });

  test("records no usage for a step without metrics", () => {
    const session = root(parse(trajectory([{ step_id: 1, source: "agent", message: "hi" }])));
    expect(session.messages[0]?.usage).toBeNull();
    expect(session.reasoningSource).toBe("none");
  });

  test("turns an unparsable document into one unparsed_line issue", () => {
    const document = parseAtifDocument("broken", "{ not json", {});
    expect(document.sessions).toHaveLength(1);
    expect(root(document)).toMatchObject({ sourceSessionId: "broken", messages: [] });
    expect(document.sessions[0]?.parsed.issues).toEqual([
      expect.objectContaining({ code: "unparsed_line", lineNo: 1, rawLine: null }),
    ]);
    const notAtif = parseAtifDocument("other", JSON.stringify({ steps: "none" }), {});
    expect(notAtif.sessions[0]?.parsed.issues[0]?.code).toBe("unparsed_line");
  });

  test("reports an unknown schema version and step source without dropping the step", () => {
    const document = parse({
      ...(trajectory([{ step_id: 1, source: "environment", message: "reset" }]) as object),
      schema_version: "ATIF-v2.0",
    });
    const session = root(document);
    expect(session.messages[0]).toMatchObject({ role: "other" });
    expect(document.sessions[0]?.parsed.issues.map((i) => i.error)).toEqual([
      expect.stringContaining('"schema_version ATIF-v2.0"'),
      expect.stringContaining('"step source environment"'),
    ]);
  });

  test("stores timestamps in UTC ISO form and drops unreadable ones", () => {
    const session = root(
      parse(
        trajectory([
          { step_id: 1, source: "user", message: "a", timestamp: "2026-10-01T11:00:00+02:00" },
          { step_id: 2, source: "user", message: "b", timestamp: "2026-10-01T09:00:01" },
          { step_id: 3, source: "user", message: "c", timestamp: "yesterday" },
        ]),
      ),
    );
    expect(session.messages.map((m) => m.timestamp)).toEqual([
      "2026-10-01T09:00:00.000Z",
      "2026-10-01T09:00:01.000Z",
      null,
    ]);
  });

  test("falls back to the given id when the document names none", () => {
    const document = parse({
      schema_version: "ATIF-v1.7",
      agent: { name: "example-agent", version: "unknown" },
      steps: [],
    });
    expect(root(document)).toMatchObject({ sourceSessionId: "fallback", cliVersion: null });
  });
});

describe("usageFromMetrics", () => {
  test("subtracts cache reads and writes from prompt_tokens", () => {
    expect(
      usageFromMetrics({
        prompt_tokens: 100,
        completion_tokens: 10,
        cached_tokens: 60,
        extra: { cache_creation_input_tokens: 30 },
      }),
    ).toMatchObject({ input: 10, cacheRead: 60, cacheCreation: 30 });
  });

  test("keeps cache writes a producer left out of prompt_tokens", () => {
    // Harbor's OpenCode converter counts input plus cache reads only.
    expect(
      usageFromMetrics({
        prompt_tokens: 70,
        completion_tokens: 10,
        cached_tokens: 60,
        extra: { cache_write_tokens: 500 },
      }),
    ).toMatchObject({ input: 10, cacheRead: 60, cacheCreation: 500 });
  });

  test("caps reasoning at the completion it is part of", () => {
    expect(usageFromMetrics({ completion_tokens: 5, extra: { thoughts_tokens: 9 } })).toMatchObject(
      { output: 5, reasoning: 5 },
    );
  });

  test("returns null without token counts", () => {
    expect(usageFromMetrics({ cost_usd: 0.1 })).toBeNull();
    expect(usageFromMetrics(undefined)).toBeNull();
  });
});

describe("atifNativeTool", () => {
  test("maps Harbor agent names back to native sources", () => {
    expect(atifNativeTool({ agent: { name: "claude-code" } })).toBe("claude_code");
    expect(atifNativeTool({ agent: { name: "gemini-cli" } })).toBe("gemini");
    expect(atifNativeTool({ agent: { name: "terminus-2" } })).toBeNull();
    expect(atifNativeTool(null)).toBeNull();
  });
});
