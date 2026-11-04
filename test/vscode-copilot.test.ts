import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import { facets, fileRefs } from "../src/enrich.ts";
import { discover, discoverSourcePaths, type IngestConfig, sync } from "../src/ingest.ts";
import { listSessions } from "../src/query.ts";
import {
  mcpBaseName,
  parseVscodeCopilotSession,
  uriPath,
  vscodeModelId,
} from "../src/sources/vscode-copilot.ts";
import { totals as statsTotals } from "../src/stats.ts";

const workDir = realpathSync(mkdtempSync(join(tmpdir(), "decant-vscode-copilot-test-")));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const fixtureUser = join(import.meta.dir, "..", "fixtures", "vscode-copilot", "User");
const workspaceFixture = join(fixtureUser, "workspaceStorage", "5f3e9c1a");

let caseCounter = 0;
function freshDir(): string {
  caseCounter += 1;
  const dir = join(workDir, `case-${caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function sampleLog(): string {
  return readFileSync(
    join(workspaceFixture, "chatSessions", "vscode-sample-session.jsonl"),
    "utf8",
  );
}

function workspace(): unknown {
  return JSON.parse(readFileSync(join(workspaceFixture, "workspace.json"), "utf8"));
}

/** A one-request mutation log built from parts, for focused cases. */
function logWith(request: Record<string, unknown>, extra: unknown[] = []): string {
  const initial = {
    kind: 0,
    v: {
      version: 3,
      sessionId: "case-session",
      creationDate: Date.UTC(2026, 9, 6, 8),
      requests: [
        {
          requestId: "request_case",
          timestamp: Date.UTC(2026, 9, 6, 8, 0, 1),
          message: { text: "hello", parts: [] },
          variableData: { variables: [] },
          modelId: "copilot/claude-sonnet-4.5",
          response: [],
          ...request,
        },
      ],
    },
  };
  return `${[initial, ...extra].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("parseVscodeCopilotSession", () => {
  test("normalizes the synthetic mutation-log session", () => {
    const parsed = parseVscodeCopilotSession("fallback", sampleLog(), {
      workspace: workspace() as never,
    });
    const { session } = parsed;
    expect(parsed.issues).toEqual([]);
    expect(session).toMatchObject({
      tool: "vscode_copilot",
      sourceSessionId: "vscode-sample-session",
      projectPath: "/synthetic/vscode-project",
      cwd: "/synthetic/vscode-project",
      gitBranch: "main",
      title: "Fix the README greeting",
      model: "claude-sonnet-4.5",
      reasoningEffort: "high",
      startedAt: "2026-10-06T08:59:30.000Z",
      endedAt: "2026-10-06T09:06:02.000Z",
      reasoningSource: "none",
      estReasoningTokens: 0,
    });
    // Input is each turn's last prompt; output sums every call in the turn.
    expect(session.totals).toMatchObject({ input: 25000, output: 1020, cacheRead: 0 });
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "other",
      "user",
      "other",
    ]);
    expect(session.rawMeta).toMatchObject({ storage: "log", responderUsername: "GitHub Copilot" });
  });

  test("links each tool call to its result by ID and keeps the model's arguments", () => {
    const { session } = parseVscodeCopilotSession("fallback", sampleLog());
    const uses = session.messages.flatMap((message) =>
      message.blocks.filter((block) => block.blockType === "tool_use"),
    );
    const results = session.messages.flatMap((message) =>
      message.blocks.filter((block) => block.blockType === "tool_result"),
    );
    expect(uses.map((block) => [block.toolName, block.toolUseId])).toEqual([
      ["read_file", "toolu_read_1__vscode-1"],
      // The extension recorded this call without its `__vscode-` suffix.
      ["replace_string_in_file", "toolu_edit_2__vscode-2"],
      ["run_in_terminal", "toolu_term_3__vscode-3"],
      ["mcp__docs__search_docs", "toolu_mcp_4__vscode-4"],
    ]);
    expect(uses[1]?.toolInput).toEqual({
      filePath: "/synthetic/vscode-project/README.md",
      oldString: "hello",
      newString: "hello.",
    });
    expect(uses[0]?.calledAt).toBe("2026-10-06T09:00:04.000Z");
    expect(results.map((block) => [block.toolUseId, block.toolResult, block.isError])).toEqual([
      ["toolu_read_1__vscode-1", "# Example\nhello\n", false],
      ["toolu_edit_2__vscode-2", "The file was edited.", false],
      ["toolu_term_3__vscode-3", "1 failing: greeting says hello", true],
      ["toolu_mcp_4__vscode-4", "Greetings end with an exclamation mark.", false],
    ]);
  });

  test("keeps thinking, inline references, and the raw response parts", () => {
    const { session } = parseVscodeCopilotSession("fallback", sampleLog());
    const first = session.messages[1];
    expect(first?.blocks.map((block) => [block.blockType, block.text])).toEqual([
      ["thinking", "The user wants the greeting fixed. Read the file first."],
      ["text", "I'll read README.md first."],
      ["tool_use", null],
    ]);
    expect(first?.raw).toMatchObject({ requestId: "request_aaaa1111" });
    const last = session.messages[9];
    expect(last?.blocks[0]?.text).toContain("I updated README.md to match.");
    // The user message keeps the request record without its response.
    expect(session.messages[0]?.raw).toMatchObject({ requestId: "request_aaaa1111" });
    expect(session.messages[0]?.raw).not.toHaveProperty("response");
  });

  test("dates the auto model's turn by the model it routed to", () => {
    const { session } = parseVscodeCopilotSession("fallback", sampleLog());
    const auto = session.messages[11];
    expect(auto).toMatchObject({ role: "assistant", model: "gpt-5.4" });
    expect(auto?.usage).toMatchObject({ input: 13000, output: 120 });
    expect(auto?.timestamp).toBe("2026-10-06T09:02:03.000Z");
  });

  test("records cancellations and failures, and counts a cancellation as an interruption", () => {
    const { session } = parseVscodeCopilotSession("fallback", sampleLog());
    const other = session.messages.filter((message) => message.role === "other");
    expect(other.map((message) => message.blocks[0]?.text)).toEqual([
      "Canceled",
      "Sorry, the synthetic service is unavailable.",
    ]);
    expect(facets(session)).toMatchObject({
      interruptionCount: 1,
      turnCount: 4,
      agentSpawnCount: 0,
    });
  });

  test("reads file references from Copilot's file tools", () => {
    const { session } = parseVscodeCopilotSession("fallback", sampleLog(), {
      workspace: workspace() as never,
    });
    expect(fileRefs(session).map((ref) => [ref.operation, ref.relPath])).toEqual([
      ["read", "README.md"],
      ["edit", "README.md"],
    ]);
  });

  test("parses a whole-file snapshot that has no usage", () => {
    const content = readFileSync(
      join(workspaceFixture, "chatSessions", "vscode-legacy-session.json"),
      "utf8",
    );
    const parsed = parseVscodeCopilotSession("fallback", content);
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.rawMeta).toMatchObject({ storage: "json" });
    expect(parsed.session.totals).toMatchObject({ input: 0, output: 0 });
    expect(parsed.session.messages.every((message) => message.usage == null)).toBe(true);
    const result = parsed.session.messages[2]?.blocks[0];
    expect(result).toMatchObject({
      blockType: "tool_result",
      toolResult: "/synthetic/vscode-project/src/greeting.ts",
    });
    expect(parsed.session.messages[3]?.blocks[0]?.text).toBe("It is defined in greeting.ts.");
  });

  test("an empty window's session has no project", () => {
    const content = readFileSync(
      join(
        fixtureUser,
        "globalStorage",
        "emptyWindowChatSessions",
        "vscode-empty-window-session.jsonl",
      ),
      "utf8",
    );
    const { session } = parseVscodeCopilotSession("fallback", content);
    expect(session).toMatchObject({ projectPath: null, cwd: null, model: "gpt-5.4" });
    expect(session.totals).toMatchObject({ input: 2500, output: 40 });
  });

  test("replays pushes that truncate, sets, and deletes", () => {
    const content = logWith({ response: [{ value: "draft" }] }, [
      { kind: 2, k: ["requests", 0, "response"], i: 0, v: [{ value: "final" }] },
      { kind: 1, k: ["requests", 0, "completionTokens"], v: 7 },
      { kind: 1, k: ["customTitle"], v: "Temporary" },
      { kind: 3, k: ["customTitle"] },
    ]);
    const { session, issues } = parseVscodeCopilotSession("fallback", content);
    expect(issues).toEqual([]);
    expect(session.title).toBe("hello");
    expect(session.messages[1]?.blocks[0]?.text).toBe("final");
    expect(session.messages[1]?.usage).toMatchObject({ input: 0, output: 7 });
  });

  test("reports malformed lines and unknown records without losing the rest", () => {
    const content = `${logWith({ response: [{ value: "kept" }, { kind: "futurePart", x: 1 }] }, [
      { kind: 1, k: ["requests", 4, "modelState"], v: { value: 1 } },
      { kind: 9, k: ["requests"] },
    ])}{not json\n`;
    const { session, issues } = parseVscodeCopilotSession("fallback", content);
    expect(session.messages[1]?.blocks[0]?.text).toBe("kept");
    expect(session.messages[1]?.raw).toMatchObject({ response: [{}, { kind: "futurePart" }] });
    expect(issues.map((issue) => [issue.code, issue.lineNo])).toEqual([
      ["unparsed_line", 2],
      ["unparsed_line", 4],
      ["unknown_record_type", 3],
      ["unknown_record_type", null],
    ]);
    expect(issues[3]?.error).toContain('response part "futurePart"');
  });

  test("reports invalid array truncation without throwing or losing later updates", () => {
    const content = logWith({ response: [{ value: "kept" }] }, [
      { kind: 2, k: ["requests", 0, "response"], i: 0.5, v: [{ value: "bad" }] },
      { kind: 1, k: ["requests", 0, "completionTokens"], v: 7 },
    ]);
    const { session, issues } = parseVscodeCopilotSession("fallback", content);
    expect(issues).toMatchObject([{ code: "unparsed_line", lineNo: 2 }]);
    expect(session.messages[1]?.blocks[0]?.text).toBe("kept");
    expect(session.totals.output).toBe(7);
  });

  test("rejects a mutation that would replace the session object's prototype", () => {
    const content = logWith({}, [
      { kind: 1, k: ["__proto__"], v: { customTitle: "inherited title" } },
      { kind: 1, k: ["requests", 0, "completionTokens"], v: 7 },
    ]);
    const { session, issues } = parseVscodeCopilotSession("fallback", content);
    expect(issues).toMatchObject([{ code: "unparsed_line", lineNo: 2 }]);
    expect(session.title).toBe("hello");
    expect(session.totals.output).toBe(7);
  });

  test("rejects an invalid replacement state and preserves later valid updates", () => {
    const content = logWith({ response: [{ value: "kept" }] }, [
      { kind: 0, v: null },
      { kind: 1, k: ["requests", 0, "completionTokens"], v: 7 },
    ]);
    const { session, issues } = parseVscodeCopilotSession("fallback", content);
    expect(issues).toMatchObject([{ code: "unparsed_line", lineNo: 2 }]);
    expect(session.messages[1]?.blocks[0]?.text).toBe("kept");
    expect(session.totals.output).toBe(7);
  });

  test("replays a large response append without a function-argument overflow", () => {
    const content = logWith({}, [
      {
        kind: 2,
        k: ["requests", 0, "response"],
        v: Array.from({ length: 150000 }, () => ({ value: "x" })),
      },
    ]);
    const { session, issues } = parseVscodeCopilotSession("fallback", content);
    expect(issues).toEqual([]);
    expect(session.messages[1]?.blocks[0]?.text?.length).toBe(150000);
  });

  test("falls back to the session file's name when the session has no ID", () => {
    const { session } = parseVscodeCopilotSession("from-name", '{"version":3,"requests":[]}');
    expect(session).toMatchObject({ sourceSessionId: "from-name", messages: [] });
  });

  test("marks a denied tool call as an error", () => {
    const content = logWith({
      response: [
        {
          kind: "toolInvocationSerialized",
          toolId: "run_in_terminal",
          toolCallId: "call_denied",
          isConfirmed: { type: 0 },
          isComplete: true,
          toolSpecificData: { kind: "terminal", commandLine: { original: "rm -rf /tmp/example" } },
          pastTenseMessage: { value: "Skipped `rm -rf /tmp/example`" },
        },
      ],
    });
    const { session } = parseVscodeCopilotSession("fallback", content);
    expect(session.messages[1]?.blocks[0]).toMatchObject({
      toolName: "run_in_terminal",
      toolInput: { command: "rm -rf /tmp/example" },
    });
    expect(session.messages[2]?.blocks[0]).toMatchObject({ isError: true });
  });

  test("keeps a request that never finished, using its last recorded usage", () => {
    // VS Code quit mid-turn: no `result`, so no toolCallRounds to supply
    // arguments, and the encrypted reasoning leaves the thinking text empty.
    const terminal = (pastTense: string) => ({
      kind: "toolInvocationSerialized",
      toolId: "run_in_terminal",
      toolCallId: "call_term",
      isComplete: true,
      toolSpecificData: { kind: "terminal", commandLine: { original: "ls" } },
      pastTenseMessage: { value: pastTense },
    });
    const content = logWith(
      {
        modelId: "copilot/auto",
        promptTokens: 900,
        completionTokens: 20,
        response: [{ kind: "markdownContent", content: { value: "Looking around." } }],
      },
      [
        { kind: 1, k: ["requests", 0, "modelState"], v: { value: 0 } },
        { kind: 1, k: ["requests", 0, "completionTokens"], v: 70 },
        { kind: 1, k: ["requests", 0, "promptTokens"], v: 1200 },
        {
          kind: 2,
          k: ["requests", 0, "response"],
          i: 1,
          v: [
            {
              kind: "toolInvocationSerialized",
              toolId: "copilot_listDirectory",
              toolCallId: "call_list",
              isComplete: true,
              invocationMessage: { value: "Reading [](file:///synthetic)" },
            },
            {
              kind: "thinking",
              value: "",
              id: "encrypted",
              metadata: { vscodeReasoningDone: true },
            },
            terminal("Running `ls`"),
          ],
        },
        { kind: 2, k: ["requests", 0, "response"], i: 3, v: [terminal("Ran `ls`")] },
      ],
    );
    const { session, issues } = parseVscodeCopilotSession("fallback", content);
    expect(issues).toEqual([]);
    const blocks = session.messages.flatMap((message) => message.blocks);
    expect(blocks.some((block) => block.blockType === "thinking")).toBe(false);
    expect(
      blocks.filter((block) => block.blockType === "tool_use").map((block) => block.toolName),
    ).toEqual(["list_dir", "run_in_terminal"]);
    expect(session.totals).toMatchObject({ input: 1200, output: 70 });
  });
});

describe("VS Code naming helpers", () => {
  test("strips VS Code's MCP prefix from tool names", () => {
    expect(mcpBaseName("mcp_github_create_issue", ["github", null])).toBe("create_issue");
    // A second server with the same name gets a number.
    expect(mcpBaseName("mcp_github2_create_issue", ["github", null])).toBe("create_issue");
    // Long names are cut to fit the prefix.
    expect(mcpBaseName("mcp_my-very-long-s_list_items", ["My Very Long Server", null])).toBe(
      "list_items",
    );
    expect(mcpBaseName("mcp_other_tool", [null, null])).toBe("tool");
    expect(mcpBaseName("plain_tool", ["x", null])).toBe("plain_tool");
  });

  test("reads model IDs without the vendor prefix", () => {
    expect(vscodeModelId("copilot/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(vscodeModelId("anthropic/group/claude-opus-4")).toBe("claude-opus-4");
    expect(vscodeModelId("gpt-5.4")).toBe("gpt-5.4");
    expect(vscodeModelId("")).toBeNull();
  });

  test("turns serialized URIs into paths", () => {
    expect(uriPath("file:///synthetic/a%20b/c.ts")).toBe("/synthetic/a b/c.ts");
    expect(uriPath("file:///c%3A/synthetic/project")).toBe("c:/synthetic/project");
    expect(uriPath({ scheme: "vscode-remote", path: "/home/example/project" })).toBe(
      "/home/example/project",
    );
    expect(uriPath("not a uri")).toBeNull();
  });
});

describe("VS Code Copilot discovery and ingest", () => {
  function stageUser(root: string): string {
    const userDir = join(root, "Code", "User");
    cpSync(fixtureUser, userDir, { recursive: true });
    return userDir;
  }

  function config(root: string, extra: Partial<IngestConfig> = {}): IngestConfig {
    return {
      claudeDir: join(root, "none", "claude"),
      codexDir: join(root, "none", "codex"),
      ...extra,
    };
  }

  test("finds workspace and empty-window sessions, preferring a session's log", () => {
    const root = freshDir();
    const userDir = stageUser(root);
    const chats = join(userDir, "workspaceStorage", "5f3e9c1a", "chatSessions");
    // VS Code leaves the pre-log snapshot behind after switching to the log.
    write(join(chats, "vscode-sample-session.json"), '{"version":3,"requests":[]}');
    // Unrelated files in workspace storage are not sessions.
    write(join(userDir, "workspaceStorage", "5f3e9c1a", "state.json"), "{}");
    write(join(userDir, "globalStorage", "transferredChatSessions", "moved.json"), "{}");
    const found = discover(config(root, { vscodeCopilotDir: userDir }));
    expect(found.map((file) => [file.tool, file.path.slice(userDir.length + 1)])).toEqual([
      ["vscode_copilot", "globalStorage/emptyWindowChatSessions/vscode-empty-window-session.jsonl"],
      ["vscode_copilot", "workspaceStorage/5f3e9c1a/chatSessions/vscode-legacy-session.json"],
      ["vscode_copilot", "workspaceStorage/5f3e9c1a/chatSessions/vscode-sample-session.jsonl"],
    ]);
  });

  test("keeps the most recently written copy of a session moved between windows", () => {
    const root = freshDir();
    const userDir = join(root, "User");
    const older = join(userDir, "globalStorage", "emptyWindowChatSessions", "moved.jsonl");
    const newer = join(userDir, "workspaceStorage", "abc", "chatSessions", "moved.jsonl");
    write(older, logWith({}));
    write(newer, logWith({}));
    utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
    utimesSync(newer, new Date(2026, 0, 2), new Date(2026, 0, 2));
    expect(discover(config(root, { vscodeCopilotDir: userDir })).map((file) => file.path)).toEqual([
      newer,
    ]);
  });

  test("reads VS Code Insiders beside VS Code", () => {
    const root = freshDir();
    const stable = join(root, "Code", "User");
    const insiders = join(root, "Code - Insiders", "User");
    write(join(stable, "workspaceStorage", "a", "chatSessions", "one.jsonl"), logWith({}));
    write(join(insiders, "workspaceStorage", "b", "chatSessions", "two.jsonl"), logWith({}));
    const found = discover(
      config(root, { vscodeCopilotDir: stable, vscodeCopilotInsidersDir: insiders }),
    );
    expect(found.map((file) => file.path)).toEqual([
      join(insiders, "workspaceStorage", "b", "chatSessions", "two.jsonl"),
      join(stable, "workspaceStorage", "a", "chatSessions", "one.jsonl"),
    ]);
  });

  test("--path claims chat session files only in VS Code's storage layout", () => {
    const root = freshDir();
    const userDir = stageUser(root);
    const chats = join(userDir, "workspaceStorage", "5f3e9c1a", "chatSessions");
    write(join(chats, "vscode-sample-session.json"), '{"version":3,"requests":[]}');
    write(join(root, "elsewhere", "chatSessions", "x.json"), "{}");
    const files = discoverSourcePaths([join(userDir, "workspaceStorage"), join(root, "elsewhere")]);
    expect(files.map((file) => [file.tool, file.path.slice(root.length + 1)])).toEqual([
      [
        "vscode_copilot",
        "Code/User/workspaceStorage/5f3e9c1a/chatSessions/vscode-legacy-session.json",
      ],
      [
        "vscode_copilot",
        "Code/User/workspaceStorage/5f3e9c1a/chatSessions/vscode-sample-session.jsonl",
      ],
    ]);
  });

  test("explicit storage imports exclude extension journals for default and relocated roots", () => {
    for (const relocated of [false, true]) {
      const root = freshDir();
      const userDir = join(root, relocated ? "relocated" : "User");
      cpSync(fixtureUser, userDir, { recursive: true });
      write(join(userDir, "workspaceStorage", "abc", "extension", "events.jsonl"), "not JSON");
      write(join(userDir, "globalStorage", "extension", "events.jsonl"), "not JSON");
      write(join(userDir, "globalStorage", "extension", "opencode.db"), "not a database");
      const ingestConfig = config(root, { vscodeCopilotDir: userDir, sourcePaths: [userDir] });
      const files = discover(ingestConfig);
      expect(files).toHaveLength(3);
      expect(files.every((file) => file.tool === "vscode_copilot")).toBe(true);
      if (!relocated) expect(discoverSourcePaths([userDir])).toEqual(files);
      const db = openDb(join(root, "archive.db"));
      try {
        expect(sync(db, ingestConfig)).toMatchObject({
          scanned: 3,
          ingested: 3,
          issues: 0,
          failed: 0,
        });
      } finally {
        closeDb(db);
      }
    }
  });

  test("ingests sessions, and a session with no usage shows cost as unavailable", () => {
    const root = freshDir();
    const userDir = stageUser(root);
    const db = openDb(join(root, "archive.db"));
    try {
      const ingestConfig = config(root, { vscodeCopilotDir: userDir });
      expect(sync(db, ingestConfig)).toMatchObject({
        scanned: 3,
        ingested: 3,
        issues: 0,
        failed: 0,
      });
      expect(sync(db, ingestConfig)).toMatchObject({ scanned: 3, ingested: 0, skipped: 3 });
      const sessions = new Map(
        listSessions(db).map((session) => [session.source_session_id, session]),
      );
      expect(sessions.get("vscode-sample-session")).toMatchObject({
        tool: "vscode_copilot",
        project_path: "/synthetic/vscode-project",
        usage_available: true,
        total_input_tokens: 25000,
        total_output_tokens: 1020,
      });
      expect(sessions.get("vscode-sample-session")?.estimated_cost_usd).toBeGreaterThan(0);
      expect(sessions.get("vscode-legacy-session")).toMatchObject({
        usage_available: false,
        estimated_cost_usd: 0,
      });
      expect(statsTotals(db, { source: "vscode_copilot" })).toMatchObject({
        sessions: 3,
        usage_sessions: 2,
      });
    } finally {
      closeDb(db);
    }
  });
});
