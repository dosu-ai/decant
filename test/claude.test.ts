import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseClaudeSession } from "../src/sources/claude.ts";

async function fixture(): Promise<string> {
  return await Bun.file(join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl")).text();
}

describe("parseClaudeSession", () => {
  test("parses messages blocks and roles", async () => {
    const parsed = parseClaudeSession("sess-claude-1", await fixture());
    const session = parsed.session;
    expect(parsed.issues).toHaveLength(0);
    expect(session.tool).toBe("claude_code");
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0]?.role).toBe("user");
    expect(session.messages[1]?.role).toBe("assistant");
    expect(session.messages[2]?.role).toBe("tool");
    expect(session.messages[1]?.blocks.map((block) => block.blockType)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
  });

  test("aggregates tokens and picks model and title", async () => {
    const parsed = parseClaudeSession("sess-claude-1", await fixture());
    const session = parsed.session;
    expect(session.model).toBe("claude-opus-4-7");
    expect(session.title).toBe("Fix the failing auth test");
    expect(session.totals.input).toBe(1200 + 1500);
    expect(session.totals.output).toBe(340 + 120);
    expect(session.startedAt).toBe("2026-05-01T10:00:00.000Z");
    expect(session.endedAt).toBe("2026-05-01T10:00:10.000Z");
  });

  test("split turn bills cumulative output once at the max", () => {
    const content = [
      '{"type":"assistant","requestId":"req-1","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"content":[{"type":"thinking","thinking":"","signature":"sig"}]}}',
      '{"type":"assistant","requestId":"req-1","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":959,"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"content":[{"type":"tool_use","name":"Read","id":"t1","input":{"file_path":"/x"}}]}}',
      '{"type":"assistant","requestId":"req-2","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":200,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"done"}]}}',
      '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":7,"output_tokens":3,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"hi"}]}}',
    ].join("\n");
    const session = parseClaudeSession("s", `${content}\n`).session;
    expect(session.totals.input).toBe(100 + 200 + 7);
    expect(session.totals.output).toBe(959 + 50 + 3);
    expect(session.totals.cacheRead).toBe(10);
    expect(session.totals.cacheCreation).toBe(5);
    expect(session.messages[0]?.usage).toBeNull();
    expect(session.messages[1]?.usage?.output).toBe(959);
    const perMessage = session.messages
      .flatMap((message) => (message.usage == null ? [] : [message.usage]))
      .reduce((sum, usage) => sum + usage.output, 0);
    expect(perMessage).toBe(session.totals.output);
  });

  test("turn with a usageless leading line is still billed", () => {
    const content = [
      '{"type":"assistant","requestId":"r9","message":{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":"s"}]}}',
      '{"type":"assistant","requestId":"r9","message":{"role":"assistant","usage":{"input_tokens":0,"output_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"x"}]}}',
    ].join("\n");
    const session = parseClaudeSession("s", `${content}\n`).session;
    expect(session.totals.output).toBe(500);
  });

  test("stream-json result totals are used for raw Claude streams", () => {
    const content = [
      '{"type":"system","subtype":"init","session_id":"stream-1","cwd":"/repo","git_branch":"main","model":"claude-opus-4-7","timestamp":"2026-05-01T10:00:00.000Z"}',
      '{"type":"user","session_id":"stream-1","message":{"role":"user","content":"Price this streaming run"}}',
      '{"type":"assistant","session_id":"stream-1","message":{"id":"msg-1","role":"assistant","content":[{"type":"text","text":"Done"}]}}',
      '{"type":"result","subtype":"success","session_id":"stream-1","usage":{"input_tokens":123,"output_tokens":45,"cache_read_input_tokens":6,"cache_creation_input_tokens":7},"total_cost_usd":0.01}',
    ].join("\n");
    const session = parseClaudeSession("stream-file", `${content}\n`).session;
    expect(session.rootSourceSessionId).toBe("stream-1");
    expect(session.rawMeta).toMatchObject({ sessionId: "stream-1" });
    expect(session.title).toBe("Price this streaming run");
    expect(session.cwd).toBe("/repo");
    expect(session.gitBranch).toBe("main");
    expect(session.model).toBe("claude-opus-4-7");
    expect(session.totals).toMatchObject({
      input: 123,
      output: 45,
      cacheRead: 6,
      cacheCreation: 7,
    });
    expect(session.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(session.messages[2]?.sourceUuid).toBe("msg-1");
    expect(session.messages[2]?.usage).toBeNull();
  });

  test("captures effort and the one-hour cache creation breakdown", () => {
    const content = [
      '{"type":"assistant","effort":"max","requestId":"r1","message":{"role":"assistant","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":40,"ephemeral_1h_input_tokens":60}},"content":[{"type":"text","text":"done"}]}}',
    ].join("\n");
    const session = parseClaudeSession("effort-cache", `${content}\n`).session;
    expect(session.reasoningEffort).toBe("max");
    expect(session.reasoningEffortLevels).toEqual(["max"]);
    expect(session.totals.cacheCreation).toBe(100);
    expect(session.totals.cacheCreation1h).toBe(60);
  });

  test("marks sessions whose effort changes between assistant turns", () => {
    const content = [
      '{"type":"assistant","effort":"high","message":{"role":"assistant","content":[]}}',
      '{"type":"assistant","effort":"max","message":{"role":"assistant","content":[]}}',
    ].join("\n");
    const session = parseClaudeSession("mixed", content).session;
    expect(session.reasoningEffort).toBe("mixed");
    expect(session.reasoningEffortLevels).toEqual(["high", "max"]);
  });

  test("preserves every current Claude Code effort label", () => {
    const content = ["low", "medium", "high", "xhigh", "max"]
      .map(
        (effort) =>
          `{"type":"assistant","effort":"${effort}","message":{"role":"assistant","content":[]}}`,
      )
      .join("\n");
    const session = parseClaudeSession("all-efforts", content).session;
    expect(session.reasoningEffort).toBe("mixed");
    expect(session.reasoningEffortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("preserves numeric Agent SDK effort budgets", () => {
    const content =
      '{"type":"assistant","effort":16384,"message":{"role":"assistant","content":[]}}';
    const session = parseClaudeSession("numeric-effort", content).session;
    expect(session.reasoningEffort).toBe("16384");
    expect(session.reasoningEffortLevels).toEqual(["16384"]);
  });

  test("snake case streaming request ids de-dupe cumulative assistant usage", () => {
    const content = [
      '{"type":"assistant","request_id":"req-1","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":200,"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"content":[{"type":"thinking","thinking":"","signature":"sig"}]}}',
      '{"type":"assistant","request_id":"req-1","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":100,"output_tokens":400,"cache_read_input_tokens":10,"cache_creation_input_tokens":5},"content":[{"type":"text","text":"done"}]}}',
    ].join("\n");
    const session = parseClaudeSession("s", `${content}\n`).session;
    expect(session.totals.input).toBe(100);
    expect(session.totals.output).toBe(400);
    expect(session.totals.cacheRead).toBe(10);
    expect(session.totals.cacheCreation).toBe(5);
    expect(session.messages[0]?.usage).toBeNull();
    expect(session.messages[1]?.usage?.output).toBe(400);
  });

  test("reasoning is estimated by subtraction on thinking turns", () => {
    const content = [
      '{"type":"assistant","requestId":"req-e","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":50,"output_tokens":300,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"thinking","thinking":"","signature":"sig"}]}}',
      '{"type":"assistant","requestId":"req-e","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":50,"output_tokens":400,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","name":"x","id":"t1","input":{"a":"bbbb"}}]}}',
    ].join("\n");
    const session = parseClaudeSession("s", `${content}\n`).session;
    expect(session.reasoningSource).toBe("inferred");
    expect(session.estReasoningTokens).toBe(400 - 12 / 4);
    expect(session.totals.reasoning).toBe(0);
    expect(session.estReasoningTokens).toBeLessThanOrEqual(session.totals.output);
  });

  test("no thinking means no reasoning estimate", () => {
    const content =
      '{"type":"assistant","requestId":"r","message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"hi there"}]}}\n';
    const session = parseClaudeSession("s", content).session;
    expect(session.reasoningSource).toBe("none");
    expect(session.estReasoningTokens).toBe(0);
  });

  test("malformed lines become issues and blank lines are skipped", () => {
    const content =
      '\n   \n{not valid json\n{"type":"user","message":{"role":"user","content":"hello"}}\n';
    const parsed = parseClaudeSession("s", content);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.lineNo).toBe(3);
    expect(parsed.issues[0]?.error).not.toBe("");
    expect(parsed.session.messages).toHaveLength(1);
    expect(parsed.session.title).toBe("hello");
  });

  test("flags unparsed lines with the unparsed_line code", () => {
    const parsed = parseClaudeSession("s1", "not json\n");
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.code).toBe("unparsed_line");
    expect(parsed.issues[0]?.lineNo).toBe(1);
  });

  test("flags unknown record types once per type with a count", () => {
    const lines = [
      JSON.stringify({ type: "wormhole", timestamp: "2026-07-01T00:00:00Z" }),
      JSON.stringify({ type: "wormhole", timestamp: "2026-07-01T00:00:01Z" }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
    ].join("\n");
    const parsed = parseClaudeSession("s1", lines);
    const unknown = parsed.issues.filter((issue) => issue.code === "unknown_record_type");
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.error).toContain('"wormhole"');
    expect(unknown[0]?.error).toContain("2 line");
    expect(unknown[0]?.rawLine).toBeNull();
    // the records themselves still land as role-"other" messages — behavior unchanged
    expect(parsed.session.messages.filter((m) => m.role === "other")).toHaveLength(2);
  });

  test("meta summary sets title and system and unknown types become messages", () => {
    const content = [
      '{"type":"summary","summary":"Synthesized Title"}',
      '{"type":"system","uuid":"s1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"system","content":"boot"}}',
      '{"type":"weird-thing","uuid":"w1","parentUuid":"s1"}',
    ].join("\n");
    const session = parseClaudeSession("s", `${content}\n`).session;
    expect(session.title).toBe("Synthesized Title");
    expect(session.messages.map((message) => message.role)).toEqual(["system", "other"]);
    expect(session.messages[1]?.sourceUuid).toBe("w1");
    expect(session.messages[1]?.blocks).toEqual([]);
  });

  test("meta title field is used when summary absent", () => {
    const parsed = parseClaudeSession("s", '{"type":"ai-title","title":"From Title Field"}\n');
    expect(parsed.session.title).toBe("From Title Field");
  });

  test("unknown blocks and tool result arrays parse", () => {
    const content = [
      '{"type":"assistant","uuid":"a1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"text","text":"hi"},{"type":"mystery","foo":1}]}}',
      '{"type":"user","uuid":"u1","timestamp":"2026-05-01T10:00:05.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":[{"type":"text","text":"line one"},{"blob":42}]},{"type":"mystery","z":2}]}}',
      '{"type":"user","uuid":"u2","timestamp":"2026-05-01T10:00:06.000Z","message":{"role":"user","content":7}}',
    ].join("\n");
    const messages = parseClaudeSession("s", `${content}\n`).session.messages;
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.blocks.map((block) => block.blockType)).toEqual(["text", "other"]);
    expect(messages[1]?.role).toBe("tool");
    const toolResult = messages[1]?.blocks.find((block) => block.blockType === "tool_result");
    expect(toolResult?.toolResult).toContain("line one");
    expect(toolResult?.toolResult).toContain("blob");
    expect(toolResult?.isError).toBe(true);
    expect(messages[1]?.blocks.some((block) => block.blockType === "other")).toBe(true);
    expect(messages[2]?.role).toBe("user");
    expect(messages[2]?.blocks).toEqual([]);
  });

  test("meta without title and already titled meta are noops", () => {
    const content = [
      '{"type":"user","uuid":"u1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"user","content":"real prompt"}}',
      '{"type":"attachment","summary":"ignored"}',
      '{"type":"file-history-snapshot"}',
    ].join("\n");
    const parsed = parseClaudeSession("s", `${content}\n`);
    expect(parsed.session.title).toBe("real prompt");
  });

  test("meta first then no summary meta", () => {
    const parsed = parseClaudeSession("s", '{"type":"attachment"}\n');
    expect(parsed.session.title).toBeNull();
  });

  test("assistant with string content has no blocks", () => {
    const content =
      '{"type":"assistant","uuid":"a1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"assistant","model":"claude-opus-4-7","content":"just text"}}\n';
    const parsed = parseClaudeSession("s", content);
    expect(parsed.session.messages).toHaveLength(1);
    expect(parsed.session.messages[0]?.blocks).toEqual([]);
  });

  test("tool result scalar and missing content stringify", () => {
    const content = [
      '{"type":"user","uuid":"u1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":99}]}}',
      '{"type":"user","uuid":"u2","timestamp":"2026-05-01T10:00:05.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2"}]}}',
    ].join("\n");
    const messages = parseClaudeSession("s", `${content}\n`).session.messages;
    const first = messages[0]?.blocks.find((block) => block.blockType === "tool_result");
    const second = messages[1]?.blocks.find((block) => block.blockType === "tool_result");
    expect(first?.toolResult).toBe("99");
    expect(second?.toolResult).toBe("");
  });

  test("primary model prefers priceable then frequency", () => {
    const content = [
      '{"type":"assistant","uuid":"a1","timestamp":"2026-05-01T10:00:00.000Z","message":{"role":"assistant","model":"<synthetic>","content":[]}}',
      '{"type":"assistant","uuid":"a2","timestamp":"2026-05-01T10:00:01.000Z","message":{"role":"assistant","model":"<synthetic>","content":[]}}',
      '{"type":"assistant","uuid":"a3","timestamp":"2026-05-01T10:00:02.000Z","message":{"role":"assistant","model":"claude-opus-4-7","content":[]}}',
    ].join("\n");
    const parsed = parseClaudeSession("s", `${content}\n`);
    expect(parsed.session.model).toBe("claude-opus-4-7");
  });
});
