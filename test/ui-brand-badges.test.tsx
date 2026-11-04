import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { providerIdentity, ToolBadge } from "../src/ui/badges.tsx";
import { TranscriptBlock } from "../src/ui/transcript.tsx";
import { DosuProvenanceBadge } from "../src/ui/views/sessions.tsx";

describe("source and provenance marks", () => {
  test("Cursor has a brand mark in source badges and assistant turns", () => {
    const html = renderToStaticMarkup(<ToolBadge tool="cursor" />);
    expect(html).toContain('class="brand-mark"');
    expect(html).toContain("<path d=");
    expect(html).toContain("Cursor");
    expect(providerIdentity("cursor").icon).toBe("cursor");
  });

  test("GitHub Copilot CLI has a brand mark in source badges and assistant turns", () => {
    const html = renderToStaticMarkup(<ToolBadge tool="copilot" />);
    expect(html).toContain('class="brand-mark"');
    expect(html).toContain("<path d=");
    expect(html).toContain("Copilot");
    expect(providerIdentity("copilot")).toEqual({
      key: "assistant",
      label: "Copilot",
      tone: "accent",
      icon: "copilot",
    });
  });

  test("Dosu session evidence has an accessible logo with no visible label", () => {
    const html = renderToStaticMarkup(
      <DosuProvenanceBadge session={{ dosu_mcp_direct_calls: 2, dosu_mcp_tree_calls: 5 }} />,
    );
    expect(html).toContain('aria-label="Optimized with Dosu; Dosu MCP used 5 times"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('<img alt=""');
    expect(html).toMatch(/<a\b[^>]*><img\b[^>]*\/><\/a>$/);
    expect(
      renderToStaticMarkup(
        <DosuProvenanceBadge session={{ dosu_mcp_direct_calls: 0, dosu_mcp_tree_calls: 0 }} />,
      ),
    ).toBe("");
  });

  test("Dosu tool calls keep their logo and name without a visible optimization claim", () => {
    const html = renderToStaticMarkup(
      <TranscriptBlock
        block={{
          ordinal: 0,
          block_type: "tool_use",
          text: null,
          tool_name: "mcp__dosu__read_knowledge",
          tool_use_id: "synthetic-call",
          tool_input: null,
          tool_result: null,
        }}
      />,
    );
    expect(html).toContain('aria-label="Dosu MCP tool call"');
    expect(html).toContain('class="dosu-tool-mark"');
    expect(html).toContain("mcp__dosu__read_knowledge");
    expect(html).not.toContain("Optimized");
  });
});
