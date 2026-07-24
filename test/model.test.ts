import { describe, expect, test } from "bun:test";
import {
  BLOCK_TYPES,
  emptyUsage,
  normalizeReasoningEffort,
  REASONING_SOURCES,
  ROLES,
  reasoningEffortLevels,
  summarizeReasoningEfforts,
  TOOL_KINDS,
  TOOLS,
} from "../src/model.ts";

// Ports model.rs `enum_strings_are_stable` / `all_enum_string_arms_are_stable`:
// these are the wire strings stored in SQLite — they must never drift.
describe("model wire strings", () => {
  test("every enum string is pinned", () => {
    expect(TOOLS).toEqual(["claude_code", "codex"]);
    expect(ROLES).toEqual(["user", "assistant", "system", "tool", "other"]);
    expect(BLOCK_TYPES).toEqual([
      "text",
      "thinking",
      "tool_use",
      "tool_result",
      "web_search",
      "image",
      "other",
    ]);
    expect(TOOL_KINDS).toEqual(["builtin", "mcp", "custom", "web_search", "tool_search"]);
    expect(REASONING_SOURCES).toEqual(["reported", "inferred", "none"]);
  });

  test("emptyUsage is all zeros (TokenUsage::default)", () => {
    expect(emptyUsage()).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      cacheCreation1h: 0,
      reasoning: 0,
    });
  });

  test("reasoning effort is normalized and marks mixed sessions", () => {
    expect(summarizeReasoningEfforts([])).toBeNull();
    expect(summarizeReasoningEfforts([" XHIGH ", "xhigh"])).toBe("xhigh");
    expect(summarizeReasoningEfforts(["high", "max"])).toBe("mixed");
    expect(normalizeReasoningEffort("claude_code", " MAX ")).toBe("ultra");
    expect(normalizeReasoningEffort("codex", " MAX ")).toBe("max");
    expect(reasoningEffortLevels("claude_code", ["low", "max", "MAX"])).toEqual(["low", "ultra"]);
    expect(reasoningEffortLevels("codex", ["max", "ultra"])).toEqual(["max", "ultra"]);
  });
});
