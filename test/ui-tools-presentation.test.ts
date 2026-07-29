import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(import.meta.dir, "..", "src", "ui", "main.tsx"), "utf8");
const styles = readFileSync(join(import.meta.dir, "..", "src", "ui", "styles.css"), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("Tools and MCP presentation", () => {
  test("renders accessible icon-and-text statuses in the table and detail dialog", () => {
    const status = sourceBetween(main, "function ToolCallStatus(", "function DrilldownTableRow(");
    const detail = sourceBetween(main, "function ToolCallDetail(", "function ToolsView(");
    const tools = sourceBetween(main, "function ToolsView(", "function FilesView(");

    expect(status).toContain("toolCallStatus(call.is_error)");
    expect(status).not.toContain("call.has_result");
    expect(status).toContain("<Badge");
    expect(status).toContain("<Icon name={status.icon} />");
    expect(status).toContain("{status.label}");
    expect(status).toContain("<Tooltip content={status.title}>");
    expect(status).toContain("{(tooltipProps) =>");
    expect(status).toContain('<span className="sr-only">{status.title}</span>');
    expect(status).not.toContain("title={status.title ?? undefined}");
    expect(detail).toContain("<ToolCallStatus call={call} />");
    expect(tools).toContain("<ToolCallStatus call={call} />");
  });

  test("uses normalized table colgroups and ellipsizes long tool and server names", () => {
    const tools = sourceBetween(main, "function ToolsView(", "function FilesView(");

    expect(tools).toContain('toolTableColumns("mcp", durationAvailable)');
    expect(tools).toContain('toolTableColumns("tools", durationAvailable)');
    expect(tools).toContain('toolTableColumns("calls", durationAvailable)');
    expect(tools.match(/<colgroup>/g)).toHaveLength(3);
    expect(tools.match(/style=\{\{ width: `\$\{column\.width\}%` \}\}/g)).toHaveLength(3);
    expect(tools).toContain('<table className="data-table mcp-table">');
    expect(tools).toContain('<table className="data-table tools-table">');
    expect(tools).toContain('<table className="data-table tool-calls-table">');
    expect(tools).not.toContain("has-duration");
    expect(tools).toMatch(
      /<span className="icon-cell">\s*<Icon name="cpu" \/>\s*<span>\{row\.mcp_server\}<\/span>/,
    );
    expect(styles).toMatch(
      /\.tool-call-detail-button \{[\s\S]*?max-width: 100%;[\s\S]*?text-overflow: ellipsis;/,
    );
  });

  test("lays out summary cards as two by two and collapses only at phone width", () => {
    expect(styles).toMatch(
      /\.tool-stat-grid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    const phone = sourceBetween(
      styles,
      "@media (max-width: 640px)",
      "@media (prefers-reduced-motion: reduce)",
    );
    expect(phone).toMatch(/\.tool-stat-grid \{[\s\S]*?grid-template-columns: 1fr;/);
  });
});
