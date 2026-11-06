import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DimensionRow } from "../src/ui/types.ts";
import { DailyPanel, type SliceStatus } from "../src/ui/views/analytics.tsx";

const day = (key: string, sessions = 1): DimensionRow => ({
  key,
  sessions,
  usage_sessions: sessions,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  est_reasoning_tokens: 0,
  estimated_cost_usd: sessions,
});

const range = { from: "2026-10-07", to: "2026-11-05" };

function render(rows: DimensionRow[], status: SliceStatus): string {
  return renderToStaticMarkup(
    <DailyPanel
      metric="sessions"
      onShowAllTime={() => {}}
      range={range}
      rows={rows}
      status={status}
    />,
  );
}

describe("DailyPanel states", () => {
  test("a bounded range with no sessions offers the recovery state, not a flat chart", () => {
    const html = render([], "ready");
    expect(html).toContain("No data in range");
    expect(html).toContain("All time");
    expect(html).not.toContain("analytics-chart");
  });

  test("first load and failure never draw padded zeros", () => {
    expect(render([], "loading")).toContain("Loading");
    expect(render([], "loading")).not.toContain("analytics-chart");
    expect(render([], "failed")).toContain("Not loaded");
  });

  test("rows from the previous filter render dimmed while the new ones load", () => {
    const stale = render([day("2026-10-08")], "loading");
    expect(stale).toContain("analytics-chart");
    expect(stale).toContain('data-updating="true"');
    expect(stale).toContain('aria-busy="true"');
    const current = render([day("2026-10-08")], "ready");
    expect(current).toContain("analytics-chart");
    expect(current).not.toContain("data-updating");
    expect(current).toContain("Sessions per day from 2026-10-07 to 2026-11-05 (UTC)");
  });
});
