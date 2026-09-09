import { describe, expect, test } from "bun:test";
import { linkageIssues } from "../src/diagnostics.ts";
import type { NormalizedBlock, NormalizedMessage, NormalizedSession } from "../src/model.ts";
import { emptyUsage } from "../src/model.ts";

function block(partial: Partial<NormalizedBlock>): NormalizedBlock {
  return {
    ordinal: 0,
    blockType: "text",
    text: null,
    toolName: null,
    toolUseId: null,
    toolInput: undefined,
    toolResult: null,
    isError: null,
    ...partial,
  };
}

function message(seq: number, blocks: NormalizedBlock[]): NormalizedMessage {
  return {
    seq,
    sourceUuid: null,
    parentSourceUuid: null,
    role: "assistant",
    model: null,
    stopReason: null,
    timestamp: null,
    usage: null,
    raw: null,
    blocks,
  };
}

function session(messages: NormalizedMessage[]): NormalizedSession {
  return {
    tool: "claude_code",
    sourceSessionId: "s1",
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

describe("linkageIssues", () => {
  test("clean call/result pairs produce no issues", () => {
    const s = session([
      message(0, [block({ blockType: "tool_use", toolUseId: "t1", toolName: "Bash" })]),
      message(1, [block({ blockType: "tool_result", toolUseId: "t1", toolResult: "ok" })]),
    ]);
    expect(linkageIssues(s)).toEqual([]);
  });

  test("flags orphan results, duplicate ids, and duplicate results", () => {
    const s = session([
      message(0, [
        block({ blockType: "tool_use", toolUseId: "dup", toolName: "Bash" }),
        block({ blockType: "tool_use", toolUseId: "dup", toolName: "Bash" }),
      ]),
      message(1, [
        block({ blockType: "tool_result", toolUseId: "dup", toolResult: "a" }),
        block({ blockType: "tool_result", toolUseId: "dup", toolResult: "b" }),
        block({ blockType: "tool_result", toolUseId: "ghost", toolResult: "c" }),
      ]),
    ]);
    const codes = linkageIssues(s)
      .map((issue) => issue.code)
      .sort();
    expect(codes).toEqual(["duplicate_tool_result", "duplicate_tool_use_id", "orphan_tool_result"]);
  });
});
