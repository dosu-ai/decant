import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPricing, estimateCost } from "../src/cost.ts";
import type { Json, NormalizedMessage, ParsedSession } from "../src/model.ts";
import type { OpenCodeParseContext } from "../src/sources/opencode.ts";
import {
  type OpenCodeLegacyMessageRow,
  type OpenCodeLegacyPartRow,
  type OpenCodeLegacySessionRow,
  parseOpenCodeLegacySession,
} from "../src/sources/opencode-legacy.ts";
import { type OpenCodeLegacyLoadedSession, OpenCodeStore } from "../src/sources/opencode-store.ts";
import { buildOpenCodeV1FixtureDb } from "./opencode-fixture.ts";
import { STEP_TIMES } from "./opencode-timing.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-opencode-legacy-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const context: OpenCodeParseContext = {
  mcpServers: ["dosu", "my server"],
  contextWindows: new Map([["opencode-go/glm-5.3-flash", 1_000_000]]),
};

let dbCounter = 0;

function load(
  names: readonly string[],
  sessionId: string,
  shape: "current" | "1.2" = "current",
): OpenCodeLegacyLoadedSession {
  dbCounter += 1;
  const path = join(workDir, `opencode-${dbCounter}.db`);
  buildOpenCodeV1FixtureDb(path, names, shape);
  const store = OpenCodeStore.open(path);
  try {
    const loaded = store.loadLegacySession(sessionId);
    if (loaded == null) {
      throw new Error(`fixture session ${sessionId} not found`);
    }
    return loaded;
  } finally {
    store.close();
  }
}

function parse(loaded: OpenCodeLegacyLoadedSession): ParsedSession {
  return parseOpenCodeLegacySession(loaded.session, loaded.messages, loaded.parts, context);
}

function fixture(
  names: readonly string[],
  sessionId: string,
  shape: "current" | "1.2" = "current",
): ParsedSession {
  return parse(load(names, sessionId, shape));
}

function texts(message: NormalizedMessage | undefined): string[] {
  return (message?.blocks ?? []).flatMap((b) => (b.text == null ? [] : [b.text]));
}

const T0 = 1791789000000;

function sessionRow(overrides: Partial<OpenCodeLegacySessionRow> = {}): OpenCodeLegacySessionRow {
  return {
    id: "ses_inline",
    project_id: "prj_inline",
    parent_id: null,
    slug: "inline",
    directory: "/decant-fixture/example",
    title: "Inline session",
    version: "1.18.35",
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    revert: null,
    agent: "build",
    model: null,
    time_created: T0,
    time_updated: T0 + 60_000,
    time_archived: null,
    ...overrides,
  };
}

function messageRow(id: string, offset: number, data: Json | string): OpenCodeLegacyMessageRow {
  return {
    id,
    session_id: "ses_inline",
    time_created: T0 + offset,
    time_updated: T0 + offset,
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
}

function partRow(id: string, messageId: string, data: Json | string): OpenCodeLegacyPartRow {
  return {
    id,
    message_id: messageId,
    session_id: "ses_inline",
    time_created: T0,
    time_updated: T0,
    data: typeof data === "string" ? data : JSON.stringify(data),
  };
}

const USER = {
  role: "user",
  time: { created: T0 },
  agent: "plan",
  model: { providerID: "opencode-go", modelID: "glm-5.3-flash" },
};

function assistant(overrides: Record<string, Json> = {}): Record<string, Json> {
  return {
    role: "assistant",
    time: { created: T0 + 1000, completed: T0 + 2000 },
    parentID: "msg_u",
    modelID: "glm-5.3-flash",
    providerID: "opencode-go",
    mode: "build",
    agent: "build",
    cost: 0.0000185,
    tokens: { input: 90, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...overrides,
  };
}

describe("parseOpenCodeLegacySession", () => {
  test("parses the sample session", () => {
    const { session, issues } = fixture(["v1-sample.sql"], "ses_v1_sample");
    expect(issues).toEqual([]);
    expect(session.messages.map((m) => m.role)).toEqual([
      "user",
      "system",
      "assistant",
      "tool",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(session.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const [user, system, first, readResult, mcpResult, second, bashResult, last] = session.messages;
    expect(user?.blocks.map((b) => [b.blockType, b.text])).toEqual([
      ["text", "Read the example notes and search the docs."],
      ["image", "notes.txt"],
    ]);
    expect(user?.sourceUuid).toBe("msg_v1s_1");
    expect(user?.timestamp).toBe(new Date(1791790000000).toISOString());
    expect(texts(system)).toEqual(["Called the Read tool on notes.txt"]);

    expect(first?.blocks.map((b) => b.blockType)).toEqual(["thinking", "tool_use", "tool_use"]);
    expect(first?.blocks[1]).toMatchObject({
      toolName: "read",
      toolUseId: "call_v1_read",
      toolInput: { filePath: "/decant-fixture/example/notes.txt" },
    });
    expect(first?.blocks[2]).toMatchObject({
      toolName: "mcp__dosu__search",
      toolUseId: "call_v1_mcp",
    });
    expect(first).toMatchObject({
      sourceUuid: "msg_v1s_2",
      model: "glm-5.3-flash",
      stopReason: "tool-calls",
      usage: { input: 120, output: 40, cacheRead: 40, cacheCreation: 16, reasoning: 10 },
    });
    expect(first?.raw).toMatchObject({
      id: "msg_v1s_2",
      cost: 0.0000416,
      providerID: "opencode-go",
    });
    expect((first!.raw as { parts: { id: string }[] }).parts.map((p) => p.id)).toEqual([
      "prt_v1s_04",
      "prt_v1s_05",
      "prt_v1s_06",
      "prt_v1s_07",
      "prt_v1s_08",
    ]);

    expect(readResult?.blocks).toEqual([
      expect.objectContaining({
        blockType: "tool_result",
        toolUseId: "call_v1_read",
        toolResult: "hello",
        isError: false,
      }),
    ]);
    expect(readResult?.sourceUuid).toBeNull();
    expect(readResult?.timestamp).toBe(new Date(1791790002500).toISOString());
    expect(readResult?.raw).toMatchObject({
      id: "prt_v1s_06",
      messageID: "msg_v1s_2",
      callID: "call_v1_read",
      tool: "read",
    });
    expect(mcpResult?.blocks[0]).toMatchObject({ toolUseId: "call_v1_mcp", isError: false });

    expect(second?.blocks.map((b) => b.blockType)).toEqual(["text", "tool_use"]);
    expect(bashResult?.blocks[0]).toMatchObject({
      toolUseId: "call_v1_bash",
      toolResult: "No such file or directory",
      isError: true,
    });

    expect(last?.blocks).toEqual([
      expect.objectContaining({ blockType: "tool_use", toolUseId: "call_v1_pending" }),
    ]);
    expect(last?.usage).toBeNull();
    expect(last?.stopReason).toBeNull();

    expect(session.totals).toEqual({
      input: 370,
      output: 57,
      cacheRead: 100,
      cacheCreation: 16,
      cacheCreation1h: 0,
      reasoning: 10,
    });
    expect(session.reasoningSource).toBe("reported");
    expect(session).toMatchObject({
      tool: "opencode",
      sourceSessionId: "ses_v1_sample",
      projectPath: "/decant-fixture/example",
      cwd: "/decant-fixture/example",
      title: "Read the example notes",
      model: "glm-5.3-flash",
      reasoningEffort: "max",
      cliVersion: "1.18.35",
      startedAt: new Date(1791790000000).toISOString(),
      endedAt: new Date(1791790060000).toISOString(),
      isArchived: false,
      isSubagent: false,
      rootSourceSessionId: null,
      agentId: null,
      agentType: "build",
    });
    expect(session.rawMeta).toMatchObject({
      format: "v1",
      id: "ses_v1_sample",
      project_id: "prj_v1",
      parent_id: null,
      slug: "v1-sample",
      version: "1.18.35",
      agent: "build",
      model: { id: "glm-5.3-flash", providerID: "opencode-go", variant: "max" },
      model_provider: "opencode-go",
      model_variant: "max",
      cost: 0.0000894,
      tokens: { input: 370, output: 47, reasoning: 10, cache_read: 100, cache_write: 16 },
      revert: null,
      time_created: 1791790000000,
      time_updated: 1791790060000,
      time_archived: null,
      model_context_window: 1_000_000,
    });
    expect(session.rawMeta).not.toHaveProperty("parentSessionId");
    expect(session.rawMeta).not.toHaveProperty("fork_rows_skipped");
  });

  test("sums every step-finish part, not info.tokens", () => {
    const { session } = fixture(["v1-sample.sql"], "ses_v1_sample");
    expect(session.messages[5]?.usage).toMatchObject({ input: 250, output: 17, cacheRead: 60 });
  });

  test("reproduces OpenCode's recorded cost from the mapped usage", () => {
    const pricing = defaultPricing();
    const sessions: ParsedSession[] = [
      fixture(["v1-sample.sql"], "ses_v1_sample"),
      fixture(["v1/fork.sql"], "ses_v1_fork"),
      fixture(["v1/compaction.sql"], "ses_v1_compact"),
      fixture(["v1/subagent.sql"], "ses_v1_parent"),
      fixture(["v1/subagent.sql"], "ses_v1_child"),
      fixture(["v1/tokens.sql"], "ses_v1_new"),
    ];
    let checked = 0;
    for (const { session } of sessions) {
      for (const message of session.messages) {
        if (message.usage == null) continue;
        const recorded = (message.raw as { cost: number }).cost;
        const listed = estimateCost(message.model ?? "", message.usage, pricing);
        expect(Math.abs(listed - recorded)).toBeLessThan(1e-9);
        checked += 1;
      }
    }
    expect(checked).toBe(8);
  });

  test("maps a 1.3.10 session without double counting reasoning", () => {
    const pricing = defaultPricing();
    const old = fixture(["v1/tokens.sql"], "ses_v1_old").session;
    expect(old.totals).toMatchObject({ input: 200, output: 100, reasoning: 40 });
    const assistants = old.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    for (const message of assistants) {
      const usage = message.usage;
      if (usage == null) throw new Error("expected usage");
      expect(usage).toMatchObject({ output: 50, reasoning: 20 });
      expect(estimateCost("glm-5.3-flash", usage, pricing)).toBeCloseTo(0.00004, 12);
      expect((message.raw as { cost: number }).cost).toBe(0.00005);
    }
    // The old session records neither model nor agent on its row.
    expect(old.model).toBe("glm-5.3-flash");
    expect(old.agentType).toBe("build");
    expect(old.reasoningEffort).toBeNull();

    const fresh = fixture(["v1/tokens.sql"], "ses_v1_new").session;
    expect(fresh.totals).toMatchObject({ output: 50, reasoning: 20 });
  });

  test("folds a compaction pair into one system message", () => {
    const { session, issues } = fixture(["v1/compaction.sql"], "ses_v1_compact");
    expect(issues).toEqual([]);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "system", "user"]);
    const compaction = session.messages[2];
    expect(compaction).toMatchObject({
      sourceUuid: "msg_v1c_3",
      model: "glm-5.3-flash",
      stopReason: null,
      timestamp: new Date(1791791010000).toISOString(),
      usage: { input: 300, output: 40 },
    });
    expect(texts(compaction)).toEqual(["Summary of earlier work."]);
    expect(compaction?.raw).toMatchObject({
      id: "msg_v1c_3",
      type: "compaction",
      auto: true,
      overflow: true,
      summary_message_id: "msg_v1c_4",
      cost: 0.000065,
      summary: true,
    });
    expect(
      session.messages.some(
        (m) => m.role === "assistant" && (m.raw as { summary?: boolean }).summary === true,
      ),
    ).toBe(false);
    expect(session.totals).toMatchObject({ input: 400, output: 80 });
  });

  test("keeps an unpaired summary or compaction request as a compaction message", () => {
    const { session, issues } = parse({
      session: sessionRow(),
      messages: [
        messageRow("msg_u", 0, USER),
        messageRow(
          "msg_s",
          1000,
          assistant({ summary: true, mode: "compaction", parentID: "msg_gone" }),
        ),
        messageRow("msg_c", 3000, { ...USER, time: { created: T0 + 3000 } }),
      ],
      parts: [
        partRow("prt_1", "msg_c", { type: "compaction", auto: false }),
        partRow("prt_2", "msg_s", { type: "text", text: "Short summary." }),
        partRow("prt_3", "msg_u", { type: "text", text: "Go." }),
      ],
    });
    expect(issues).toEqual([]);
    expect(
      session.messages.map((m) => [m.role, (m.raw as { type?: string }).type ?? null]),
    ).toEqual([
      ["user", null],
      ["system", "compaction"],
      ["system", "compaction"],
    ]);
    expect(texts(session.messages[1])).toEqual(["Short summary."]);
    expect(session.messages[1]).toMatchObject({
      sourceUuid: "msg_s",
      usage: { input: 90, output: 10 },
    });
    expect(session.messages[1]?.raw).toMatchObject({ id: "msg_s", summary_message_id: "msg_s" });
    expect(texts(session.messages[2])).toEqual(["Context compacted"]);
    expect(session.messages[2]).toMatchObject({ sourceUuid: "msg_c", usage: null });
    expect(session.messages[2]?.raw).toMatchObject({ auto: false, summary_message_id: null });
    expect(session.totals).toMatchObject({ input: 90, output: 10 });
  });

  test("skips rows a fork inherited", () => {
    const { session } = fixture(["v1/fork.sql"], "ses_v1_fork");
    expect(session.rawMeta).toMatchObject({ fork_rows_skipped: 2 });
    expect(session.totals).toMatchObject({ input: 90, output: 10 });
    expect(texts(session.messages[0])).toEqual(["Try again."]);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("links a subagent child to its parent", () => {
    const child = fixture(["v1/subagent.sql"], "ses_v1_child").session;
    expect(child).toMatchObject({
      isSubagent: true,
      rootSourceSessionId: "ses_v1_parent",
      agentId: "ses_v1_child",
      agentType: "explore",
    });
    expect(child.rawMeta).toMatchObject({ parentSessionId: "ses_v1_parent" });

    const parent = fixture(["v1/subagent.sql"], "ses_v1_parent").session;
    const task = parent.messages.find((m) => m.role === "tool");
    // Ingest links the child through the result row's raw call id and metadata.
    expect(task?.raw).toMatchObject({
      callID: "call_v1_task",
      tool: "task",
      state: { metadata: { sessionId: "ses_v1_child" } },
    });
    expect(task?.blocks[0]).toMatchObject({ toolUseId: "call_v1_task", toolResult: "notes.txt" });
  });

  test("reports malformed rows as diagnostics", () => {
    const { session, issues } = fixture(["v1/malformed.sql"], "ses_v1_bad");
    expect(issues.map((i) => i.code).sort()).toEqual([
      "unknown_record_type",
      "unknown_record_type",
      "unparsed_line",
      "unparsed_line",
      "unparsed_line",
    ]);
    for (const issue of issues) {
      if (issue.rawLine != null) {
        expect(["not json", "nope"]).toContain(issue.rawLine);
      }
      expect(issue.error).not.toContain("orphan");
    }
    expect(issues.find((i) => i.rawLine === "not json")?.lineNo).toBe(1);
    expect(issues.find((i) => i.rawLine === "nope")?.lineNo).toBe(2);
    expect(issues.find((i) => i.error === "part references a missing message")?.lineNo).toBeNull();
    const unknown = issues.filter((i) => i.code === "unknown_record_type").map((i) => i.error);
    expect(unknown.some((e) => e.includes('"part:hologram"'))).toBe(true);
    expect(unknown.some((e) => e.includes('"role:narrator"'))).toBe(true);
    // The readable user message survives with no blocks.
    expect(session.messages.map((m) => [m.role, m.blocks.length])).toEqual([["user", 0]]);
    expect(session.reasoningSource).toBe("none");
  });

  test("reads a v1.2-shaped session", () => {
    const { session, issues } = fixture(["v1/old-shape.sql"], "ses_v1_12", "1.2");
    expect(issues).toEqual([]);
    expect(session.totals).toMatchObject({ input: 100, output: 50, reasoning: 20 });
    expect(session.model).toBe("glm-5.3-flash");
    expect(session.agentType).toBe("build");
    expect(session.rawMeta).toMatchObject({
      cost: null,
      model: null,
      agent: null,
      model_provider: "opencode-go",
      tokens: { input: null, output: null, reasoning: null, cache_read: null, cache_write: null },
    });
  });

  test("keeps reverted rows", () => {
    const loaded = load(["v1-sample.sql"], "ses_v1_sample");
    const base = parse(loaded).session;
    const { session } = parseOpenCodeLegacySession(
      { ...loaded.session, revert: '{"messageID":"msg_v1s_3"}' },
      loaded.messages,
      loaded.parts,
      context,
    );
    expect(session.messages).toHaveLength(base.messages.length);
    expect((session.rawMeta as { revert: { messageID: string } }).revert.messageID).toBe(
      "msg_v1s_3",
    );
  });

  test("turns subtask-only user messages into system messages", () => {
    const { session, issues } = parse({
      session: sessionRow(),
      messages: [
        messageRow("msg_u", 0, USER),
        messageRow("msg_t", 500, { ...USER, time: { created: T0 + 500 } }),
      ],
      parts: [
        partRow("prt_1", "msg_t", {
          type: "subtask",
          prompt: "List the files",
          description: "List files",
          agent: "explore",
          command: "files",
        }),
        partRow("prt_2", "msg_u", { type: "text", text: "Hello.", ignored: false }),
        partRow("prt_3", "msg_u", { type: "text", text: "hidden", ignored: true }),
        partRow("prt_4", "msg_u", { type: "agent", name: "explore" }),
      ],
    });
    expect(issues).toEqual([]);
    expect(session.messages.map((m) => [m.role, texts(m)])).toEqual([
      ["user", ["Hello."]],
      ["system", ["Subtask (explore): List files"]],
    ]);
    expect(session.messages[1]?.raw).toMatchObject({
      id: "prt_1",
      messageID: "msg_t",
      type: "subtask",
    });
    // Without a session agent the last user message's agent is used.
    expect(
      parse({ session: sessionRow({ agent: null }), messages: [], parts: [] }).session.agentType,
    ).toBeNull();
    expect(
      parse({
        session: sessionRow({ agent: null }),
        messages: [messageRow("msg_u", 0, USER)],
        parts: [],
      }).session.agentType,
    ).toBe("plan");
  });

  test("keeps running and pending tools as calls without results", () => {
    const { session, issues } = parse({
      session: sessionRow({ time_archived: T0 + 90_000, title: null }),
      messages: [
        messageRow("msg_u", 0, USER),
        messageRow(
          "msg_a",
          1000,
          assistant({ variant: "default", error: { name: "MessageAbortedError" } }),
        ),
      ],
      parts: [
        partRow("prt_1", "msg_u", { type: "text", text: "  Run the example tool.  " }),
        partRow("prt_2", "msg_a", {
          type: "tool",
          callID: "call_run",
          tool: "my_server_lookup",
          state: { status: "running", input: { q: "x" }, time: { start: T0 + 1100 } },
        }),
        partRow("prt_3", "msg_a", {
          type: "tool",
          callID: "call_pend",
          tool: "bash",
          state: { status: "pending", input: {}, raw: "" },
        }),
        partRow("prt_4", "msg_a", { type: "reasoning", text: "" }),
        partRow("prt_5", "msg_a", { type: "text", text: "" }),
      ],
    });
    expect(issues).toEqual([]);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const call = session.messages[1];
    // Empty reasoning stays: a provider that hides reasoning still bills it.
    expect(call?.blocks.map((b) => [b.blockType, b.toolName, b.toolUseId])).toEqual([
      ["tool_use", "mcp__my_server__lookup", "call_run"],
      ["tool_use", "bash", "call_pend"],
      ["thinking", null, null],
    ]);
    expect(call?.stopReason).toBe("error");
    expect(session).toMatchObject({
      title: "Run the example tool.",
      isArchived: true,
      reasoningEffort: null,
      model: "glm-5.3-flash",
    });
  });
});

describe("OpenCode 1.x step timing", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const T = STEP_TIMES;
  const at = (ms: number) => ms - T0;

  test("dates a message when its last part streamed and a tool result when the tool ended", () => {
    const { session } = parse({
      session: sessionRow({ time_created: T.session }),
      messages: [
        messageRow("msg_u1", at(T.prompt1), { ...USER, time: { created: T.prompt1 } }),
        messageRow(
          "msg_a1",
          at(T.step1Created),
          assistant({
            time: { created: T.step1Created, completed: T.step1Completed },
            tokens: { input: 1000, output: 50, reasoning: 150, cache: { read: 0, write: 0 } },
            finish: "tool-calls",
          }),
        ),
        messageRow("msg_u2", at(T.prompt2), { ...USER, time: { created: T.prompt2 } }),
        messageRow(
          "msg_a2",
          at(T.step2Created),
          assistant({
            time: { created: T.step2Created, completed: T.step2Completed },
            tokens: { input: 1200, output: 60, reasoning: 240, cache: { read: 0, write: 0 } },
          }),
        ),
      ],
      parts: [
        partRow("prt_01", "msg_u1", { type: "text", text: "Read the notes." }),
        partRow("prt_02", "msg_a1", { type: "step-start" }),
        partRow("prt_03", "msg_a1", {
          type: "reasoning",
          text: "Read the file first.",
          time: { start: T.reasoning1Created, end: T.reasoning1Completed },
        }),
        partRow("prt_04", "msg_a1", {
          type: "tool",
          callID: "call_read",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/decant-fixture/example/notes.txt" },
            output: "hello",
            title: "notes.txt",
            metadata: {},
            time: { start: T.toolRan, end: T.toolCompleted },
          },
        }),
        partRow("prt_05", "msg_u2", { type: "text", text: "And then?" }),
        partRow("prt_06", "msg_a2", {
          type: "reasoning",
          text: "",
          time: { start: T.reasoning2Created, end: T.reasoning2Completed },
        }),
        partRow("prt_07", "msg_a2", {
          type: "text",
          text: "The notes say hello.",
          time: { start: T.reasoning2Completed, end: T.step2Streamed },
        }),
      ],
    });
    expect(session.messages.map((m) => [m.role, m.timestamp])).toEqual([
      ["user", iso(T.prompt1)],
      ["assistant", iso(T.toolRan)],
      ["tool", iso(T.toolCompleted)],
      ["user", iso(T.prompt2)],
      ["assistant", iso(T.step2Streamed)],
    ]);
    expect(session.messages[1]?.blocks[1]).toMatchObject({
      blockType: "tool_use",
      calledAt: iso(T.toolRan),
    });
    expect(session.messages[1]?.raw).toMatchObject({ reasoning_tokens: 150 });
    expect(session.messages[4]?.blocks.map((b) => [b.blockType, b.text])).toEqual([
      ["thinking", ""],
      ["text", "The notes say hello."],
    ]);
    expect(session.messages[4]?.raw).toMatchObject({ reasoning_tokens: 240 });
  });

  test("records reasoning summed over the message's step-finish parts", () => {
    const finish = (reasoning: number) => ({
      type: "step-finish",
      reason: "stop",
      cost: 0,
      tokens: { input: 10, output: 4, reasoning, cache: { read: 0, write: 0 } },
    });
    const { session } = parse({
      session: sessionRow(),
      messages: [
        // info.tokens holds only the last step's usage.
        messageRow(
          "msg_a",
          1000,
          assistant({
            tokens: { input: 10, output: 4, reasoning: 7, cache: { read: 0, write: 0 } },
          }),
        ),
      ],
      parts: [
        partRow("prt_1", "msg_a", finish(5)),
        partRow("prt_2", "msg_a", { type: "reasoning", text: "", time: { start: T0, end: T0 } }),
        partRow("prt_3", "msg_a", finish(7)),
      ],
    });
    expect(session.messages[0]?.usage).toMatchObject({ output: 20, reasoning: 12 });
    expect(session.messages[0]?.raw).toMatchObject({ reasoning_tokens: 12 });
  });

  test("falls back to the message's end, never its start, when a time is missing", () => {
    const { session } = parse({
      session: sessionRow(),
      messages: [
        // A text part without a time (older 1.x): completion ends the step.
        messageRow(
          "msg_a",
          1000,
          assistant({ time: { created: T0 + 1000, completed: T0 + 1900 } }),
        ),
        // Only a start: nothing else to go on.
        messageRow("msg_b", 2000, assistant({ time: { created: T0 + 2000 } })),
      ],
      parts: [
        partRow("prt_1", "msg_a", { type: "text", text: "a" }),
        partRow("prt_2", "msg_b", { type: "text", text: "b" }),
      ],
    });
    expect(session.messages.map((m) => m.timestamp)).toEqual([iso(T0 + 1900), iso(T0 + 2000)]);
  });
});
