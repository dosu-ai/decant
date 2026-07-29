import { describe, expect, test } from "bun:test";
import { type ToolTableKind, toolTableColumns } from "../src/ui/tool-table-layout.ts";

const expectedColumns: Record<ToolTableKind, { absent: string[]; present: string[] }> = {
  mcp: {
    absent: ["col-mcp-server", "col-mcp-tools", "col-mcp-calls", "col-mcp-errors", "col-mcp-last"],
    present: [
      "col-mcp-server",
      "col-mcp-tools",
      "col-mcp-calls",
      "col-mcp-errors",
      "col-mcp-elapsed",
      "col-mcp-last",
    ],
  },
  tools: {
    absent: [
      "col-tool-name",
      "col-tool-kind",
      "col-tool-server",
      "col-tool-calls",
      "col-tool-errors",
      "col-tool-last",
    ],
    present: [
      "col-tool-name",
      "col-tool-kind",
      "col-tool-server",
      "col-tool-calls",
      "col-tool-errors",
      "col-tool-elapsed",
      "col-tool-last",
    ],
  },
  calls: {
    absent: [
      "col-call-status",
      "col-call-tool",
      "col-call-input",
      "col-call-output",
      "col-call-when",
      "col-call-session",
    ],
    present: [
      "col-call-status",
      "col-call-tool",
      "col-call-input",
      "col-call-elapsed",
      "col-call-output",
      "col-call-when",
      "col-call-session",
    ],
  },
};

describe("tool table column layouts", () => {
  for (const table of ["mcp", "tools", "calls"] as const) {
    test(`${table} keeps exact column order and normalized widths`, () => {
      for (const durationAvailable of [false, true]) {
        const columns = toolTableColumns(table, durationAvailable);
        expect(columns.map((column) => column.className)).toEqual(
          durationAvailable ? expectedColumns[table].present : expectedColumns[table].absent,
        );
        expect(columns.reduce((total, column) => total + column.width, 0)).toBe(100);
        expect(columns.every((column) => column.width > 0)).toBe(true);
      }
    });
  }

  test("reserves enough minimum-width space for the full Unknown status badge", () => {
    for (const durationAvailable of [false, true]) {
      const status = toolTableColumns("calls", durationAvailable).find(
        (column) => column.className === "col-call-status",
      );
      expect(status?.width).toBeGreaterThanOrEqual(12);
    }
  });
});
