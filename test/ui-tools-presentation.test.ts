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
  test("the detail header can shrink so a long MCP tool name cannot push the close button out", () => {
    const header = sourceBetween(styles, ".tool-detail-heading {", ".tool-detail-elision {");
    expect(header).toContain("min-width: 0");
    expect(header).toMatch(/\.tool-detail-panel > header h2 \{[^}]*overflow-wrap: anywhere/s);
    expect(main).toContain('<div className="tool-detail-heading">');
  });

  test("an elided value says so instead of appearing unformatted", () => {
    const detail = sourceBetween(main, "function ToolValueElision(", "function ToolCallStatus(");
    expect(detail).toContain("previewOmittedCount");
    expect(detail).toContain("tool-detail-elision");
    const panel = sourceBetween(main, "function ToolCallDetail(", "function ToolsView(");
    expect(panel).toContain("<ToolValueElision value={call.input_preview} />");
    expect(panel).toContain("<ToolValueElision value={call.output_preview} />");
    expect(styles).toContain(".tool-detail-elision {");
  });

  test("renders accessible icon-and-text statuses in the table and detail dialog", () => {
    const status = sourceBetween(main, "function ToolCallStatus(", "function DrilldownTableRow(");
    const detail = sourceBetween(main, "function ToolCallDetail(", "function ToolsView(");
    const tools = sourceBetween(main, "function ToolsView(", "function FilesView(");

    expect(status).toContain("toolCallStatus(call.is_error, call.has_result)");
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

  test("keeps tool and MCP drilldowns independent from stale call filters", () => {
    const tools = sourceBetween(main, "function ToolsView(", "function FilesView(");

    expect(tools).toContain("const clearedCallFilters = clearToolCallFilters(locationFilters)");
    expect(tools.match(/\.\.\.clearedCallFilters/g)).toHaveLength(2);
    expect(tools).not.toMatch(/\.\.\.locationFilters,\s+(server|tool): row\./);
  });

  test("gives call details room to scan and a compact transcript action", () => {
    const detail = sourceBetween(main, "function ToolCallDetail(", "function ToolsView(");
    const detailStyles = sourceBetween(styles, ".tool-detail-panel {", ".files-table {");

    expect(detail).toContain("<dt>Input size</dt>");
    expect(detail).toContain("<dt>Output size</dt>");
    expect(detail).toContain('className="tool-detail-session"');
    expect(detail).toContain('className="secondary-button tool-detail-transcript-link"');
    expect(detail).toContain('<Icon name="messages" />');
    expect(detail).toContain("View in transcript");
    expect(detailStyles).toMatch(
      /\.tool-detail-meta \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s,
    );
    expect(detailStyles).toMatch(/\.tool-detail-content \{[^}]*align-content: start/s);
    expect(detailStyles).toMatch(/\.tool-detail-transcript-link \{[^}]*white-space: nowrap/s);
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
      /<span className="icon-cell">\s*<Icon name="cpu" \/>\s*<span title=\{row\.mcp_server\}>\s*\{mcpServerLabel\(serverLabels, row\.mcp_server\)\}\s*<\/span>/,
    );
    expect(styles).toMatch(
      /\.tool-call-detail-button \{[\s\S]*?max-width: 100%;[\s\S]*?text-overflow: ellipsis;/,
    );
  });

  test("server names are formatted for display only, never for identity", () => {
    const tools = sourceBetween(main, "function ToolsView(", "function FilesView(");

    // Labels cover both tables, which are limited independently, so a server
    // in one but not the other still reads the same.
    expect(tools).toContain("...data.mcp.map((row) => row.mcp_server)");
    expect(tools).toContain("...data.tools.map((row) => row.mcp_server)");
    // Filter value, drilldown target, and the hover title stay on the raw slug:
    // the display label is deliberately not unique, so it cannot be identity.
    expect(tools).toContain("server: row.mcp_server,");
    expect(tools).toContain("value={row.mcp_server}");
    expect(tools).toContain("title={row.mcp_server}");
    expect(tools).not.toMatch(/value=\{(formatMcpServer|mcpServerLabel)\(/);
    expect(tools).not.toMatch(/server: (formatMcpServer|mcpServerLabel)\(/);
    // Nothing in the view formats a name on its own. `formatMcpServer` ignores
    // the other servers on screen, so a render site calling it directly is how
    // two rows both reading "Dosu" would come back.
    expect(tools).not.toContain("formatMcpServer(");
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
