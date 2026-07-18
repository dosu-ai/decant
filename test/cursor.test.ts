import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCursorSession } from "../src/sources/cursor.ts";

async function fixture(name: string): Promise<string> {
  return await Bun.file(join(import.meta.dir, "..", "fixtures", "cursor", name)).text();
}

describe("parseCursorSession", () => {
  test("parses stream-json sessions with caller-owned identity and totals", async () => {
    const meta = JSON.parse(await fixture("stream.meta.json"));
    const parsed = parseCursorSession("cursor-stream", await fixture("stream.jsonl"), {
      sourcePath: "/tmp/cursor/stream.jsonl",
      sidecarMeta: meta,
    });

    expect(parsed.issues).toEqual([]);
    expect(parsed.session).toMatchObject({
      tool: "cursor",
      sourceSessionId: "cursor-stream",
      title: "Read package.json and add a note",
      cwd: "/Users/dev/proj",
      projectPath: "/Users/dev/proj",
      model: "composer-2.5",
      cliVersion: "2026.07.01",
      startedAt: "2026-07-06T10:00:00.000Z",
      endedAt: "2026-07-06T10:00:01.000Z",
      totals: {
        input: 1000,
        output: 200,
        cacheRead: 50,
        cacheCreation: 25,
        reasoning: 0,
      },
      reasoningSource: "inferred",
    });
    expect(parsed.session.estReasoningTokens).toBeGreaterThan(0);
    expect(parsed.session.estReasoningTokens).toBeLessThanOrEqual(200);
    expect(parsed.session.rawMeta).toMatchObject({
      init: { session_id: "cursor-init-1" },
      nativeTranscript: false,
    });
  });

  test("pairs completed tool calls and skips started duplicates", async () => {
    const parsed = parseCursorSession("cursor-stream", await fixture("stream.jsonl"));
    const toolMessages = parsed.session.messages.filter((message) =>
      message.blocks.some((block) => block.blockType === "tool_use"),
    );

    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]?.blocks).toEqual([
      expect.objectContaining({
        blockType: "tool_use",
        toolName: "read",
        toolUseId: "call-read",
        toolInput: { path: "package.json" },
      }),
      expect.objectContaining({
        blockType: "tool_result",
        toolUseId: "call-read",
        isError: false,
      }),
    ]);
    expect(toolMessages[1]?.blocks[0]).toMatchObject({
      blockType: "tool_use",
      toolName: "write",
      toolUseId: "call-write",
      toolInput: { path: "notes.txt", fileText: "done", toolCallId: "call-write" },
    });
    expect(toolMessages[2]?.blocks[0]).toMatchObject({
      blockType: "tool_use",
      toolName: "shell",
      toolUseId: "call-shell",
      toolInput: { command: "bun test" },
    });
  });

  test("parses local Cursor role-message transcripts", async () => {
    const parsed = parseCursorSession("native", await fixture("native.jsonl"), {
      sourcePath:
        "/Users/dev/.cursor/projects/Users-dev-proj/agent-transcripts/native/native.jsonl",
      sidecarMeta: {
        createdAtMs: Date.parse("2026-07-06T10:01:00.000Z"),
        updatedAtMs: Date.parse("2026-07-06T10:03:00.000Z"),
        cwd: "/Users/dev/proj",
      },
    });

    expect(parsed.issues).toEqual([]);
    expect(parsed.session.title).toBe("Open the README and summarize the setup.");
    expect(parsed.session.cwd).toBe("/Users/dev/proj");
    expect(parsed.session.projectPath).toBe("/Users/dev/proj");
    expect(parsed.session.startedAt).toBe("2026-07-06T10:01:00.000Z");
    expect(parsed.session.endedAt).toBe("2026-07-06T10:03:00.000Z");
    expect(parsed.session.totals.output).toBe(0);
    expect(parsed.session.rawMeta).toMatchObject({
      nativeTranscript: true,
      sourceProjectKey: "Users-dev-proj",
    });
    expect(parsed.session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "other",
    ]);
    expect(parsed.session.messages[1]?.blocks).toEqual([
      expect.objectContaining({ blockType: "text", text: "I'll read the README first." }),
      expect.objectContaining({
        blockType: "tool_use",
        toolName: "Read",
        toolUseId: "tool-readme",
        toolInput: { path: "README.md" },
      }),
    ]);
  });

  test("parses native Cursor JSON-string message content into readable text", () => {
    const parsed = parseCursorSession(
      "native-json",
      JSON.stringify({
        role: "user",
        message: JSON.stringify({
          content: [
            {
              type: "text",
              text: "<timestamp>Monday, Jul 6, 2026</timestamp>\n<user_query>\nPlease format this for Discord.\n</user_query>",
            },
          ],
        }),
      }),
    );

    expect(parsed.session.title).toBe("Please format this for Discord.");
    expect(parsed.session.messages[0]?.blocks[0]?.text).toContain("Please format this");
  });

  test("marks Cursor tool-call error results", () => {
    const parsed = parseCursorSession(
      "tool-error",
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-error",
        tool_call: {
          readToolCall: {
            args: { path: "missing.txt" },
            result: { error: "file not found" },
          },
        },
      }),
    );

    expect(parsed.session.messages[0]?.blocks).toEqual([
      expect.objectContaining({
        blockType: "tool_use",
        toolName: "read",
        toolUseId: "call-error",
      }),
      expect.objectContaining({
        blockType: "tool_result",
        toolUseId: "call-error",
        isError: true,
      }),
    ]);
  });

  test("reports malformed JSONL rows without dropping valid messages", async () => {
    const parsed = parseCursorSession("bad", `${(await fixture("native.jsonl")).trimEnd()}\n{bad`);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.lineNo).toBe(5);
    expect(parsed.session.messages.length).toBeGreaterThan(0);
  });

  test("uses nested Cursor tool-call timestamps for session bounds", () => {
    const parsed = parseCursorSession(
      "nested-times",
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-read",
        tool_call: {
          readToolCall: {
            args: { path: "package.json" },
            startedAtMs: "1783373851610",
            completedAtMs: "1783373851999",
            result: { success: { content: "{}" } },
          },
        },
      }),
    );

    expect(parsed.session.startedAt).toBe("2026-07-06T21:37:31.610Z");
    expect(parsed.session.endedAt).toBe("2026-07-06T21:37:31.999Z");
    expect(parsed.session.messages[0]?.timestamp).toBe("2026-07-06T21:37:31.610Z");
  });

  test("ignores out-of-range epoch timestamps instead of aborting the parse", () => {
    const parsed = parseCursorSession(
      "invalid-times",
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-read",
        tool_call: {
          readToolCall: {
            args: { path: "package.json" },
            startedAtMs: "9000000000000000",
            completedAtMs: "9000000000000000",
            result: { success: { content: "{}" } },
          },
        },
      }),
    );

    expect(parsed.session.startedAt).toBeNull();
    expect(parsed.session.endedAt).toBeNull();
    expect(parsed.session.messages[0]?.timestamp).toBeNull();
  });

  test("uses reported reasoning provenance when result usage includes reasoning tokens", () => {
    const parsed = parseCursorSession(
      "reported",
      JSON.stringify({
        type: "result",
        usage: { inputTokens: 10, outputTokens: 6, reasoningTokens: 4 },
      }),
    );

    expect(parsed.session.totals.reasoning).toBe(4);
    expect(parsed.session.estReasoningTokens).toBe(0);
    expect(parsed.session.reasoningSource).toBe("reported");
  });
});
