import { describe, expect, test } from "bun:test";
import { dosuToolDisplayName, isDosuToolName } from "../src/ui/dosu-tool.ts";

describe("Dosu transcript tool evidence", () => {
  test("recognizes only confirmed normalized Dosu MCP namespaces", () => {
    expect(isDosuToolName("mcp__dosu__read_knowledge")).toBe(true);
    expect(isDosuToolName("mcp__claude_ai_Dosu__search")).toBe(true);
    expect(isDosuToolName("mcp__my_dosu_proxy__search")).toBe(false);
    expect(isDosuToolName("dosu__unqualified_tool")).toBe(false);
    expect(isDosuToolName(null)).toBe(false);
  });

  test("uses the normalized operation name in compact navigation", () => {
    expect(dosuToolDisplayName("mcp__dosu__read_knowledge")).toBe("read_knowledge");
    expect(dosuToolDisplayName(null)).toBe("Dosu tool");
  });
});
