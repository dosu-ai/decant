import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import type { Json } from "../src/model.ts";
import {
  innerToolCalls,
  innerToolName,
  mcpServerPrefixes,
  normalizeOpenCodeToolName,
  type OpenCodeMessageRow,
  type OpenCodeParseContext,
  type OpenCodeSessionRow,
  parseOpenCodeSession,
} from "../src/sources/opencode.ts";
import { OpenCodeStore } from "../src/sources/opencode-store.ts";
import { openCodeUsage } from "../src/sources/opencode-usage.ts";
import { buildOpenCodeFixtureDb } from "./opencode-fixture.ts";
import { STEP_TIMES, timingMessageRows, timingSessionRow } from "./opencode-timing.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-opencode-parser-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const T0 = 1791786000000; // 2026-10-12T06:20:00.000Z
const GLM = { providerID: "opencode-go", id: "glm-5.3-flash", variant: "max" };

const context: OpenCodeParseContext = {
  mcpServers: ["dosu", "my server"],
  contextWindows: new Map([["opencode-go/glm-5.3-flash", 1_000_000]]),
};

function sessionRow(overrides: Partial<OpenCodeSessionRow> = {}): OpenCodeSessionRow {
  return {
    id: "ses_inline",
    project_id: "prj_inline",
    parent_id: null,
    fork_session_id: null,
    fork_boundary: null,
    slug: "inline",
    directory: "/decant-fixture/example",
    title: "Inline session",
    version: "2.0.27",
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    agent: "build",
    model: JSON.stringify(GLM),
    time_created: T0,
    time_updated: T0 + 60_000,
    time_archived: null,
    ...overrides,
  };
}

function msg(
  seq: number,
  type: string,
  data: Json | string,
  timeCreated = T0 + seq * 1000,
): OpenCodeMessageRow {
  return {
    id: `msg_${seq}`,
    session_id: "ses_inline",
    type,
    seq,
    time_created: timeCreated,
    time_updated: timeCreated,
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
}

function assistant(seq: number, extra: Record<string, Json>): OpenCodeMessageRow {
  return msg(seq, "assistant", {
    agent: "build",
    model: GLM,
    content: [],
    time: { created: T0 + seq * 1000, completed: T0 + seq * 1000 + 500 },
    ...extra,
  });
}

let fixtureCount = 0;

function fixtureSession(name: string, sessionId: string, mcpServers: string[] = []) {
  // Each call builds a fresh database: the same fixture is parsed by several tests.
  fixtureCount += 1;
  const dir = join(workDir, `${fixtureCount}-${name}-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "opencode.db");
  buildOpenCodeFixtureDb(path, [name]);
  const store = OpenCodeStore.open(path);
  try {
    const loaded = store.loadSession(sessionId);
    if (loaded == null) throw new Error(`fixture ${name} lacks ${sessionId}`);
    return parseOpenCodeSession(loaded.session, loaded.messages, {
      mcpServers,
      contextWindows: store.contextWindows(),
    });
  } finally {
    store.close();
  }
}

describe("parseOpenCodeSession", () => {
  test("parses the sample fixture into messages, usage, effort, and linked tool calls", () => {
    const parsed = fixtureSession("sample.sql", "ses_sample");
    const { session } = parsed;
    expect(parsed.issues).toEqual([]);
    expect(session).toMatchObject({
      tool: "opencode",
      sourceSessionId: "ses_sample",
      projectPath: "/decant-fixture/example",
      cwd: "/decant-fixture/example",
      title: "Summarize the example file",
      model: "glm-5.3-flash",
      reasoningEffort: "max",
      reasoningEffortLevels: ["max"],
      cliVersion: "2.0.27",
      startedAt: "2026-10-12T06:20:00.000Z",
      endedAt: "2026-10-12T06:21:00.000Z",
      isArchived: false,
      isSubagent: false,
      agentType: "build",
      reasoningSource: "reported",
      totals: {
        input: 320,
        output: 52,
        cacheRead: 100,
        cacheCreation: 16,
        cacheCreation1h: 0,
        reasoning: 10,
      },
    });
    expect(session.rawMeta).toMatchObject({
      model_provider: "opencode-go",
      model_variant: "max",
      model_context_window: 1_000_000,
      cost: 0.0000794,
    });
    expect(session.messages.map((m) => [m.seq, m.role])).toEqual([
      [0, "user"],
      [1, "assistant"],
      [2, "tool"],
      [3, "assistant"],
    ]);
    expect(session.messages[0]?.blocks).toMatchObject([
      { ordinal: 0, blockType: "text", text: "Read the example file and summarize it." },
    ]);
    expect(session.messages[1]).toMatchObject({
      model: "glm-5.3-flash",
      stopReason: "tool-calls",
      // The step's `time.streamed`: generation ended, the tool still running.
      timestamp: "2026-10-12T06:20:02.600Z",
      usage: { input: 120, output: 40, reasoning: 10, cacheRead: 40, cacheCreation: 16 },
    });
    expect(session.messages[1]?.blocks).toMatchObject([
      { ordinal: 0, blockType: "thinking", text: "Read the file before answering." },
      {
        ordinal: 1,
        blockType: "tool_use",
        toolName: "read",
        toolUseId: "call_read_1",
        toolInput: { path: "/decant-fixture/example/notes.txt" },
      },
    ]);
    expect(session.messages[2]).toMatchObject({
      timestamp: "2026-10-12T06:20:03.000Z",
      usage: null,
      blocks: [
        {
          ordinal: 0,
          blockType: "tool_result",
          toolUseId: "call_read_1",
          toolResult: "hello",
          isError: false,
        },
      ],
    });
    expect(session.messages[2]?.raw).toMatchObject({
      type: "tool",
      id: "call_read_1",
      name: "read",
    });
    expect(session.messages[1]?.raw).toMatchObject({
      id: "msg_sample_2",
      type: "assistant",
      seq: 2,
      cost: 0.0000416,
    });
    expect(session.messages[3]).toMatchObject({
      stopReason: "stop",
      usage: { input: 200, output: 12, cacheRead: 60 },
    });
  });

  test("reproduces OpenCode's recorded cost from the mapped usage", () => {
    const pricing = defaultPricing();
    for (const [fixture, sessionId] of [
      ["sample.sql", "ses_sample"],
      ["mcp.sql", "ses_mcp"],
    ] as const) {
      const { session } = fixtureSession(fixture, sessionId);
      let total = 0;
      for (const message of session.messages) {
        if (message.role !== "assistant" || message.usage == null) continue;
        const recorded = (message.raw as { cost: number }).cost;
        expect(estimateCost(message.model ?? "", message.usage, pricing)).toBeCloseTo(recorded, 9);
        total += recorded;
      }
      expect(estimateCost(session.model ?? "", session.totals, pricing)).toBeCloseTo(total, 9);
      expect(total).toBeCloseTo((session.rawMeta as { cost: number }).cost, 9);
    }
  });

  test("folds reasoning into output and keeps cache writes", () => {
    const { session } = parseOpenCodeSession(
      sessionRow(),
      [
        assistant(1, {
          tokens: { input: 10, output: 5, reasoning: 7, cache: { read: 3, write: 2 } },
        }),
      ],
      context,
    );
    expect(session.messages[0]?.usage).toEqual({
      input: 10,
      output: 12,
      cacheRead: 3,
      cacheCreation: 2,
      cacheCreation1h: 0,
      reasoning: 7,
    });
    expect(session.totals).toEqual(
      session.messages[0]?.usage as NonNullable<typeof session.totals>,
    );
  });

  test("maps 2.x tokens exactly as the shared mapping does for disjoint rows", () => {
    // One mapping serves both readers: a 2.x row is the 1.x "disjoint" case.
    const cases: Record<string, Json>[] = [
      { input: 10, output: 5, reasoning: 7, cache: { read: 3, write: 2 } },
      { input: 120, output: 30, reasoning: 0, cache: { read: 40, write: 16 } },
      { input: 4, output: 2, reasoning: 9 },
      { input: -1, output: 2.5, reasoning: "3", cache: { read: null, write: 7 } },
      {},
    ];
    for (const tokens of cases) {
      const { session } = parseOpenCodeSession(sessionRow(), [assistant(1, { tokens })], context);
      expect(session.messages[0]?.usage ?? null).toEqual(openCodeUsage(tokens, "disjoint"));
    }
  });

  test("names MCP tools from the configured servers and classifies web search as a tool call", () => {
    const parsed = fixtureSession("mcp.sql", "ses_mcp", ["dosu"]);
    expect(parsed.issues).toEqual([]);
    const names = parsed.session.messages.flatMap((m) =>
      m.blocks.filter((b) => b.blockType === "tool_use").map((b) => b.toolName),
    );
    expect(names).toEqual(["mcp__dosu__search_knowledge", "websearch", "execute", "webfetch"]);
    const results = parsed.session.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.blocks[0]);
    expect(results).toMatchObject([
      { toolUseId: "call_mcp_1", toolResult: "example result", isError: false },
      { toolUseId: "call_web_1", toolResult: "example page", isError: false },
      { toolUseId: "call_exec_1", toolResult: "example knowledge", isError: false },
      { toolUseId: "call_fetch_1", toolResult: "fetch failed", isError: true },
    ]);
    expect(parsed.session.model).toBe("meta/muse-wonder");
    expect(parsed.session.rawMeta).toMatchObject({
      model_provider: "openrouter",
      model_context_window: 1_048_576,
    });
    expect(parsed.session.reasoningEffort).toBe("high");
  });

  test("records each call an execute program made on the execute tool_use block", () => {
    const parsed = fixtureSession("mcp.sql", "ses_mcp", ["dosu"]);
    const blocks = parsed.session.messages.flatMap((m) => m.blocks);
    const execute = blocks.find((b) => b.toolName === "execute");
    expect(execute?.toolInput).toMatchObject({ code: expect.stringContaining("read_knowledge") });
    expect(execute?.innerToolCalls).toEqual([
      {
        toolName: "mcp__dosu__read_knowledge",
        toolUseId: "call_exec_1#0",
        toolInput: { query: "example topic" },
        isError: false,
      },
      {
        toolName: "mcp__exa__web_search_exa",
        toolUseId: "call_exec_1#1",
        toolInput: { query: "example topic" },
        isError: true,
      },
      {
        toolName: "search",
        toolUseId: "call_exec_1#2",
        toolInput: { query: "example" },
        isError: false,
      },
      {
        toolName: "opencode.list_mcp_resources",
        toolUseId: "call_exec_1#3",
        toolInput: undefined,
        isError: false,
      },
    ]);
    // Inner calls add no blocks: the program and its one result are the only
    // transcript text, so search and transcripts show nothing twice.
    expect(blocks.filter((b) => b.blockType === "tool_use")).toHaveLength(4);
    expect(blocks.filter((b) => b.blockType === "tool_result")).toHaveLength(4);
    expect(blocks.filter((b) => b.innerToolCalls != null).map((b) => b.toolUseId)).toEqual([
      "call_exec_1",
    ]);
  });

  test("names inner calls by namespace and tolerates sparse execute metadata", () => {
    expect(innerToolName("dosu.write_knowledge")).toBe("mcp__dosu__write_knowledge");
    expect(innerToolName("probe-tools.echo")).toBe("mcp__probe-tools__echo");
    expect(innerToolName("context7.resolve-library-id")).toBe("mcp__context7__resolve-library-id");
    expect(innerToolName("my server.run it")).toBe("mcp__my_server__run_it");
    expect(innerToolName("opencode.list_mcp_resources")).toBe("opencode.list_mcp_resources");
    expect(innerToolName("search")).toBe("search");
    expect(innerToolName(".hidden")).toBe(".hidden");
    expect(innerToolName("trailing.")).toBe("trailing.");

    expect(innerToolCalls(undefined, "call_1")).toEqual([]);
    expect(innerToolCalls({ tool: "dosu.whoami" }, "call_1")).toEqual([]);
    expect(
      innerToolCalls(
        [
          { tool: "dosu.whoami", status: "running" },
          { status: "completed" },
          "not an object",
          { tool: "github.get_me", status: "completed", input: { a: 1 } },
        ],
        null,
      ),
    ).toEqual([
      { toolName: "mcp__dosu__whoami", toolUseId: null, toolInput: undefined, isError: null },
      {
        toolName: "mcp__github__get_me",
        toolUseId: null,
        toolInput: { a: 1 },
        isError: false,
      },
    ]);

    const toolCalls = [{ tool: "dosu.whoami", status: "completed" }];
    const tool = (name: string, status: string) => ({
      type: "tool",
      id: `call_${name}`,
      name,
      state: { status, input: {}, content: [], metadata: { toolCalls } },
    });
    const { session } = parseOpenCodeSession(
      sessionRow(),
      [
        assistant(1, {
          content: [tool("execute", "completed"), tool("read", "completed")],
        }),
        assistant(2, { content: [tool("execute", "running")] }),
      ],
      context,
    );
    const calls = session.messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.blockType === "tool_use")
      .map((b) => [b.toolName, b.innerToolCalls?.map((c) => c.toolUseId) ?? null]);
    // Only `execute` carries inner calls; a running one records those so far.
    expect(calls).toEqual([
      ["execute", ["call_execute#0"]],
      ["read", null],
      ["execute", ["call_execute#0"]],
    ]);
  });

  test("normalizes MCP names by the longest sanitized server prefix", () => {
    const prefixes = mcpServerPrefixes(["a", "a_b", "my server", ""]);
    expect(prefixes).toEqual(["my_server", "a_b", "a"]);
    expect(normalizeOpenCodeToolName("a_b_tool", prefixes)).toBe("mcp__a_b__tool");
    expect(normalizeOpenCodeToolName("a_tool", prefixes)).toBe("mcp__a__tool");
    expect(normalizeOpenCodeToolName("my_server_run", prefixes)).toBe("mcp__my_server__run");
    expect(normalizeOpenCodeToolName("shell", prefixes)).toBe("shell");
    expect(normalizeOpenCodeToolName("a_", prefixes)).toBe("a_");
    expect(normalizeOpenCodeToolName("dosu_search", [])).toBe("dosu_search");
  });

  test("drops rows a fork inherited from its parent", () => {
    const { session } = parseOpenCodeSession(
      sessionRow({ fork_session_id: "ses_parent", fork_boundary: "msg_0", time_created: T0 }),
      [
        msg(1, "user", { text: "inherited prompt", time: { created: T0 - 5000 } }, T0 - 5000),
        assistant(2, {
          tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: T0 - 4000 },
        }),
        msg(3, "user", { text: "own prompt", time: { created: T0 + 1000 } }, T0 + 1000),
        assistant(4, {
          tokens: { input: 70, output: 9, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ].map((row, index) =>
        index === 1 ? { ...row, time_created: T0 - 4000, time_updated: T0 - 4000 } : row,
      ),
      context,
    );
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.totals).toMatchObject({ input: 70, output: 9 });
    expect(session.rawMeta).toMatchObject({ fork_session_id: "ses_parent", fork_rows_skipped: 2 });
    expect(session.title).toBe("Inline session");
  });

  test("drops inherited rows of a fork OpenCode migrated from 1.x, which has no fork link", () => {
    const { session } = parseOpenCodeSession(
      sessionRow({ version: "1.18.35", time_created: T0 }),
      [
        msg(1, "user", { text: "inherited prompt", time: { created: T0 - 5000 } }, T0 - 5000),
        msg(2, "user", { text: "own prompt", time: { created: T0 + 1000 } }, T0 + 1000),
        assistant(3, {
          tokens: { input: 70, output: 9, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ],
      context,
    );
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.rawMeta).toMatchObject({ fork_session_id: null, fork_rows_skipped: 1 });
  });

  test("keeps a native 2.x row that predates its session when there is no fork link", () => {
    // A clock step backwards must not drop a native session's usage.
    const { session } = parseOpenCodeSession(
      sessionRow({ version: "2.0.27", time_created: T0 }),
      [
        msg(1, "user", { text: "early prompt", time: { created: T0 - 5000 } }, T0 - 5000),
        assistant(2, {
          tokens: { input: 70, output: 9, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ],
      context,
    );
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.totals).toMatchObject({ input: 70, output: 9 });
    expect(session.rawMeta).not.toHaveProperty("fork_rows_skipped");
  });

  test("keeps reasoning inside output for a row migrated from a pre-1.3.16 session", () => {
    const tokens = { input: 100, output: 50, reasoning: 20, cache: { read: 0, write: 0 } };
    const usage = (version: string) =>
      parseOpenCodeSession(sessionRow({ version }), [assistant(1, { tokens })], context).session
        .messages[0]?.usage;
    expect(usage("1.3.10")).toMatchObject({ input: 100, output: 50, reasoning: 20 });
    expect(usage("0.0.0-dev-202603010000")).toMatchObject({ output: 50, reasoning: 20 });
    expect(usage("1.3.16")).toMatchObject({ output: 70, reasoning: 20 });
    expect(usage("2.0.27")).toMatchObject({ output: 70, reasoning: 20 });
  });

  test("corrects migrated rows from the 1.x copy and leaves later rows disjoint", () => {
    const tokens = { input: 150, output: 30, reasoning: 0, cache: { read: 100, write: 0 } };
    const later = { input: 60, output: 8, reasoning: 4, cache: { read: 0, write: 0 } };
    const rows = [
      assistant(1, { tokens, cost: 0.0000655 }),
      msg(2, "compaction", { status: "completed", summary: "Summary.", time: { created: T0 } }),
      assistant(3, { tokens: later }),
    ];
    const step = (messageId: string, stepTokens: object) => ({
      id: `prt_${messageId}_${JSON.stringify(stepTokens).length}`,
      message_id: messageId,
      session_id: "ses_inline",
      time_created: T0,
      time_updated: T0,
      data: JSON.stringify({ type: "step-finish", tokens: stepTokens }),
    });
    const legacyMessage = (id: string, info: object) => ({
      id,
      session_id: "ses_inline",
      time_created: T0,
      time_updated: T0,
      data: JSON.stringify(info),
    });
    const legacy = {
      version: "1.3.10",
      messages: [
        legacyMessage("msg_1", { role: "assistant", modelID: "glm-5.3-flash", cost: 0.0000655 }),
        legacyMessage("msg_2", { role: "user" }),
        legacyMessage("msg_9", {
          role: "assistant",
          summary: true,
          parentID: "msg_2",
          modelID: "glm-5.3-flash",
          cost: 0.000065,
        }),
      ],
      parts: [
        step("msg_1", { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } }),
        step("msg_1", tokens),
        step("msg_9", { input: 300, output: 40, reasoning: 0, cache: { read: 0, write: 0 } }),
      ],
    };
    const corrected = parseOpenCodeSession(
      sessionRow({ version: "1.3.10" }),
      rows,
      context,
      legacy,
    ).session;
    expect(corrected.messages.map((m) => [m.sourceUuid, m.role, m.model, m.usage?.input])).toEqual([
      ["msg_1", "assistant", "glm-5.3-flash", 250],
      ["msg_2", "system", "glm-5.3-flash", 300],
      ["msg_3", "assistant", "glm-5.3-flash", 60],
    ]);
    expect(corrected.messages[2]?.usage).toMatchObject({ output: 12, reasoning: 4 });
    // The migrated row's own tokens say 0 reasoning; the 1.x steps say 5.
    expect(corrected.messages[0]?.raw).toMatchObject({ reasoning_tokens: 5 });
    expect((corrected.messages[1]!.raw as { cost: number }).cost).toBe(0.000065);
    expect(corrected.rawMeta).toMatchObject({ migrated_rows_from_v1: 2 });

    // A 1.x copy with no messages corrects nothing: every row is read by the
    // session's version, as when the 1.x tables are gone.
    for (const copy of [null, { ...legacy, messages: [], parts: [] }]) {
      const plain = parseOpenCodeSession(
        sessionRow({ version: "1.3.10" }),
        rows,
        context,
        copy,
      ).session;
      expect(plain.messages.map((m) => m.usage?.input ?? null)).toEqual([150, null, 60]);
      expect(plain.messages[2]?.usage).toMatchObject({ output: 8, reasoning: 4 });
      expect(plain.rawMeta).not.toHaveProperty("migrated_rows_from_v1");
    }
  });

  test("keeps sequence gaps left by a revert without issues", () => {
    const parsed = parseOpenCodeSession(
      sessionRow(),
      [
        msg(1, "user", { text: "hello", time: { created: T0 + 1000 } }),
        assistant(2, {}),
        assistant(7, {}),
      ],
      context,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.messages.map((m) => m.seq)).toEqual([0, 1, 2]);
  });

  test("ingests an in-progress assistant row as it stands", () => {
    const parsed = parseOpenCodeSession(
      sessionRow(),
      [
        msg(1, "assistant", {
          agent: "build",
          model: GLM,
          content: [
            { type: "text", text: "Working" },
            {
              type: "tool",
              id: "call_run",
              name: "shell",
              state: { status: "running", input: { command: "ls" }, metadata: {} },
              time: { created: T0 + 1000 },
            },
          ],
          time: { created: T0 + 1000 },
        }),
      ],
      context,
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.messages).toHaveLength(1);
    expect(parsed.session.messages[0]).toMatchObject({
      role: "assistant",
      usage: null,
      stopReason: null,
    });
    expect(parsed.session.messages[0]?.blocks.map((b) => b.blockType)).toEqual([
      "text",
      "tool_use",
    ]);
    expect(parsed.session.totals).toMatchObject({ input: 0, output: 0 });
    expect(parsed.session.reasoningSource).toBe("none");
  });

  test("records a failed request with its error and null usage, never zero usage", () => {
    const { session } = parseOpenCodeSession(
      sessionRow(),
      [
        assistant(1, {
          error: { type: "provider.quota", message: "quota exceeded" },
          finish: "error",
        }),
        assistant(2, {
          error: { type: "aborted", message: "aborted" },
          tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ],
      context,
    );
    expect(session.messages[0]).toMatchObject({ stopReason: "error", usage: null });
    expect(session.messages[0]?.raw).toMatchObject({ error: { type: "provider.quota" } });
    expect(session.messages[1]).toMatchObject({
      stopReason: "error",
      usage: { input: 5, output: 1 },
    });
  });

  test("marks compaction rows as system compaction boundaries carrying their usage", () => {
    const { session } = parseOpenCodeSession(
      sessionRow(),
      [
        msg(1, "compaction", {
          status: "completed",
          reason: "manual",
          model: GLM,
          summary: "Summary of earlier work.",
          recent: "",
          cost: 0.0001,
          tokens: { input: 900, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: T0 + 1000 },
        }),
        msg(2, "compaction", {
          status: "failed",
          reason: "auto",
          error: { type: "aborted", message: "x" },
          time: { created: T0 + 2000 },
        }),
      ],
      context,
    );
    expect(session.messages[0]).toMatchObject({
      role: "system",
      model: "glm-5.3-flash",
      usage: { input: 900, output: 100 },
      blocks: [{ blockType: "text", text: "Summary of earlier work." }],
    });
    expect(session.messages[0]?.raw).toMatchObject({ type: "compaction", seq: 1 });
    expect(session.messages[1]).toMatchObject({ role: "system", stopReason: "error", usage: null });
    expect(session.totals).toMatchObject({ input: 900, output: 100 });
  });

  test("keeps a recorded cost of zero in raw without touching usage", () => {
    const { session } = parseOpenCodeSession(
      sessionRow(),
      [
        assistant(1, {
          cost: 0,
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ],
      context,
    );
    expect(session.messages[0]?.raw).toMatchObject({ cost: 0 });
    expect(session.messages[0]?.usage).toMatchObject({ input: 10, output: 2 });
  });

  test("reports unknown types once and invalid data rows as unparsed lines", () => {
    const parsed = parseOpenCodeSession(
      sessionRow(),
      [
        msg(1, "user", { text: "hello", time: { created: T0 + 1000 } }),
        msg(2, "future-thing", { time: { created: T0 + 2000 } }),
        msg(3, "future-thing", { time: { created: T0 + 3000 } }),
        msg(4, "assistant", "{not json"),
        msg(5, "assistant", '"a string"'),
      ],
      context,
    );
    expect(parsed.session.messages).toHaveLength(1);
    expect(parsed.issues).toMatchObject([
      { code: "unparsed_line", lineNo: 4, rawLine: "{not json" },
      { code: "unparsed_line", lineNo: 5, rawLine: '"a string"' },
      { code: "unknown_record_type", lineNo: 2, rawLine: null },
    ]);
    expect(parsed.issues[2]?.error).toContain('"future-thing" on 2 line(s)');
  });

  test("links a child session to its parent and keeps switch records in metadata", () => {
    const { session } = parseOpenCodeSession(
      sessionRow({ id: "ses_child", parent_id: "ses_parent", agent: "explore" }),
      [
        msg(1, "agent-switched", {
          agent: "explore",
          previous: "build",
          time: { created: T0 + 1000 },
        }),
        msg(2, "model-switched", { model: GLM, time: { created: T0 + 2000 } }),
        msg(3, "location-switched", {
          location: "/decant-fixture/example",
          time: { created: T0 + 3000 },
        }),
        msg(4, "user", { text: "hello", time: { created: T0 + 4000 } }),
      ],
      context,
    );
    expect(session).toMatchObject({
      isSubagent: true,
      rootSourceSessionId: "ses_parent",
      agentId: "ses_child",
      agentType: "explore",
      spawnToolUseId: null,
    });
    expect(session.rawMeta).toMatchObject({ parentSessionId: "ses_parent" });
    expect((session.rawMeta as { switches: Json[] }).switches).toHaveLength(3);
    expect(session.messages).toHaveLength(1);
  });

  test("renders shell, system-like, idle, and attachment rows", () => {
    const { session } = parseOpenCodeSession(
      sessionRow({ title: null, model: null, time_archived: T0 + 99_000 }),
      [
        msg(1, "user", {
          text: "",
          files: [{ type: "file", mime: "image/png", filename: "shot.png", url: "data:," }],
          time: { created: T0 + 1000 },
        }),
        msg(2, "shell", {
          shellID: "sh_1",
          command: "ls",
          status: "completed",
          exit: 0,
          output: "hello",
          time: { created: T0 + 2000 },
        }),
        msg(3, "system", {
          text: "Context updated.",
          description: "update",
          time: { created: T0 + 3000 },
        }),
        msg(4, "synthetic", { text: "Synthetic note.", time: { created: T0 + 4000 } }),
        msg(5, "skill", {
          skill: "sk_1",
          name: "example",
          text: "Skill loaded.",
          time: { created: T0 + 5000 },
        }),
        msg(6, "idle", { outcome: "succeeded", time: { created: T0 + 6000 } }),
        msg(7, "idle", {
          outcome: "failed",
          error: { type: "provider.auth", message: "no key" },
          time: { created: T0 + 7000 },
        }),
        msg(8, "idle", { outcome: "interrupted", time: { created: T0 + 8000 } }),
        msg(9, "user", { text: "second prompt", time: { created: T0 + 9000 } }),
        assistant(10, {
          model: { providerID: "opencode-go", id: "glm-5.3-flash", variant: "default" },
        }),
      ],
      context,
    );
    expect(
      session.messages.map((m) => [
        m.role,
        m.blocks[0]?.blockType ?? null,
        m.blocks[0]?.text ?? null,
      ]),
    ).toEqual([
      ["user", "image", "shot.png"],
      ["user", "text", "$ ls\nhello"],
      ["system", "text", "Context updated."],
      ["system", "text", "Synthetic note."],
      ["system", "text", "Skill loaded."],
      ["system", "text", "Turn failed: no key"],
      ["system", "text", "Turn interrupted"],
      ["user", "text", "second prompt"],
      ["assistant", null, null],
    ]);
    expect(session.messages[5]?.stopReason).toBe("error");
    expect(session.title).toBe("second prompt");
    expect(session.model).toBe("glm-5.3-flash");
    expect(session.reasoningEffort).toBeNull();
    expect(session.isArchived).toBe(true);
    expect(session.rawMeta).toMatchObject({ model_context_window: 1_000_000 });
  });

  test("runs linkage diagnostics before returning", () => {
    const tool = {
      type: "tool",
      id: "call_dup",
      name: "read",
      state: {
        status: "completed",
        input: { path: "/decant-fixture/example/a" },
        content: [{ type: "text", text: "a" }],
      },
      time: { created: T0 },
    };
    const parsed = parseOpenCodeSession(
      sessionRow(),
      [assistant(1, { content: [tool] }), assistant(2, { content: [tool] })],
      context,
    );
    expect(parsed.issues.map((issue) => issue.code)).toEqual([
      "duplicate_tool_use_id",
      "duplicate_tool_result",
    ]);
  });
});

describe("OpenCode 2.x step timing", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  test("stamps a step when its generation ended and a tool result when the tool did", () => {
    const { session } = parseOpenCodeSession(timingSessionRow(), timingMessageRows(), context);
    expect(session.messages.map((m) => [m.role, m.timestamp])).toEqual([
      ["user", iso(STEP_TIMES.prompt1)],
      ["assistant", iso(STEP_TIMES.step1Streamed)],
      ["tool", iso(STEP_TIMES.toolCompleted)],
      ["user", iso(STEP_TIMES.prompt2)],
      ["assistant", iso(STEP_TIMES.step2Streamed)],
    ]);
    // The call is dated when it started to run, so its duration is the run.
    expect(session.messages[1]?.blocks[1]).toMatchObject({
      blockType: "tool_use",
      calledAt: iso(STEP_TIMES.toolRan),
    });
  });

  test("keeps hidden reasoning as an empty thinking block and records its tokens", () => {
    const { session } = parseOpenCodeSession(timingSessionRow(), timingMessageRows(), context);
    const answer = session.messages[4];
    expect(answer?.blocks.map((b) => [b.blockType, b.text])).toEqual([
      ["thinking", ""],
      ["text", "The notes say hello."],
    ]);
    expect(answer?.usage).toMatchObject({ output: 300, reasoning: 240 });
    expect(answer?.raw).toMatchObject({ reasoning_tokens: 240 });
    expect(session.messages[1]?.raw).toMatchObject({ reasoning_tokens: 150 });
    expect(session.totals).toMatchObject({ input: 2200, output: 500, reasoning: 390 });
  });

  test("falls back to the step's end, never its start, when a time is missing", () => {
    const step = (seq: number, content: Json[], time: Record<string, number>) =>
      msg(seq, "assistant", { agent: "build", model: GLM, content, time });
    const reasoning = (completed: number) => ({
      type: "reasoning",
      text: "r",
      time: { created: T0, completed },
    });
    const tool = (id: string, time: Record<string, number>) => ({
      type: "tool",
      id,
      name: "read",
      state: { status: "completed", input: { path: "/decant-fixture/example/a" }, content: [] },
      time,
    });
    const { session } = parseOpenCodeSession(
      sessionRow(),
      [
        // No `streamed` and no tools: `completed` is the end of generation.
        step(1, [reasoning(T0 + 1200), { type: "text", text: "a" }], {
          created: T0 + 1000,
          completed: T0 + 1900,
        }),
        // No `streamed` with a tool: `completed` waits for the tool, so the
        // latest part that finished streaming marks the end. A row migrated
        // from 1.x has no `ran`; its `created` is when the tool started.
        step(
          2,
          [reasoning(T0 + 2300), tool("call_mig", { created: T0 + 2400, completed: T0 + 2800 })],
          {
            created: T0 + 2000,
            completed: T0 + 2900,
          },
        ),
        // A tool with no completion time: the result takes the step's end.
        step(3, [tool("call_open", { created: T0 + 3100, ran: T0 + 3200 })], {
          created: T0 + 3000,
          streamed: T0 + 3300,
        }),
        // Only a start: nothing else to go on.
        step(4, [{ type: "text", text: "b" }], { created: T0 + 4000 }),
      ],
      context,
    );
    expect(session.messages.map((m) => [m.role, m.timestamp])).toEqual([
      ["assistant", iso(T0 + 1900)],
      ["assistant", iso(T0 + 2400)],
      ["tool", iso(T0 + 2800)],
      ["assistant", iso(T0 + 3300)],
      ["tool", iso(T0 + 3300)],
      ["assistant", iso(T0 + 4000)],
    ]);
  });
});
