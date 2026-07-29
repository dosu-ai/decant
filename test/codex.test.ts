import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCodexSession } from "../src/sources/codex.ts";

async function fixture(): Promise<string> {
  return await Bun.file(join(import.meta.dir, "..", "fixtures", "codex", "sample.jsonl")).text();
}

describe("parseCodexSession", () => {
  test("parses meta model and conversation", async () => {
    const parsed = parseCodexSession("fallback", await fixture(), new Map());
    const session = parsed.session;
    expect(parsed.issues).toHaveLength(0);
    expect(session.tool).toBe("codex");
    expect(session.sourceSessionId).toBe("sess-codex-1");
    expect(session.cwd).toBe("/Users/dev/proj");
    expect(session.model).toBe("gpt-5.4");
    expect(session.reasoningEffort).toBe("high");
    expect(session.reasoningEffortLevels).toEqual(["high"]);
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0]?.role).toBe("user");
    expect(session.messages[1]?.blocks[0]?.blockType).toBe("tool_use");
    expect(session.messages[2]?.role).toBe("tool");
    expect(session.title).toBe("List the open TODOs");
  });

  test("cumulative token count becomes session totals", async () => {
    const parsed = parseCodexSession("fallback", await fixture(), new Map());
    expect(parsed.session.totals.input).toBe(500);
    expect(parsed.session.totals.output).toBe(150);
    expect(parsed.session.totals.cacheRead).toBe(400);
    expect(parsed.session.totals.reasoning).toBe(60);
    expect(parsed.session.reasoningSource).toBe("reported");
    expect(parsed.session.estReasoningTokens).toBe(0);
  });

  test("session index title overrides", async () => {
    const parsed = parseCodexSession(
      "fallback",
      await fixture(),
      new Map([["sess-codex-1", "TODO audit"]]),
    );
    expect(parsed.session.title).toBe("TODO audit");
  });

  test("marks sessions whose effort changes between turns", () => {
    const content = [
      '{"type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"high"}}',
      '{"type":"turn_context","payload":{"model":"gpt-5.6-sol","effort":"xhigh"}}',
    ].join("\n");
    const session = parseCodexSession("mixed", content, new Map()).session;
    expect(session.reasoningEffort).toBe("mixed");
    expect(session.reasoningEffortLevels).toEqual(["high", "xhigh"]);
  });

  test("preserves every current Codex effort label", () => {
    const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    const content = efforts
      .map(
        (effort) => `{"type":"turn_context","payload":{"model":"gpt-test","effort":"${effort}"}}`,
      )
      .join("\n");
    const session = parseCodexSession("all-efforts", content, new Map()).session;
    expect(session.reasoningEffort).toBe("mixed");
    expect(session.reasoningEffortLevels).toEqual(efforts);
  });

  test("preserves future custom Codex effort labels", () => {
    const content =
      '{"type":"turn_context","payload":{"model":"gpt-future","effort":"Future-Level"}}';
    const session = parseCodexSession("future-effort", content, new Map()).session;
    expect(session.reasoningEffort).toBe("Future-Level");
    expect(session.reasoningEffortLevels).toEqual(["Future-Level"]);
  });

  test("stamps last_token_usage onto the producing assistant without crossing compaction", () => {
    const content = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-01T09:00:00Z",
        payload: { id: "sess-stamp", cwd: "/tmp/proj" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T09:00:01Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T09:00:02Z",
        payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: "{}" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T09:00:03Z",
        payload: { type: "function_call_output", call_id: "c1", output: "ok" },
      }),
      // Walks back past the tool row; the later reading wins for the message.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T09:00:04Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 700,
              cache_write_input_tokens: 50,
              output_tokens: 60,
            },
            last_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 700,
              cache_write_input_tokens: 50,
              output_tokens: 60,
              reasoning_output_tokens: 10,
            },
            model_context_window: 258_400,
          },
        },
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: "2026-06-01T09:00:05Z",
        payload: { message: "Carried summary.", replacement_history: [] },
      }),
      // Real rollouts emit zero readings immediately after compaction. They
      // must not walk back across the system boundary and erase the peak.
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T09:00:06Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 700,
              output_tokens: 60,
            },
            last_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
            },
            model_context_window: 258_400,
          },
        },
      }),
    ].join("\n");

    const parsed = parseCodexSession("sess-stamp", content, new Map());
    const messages = parsed.session.messages;
    expect(messages).toHaveLength(4);
    expect(messages[0]?.usage).toBeNull();
    expect(messages[1]?.usage).toEqual({
      input: 150,
      output: 60,
      cacheRead: 700,
      cacheCreation: 50,
      cacheCreation1h: 0,
      reasoning: 10,
    });
    expect(messages[2]?.usage).toBeNull();
    expect(messages[3]?.role).toBe("system");
    expect(messages[3]?.blocks[0]?.text).toBe("Carried summary.");
    const rawMeta = parsed.session.rawMeta as { model_context_window?: number };
    expect(rawMeta.model_context_window).toBe(258_400);
  });

  test("preserves inclusive input when a future cache-write breakdown is inconsistent", () => {
    const content = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-01T09:00:00Z",
        payload: { id: "sess-cache-breakdown", cwd: "/tmp/proj" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T09:00:01Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T09:00:02Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 90,
              cache_write_input_tokens: 50,
              output_tokens: 1,
            },
          },
        },
      }),
    ].join("\n");

    expect(
      parseCodexSession("sess-cache-breakdown", content, new Map()).session.messages[0]?.usage,
    ).toMatchObject({
      input: 10,
      cacheRead: 90,
      cacheCreation: 0,
    });
  });

  test("token_count before any assistant output is dropped", () => {
    const content = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-06-01T09:00:00Z",
        payload: { id: "sess-early", cwd: "/tmp/proj" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-01T09:00:01Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-01T09:00:02Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
            last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
          },
        },
      }),
    ].join("\n");

    const parsed = parseCodexSession("sess-early", content, new Map());
    expect(parsed.session.messages[0]?.usage).toBeNull();
    expect(parsed.session.rawMeta).toEqual({ id: "sess-early", cwd: "/tmp/proj" });
  });

  test("parses subagent session metadata", () => {
    const content = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-05-01T10:00:00Z",
        payload: {
          id: "child-thread",
          cwd: "/tmp/proj",
          parent_thread_id: "parent-thread",
          agent_nickname: "Ada",
          agent_role: "explorer",
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
                agent_nickname: "Ada",
                agent_role: "explorer",
              },
            },
          },
        },
      }),
    ].join("\n");

    const session = parseCodexSession("fallback", `${content}\n`, new Map()).session;
    expect(session.isSubagent).toBe(true);
    expect(session.rootSourceSessionId).toBe("parent-thread");
    expect(session.agentId).toBe("Ada");
    expect(session.agentType).toBe("explorer");
    expect(session.spawnDepth).toBe(1);
  });

  test("malformed and blank lines and unknown top types", () => {
    const content = [
      "",
      "{oops not json",
      '{"type":"turn_context","timestamp":"2026-05-01T10:00:00Z","payload":{"model":"gpt-5.4","cwd":"/tmp/proj"}}',
      '{"type":"session_meta","timestamp":"2026-05-01T10:00:01Z","payload":{"id":"sx","cli_version":"1.2"}}',
      '{"type":"unknown-top","timestamp":"2026-05-01T10:00:02Z"}',
    ].join("\n");
    const parsed = parseCodexSession("fallback", `${content}\n`, new Map());
    // the malformed line and the trailing unknown-top record each land an issue
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues[0]?.code).toBe("unparsed_line");
    expect(parsed.issues[0]?.lineNo).toBe(2);
    expect(parsed.issues[1]?.code).toBe("unknown_record_type");
    expect(parsed.issues[1]?.error).toContain('"unknown-top"');
    const session = parsed.session;
    expect(session.sourceSessionId).toBe("sx");
    expect(session.cwd).toBe("/tmp/proj");
    expect(session.model).toBe("gpt-5.4");
    expect(session.cliVersion).toBe("1.2");
    expect(session.startedAt).toBe("2026-05-01T10:00:00Z");
    expect(session.endedAt).toBe("2026-05-01T10:00:02Z");
  });

  test("flags unknown top-level record types, ignoring event_msg subtypes", () => {
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-01T00:00:00Z",
        payload: { id: "c1" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-01T00:00:01Z",
        payload: { type: "agent_message" },
      }),
      JSON.stringify({ type: "wormhole", timestamp: "2026-07-01T00:00:02Z", payload: {} }),
    ].join("\n");
    const parsed = parseCodexSession("c1", lines, new Map());
    const unknown = parsed.issues.filter((issue) => issue.code === "unknown_record_type");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.error).toContain('"wormhole"');
  });

  test("response item variants cover every block kind", () => {
    const content = [
      '{"type":"response_item","timestamp":"2026-05-01T10:00:00Z","payload":{"type":"reasoning","summary":[],"content":[{"text":"deep thought"}]}}',
      '{"type":"response_item","payload":{"type":"web_search_call"}}',
      '{"type":"response_item","payload":{"type":"mystery","foo":1}}',
      '{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"plain"}}',
      '{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c2","output":{"k":1}}}',
      '{"type":"response_item","payload":{"type":"tool_search_output","call_id":"c3"}}',
      '{"type":"response_item","payload":{"type":"message","role":"system","content":"sys note"}}',
      '{"type":"response_item","payload":{"type":"message","role":"assistant","content":42}}',
      '{"type":"response_item","payload":{"type":"custom_tool_call","name":"do_thing","call_id":"k1","input":{"a":1}}}',
    ].join("\n");
    const messages = parseCodexSession("fallback", `${content}\n`, new Map()).session.messages;
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.blocks[0]?.blockType).toBe("thinking");
    expect(messages[0]?.blocks[0]?.text).toBe("deep thought");
    expect(messages[1]?.blocks[0]?.blockType).toBe("web_search");
    expect(messages[2]?.blocks[0]?.blockType).toBe("other");
    expect(messages[3]?.blocks[0]?.toolResult).toBe("plain");
    expect(messages[4]?.blocks[0]?.toolResult).toBe('{"k":1}');
    expect(messages[5]?.blocks[0]?.toolResult).toBe("");
    expect(messages[6]?.role).toBe("system");
    expect(messages[6]?.blocks[0]?.text).toBe("sys note");
    expect(messages[7]?.blocks[0]?.text).toBe("");
    expect(messages[8]?.blocks[0]?.blockType).toBe("tool_use");
    expect(messages[8]?.blocks[0]?.toolName).toBe("do_thing");
    expect(messages[8]?.blocks[0]?.toolInput).toEqual({ a: 1 });
  });

  test("qualifies namespaced tool names but leaves empty names unchanged", () => {
    const content = [
      '{"type":"response_item","payload":{"type":"mcp_tool_call","namespace":"mcp__dosu","name":"read_knowledge","call_id":"c1"}}',
      '{"type":"response_item","payload":{"type":"mcp_tool_call","namespace":"mcp__dosu","name":"","call_id":"c2"}}',
    ].join("\n");
    const messages = parseCodexSession("fallback", content, new Map()).session.messages;

    expect(messages[0]?.blocks[0]?.toolName).toBe("mcp__dosu__read_knowledge");
    expect(messages[1]?.blocks[0]?.toolName).toBe("");
  });

  test("parses the synthetic MCP fixture with exact and mcp-prefix-less namespaces", () => {
    const content = readFileSync(
      join(import.meta.dir, "..", "fixtures", "codex", "mcp.jsonl"),
      "utf8",
    );
    const messages = parseCodexSession("fallback", content, new Map()).session.messages;
    const toolNames = messages.flatMap((message) =>
      message.blocks.flatMap((block) => (block.toolName == null ? [] : [block.toolName])),
    );

    expect(toolNames).toContain("mcp__dosu__read_knowledge");
    expect(toolNames).toContain("mcp__github__search_code");
    expect(toolNames).toContain("dosu__unqualified_tool");
  });
});
