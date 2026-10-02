import { describe, expect, test } from "bun:test";
import type { ToolRow } from "../src/ui/types.ts";
import { toolAggregate } from "../src/ui/views/tools.tsx";

function row(tool_name: string, calls: number, mcp_server: string | null = null): ToolRow {
  return {
    tool_name,
    tool_kind: mcp_server == null ? "builtin" : "mcp",
    mcp_server,
    calls,
    errors: 0,
    p50_ms: null,
    p95_ms: null,
    last_used_at: null,
  };
}

describe("Tools summary cards", () => {
  const tools = [row("Read", 9), row("search", 4, "docs"), row("fetch", 6, "web")];
  const summary = { calls: 19, errors: 2, p50_ms: 10, p95_ms: 90 };

  test("report the scoped population and the most-called tool", () => {
    expect(toolAggregate(tools, summary)).toEqual({
      totalCalls: 19,
      errorRate: (2 / 19) * 100,
      p50: 10,
      p95: 90,
      topTool: "Read",
    });
  });

  test("pick the top tool inside the active tool or server filter", () => {
    expect(toolAggregate(tools, summary, { tool: "", server: "docs" }).topTool).toBe("search");
    expect(toolAggregate(tools, summary, { tool: "fetch", server: "" }).topTool).toBe("fetch");
    expect(toolAggregate(tools, summary, { tool: "Read", server: "web" }).topTool).toBeNull();
  });
});
