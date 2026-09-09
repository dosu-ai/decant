import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { epochSecs, extension, type FileRef, facets, fileRefs, relativize } from "../src/enrich.ts";
import type { NormalizedBlock, NormalizedSession, Tool } from "../src/model.ts";
import { emptyUsage } from "../src/model.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";

async function claudeSession(): Promise<NormalizedSession> {
  const content = await Bun.file(
    join(import.meta.dir, "..", "fixtures", "claude", "enriched.jsonl"),
  ).text();
  return parseClaudeSession("sess-claude-enr", content).session;
}

async function codexSession(): Promise<NormalizedSession> {
  const content = await Bun.file(
    join(import.meta.dir, "..", "fixtures", "codex", "enriched.jsonl"),
  ).text();
  return parseCodexSession("fallback", content, new Map()).session;
}

function brief(ref: FileRef): [string | null, string, string | null] {
  return [ref.relPath, ref.operation, ref.ext];
}

function toolUse(toolName: string, toolInput: NormalizedBlock["toolInput"]): NormalizedBlock {
  return {
    ordinal: 0,
    blockType: "tool_use",
    text: null,
    toolName,
    toolUseId: "t1",
    toolInput,
    toolResult: null,
    isError: null,
  };
}

function oneBlockSession(tool: Tool, block: NormalizedBlock): NormalizedSession {
  return {
    tool,
    sourceSessionId: "s",
    projectPath: null,
    title: null,
    cwd: null,
    gitBranch: null,
    model: null,
    reasoningEffort: null,
    reasoningEffortLevels: [],
    cliVersion: null,
    startedAt: null,
    endedAt: null,
    isArchived: false,
    isSubagent: false,
    rootSourceSessionId: null,
    spawnToolUseId: null,
    agentId: null,
    agentType: null,
    spawnDepth: null,
    rawMeta: null,
    totals: emptyUsage(),
    estReasoningTokens: 0,
    reasoningSource: "none",
    messages: [
      {
        seq: 0,
        sourceUuid: null,
        parentSourceUuid: null,
        role: "assistant",
        model: null,
        stopReason: null,
        timestamp: null,
        usage: null,
        raw: null,
        blocks: [block],
      },
    ],
  };
}

describe("fileRefs", () => {
  test("Claude file refs are extracted with rel paths and extensions", async () => {
    const refs = fileRefs(await claudeSession());
    expect(refs.map(brief)).toEqual([
      ["src/main.rs", "read", "rs"],
      ["src/main.rs", "edit", "rs"],
      ["README.md", "write", "md"],
      ["nb.ipynb", "edit", "ipynb"],
    ]);
    expect(refs[0]?.path).toBe("/Users/dev/proj/src/main.rs");
    expect(refs[0]?.timestamp).toBe("2026-05-03T10:01:00.000Z");
  });

  test("Codex apply_patch headers become refs and exec_command is ignored", async () => {
    const refs = fileRefs(await codexSession());
    expect(refs.map(brief)).toEqual([
      ["docs/new.md", "write", "md"],
      ["src/lib.rs", "edit", "rs"],
      ["old.txt", "delete", "txt"],
    ]);
  });

  test("Claude ref without path input is skipped", () => {
    const missingPath = oneBlockSession("claude_code", toolUse("Read", { something_else: 1 }));
    expect(fileRefs(missingPath)).toEqual([]);
    const bash = oneBlockSession("claude_code", toolUse("Bash", { command: "ls" }));
    expect(fileRefs(bash)).toEqual([]);
  });

  test("Gemini file tools become refs keyed by file_path", () => {
    const read = oneBlockSession("gemini", toolUse("read_file", { file_path: "/w/src/a.ts" }));
    read.cwd = "/w";
    expect(fileRefs(read).map(brief)).toEqual([["src/a.ts", "read", "ts"]]);
    const edit = oneBlockSession(
      "gemini",
      toolUse("replace", { file_path: "b.md", old_string: "x", new_string: "y" }),
    );
    expect(fileRefs(edit).map(brief)).toEqual([["b.md", "edit", "md"]]);
    const write = oneBlockSession(
      "gemini",
      toolUse("write_file", { file_path: "c.json", content: "{}" }),
    );
    expect(fileRefs(write).map(brief)).toEqual([["c.json", "write", "json"]]);
    const shell = oneBlockSession("gemini", toolUse("run_shell_command", { command: "cat f.txt" }));
    expect(fileRefs(shell)).toEqual([]);
  });

  test("Codex apply_patch with non-string input is skipped", () => {
    const objectInput = oneBlockSession("codex", toolUse("apply_patch", { patch: "x" }));
    expect(fileRefs(objectInput)).toEqual([]);
    const shell = oneBlockSession("codex", toolUse("shell", "ls -la"));
    expect(fileRefs(shell)).toEqual([]);
  });
});

describe("facets", () => {
  test("active seconds ignores nonpositive gaps and missing timestamps", () => {
    const content = [
      '{"type":"user","uuid":"u1","timestamp":"2026-05-01T10:00:10.000Z","message":{"role":"user","content":"a"}}',
      '{"type":"assistant","uuid":"a1","timestamp":"2026-05-01T10:00:05.000Z","message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"b"}]}}',
      '{"type":"assistant","uuid":"a2","message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"c"}]}}',
    ].join("\n");
    const session = parseClaudeSession("s", `${content}\n`).session;
    expect(facets(session).activeSeconds).toBe(0);
  });

  test("Claude facets count all markers", async () => {
    const got = facets(await claudeSession());
    expect(got.turnCount).toBe(1);
    expect(got.errorCount).toBe(1);
    expect(got.interruptionCount).toBe(1);
    expect(got.commandCount).toBe(1);
    expect(got.compactionCount).toBe(1);
    expect(got.sidechainMessageCount).toBe(2);
    expect(got.agentSpawnCount).toBe(1);
    expect(got.skillCount).toBe(1);
    expect(got.thinkingBlockCount).toBe(1);
    expect(got.thinkingChars).toBe("Plan the refactor carefully.".length);
    expect(got.activeSeconds).toBe(490);
  });

  test("standalone subagents count their sidechain prompts as turns", () => {
    const content = [
      '{"type":"user","uuid":"u1","isSidechain":true,"timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"user","content":"inspect it"}}',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","isSidechain":true,"timestamp":"2026-05-01T10:00:01.000Z","message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"done"}]}}',
    ].join("\n");
    const session = parseClaudeSession("agent-a1", content, {
      sourcePath: "/tmp/project/session/subagents/agent-a1.jsonl",
    }).session;

    expect(session.isSubagent).toBe(true);
    expect(facets(session)).toMatchObject({ turnCount: 1, sidechainMessageCount: 2 });
  });

  test("compact summaries do not count as user turns", () => {
    const content = [
      '{"type":"user","uuid":"u1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"user","content":"start"}}',
      '{"type":"user","uuid":"u2","parentUuid":"u1","isCompactSummary":true,"timestamp":"2026-05-01T10:00:01.000Z","message":{"role":"user","content":"carried summary"}}',
    ].join("\n");
    const session = parseClaudeSession("summary-turn", content).session;

    expect(facets(session).turnCount).toBe(1);
  });

  test("thinking chars count UTF-8 bytes", () => {
    const session = oneBlockSession("claude_code", {
      ordinal: 0,
      blockType: "thinking",
      text: "a中",
      toolName: null,
      toolUseId: null,
      toolInput: undefined,
      toolResult: null,
      isError: null,
    });
    expect(facets(session).thinkingChars).toBe(4);
  });

  test("Codex facets thinking and active duration", async () => {
    const got = facets(await codexSession());
    expect(got.turnCount).toBe(1);
    expect(got.thinkingBlockCount).toBe(1);
    expect(got.thinkingChars).toBeGreaterThan(0);
    expect(got.activeSeconds).toBe(8);
    expect(got.errorCount).toBe(0);
    expect(got.sidechainMessageCount).toBe(0);
  });
});

describe("path helpers", () => {
  test("relativize and extension edge cases", () => {
    expect(relativize("/a/b/c.rs", "/a/b")).toBe("c.rs");
    expect(relativize("/a/b/c.rs", "/a/b/")).toBe("c.rs");
    expect(relativize("/elsewhere/c.rs", "/a/b")).toBeNull();
    expect(relativize("/a/b/c.rs", null)).toBeNull();
    expect(relativize("docs/x.md", null)).toBe("docs/x.md");
    expect(extension("a/b/c.RS")).toBe("rs");
    expect(extension("Makefile")).toBeNull();
    expect(extension(".env")).toBeNull();
    expect(extension("a.tar.gz")).toBe("gz");
  });

  test("epoch seconds parses session timestamps", () => {
    expect(epochSecs("1970-01-01T00:00:00.000Z")).toBe(0);
    expect(epochSecs("1970-01-02T00:00:01Z")).toBe(86_401);
    expect(epochSecs("not a time")).toBeNull();
    const a = epochSecs("2026-05-03T10:00:00.000Z");
    const b = epochSecs("2026-05-03T10:01:00.000Z");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect((b ?? 0) - (a ?? 0)).toBe(60);
  });
});
