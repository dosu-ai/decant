import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import { closeDb, openDb } from "../src/db.ts";
import { discover, discoverSourcePaths, type IngestConfig, sync } from "../src/ingest.ts";
import { emptyUsage } from "../src/model.ts";
import {
  type CopilotModelUsage,
  mergeSnapshots,
  parseCopilotSession,
  type UsageSnapshot,
} from "../src/sources/copilot.ts";
import { totals as statsTotals } from "../src/stats.ts";

const workDir = realpathSync(mkdtempSync(join(tmpdir(), "decant-copilot-test-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshDir(): string {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fixture(name: string): string {
  return readFileSync(
    join(import.meta.dir, "..", "fixtures", "copilot", name, "events.jsonl"),
    "utf8",
  );
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** One event line in the shape Copilot CLI writes. */
function event(
  type: string,
  data: Record<string, unknown>,
  id: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type,
    data,
    id,
    parentId: null,
    timestamp: "2026-10-05T08:00:00.000Z",
    ...extra,
  });
}

function usage(fields: Partial<CopilotModelUsage>): CopilotModelUsage {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...fields };
}

function snapshot(entries: Record<string, Partial<CopilotModelUsage>>): UsageSnapshot {
  return new Map(Object.entries(entries).map(([model, fields]) => [model, usage(fields)]));
}

describe("parseCopilotSession", () => {
  test("normalizes the synthetic sample session", () => {
    const parsed = parseCopilotSession("fallback", fixture("sample"));
    const { session } = parsed;

    expect(parsed.issues).toEqual([]);
    expect(session).toMatchObject({
      tool: "copilot",
      sourceSessionId: "copilot-sample-session",
      projectPath: "/synthetic/copilot-project",
      cwd: "/synthetic/copilot-project",
      gitBranch: "main",
      title: "hello, please fix the greeting in README.md",
      model: "claude-sonnet-4.5",
      reasoningEffort: "mixed",
      reasoningEffortLevels: ["medium", "high"],
      cliVersion: "1.0.105",
      startedAt: "2026-10-01T10:00:00.000Z",
      endedAt: "2026-10-01T10:03:00.000Z",
      isSubagent: false,
      reasoningSource: "reported",
      // Copilot counts cache reads and writes inside inputTokens.
      totals: {
        input: 8000 + 4000,
        output: 155 + 70,
        cacheRead: 30000 + 8000,
        cacheCreation: 2000,
        cacheCreation1h: 0,
        reasoning: 30,
      },
    });
    expect(session.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
      "system",
      "other",
      "user",
      "other",
    ]);
  });

  test("stores reasoning once when the message repeats its reasoning event", () => {
    const { session } = parseCopilotSession("fallback", fixture("sample"));
    const thinking = session.messages.flatMap((message) =>
      message.blocks.filter((block) => block.blockType === "thinking"),
    );
    expect(thinking.map((block) => block.text)).toEqual(["Read the README before editing it."]);
  });

  test("links tool requests to results and dates calls from execution start", () => {
    const { session } = parseCopilotSession("fallback", fixture("sample"));
    const uses = session.messages.flatMap((message) =>
      message.blocks.filter((block) => block.blockType === "tool_use"),
    );
    expect(uses.map((block) => [block.toolName, block.toolUseId])).toEqual([
      ["view", "call-view"],
      ["report_intent", "call-intent"],
      ["edit", "call-edit"],
      ["bash", "call-bash"],
      ["mcp__example__search", "call-mcp"],
      ["create", "call-create"],
    ]);
    // The edit waited on a permission prompt, so it ran after its response.
    expect(uses[2]?.calledAt).toBe("2026-10-01T10:00:14.000Z");

    const results = session.messages.flatMap((message) =>
      message.blocks.filter((block) => block.blockType === "tool_result"),
    );
    const bash = results.find((block) => block.toolUseId === "call-bash");
    expect(bash).toMatchObject({ toolResult: "1 test failed", isError: true });
    expect(results.find((block) => block.toolUseId === "call-view")).toMatchObject({
      toolResult: "1. # Helo world",
      isError: false,
    });
  });

  test("dates each response's output tokens on its message", () => {
    const { session } = parseCopilotSession("fallback", fixture("sample"));
    const outputs = session.messages
      .filter((message) => message.usage != null)
      .map((message) => [message.model, message.usage?.output, message.usage?.input]);
    expect(outputs).toEqual([
      ["claude-sonnet-4.5", 40, 0],
      ["claude-sonnet-4.5", 60, 0],
      ["claude-sonnet-4.5", 30, 0],
      ["claude-sonnet-4.5", 25, 0],
      ["gpt-5.4", 50, 0],
      ["gpt-5.4", 20, 0],
    ]);
  });

  test("keeps subagent events in the parent and sums runs a resume restarted", () => {
    const { session, issues } = parseCopilotSession("fallback", fixture("resumed"));
    expect(issues).toEqual([]);
    expect(session.sourceSessionId).toBe("copilot-resumed-session");
    expect(session.gitBranch).toBe("feature");
    // Run one: 3000 in (1000 cached). Run two restarted at zero: 2500 in (1500 cached).
    expect(session.totals).toEqual({
      input: 2000 + 1000,
      output: 12 + 37,
      cacheRead: 1000 + 1500,
      cacheCreation: 0,
      cacheCreation1h: 0,
      reasoning: 0,
    });
    expect(session.reasoningSource).toBe("none");
    const glob = session.messages.find((message) =>
      message.blocks.some((block) => block.toolName === "glob"),
    );
    expect(glob?.raw).toMatchObject({ agentId: "agent-explore-1" });
    expect(session.rawMeta).toMatchObject({
      modelUsage: [
        {
          model: "claude-haiku-4.5",
          requests: 4,
          input: 3000,
          output: 49,
          cacheRead: 2500,
          cacheCreation: 0,
        },
      ],
    });
  });

  test("reports malformed lines and unknown types, and skips ephemeral and repeated events", () => {
    const content = [
      event("session.start", { sessionId: "s-1", startTime: "2026-10-05T08:00:00.000Z" }, "e1"),
      "{not json",
      event("user.message", { content: "hello" }, "e2"),
      event("user.message", { content: "hello" }, "e2"),
      event("assistant.message_delta", { deltaContent: "hel" }, "e3", { ephemeral: true }),
      event("assistant.message", { messageId: "m", content: "hi", outputTokens: 3 }, "e4"),
      event("session.future_feature", {}, "e5"),
      event("session.future_feature", {}, "e6"),
      event("assistant.turn_end", { turnId: "0" }, "e7"),
      "",
    ].join("\n");
    const { session, issues } = parseCopilotSession("fallback", content);

    expect(issues.map((issue) => [issue.code, issue.lineNo])).toEqual([
      ["unparsed_line", 2],
      ["unknown_record_type", 7],
    ]);
    expect(issues[1]?.error).toContain('"session.future_feature" on 2 line(s)');
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    // No usage snapshot yet: only the response's output is known.
    expect(session.totals).toEqual({ ...emptyUsage(), output: 3 });
    expect(session.model).toBeNull();
  });

  test("falls back to the directory name and keeps an orphan result as a diagnostic", () => {
    const content = [
      event("user.message", { content: "run it" }, "e1"),
      event("tool.execution_complete", { toolCallId: "lost", success: true }, "e2"),
    ].join("\n");
    const { session, issues } = parseCopilotSession("dir-session-id", content);
    expect(session.sourceSessionId).toBe("dir-session-id");
    expect(issues.map((issue) => issue.code)).toEqual(["orphan_tool_result"]);
  });

  test("records a tool that ran without a recorded request", () => {
    const content = [
      event("session.start", { sessionId: "s", selectedModel: "gpt-5.4" }, "e1"),
      event(
        "tool.execution_start",
        { toolCallId: "u-1", toolName: "bash", arguments: { command: "ls" } },
        "e2",
      ),
      event(
        "tool.execution_complete",
        { toolCallId: "u-1", success: true, result: { content: "a" } },
        "e3",
      ),
    ].join("\n");
    const { session, issues } = parseCopilotSession("fallback", content);
    expect(issues).toEqual([]);
    expect(session.messages[0]).toMatchObject({ role: "assistant", model: "gpt-5.4" });
    expect(session.messages[0]?.blocks[0]).toMatchObject({
      blockType: "tool_use",
      toolName: "bash",
      toolUseId: "u-1",
      toolInput: { command: "ls" },
    });
  });

  test("reads checkpoint usage by model id, adding providers that serve one model", () => {
    const content = [
      event("session.start", { sessionId: "s" }, "e1"),
      event(
        "session.usage_checkpoint",
        {
          totalNanoAiu: 0,
          providerModelMetrics: [
            {
              modelId: "gpt-5.4",
              metrics: {
                requests: { count: 1, cost: 0 },
                usage: {
                  inputTokens: 100,
                  outputTokens: 5,
                  cacheReadTokens: 40,
                  cacheWriteTokens: 0,
                },
              },
            },
            {
              modelId: "gpt-5.4",
              metrics: {
                requests: { count: 2, cost: 0 },
                usage: {
                  inputTokens: 50,
                  outputTokens: 5,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              },
            },
            {
              modelId: null,
              metrics: {
                requests: { count: 1, cost: 0 },
                usage: {
                  inputTokens: 10,
                  outputTokens: 1,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              },
            },
          ],
        },
        "e2",
      ),
    ].join("\n");
    const { session } = parseCopilotSession("fallback", content);
    expect(session.rawMeta).toMatchObject({
      modelUsage: [
        { model: "gpt-5.4", requests: 3, input: 110, output: 10, cacheRead: 40 },
        { model: "", requests: 1, input: 10, output: 1, cacheRead: 0 },
      ],
    });
    expect(session.model).toBe("gpt-5.4");
  });
});

describe("mergeSnapshots", () => {
  test("takes the last of cumulative snapshots", () => {
    const merged = mergeSnapshots([
      snapshot({ a: { requests: 1, input: 10, output: 1 } }),
      snapshot({ a: { requests: 2, input: 30, output: 4 }, b: { requests: 1, output: 2 } }),
    ]);
    expect(merged).toEqual(
      snapshot({ a: { requests: 2, input: 30, output: 4 }, b: { requests: 1, output: 2 } }),
    );
  });

  test("keeps a run's usage when the next snapshot restarts below it", () => {
    const merged = mergeSnapshots([
      snapshot({ a: { requests: 3, input: 300, output: 9 } }),
      snapshot({ a: { requests: 1, input: 100, output: 2 } }),
      snapshot({ a: { requests: 2, input: 150, output: 5 } }),
    ]);
    expect(merged).toEqual(snapshot({ a: { requests: 5, input: 450, output: 14 } }));
  });

  test("treats a snapshot that drops a model as a restart", () => {
    const merged = mergeSnapshots([snapshot({ a: { requests: 1, input: 10 } }), snapshot({})]);
    expect(merged).toEqual(snapshot({ a: { requests: 1, input: 10 } }));
  });

  test("returns no usage without snapshots", () => {
    expect(mergeSnapshots([])).toEqual(new Map());
  });
});

describe("Copilot ingest", () => {
  function stage(dir: string, names: string[]): IngestConfig {
    const copilotDir = join(dir, "copilot", "session-state");
    for (const name of names) {
      write(join(copilotDir, name, "events.jsonl"), fixture(name));
    }
    return { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex"), copilotDir };
  }

  function open(dir: string): Database {
    return openDb(join(dir, "archive.db"));
  }

  test("discovers each session's journal and nothing else in its directory", () => {
    const dir = freshDir();
    const config = stage(dir, ["sample"]);
    const sessionDir = join(config.copilotDir ?? "", "sample");
    write(join(sessionDir, "events.1.jsonl"), "");
    write(join(sessionDir, "plan.md"), "");
    write(join(sessionDir, "files", "notes.jsonl"), "");
    mkdirSync(join(config.copilotDir ?? "", "empty-session"), { recursive: true });

    expect(discover(config).map((file) => [file.tool, file.path])).toEqual([
      ["copilot", join(sessionDir, "events.jsonl")],
    ]);
    // --path keeps the same rule, and never reads a session's own files as a
    // Claude Code transcript.
    expect(
      discoverSourcePaths([config.copilotDir ?? ""]).map((file) => [
        file.tool,
        basename(dirname(file.path)),
        basename(file.path),
      ]),
    ).toEqual([["copilot", "sample", "events.jsonl"]]);
  });

  test("ingests sessions with per-model cost, file references, and facets", () => {
    const dir = freshDir();
    const config = stage(dir, ["sample", "resumed"]);
    const db = open(dir);

    expect(sync(db, config)).toMatchObject({ scanned: 2, ingested: 2, issues: 0, failed: 0 });
    // Unchanged journals are skipped on the next sync.
    expect(sync(db, config)).toMatchObject({ scanned: 2, ingested: 0, skipped: 2 });

    const sample = db
      .query(
        `SELECT id, tool, model, cli_version, git_branch, total_input_tokens, total_output_tokens,
                total_cache_read_tokens, total_cache_creation_tokens, total_reasoning_tokens,
                estimated_cost_usd, compaction_count, interruption_count, error_count, turn_count
           FROM session WHERE source_session_id = 'copilot-sample-session'`,
      )
      .get() as Record<string, number | string> & { id: number };
    const pricing = defaultPricing();
    const expectedCost =
      estimateCost(
        "claude-sonnet-4.5",
        { ...emptyUsage(), input: 8000, output: 155, cacheRead: 30000, cacheCreation: 2000 },
        pricing,
      ) +
      estimateCost(
        "gpt-5.4",
        { ...emptyUsage(), input: 4000, output: 70, cacheRead: 8000, reasoning: 30 },
        pricing,
      );
    expect(sample).toMatchObject({
      tool: "copilot",
      model: "claude-sonnet-4.5",
      cli_version: "1.0.105",
      git_branch: "main",
      total_input_tokens: 12000,
      total_output_tokens: 225,
      total_cache_read_tokens: 38000,
      total_cache_creation_tokens: 2000,
      total_reasoning_tokens: 30,
      compaction_count: 1,
      interruption_count: 1,
      error_count: 1,
      turn_count: 3,
    });
    expect(expectedCost).toBeGreaterThan(0);
    expect(sample.estimated_cost_usd).toBeCloseTo(expectedCost, 10);

    expect(
      db
        .query(
          `SELECT model, requests, input_tokens, output_tokens, cache_read_tokens,
                  cache_creation_tokens
             FROM session_model_usage WHERE session_id = ?1 ORDER BY model`,
        )
        .all(sample.id),
    ).toEqual([
      {
        model: "claude-sonnet-4.5",
        requests: 4,
        input_tokens: 8000,
        output_tokens: 155,
        cache_read_tokens: 30000,
        cache_creation_tokens: 2000,
      },
      {
        model: "gpt-5.4",
        requests: 2,
        input_tokens: 4000,
        output_tokens: 70,
        cache_read_tokens: 8000,
        cache_creation_tokens: 0,
      },
    ]);

    expect(
      db
        .query("SELECT rel_path, operation FROM file_ref WHERE session_id = ?1 ORDER BY id")
        .all(sample.id),
    ).toEqual([
      { rel_path: "README.md", operation: "read" },
      { rel_path: "README.md", operation: "edit" },
      { rel_path: "CHANGELOG.md", operation: "write" },
    ]);

    expect(
      db
        .query(
          `SELECT agent_spawn_count FROM session
            WHERE source_session_id = 'copilot-resumed-session'`,
        )
        .get(),
    ).toEqual({ agent_spawn_count: 1 });

    expect(statsTotals(db, { source: "copilot_cli" }).sessions).toBe(2);
    closeDb(db);
  });
});
