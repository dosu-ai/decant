export type ToolTableKind = "calls" | "mcp" | "tools";

export type ToolTableColumn = {
  className: string;
  width: number;
};

const TABLE_COLUMNS: Record<
  ToolTableKind,
  { withDuration: readonly ToolTableColumn[]; withoutDuration: readonly ToolTableColumn[] }
> = {
  mcp: {
    withoutDuration: [
      { className: "col-mcp-server", width: 52 },
      { className: "col-mcp-tools", width: 12 },
      { className: "col-mcp-calls", width: 12 },
      { className: "col-mcp-errors", width: 12 },
      { className: "col-mcp-last", width: 12 },
    ],
    withDuration: [
      { className: "col-mcp-server", width: 40 },
      { className: "col-mcp-tools", width: 10 },
      { className: "col-mcp-calls", width: 10 },
      { className: "col-mcp-errors", width: 10 },
      { className: "col-mcp-elapsed", width: 15 },
      { className: "col-mcp-last", width: 15 },
    ],
  },
  tools: {
    withoutDuration: [
      { className: "col-tool-name", width: 28 },
      { className: "col-tool-kind", width: 11 },
      { className: "col-tool-server", width: 25 },
      { className: "col-tool-calls", width: 12 },
      { className: "col-tool-errors", width: 12 },
      { className: "col-tool-last", width: 12 },
    ],
    withDuration: [
      { className: "col-tool-name", width: 24 },
      { className: "col-tool-kind", width: 10 },
      { className: "col-tool-server", width: 22 },
      { className: "col-tool-calls", width: 9 },
      { className: "col-tool-errors", width: 9 },
      { className: "col-tool-elapsed", width: 13 },
      { className: "col-tool-last", width: 13 },
    ],
  },
  calls: {
    withoutDuration: [
      { className: "col-call-status", width: 15 },
      { className: "col-call-tool", width: 21 },
      { className: "col-call-input", width: 25 },
      { className: "col-call-output", width: 11 },
      { className: "col-call-when", width: 12 },
      { className: "col-call-session", width: 16 },
    ],
    withDuration: [
      { className: "col-call-status", width: 15 },
      { className: "col-call-tool", width: 19 },
      { className: "col-call-input", width: 20 },
      { className: "col-call-elapsed", width: 10 },
      { className: "col-call-output", width: 10 },
      { className: "col-call-when", width: 11 },
      { className: "col-call-session", width: 15 },
    ],
  },
};

export function toolTableColumns(
  table: ToolTableKind,
  durationAvailable: boolean,
): readonly ToolTableColumn[] {
  return durationAvailable
    ? TABLE_COLUMNS[table].withDuration
    : TABLE_COLUMNS[table].withoutDuration;
}
