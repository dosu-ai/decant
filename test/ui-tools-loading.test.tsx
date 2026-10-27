import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyData } from "../src/ui/data-slices.ts";
import { ALL_DATE_RANGE } from "../src/ui/date-range.ts";
import type { DashboardData } from "../src/ui/types.ts";
import { ToolsView } from "../src/ui/views/tools.tsx";

function renderTools(
  status: "loading" | "ready" | "failed",
  data: DashboardData = emptyData,
  search = "",
): string {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search } },
  });
  try {
    return renderToStaticMarkup(
      <ToolsView
        data={data}
        dateRange={ALL_DATE_RANGE}
        mcpStatus={status}
        onDateRangeChange={() => {}}
        reloadKey={0}
        toolsStatus={status}
      />,
    );
  } finally {
    if (previousWindow == null) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", previousWindow);
    }
  }
}

describe("Tools initial loading", () => {
  test("shows pending requests without claiming zero calls or an empty archive", () => {
    const html = renderTools("loading");
    expect(html).toContain("Loading tools…");
    expect(html).toContain("Loading MCP servers…");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("No MCP servers");
    expect(html).not.toContain("No tool calls.");
    expect(html).not.toContain("0 matching");
    expect(html).not.toMatch(/Total calls<[\s\S]*?<strong[^>]*>0</);
  });

  test("distinguishes failed usage requests from pending or empty results", () => {
    const html = renderTools("failed");
    expect(html).toContain("Tool usage could not be loaded.");
    expect(html).toContain("MCP servers could not be loaded.");
    expect(html).not.toContain("Loading tools…");
    expect(html).not.toContain("Loading MCP servers…");
    expect(html).not.toContain("No MCP servers");
    expect(html).not.toContain("No tool calls.");
  });

  test("shows empty results after successful requests and keeps available rows visible", () => {
    const empty = renderTools("ready");
    expect(empty).toContain("No MCP servers");
    expect(empty).toContain("No tool calls.");
    const html = renderTools("ready", {
      ...emptyData,
      tools: [
        {
          tool_name: "Read",
          tool_kind: "builtin",
          mcp_server: null,
          calls: 12,
          errors: 0,
          p50_ms: null,
          p95_ms: null,
          last_used_at: null,
        },
      ],
    });
    expect(html).toContain("Show calls to tool Read");
    expect(html).not.toContain("Loading tools…");
    expect(html).not.toContain("No tool calls.");
  });

  test("later-page links keep summary values pending instead of claiming zero calls", () => {
    const html = renderTools("ready", emptyData, "?offset=100");
    expect(html).toMatch(/Total calls<\/span><strong>Loading…<\/strong>/);
    expect(html).not.toContain("0 matching");
  });

  test("retains active tool and server filter values while usage options are pending or absent", () => {
    for (const status of ["loading", "ready", "failed"] as const) {
      const html = renderTools(status, emptyData, "?tool=mcp__docs__outside_limit&server=docs");
      expect(html).toMatch(
        /<option[^>]*value="mcp__docs__outside_limit"[^>]*selected=""[^>]*>mcp__docs__outside_limit<\/option>/,
      );
      expect(html).toMatch(/<option[^>]*value="docs"[^>]*selected=""[^>]*>[^<]+<\/option>/);
      expect(html).not.toContain("outside_limit (0)");
    }
  });

  test("hides previous-date usage rows while the current date scope is loading", () => {
    const html = renderTools("loading", {
      ...emptyData,
      tools: [
        {
          tool_name: "OldRangeTool",
          tool_kind: "builtin",
          mcp_server: null,
          calls: 12,
          errors: 0,
          p50_ms: null,
          p95_ms: null,
          last_used_at: null,
        },
      ],
    });
    expect(html).toContain("Loading tools…");
    expect(html).not.toContain("Show calls to tool OldRangeTool");
  });

  test("top MCP tools show a readable name with their full identity on hover", () => {
    const html = renderTools("ready", {
      ...emptyData,
      tools: [
        {
          tool_name: "mcp__exa__web_search_exa",
          tool_kind: "mcp",
          mcp_server: "exa",
          calls: 12,
          errors: 0,
          p50_ms: null,
          p95_ms: null,
          last_used_at: null,
        },
      ],
    });
    expect(html).toContain('<strong title="mcp__exa__web_search_exa">web_search_exa</strong>');
    const changedDates = renderTools(
      "ready",
      {
        ...emptyData,
        tools: [
          {
            tool_name: "OldRangeTool",
            tool_kind: "builtin",
            mcp_server: null,
            calls: 12,
            errors: 0,
            p50_ms: null,
            p95_ms: null,
            last_used_at: null,
          },
        ],
      },
      "?from=2026-05-01",
    );
    expect(changedDates).toMatch(/Top tool<\/span><strong>Loading…<\/strong>/);
  });
});
