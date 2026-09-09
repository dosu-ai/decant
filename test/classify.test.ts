import { describe, expect, test } from "bun:test";
import { outcome, workType } from "../src/classify.ts";
import type { FileRef, Operation } from "../src/enrich.ts";
import {
  emptyUsage,
  type NormalizedBlock,
  type NormalizedMessage,
  type NormalizedSession,
} from "../src/model.ts";

function msg(role: NormalizedMessage["role"], blocks: NormalizedBlock[]): NormalizedMessage {
  return {
    seq: 0,
    sourceUuid: null,
    parentSourceUuid: null,
    role,
    model: null,
    stopReason: null,
    timestamp: null,
    usage: null,
    raw: {},
    blocks,
  };
}

function text(value: string): NormalizedBlock {
  return {
    ordinal: 0,
    blockType: "text",
    text: value,
    toolName: null,
    toolUseId: null,
    toolInput: undefined,
    toolResult: null,
    isError: null,
  };
}

function toolResult(error: boolean): NormalizedBlock {
  return {
    ordinal: 0,
    blockType: "tool_result",
    text: null,
    toolName: null,
    toolUseId: "t1",
    toolInput: undefined,
    toolResult: "out",
    isError: error,
  };
}

function session(messages: NormalizedMessage[]): NormalizedSession {
  return {
    tool: "claude_code",
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
    messages,
  };
}

function fref(operation: Operation): FileRef {
  return {
    messageIdx: 0,
    path: "x.rs",
    relPath: "x.rs",
    ext: "rs",
    operation,
    timestamp: null,
  };
}

describe("outcome", () => {
  test("completed when assistant ends with text", () => {
    const assistant = msg("assistant", [text("Done.")]);
    assistant.stopReason = "end_turn";
    expect(outcome(session([msg("user", [text("do it")]), assistant]))).toBe("completed");
  });

  test("abandoned when session ends on user text", () => {
    expect(
      outcome(
        session([msg("assistant", [text("Done.")]), msg("user", [text("and one more thing")])]),
      ),
    ).toBe("abandoned");
  });

  test("abandoned when assistant stops mid tool use", () => {
    const assistant = msg("assistant", [text("Reading...")]);
    assistant.stopReason = "tool_use";
    expect(outcome(session([msg("user", [text("go")]), assistant]))).toBe("abandoned");
  });

  test("abandoned on recent interruption", () => {
    expect(
      outcome(
        session([
          msg("user", [text("go")]),
          msg("assistant", [text("working")]),
          msg("user", [text("[Request interrupted by user]")]),
        ]),
      ),
    ).toBe("abandoned");
  });

  test("failed when trailing tool error unconsumed", () => {
    expect(outcome(session([msg("user", [text("go")]), msg("tool", [toolResult(true)])]))).toBe(
      "failed",
    );
  });

  test("ignores sidechain tail", () => {
    const assistant = msg("assistant", [text("Done.")]);
    assistant.stopReason = "end_turn";
    const sidechain = msg("user", [text("subagent prompt")]);
    sidechain.raw = { isSidechain: true };
    expect(outcome(session([msg("user", [text("go")]), assistant, sidechain]))).toBe("completed");
  });

  test("none for empty or non-conversational main thread", () => {
    expect(outcome(session([]))).toBeNull();
    expect(outcome(session([msg("system", [text("boot")])]))).toBeNull();
  });

  test("abandoned when trailing result is ok despite earlier error", () => {
    expect(
      outcome(
        session([
          msg("user", [text("go")]),
          msg("tool", [toolResult(true)]),
          msg("assistant", [text("retrying with a fix")]),
          msg("tool", [toolResult(false)]),
        ]),
      ),
    ).toBe("abandoned");
  });
});

describe("workType", () => {
  test("tool mix fallback runs without any prompt", () => {
    const got = workType(session([msg("tool", [toolResult(false)])]), [fref("read"), fref("edit")]);
    expect(got).toBe("feature");
  });

  test("keywords match whole words not substrings", () => {
    expect(
      workType(session([msg("user", [text("Update the fixture data for tests")])]), []),
    ).toBeNull();
    expect(
      workType(session([msg("user", [text("Document the URL prefix handling")])]), []),
    ).toBeNull();
    expect(workType(session([msg("user", [text("Fixing the flaky login spec")])]), [])).toBe(
      "debugging",
    );
    expect(workType(session([msg("user", [text("fix login")])]), [])).toBe("debugging");
    expect(workType(session([msg("user", [text("fixé login")])]), [])).toBeNull();
  });

  test("keywords take priority", () => {
    const cases: [string, NonNullable<ReturnType<typeof workType>>][] = [
      ["Fix the failing auth test", "debugging"],
      ["Implement cursor pagination for /sessions", "feature"],
      ["Refactor the parser module into two files", "refactor"],
      ["Research whether turso fits this app", "research"],
      ["Configure the release pipeline", "ops"],
    ];
    for (const [prompt, expected] of cases) {
      expect(workType(session([msg("user", [text(prompt)])]), [])).toBe(expected);
    }
  });

  test("falls back to tool mix", () => {
    expect(workType(session([msg("user", [text("what does this repo do")])]), [fref("read")])).toBe(
      "research",
    );
    expect(
      workType(session([msg("user", [text("ok let's go then")])]), [fref("read"), fref("edit")]),
    ).toBe("feature");
  });

  test("none without signal", () => {
    expect(workType(session([msg("user", [text("hello there")])]), [])).toBeNull();
  });

  test("writes outweigh edits is feature", () => {
    expect(
      workType(session([msg("tool", [toolResult(false)])]), [
        fref("write"),
        fref("write"),
        fref("edit"),
      ]),
    ).toBe("feature");
  });
});
