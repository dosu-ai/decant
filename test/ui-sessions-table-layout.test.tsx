import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionSummary } from "../src/ui/types.ts";
import { SessionTableRow, SessionTableSkeletonRows } from "../src/ui/views/sessions.tsx";

const TITLE_FLOOR_PX = 280;

const styles = readFileSync(join(import.meta.dir, "..", "src", "ui", "styles.css"), "utf8");
const view = readFileSync(
  join(import.meta.dir, "..", "src", "ui", "views", "sessions.tsx"),
  "utf8",
);

const columns = [...view.matchAll(/<col className="(col-session-[a-z]+)" \/>/g)].map(
  (match) => match[1] as string,
);

function columnWidth(column: string): number {
  const rule = new RegExp(`\\.sessions-table \\.${column} \\{\\s*width: (\\d+)px;`).exec(styles);
  expect(rule).not.toBeNull();
  return Number(rule?.[1]);
}

/** Container-query tiers in source order, each with the columns it drops. */
const tiers = [
  ...styles.matchAll(/@container sessions-table \(width < (\d+)px\) \{([\s\S]*?)\n\}/g),
].map((match) => ({
  below: Number(match[1]),
  hides: [...(match[2] ?? "").matchAll(/\.sessions-table \.(col-session-[a-z]+)/g)].map(
    (hidden) => hidden[1] as string,
  ),
}));

function cellClasses(markup: string): string[][] {
  return [...markup.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<td(?: class="([^"]*)")?/g)].map((cell) => cell[1] ?? ""),
  );
}

const session: SessionSummary = {
  id: 1,
  tool: "opencode",
  source_session_id: "synthetic",
  title: "Synthetic session",
  project_path: "/tmp/project",
  model: "claude-sonnet-5-5",
  reasoning_effort: "medium",
  reasoning_effort_levels: [],
  total_reasoning_tokens: 0,
  reasoning_source: null,
  started_at: "2026-10-18T19:04:00.000Z",
  message_count: 47662,
  total_input_tokens: 0,
  total_output_tokens: 0,
  estimated_cost_usd: 1124.88,
  cost_source: "decant",
  model_provider: null,
  user_state: null,
  is_user_archived: false,
  is_subagent: false,
  parent_session_id: null,
  spawn_tool_use_id: null,
  agent_id: null,
  agent_type: null,
  spawn_depth: null,
  context_window_tokens: 200000,
  peak_context_tokens: 120000,
  compaction_count: 2,
  subagent_count: 3,
  subagent_estimated_cost_usd: 7.25,
  ingest_issue_count: 0,
  informational_ingest_issue_count: 0,
  dosu_mcp_direct_calls: 0,
  dosu_mcp_tree_calls: 0,
};

describe("sessions table layout", () => {
  test("title is the only column without a fixed width", () => {
    expect(columns).toContain("col-session-title");
    expect(styles).toMatch(/\.sessions-table \.col-session-title \{\s*width: auto;/);
    for (const column of columns.filter((name) => name !== "col-session-title")) {
      expect(columnWidth(column)).toBeGreaterThan(0);
    }
  });

  test("each tier drops columns before the title falls below its floor", () => {
    expect(tiers.length).toBeGreaterThan(0);
    let visible = columns.filter((name) => name !== "col-session-title");
    const fixedWidth = () => visible.reduce((sum, column) => sum + columnWidth(column), 0);
    for (const tier of tiers) {
      expect(tier.below).toBe(fixedWidth() + TITLE_FLOOR_PX);
      expect(tier.hides.length).toBeGreaterThan(0);
      visible = visible.filter((column) => !tier.hides.includes(column));
    }
    // Below the last tier the table scrolls rather than squeezing the title.
    const tableRule = /\.sessions-table \{\s*min-width: (\d+)px;/.exec(styles);
    expect(Number(tableRule?.[1])).toBe(fixedWidth() + TITLE_FLOOR_PX);
  });

  test("never hides the columns that identify or open a session", () => {
    const hidden = tiers.flatMap((tier) => tier.hides);
    for (const column of ["col-session-tool", "col-session-title", "col-session-project"]) {
      expect(hidden).not.toContain(column);
    }
  });

  test("keeps the empty message out of the column grid", () => {
    // A colSpan row would add back the columns a narrow panel hides, and the
    // phantom columns squeeze the visible header.
    expect(view).not.toContain("colSpan");
    expect(view).toContain('<p className="sessions-empty">{emptyMessage}</p>');
  });

  test("collapsible columns carry their class on every header, row, and skeleton cell", () => {
    const head = view.slice(view.indexOf("<thead>"), view.indexOf("</thead>"));
    const headers = [...head.matchAll(/<th(?: className="([^"]*)")?>/g)].map(
      (match) => match[1] ?? "",
    );
    const rows = cellClasses(
      renderToStaticMarkup(
        <table>
          <tbody>
            <SessionTableRow depth={0} expanded={false} onToggle={() => {}} session={session} />
            <SessionTableSkeletonRows />
          </tbody>
        </table>,
      ),
    );
    expect(headers).toHaveLength(columns.length);
    expect(rows.length).toBeGreaterThan(1);
    for (const column of new Set(tiers.flatMap((tier) => tier.hides))) {
      const index = columns.indexOf(column);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(headers[index]?.split(" ")).toContain(column);
      for (const cells of rows) {
        expect(cells).toHaveLength(columns.length);
        expect(cells[index]?.split(" ")).toContain(column);
      }
    }
  });
});
