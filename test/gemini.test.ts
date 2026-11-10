import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGeminiSession } from "../src/sources/gemini.ts";

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", "gemini", name), "utf8");
}

describe("parseGeminiSession", () => {
  test("parses messages, usage, thoughts, and linked tool calls", () => {
    const parsed = parseGeminiSession(
      "fallback",
      fixture("sample.jsonl"),
      "/synthetic/gemini-project",
    );
    const { session } = parsed;

    expect(parsed.issues).toEqual([]);
    expect(session).toMatchObject({
      tool: "gemini",
      sourceSessionId: "gemini-synthetic",
      projectPath: "/synthetic/gemini-project",
      cwd: "/synthetic/gemini-project",
      title: "Inspect the synthetic example.",
      model: "example-model",
      startedAt: "2026-06-01T10:00:00.000Z",
      endedAt: "2026-06-01T10:00:06.000Z",
      reasoningSource: "reported",
      totals: {
        input: 15,
        output: 14,
        cacheRead: 8,
        cacheCreation: 0,
        cacheCreation1h: 0,
        reasoning: 2,
      },
    });
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);

    const call = session.messages[1]?.blocks.find((block) => block.blockType === "tool_use");
    const result = session.messages[2]?.blocks.find((block) => block.blockType === "tool_result");
    expect(call).toMatchObject({
      ordinal: 1,
      toolName: "read_file",
      toolUseId: "call-1",
      toolInput: { file_path: "/tmp/example.txt" },
    });
    expect(result).toMatchObject({
      ordinal: 0,
      toolUseId: "call-1",
      toolResult: '{"output":"example"}',
      isError: false,
    });
    expect(session.messages[1]?.blocks.map((block) => block.ordinal)).toEqual([0, 1, 2]);
  });

  test("continues after malformed lines and reports unknown record types once", () => {
    const content = [
      JSON.stringify({
        sessionId: "gemini-drift",
        startTime: "2026-06-02T10:00:00.000Z",
      }),
      JSON.stringify({
        id: "user-1",
        timestamp: "2026-06-02T10:00:01.000Z",
        type: "user",
        content: "Continue after malformed input.",
      }),
      '{"broken":',
      JSON.stringify({ type: "future_record", timestamp: "2026-06-02T10:00:02.000Z" }),
      JSON.stringify({ type: "future_record", timestamp: "2026-06-02T10:00:02.500Z" }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-02T10:00:03.000Z",
        type: "gemini",
        model: "example-model",
        content: [{ text: "Parsing continued." }],
        tokens: { input: 2, output: 2, cached: 0, thoughts: 0 },
      }),
    ].join("\n");
    const parsed = parseGeminiSession("fallback", content, null);

    expect(parsed.session.sourceSessionId).toBe("gemini-drift");
    expect(parsed.session.messages).toHaveLength(2);
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues[0]).toMatchObject({ code: "unparsed_line", lineNo: 3 });
    expect(parsed.issues[1]).toMatchObject({
      code: "unknown_record_type",
      lineNo: 4,
      error: 'unknown record type "future_record" on 2 line(s); ignored',
    });
  });

  test("skips injected session context and marks error tool results", () => {
    const content = [
      JSON.stringify({ sessionId: "gemini-error", startTime: "2026-06-03T10:00:00.000Z" }),
      JSON.stringify({
        id: "context",
        timestamp: "2026-06-03T10:00:01.000Z",
        type: "user",
        content: [
          { text: "  <session_context>synthetic boilerplate</session_context>" },
          { text: "<hook_context>synthetic hook boilerplate</hook_context>" },
        ],
      }),
      JSON.stringify({
        id: "call",
        timestamp: "2026-06-03T10:00:02.000Z",
        type: "gemini",
        model: "example-model",
        content: [],
        toolCalls: [{ id: "call-error", name: "read_file", args: {} }],
      }),
      JSON.stringify({
        id: "result",
        timestamp: "2026-06-03T10:00:03.000Z",
        type: "user",
        content: [
          {
            functionResponse: {
              id: "call-error",
              name: "read_file",
              response: { error: "synthetic failure" },
            },
          },
        ],
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.messages).toHaveLength(2);
    expect(parsed.session.messages[1]?.role).toBe("tool");
    expect(parsed.session.messages[1]?.blocks[0]).toMatchObject({
      toolUseId: "call-error",
      isError: true,
    });
  });

  test("does not mark explicit false or empty error values as failures", () => {
    const content = [
      JSON.stringify({ sessionId: "gemini-success", startTime: "2026-06-03T10:00:00.000Z" }),
      JSON.stringify({
        id: "calls",
        timestamp: "2026-06-03T10:00:01.000Z",
        type: "gemini",
        model: "example-model",
        content: [],
        toolCalls: [
          { id: "call-false", name: "read_file", args: {} },
          { id: "call-empty", name: "read_file", args: {} },
        ],
      }),
      JSON.stringify({
        id: "results",
        timestamp: "2026-06-03T10:00:02.000Z",
        type: "user",
        content: [
          {
            functionResponse: {
              id: "call-false",
              name: "read_file",
              response: { error: false },
            },
          },
          {
            functionResponse: {
              id: "call-empty",
              name: "read_file",
              response: { error: "" },
            },
          },
        ],
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.messages[1]?.blocks).toHaveLength(2);
    expect(parsed.session.messages[1]?.blocks.map((block) => block.isError)).toEqual([
      false,
      false,
    ]);
  });

  test("retains repeated tool responses without duplicating their linkage", () => {
    const content = [
      JSON.stringify({ sessionId: "gemini-repeat", startTime: "2026-06-04T10:00:00.000Z" }),
      JSON.stringify({
        id: "call",
        timestamp: "2026-06-04T10:00:01.000Z",
        type: "gemini",
        model: "example-model",
        toolCalls: [{ id: "call-1", name: "read_file", args: {} }],
      }),
      JSON.stringify({
        id: "result-1",
        timestamp: "2026-06-04T10:00:02.000Z",
        type: "user",
        content: [
          {
            functionResponse: {
              id: "call-1",
              name: "read_file",
              response: { output: "complete synthetic output" },
            },
          },
        ],
      }),
      JSON.stringify({
        id: "result-2",
        timestamp: "2026-06-04T10:00:03.000Z",
        type: "user",
        content: [
          {
            functionResponse: {
              id: "call-1",
              name: "read_file",
              response: { output: "short output" },
            },
          },
        ],
      }),
      JSON.stringify({
        id: "info-1",
        timestamp: "2026-06-04T10:00:04.000Z",
        type: "info",
        content: "Synthetic informational record.",
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "other",
      "other",
    ]);
    expect(parsed.session.messages[2]?.blocks[0]).toMatchObject({
      blockType: "other",
      toolUseId: null,
    });
    expect(parsed.session.messages[2]?.raw).toMatchObject({ id: "result-2" });
  });

  test("normalizes Gemini MCP display names", () => {
    const parsed = parseGeminiSession("fallback", fixture("mcp.jsonl"), null);
    const call = parsed.session.messages[1]?.blocks.find((block) => block.blockType === "tool_use");

    expect(parsed.issues).toEqual([]);
    expect(call).toMatchObject({
      toolName: "mcp__docs__lookup",
      toolUseId: "mcp-call-1",
    });
  });

  test("normalizes Gemini MCP internal names", () => {
    const content = [
      JSON.stringify({
        sessionId: "synthetic-mcp-internal",
        startTime: "2026-06-05T10:00:00.000Z",
      }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-05T10:00:01.000Z",
        type: "gemini",
        content: "Calling the synthetic MCP tool.",
        toolCalls: [
          {
            id: "mcp-call-2",
            name: "mcp_docs_search_pages",
            args: { query: "synthetic" },
          },
        ],
      }),
      JSON.stringify({
        id: "result-1",
        timestamp: "2026-06-05T10:00:02.000Z",
        type: "user",
        content: [
          {
            functionResponse: {
              id: "mcp-call-2",
              name: "mcp_docs_search_pages",
              response: { output: "Synthetic result." },
            },
          },
        ],
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    const call = parsed.session.messages[0]?.blocks.find((block) => block.blockType === "tool_use");

    expect(parsed.issues).toEqual([]);
    expect(call).toMatchObject({
      toolName: "mcp__docs__search_pages",
      toolUseId: "mcp-call-2",
    });
  });

  test("replays a re-appended message id as a replacement, not a duplicate", () => {
    // Gemini CLI appends the same message id again when usage or tool calls
    // arrive after the text, so the last record wins and nothing doubles.
    const content = [
      JSON.stringify({ sessionId: "gemini-replay", startTime: "2026-06-06T10:00:00.000Z" }),
      JSON.stringify({
        id: "user-1",
        timestamp: "2026-06-06T10:00:01.000Z",
        type: "user",
        content: "Replay the synthetic turn.",
      }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-06T10:00:02.000Z",
        type: "gemini",
        model: "example-model",
        content: [{ text: "Working on it." }],
      }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-06T10:00:02.000Z",
        type: "gemini",
        model: "example-model",
        content: [{ text: "Working on it." }],
        toolCalls: [{ id: "call-1", name: "read_file", args: { file_path: "/tmp/a" } }],
      }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-06T10:00:02.000Z",
        type: "gemini",
        model: "example-model",
        content: [{ text: "Working on it." }],
        toolCalls: [{ id: "call-1", name: "read_file", args: { file_path: "/tmp/a" } }],
        tokens: { input: 7, output: 3, cached: 1, thoughts: 2, tool: 0, total: 13 },
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(parsed.session.messages[1]?.blocks.map((block) => block.blockType)).toEqual([
      "text",
      "tool_use",
    ]);
    expect(parsed.session.totals).toMatchObject({
      input: 6,
      output: 5,
      cacheRead: 1,
      reasoning: 2,
    });
  });

  test("nets cached tokens out of input and folds thoughts into output", () => {
    // Gemini's promptTokenCount already includes cachedContentTokenCount and
    // thoughtsTokenCount sits outside candidatesTokenCount, whereas Decant
    // treats input as uncached and reasoning as a subset of output.
    const content = [
      JSON.stringify({ sessionId: "gemini-usage", startTime: "2026-06-13T10:00:00.000Z" }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-13T10:00:01.000Z",
        type: "gemini",
        content: [{ text: "Counted." }],
        tokens: { input: 100, output: 30, cached: 60, thoughts: 5, tool: 0, total: 135 },
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    expect(parsed.session.messages[0]?.usage).toEqual({
      input: 40,
      output: 35,
      cacheRead: 60,
      cacheCreation: 0,
      cacheCreation1h: 0,
      reasoning: 5,
    });
    expect(parsed.session.totals).toMatchObject({ input: 40, output: 35, reasoning: 5 });
  });

  test("treats $set.messages as an authoritative checkpoint", () => {
    const content = [
      JSON.stringify({ sessionId: "gemini-checkpoint", startTime: "2026-06-07T10:00:00.000Z" }),
      JSON.stringify({
        id: "user-1",
        timestamp: "2026-06-07T10:00:01.000Z",
        type: "user",
        content: "Original first prompt.",
      }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-07T10:00:02.000Z",
        type: "gemini",
        content: [{ text: "Original reply." }],
        tokens: { input: 4, output: 2, cached: 0, thoughts: 0 },
      }),
      JSON.stringify({
        $set: {
          lastUpdated: "2026-06-07T10:00:03.000Z",
          messages: [
            {
              id: "user-2",
              timestamp: "2026-06-07T10:00:03.000Z",
              type: "user",
              content: "Checkpointed prompt.",
            },
            {
              id: "assistant-1",
              timestamp: "2026-06-07T10:00:02.000Z",
              type: "gemini",
              content: [{ text: "Rewritten reply." }],
              tokens: { input: 4, output: 2, cached: 0, thoughts: 0 },
            },
          ],
        },
      }),
      JSON.stringify({
        id: "assistant-2",
        timestamp: "2026-06-07T10:00:04.000Z",
        type: "gemini",
        content: [{ text: "After the checkpoint." }],
        tokens: { input: 1, output: 1, cached: 0, thoughts: 0 },
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    expect(parsed.issues).toEqual([]);
    expect(
      parsed.session.messages.map((message) => [message.sourceUuid, message.blocks[0]?.text]),
    ).toEqual([
      ["user-2", "Checkpointed prompt."],
      ["assistant-1", "Rewritten reply."],
      ["assistant-2", "After the checkpoint."],
    ]);
    expect(parsed.session.title).toBe("Checkpointed prompt.");
    expect(parsed.session.totals).toMatchObject({ input: 5, output: 3 });
  });

  test("drops the rewound message and everything after it", () => {
    const content = [
      JSON.stringify({ sessionId: "gemini-rewind", startTime: "2026-06-08T10:00:00.000Z" }),
      JSON.stringify({
        id: "user-1",
        timestamp: "2026-06-08T10:00:01.000Z",
        type: "user",
        content: "Keep this prompt.",
      }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-08T10:00:02.000Z",
        type: "gemini",
        content: [{ text: "Kept reply." }],
        tokens: { input: 3, output: 1, cached: 0, thoughts: 0 },
      }),
      JSON.stringify({
        id: "user-2",
        timestamp: "2026-06-08T10:00:03.000Z",
        type: "user",
        content: "Rewound prompt.",
      }),
      JSON.stringify({
        id: "assistant-2",
        timestamp: "2026-06-08T10:00:04.000Z",
        type: "gemini",
        content: [{ text: "Rewound reply." }],
        tokens: { input: 100, output: 100, cached: 0, thoughts: 0 },
      }),
      JSON.stringify({ $rewindTo: "user-2" }),
      JSON.stringify({
        id: "user-3",
        timestamp: "2026-06-08T10:00:05.000Z",
        type: "user",
        content: "Replacement prompt.",
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    expect(parsed.issues).toEqual([]);
    expect(parsed.session.messages.map((message) => message.sourceUuid)).toEqual([
      "user-1",
      "assistant-1",
      "user-3",
    ]);
    expect(parsed.session.totals).toMatchObject({ input: 3, output: 1 });
    expect(parsed.session.endedAt).toBe("2026-06-08T10:00:05.000Z");
  });

  test("keeps thoughts recorded as subject and description", () => {
    const content = [
      JSON.stringify({ sessionId: "gemini-thoughts", startTime: "2026-06-09T10:00:00.000Z" }),
      JSON.stringify({
        id: "assistant-1",
        timestamp: "2026-06-09T10:00:01.000Z",
        type: "gemini",
        content: [{ text: "Done." }],
        thoughts: [
          {
            subject: "Planning",
            description: "Read the synthetic file first.",
            timestamp: "2026-06-09T10:00:00.500Z",
          },
          { subject: "", description: "Description only.", timestamp: "2026-06-09T10:00:00.700Z" },
        ],
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    const thinking = parsed.session.messages[0]?.blocks.filter(
      (block) => block.blockType === "thinking",
    );
    expect(thinking?.map((block) => block.text)).toEqual([
      "Planning\n\nRead the synthetic file first.",
      "Description only.",
    ]);
  });

  test("marks subagent sessions from the header kind and parent id", () => {
    const content = [
      JSON.stringify({
        sessionId: "gemini-child",
        projectHash: "synthetic-project",
        startTime: "2026-06-10T10:00:00.000Z",
        kind: "subagent",
      }),
      JSON.stringify({
        id: "user-1",
        timestamp: "2026-06-10T10:00:01.000Z",
        type: "user",
        content: "Delegated task.",
      }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null, {
      parentSessionId: "gemini-parent",
    });
    expect(parsed.session).toMatchObject({
      isSubagent: true,
      rootSourceSessionId: "gemini-parent",
      agentId: "gemini-child",
    });

    const headerOnly = parseGeminiSession("fallback", content, null);
    expect(headerOnly.session).toMatchObject({ isSubagent: true, rootSourceSessionId: null });
  });

  test("uses the recorded session summary as the title", () => {
    const content = [
      JSON.stringify({ sessionId: "gemini-summary", startTime: "2026-06-11T10:00:00.000Z" }),
      JSON.stringify({
        id: "user-1",
        timestamp: "2026-06-11T10:00:01.000Z",
        type: "user",
        content: "First prompt text.",
      }),
      JSON.stringify({ $set: { summary: "Synthetic session summary" } }),
    ].join("\n");

    const parsed = parseGeminiSession("fallback", content, null);
    expect(parsed.session.title).toBe("Synthetic session summary");
  });
});
