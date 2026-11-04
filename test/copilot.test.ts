import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { contextWindowForSession } from "../src/context-window.ts";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import { closeDb, openDb } from "../src/db.ts";
import {
  discover,
  discoverSourcePaths,
  type IngestConfig,
  sync,
  upsertSession,
} from "../src/ingest.ts";
import { decodeMessageRaw } from "../src/message-storage.ts";
import { emptyUsage } from "../src/model.ts";
import { sessionCostParts } from "../src/model-usage.ts";
import { getSession } from "../src/query.ts";
import { setSessionUserState } from "../src/session-user-state.ts";
import {
  type CopilotModelUsage,
  chooseTotals,
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

/** A `session.usage_record` line, trimmed to the fields Decant reads. */
function usageRecord(
  id: string,
  apiCallId: string,
  model: string,
  fields: Record<string, number>,
  extra: Record<string, unknown> = {},
): string {
  return event(
    "session.usage_record",
    {
      usage: {
        model,
        apiCallId,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        maxPromptTokens: 200000,
        ...fields,
      },
    },
    id,
    extra,
  );
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

  test("counts output once across chunks of the same model call", () => {
    for (const receipt of ["none", "before", "after"]) {
      const records = [
        event(
          "assistant.message",
          { content: "first", apiCallId: "split", outputTokens: 10 },
          "m1",
        ),
        event(
          "assistant.message",
          { content: "second", apiCallId: "split", outputTokens: 10 },
          "m2",
        ),
      ];
      const usage = usageRecord("u1", "split", "gpt-5.4", { inputTokens: 100, outputTokens: 10 });
      if (receipt === "before") records.unshift(usage);
      if (receipt === "after") records.push(usage);
      const { session } = parseCopilotSession("split", records.join("\n"));
      expect(session.messages.reduce((sum, message) => sum + (message.usage?.output ?? 0), 0)).toBe(
        10,
      );
      expect(session.totals.output).toBe(10);
      expect(session.messages[1]?.usage).toBeNull();
    }
  });

  test("keeps output reported only on a call's final chunk", () => {
    const { session } = parseCopilotSession(
      "final-chunk",
      [
        event("assistant.message", { content: "first", apiCallId: "split" }, "m1"),
        event(
          "assistant.message",
          { content: "second", apiCallId: "split", outputTokens: 10 },
          "m2",
        ),
      ].join("\n"),
    );
    expect(session.totals.output).toBe(10);
    expect(session.messages[0]?.usage?.output).toBe(10);
    expect(session.messages[1]?.usage).toBeNull();
  });

  test("counts a replayed usage receipt once even with a new event ID", () => {
    const { session } = parseCopilotSession(
      "receipts",
      [
        usageRecord("u1", "call-a", "gpt-5.4", { inputTokens: 100, outputTokens: 10 }),
        usageRecord("u2", "call-a", "gpt-5.4", { inputTokens: 100, outputTokens: 10 }),
        event("assistant.message", { content: "done", apiCallId: "call-a" }, "m1"),
      ].join("\n"),
    );
    expect(session.totals).toEqual({ ...emptyUsage(), input: 100, output: 10 });
    expect(session.rawMeta).toMatchObject({ modelUsage: [{ requests: 1 }] });
  });

  test("keeps repeated reasoning from separate model calls", () => {
    const { session } = parseCopilotSession(
      "reasoning",
      [
        event("assistant.reasoning", { content: "Check the result.", apiCallId: "call-a" }, "r1"),
        event(
          "assistant.message",
          { content: "first", reasoningText: "Check the result.", apiCallId: "call-a" },
          "m1",
        ),
        event(
          "assistant.message",
          { content: "second", reasoningText: "Check the result.", apiCallId: "call-b" },
          "m2",
        ),
      ].join("\n"),
    );
    expect(
      session.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.blockType === "thinking")
        .map((block) => block.text),
    ).toEqual(["Check the result.", "Check the result."]);
  });

  test("attaches each call's usage record to its message, net of cache", () => {
    const { session, issues } = parseCopilotSession(
      "fallback",
      [
        event("session.start", { sessionId: "records", context: { cwd: "/synthetic/p" } }, "e1"),
        event("user.message", { content: "say pong" }, "e2"),
        usageRecord("e3", "call-1", "claude-sonnet-4.5", {
          inputTokens: 27417,
          outputTokens: 4,
          cacheWriteTokens: 27413,
        }),
        event(
          "assistant.message",
          { messageId: "m1", content: "pong", model: "claude-sonnet-4.5", apiCallId: "call-1" },
          "e4",
        ),
        // The second call's record follows its message, and its two messages
        // share one call; the usage goes on the first.
        event(
          "assistant.message",
          { messageId: "m2", content: "more", model: "claude-sonnet-4.5", apiCallId: "call-2" },
          "e5",
        ),
        event(
          "assistant.message",
          { messageId: "m3", content: "again", model: "claude-sonnet-4.5", apiCallId: "call-2" },
          "e6",
        ),
        usageRecord("e7", "call-2", "claude-sonnet-4.5", {
          inputTokens: 27500,
          outputTokens: 9,
          cacheReadTokens: 27413,
          cacheWriteTokens: 80,
          reasoningTokens: 3,
        }),
      ].join("\n"),
    );
    expect(issues).toEqual([]);
    expect(session.messages.filter((m) => m.role === "assistant").map((m) => m.usage)).toEqual([
      { ...emptyUsage(), input: 4, output: 4, cacheCreation: 27413 },
      { ...emptyUsage(), input: 7, output: 9, cacheRead: 27413, cacheCreation: 80, reasoning: 3 },
      null,
    ]);
    // No snapshot was written, so the records are the totals.
    expect(session.totals).toEqual({
      ...emptyUsage(),
      input: 11,
      output: 13,
      cacheRead: 27413,
      cacheCreation: 27493,
      reasoning: 3,
    });
    expect(session.reasoningSource).toBe("reported");
    expect(session.rawMeta).toMatchObject({
      model_context_window: 200000,
      modelUsage: [{ model: "claude-sonnet-4.5", requests: 2, input: 11, output: 13 }],
    });
  });

  test("counts a call made after the last snapshot from its usage record", () => {
    const lines = [
      event("user.message", { content: "go" }, "e1"),
      usageRecord("e2", "c1", "claude-haiku-4.5", { inputTokens: 1000, outputTokens: 10 }),
      event("assistant.message", { content: "a", apiCallId: "c1" }, "e3"),
      event(
        "session.usage_checkpoint",
        {
          providerModelMetrics: [
            {
              modelId: "claude-haiku-4.5",
              metrics: { requests: { count: 1 }, usage: { inputTokens: 1000, outputTokens: 10 } },
            },
          ],
        },
        "e4",
      ),
      // The session stopped mid-turn: this call has a record but no snapshot.
      usageRecord("e5", "c2", "claude-haiku-4.5", { inputTokens: 1200, outputTokens: 20 }),
      event("assistant.message", { content: "b", apiCallId: "c2" }, "e6"),
    ];
    const { session } = parseCopilotSession("fallback", lines.join("\n"));
    expect(session.totals).toMatchObject({ input: 2200, output: 30 });
  });

  test("keeps a subagent's model and prompt limit out of the main agent's", () => {
    const sub = { agentId: "agent-1" };
    const { session, issues } = parseCopilotSession(
      "fallback",
      [
        event("session.model_change", { newModel: "claude-haiku-4.5" }, "e1"),
        event("user.message", { content: "explore" }, "e2"),
        usageRecord("e3", "c1", "claude-haiku-4.5", { inputTokens: 500, outputTokens: 5 }),
        event(
          "assistant.message",
          {
            content: "",
            apiCallId: "c1",
            toolRequests: [{ toolCallId: "t1", name: "task", arguments: {} }],
          },
          "e4",
        ),
        event("session.model_change", { newModel: "gpt-5.4" }, "e5", sub),
        event("user.message", { content: "list files" }, "e6", sub),
        usageRecord(
          "e7",
          "c2",
          "gpt-5.4",
          { inputTokens: 300, outputTokens: 7, maxPromptTokens: 400000 },
          sub,
        ),
        event(
          "assistant.message",
          { content: "two files", model: "gpt-5.4", apiCallId: "c2" },
          "e8",
          sub,
        ),
        event("tool.execution_complete", { toolCallId: "t1", success: true }, "e9"),
        event("assistant.message", { content: "done" }, "e10"),
      ].join("\n"),
    );
    expect(issues).toEqual([]);
    // The last message names no model, so it takes the main agent's.
    expect(session.messages.at(-1)?.model).toBe("claude-haiku-4.5");
    expect(session.rawMeta).toMatchObject({ model_context_window: 200000 });
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

describe("chooseTotals", () => {
  test("takes the usage records when they cover the snapshots", () => {
    const ledger = snapshot({ m: { requests: 3, input: 30, output: 3 } });
    expect(chooseTotals(ledger, snapshot({ m: { requests: 2, input: 20, output: 2 } }))).toBe(
      ledger,
    );
    expect(chooseTotals(ledger, new Map())).toBe(ledger);
  });

  test("keeps the snapshots when a call wrote no record or no records exist", () => {
    const merged = snapshot({ m: { requests: 3, input: 30, output: 3 } });
    expect(chooseTotals(snapshot({ m: { requests: 2, input: 20, output: 2 } }), merged)).toBe(
      merged,
    );
    expect(chooseTotals(snapshot({ other: { requests: 9, input: 90 } }), merged)).toBe(merged);
    expect(chooseTotals(new Map(), merged)).toBe(merged);
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

  test("explicit paths honor a relocated Copilot root and exclude its sidecars", () => {
    const dir = freshDir();
    const copilotDir = join(dir, "relocated");
    const journal = join(copilotDir, "sample", "events.jsonl");
    write(journal, fixture("sample"));
    write(join(copilotDir, "sample", "events.1.jsonl"), "{}");
    write(join(copilotDir, "sample", "files", "notes.jsonl"), "{}");
    const config = { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex"), copilotDir };
    expect(discover({ ...config, sourcePaths: [journal] })).toEqual([
      { tool: "copilot", path: journal, archived: false },
    ]);
    expect(discover({ ...config, sourcePaths: [copilotDir] })).toEqual([
      { tool: "copilot", path: journal, archived: false },
    ]);
    const db = open(dir);
    expect(sync(db, { ...config, sourcePaths: [journal] })).toMatchObject({
      ingested: 1,
      issues: 0,
    });
    expect(db.query("SELECT tool FROM session").get()).toEqual({ tool: "copilot" });
    closeDb(db);
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

  test("prices unnamed legacy checkpoint usage with a known session model", () => {
    for (const model of ["gpt-5.4", null]) {
      const dir = freshDir();
      const db = open(dir);
      const parsed = parseCopilotSession(
        "legacy-cost",
        [
          event("session.start", { selectedModel: model }, "s"),
          event(
            "session.usage_checkpoint",
            {
              providerModelMetrics: [
                {
                  modelId: null,
                  metrics: {
                    requests: { count: 1 },
                    usage: {
                      inputTokens: 1000,
                      outputTokens: 100,
                      cacheReadTokens: 0,
                      cacheWriteTokens: 0,
                    },
                  },
                },
              ],
            },
            "c",
          ),
        ].join("\n"),
      );
      upsertSession(db, parsed, join(dir, "missing.jsonl"), 1, 2);
      expect(db.query("SELECT estimated_cost_usd FROM session").get()).toEqual({
        estimated_cost_usd: model == null ? 0 : 0.004,
      });
      db.exec("UPDATE session SET estimated_cost_usd = 0");
      sync(db, { claudeDir: join(dir, "none"), codexDir: join(dir, "none") });
      expect(db.query("SELECT estimated_cost_usd FROM session").get()).toEqual({
        estimated_cost_usd: model == null ? 0 : 0.004,
      });
      closeDb(db);
    }
    expect(
      sessionCostParts(
        [
          {
            model: "",
            tier: "standard",
            requests: 1,
            usage: { ...emptyUsage(), input: 1000 },
            reportedCostUsd: 0.123,
          },
        ],
        { model: "gpt-5.4", usage: emptyUsage() },
      ),
    ).toMatchObject({ input: 0, reported: 0.123 });
  });

  test("keeps a successful compaction without a summary and drops a failed one", () => {
    const dir = freshDir();
    const db = open(dir);
    const parsed = parseCopilotSession(
      "compaction-variants",
      [
        event("session.compaction_complete", { success: true, preCompactionTokens: 8000 }, "c1"),
        event(
          "session.compaction_complete",
          { success: false, summaryContent: "partial", preCompactionTokens: 9000 },
          "c2",
        ),
      ].join("\n"),
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.messages.map((message) => [message.role, message.blocks.length])).toEqual(
      [["system", 0]],
    );
    upsertSession(db, parsed, join(dir, "missing.jsonl"), 1, 2);
    const id = (db.query("SELECT id FROM session").get() as { id: number }).id;
    expect(contextWindowForSession(db, id)).toMatchObject({
      peak_tokens: 8000,
      compactions: [{ pre_tokens: 8000 }],
    });
    expect(db.query("SELECT compaction_count FROM session").get()).toEqual({ compaction_count: 1 });
    closeDb(db);
  });

  test("keeps recorded compaction occupancy and repairs old compressed metadata without a source", () => {
    for (const [compressed, preTokens] of [
      [false, 9000],
      [true, 9000],
      [true, undefined],
    ] as const) {
      const dir = freshDir();
      const db = open(dir);
      const parsed = parseCopilotSession(
        "compaction",
        event(
          "session.compaction_complete",
          {
            success: true,
            summaryContent: compressed ? "synthetic summary ".repeat(200) : "summary",
            preCompactionTokens: preTokens,
            postCompactionTokens: 1200,
          },
          "compact",
        ),
      );
      upsertSession(db, parsed, join(dir, "missing.jsonl"), 1, 2);
      const id = (db.query("SELECT id FROM session").get() as { id: number }).id;
      expect(contextWindowForSession(db, id)).toMatchObject({
        peak_tokens: preTokens ?? 0,
        compactions: [{ pre_tokens: preTokens ?? null }],
      });
      const before = db.query("SELECT raw FROM message").get() as { raw: string | Uint8Array };
      expect(typeof before.raw === "string").toBe(!compressed);
      db.exec(
        "UPDATE message SET raw_meta = CASE WHEN typeof(raw) = 'blob' THEN '{\"type\":\"session.compaction_complete\"}' ELSE NULL END; UPDATE session SET peak_context_tokens = 0",
      );
      setSessionUserState(db, id, "archived");
      const config = { claudeDir: join(dir, "none"), codexDir: join(dir, "none") };
      expect(sync(db, config)).toMatchObject({ ingested: 0, scanned: 0 });
      expect(db.query("SELECT peak_context_tokens FROM session").get()).toEqual({
        peak_context_tokens: preTokens ?? 0,
      });
      expect(getSession(db, id)?.messages[0]).toMatchObject({
        compact_pre_tokens: preTokens ?? null,
      });
      const after = db.query("SELECT raw FROM message").get() as { raw: string | Uint8Array };
      expect(decodeMessageRaw(after.raw)).toBe(decodeMessageRaw(before.raw));
      expect(db.query("SELECT state FROM session_user_state").get()).toEqual({ state: "archived" });
      const writes = db.query("SELECT total_changes() AS n").get() as { n: number };
      sync(db, config);
      expect(db.query("SELECT total_changes() AS n").get()).toEqual(writes);
      closeDb(db);
    }
  });

  test("files a subagent's inline events as sidechain rows outside the parent's turns and context", () => {
    const dir = freshDir();
    const copilotDir = join(dir, "copilot", "session-state");
    const sub = { agentId: "agent-1" };
    write(
      join(copilotDir, "inline-subagent", "events.jsonl"),
      [
        event("session.start", { sessionId: "inline-subagent" }, "e1"),
        event("user.message", { content: "explore the repo" }, "e2"),
        usageRecord("e3", "c1", "claude-haiku-4.5", {
          inputTokens: 1000,
          outputTokens: 5,
          cacheReadTokens: 900,
        }),
        event(
          "assistant.message",
          {
            content: "",
            model: "claude-haiku-4.5",
            apiCallId: "c1",
            toolRequests: [{ toolCallId: "t1", name: "task", arguments: {} }],
          },
          "e4",
        ),
        event("user.message", { content: "list the files" }, "e5", sub),
        usageRecord("e6", "c2", "gpt-5.4", { inputTokens: 9000, outputTokens: 7 }, sub),
        event(
          "assistant.message",
          { content: "two files", model: "gpt-5.4", apiCallId: "c2" },
          "e7",
          sub,
        ),
        event("tool.execution_complete", { toolCallId: "t1", success: true }, "e8"),
        usageRecord("e9", "c3", "claude-haiku-4.5", { inputTokens: 1100, outputTokens: 4 }),
        event(
          "assistant.message",
          { content: "done", model: "claude-haiku-4.5", apiCallId: "c3" },
          "e10",
        ),
      ].join("\n"),
    );
    const db = open(dir);
    expect(
      sync(db, { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex"), copilotDir }),
    ).toMatchObject({ ingested: 1, issues: 0 });
    const row = db
      .query(
        `SELECT id, turn_count, sidechain_message_count, context_window_tokens, peak_context_tokens
           FROM session`,
      )
      .get() as { id: number } & Record<string, number>;
    // The subagent's 9000-token prompt is its own context, not the parent's.
    expect(row).toMatchObject({
      turn_count: 1,
      sidechain_message_count: 2,
      context_window_tokens: 200000,
      peak_context_tokens: 1100,
    });
    const transcript = getSession(db, row.id)?.messages ?? [];
    expect(transcript.filter((m) => m.is_sidechain).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    closeDb(db);
  });
});
