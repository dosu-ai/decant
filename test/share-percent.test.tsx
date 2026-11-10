import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sharePercentLabel } from "../src/share-percent.ts";
import type { DimensionRow } from "../src/ui/types.ts";
import { OutcomesPanel } from "../src/ui/views/analytics.tsx";

describe("share percent labels", () => {
  test("rounds each share on its own instead of forcing a sum of 100", () => {
    // Largest remainder showed these as 49%, 50%, 0%, 1%.
    const counts = [1462, 1465, 7, 19];
    const total = counts.reduce((sum, value) => sum + value, 0);
    expect(counts.map((count) => sharePercentLabel(count, total))).toEqual([
      "49.5%",
      "49.6%",
      "0.2%",
      "0.6%",
    ]);
  });

  test("never shows a nonzero share as 0.0% or a partial one as 100.0%", () => {
    expect(sharePercentLabel(1, 10_000)).toBe("<0.1%");
    expect(sharePercentLabel(9_999, 10_000)).toBe(">99.9%");
    expect(sharePercentLabel(5, 10_000)).toBe("0.1%");
  });

  test("rounds exact ties up despite floating-point error", () => {
    // 0.15.toFixed(1) is "0.1" and 28.75.toFixed(1) is "28.7".
    expect(sharePercentLabel(3, 2000)).toBe("0.2%");
    expect(sharePercentLabel(23, 80)).toBe("28.8%");
    expect(sharePercentLabel(1, 16)).toBe("6.3%");
    expect(sharePercentLabel(1999, 2000)).toBe(">99.9%");
    expect(sharePercentLabel(1, 2000)).toBe("0.1%");
  });

  test("keeps exact and empty shares plain", () => {
    expect(sharePercentLabel(4, 4)).toBe("100.0%");
    expect(sharePercentLabel(1, 2)).toBe("50.0%");
    expect(sharePercentLabel(0, 4)).toBe("0.0%");
    expect(sharePercentLabel(-1, 4)).toBe("0.0%");
    expect(sharePercentLabel(Number.NaN, 4)).toBe("0.0%");
    expect(sharePercentLabel(Number.POSITIVE_INFINITY, 4)).toBe("0.0%");
  });

  test("shows a dash when there is no total to share", () => {
    expect(sharePercentLabel(0, 0)).toBe("-");
    expect(sharePercentLabel(1, Number.NaN)).toBe("-");
    expect(sharePercentLabel(1, Number.POSITIVE_INFINITY)).toBe("-");
  });
});

const outcome = (key: string, sessions: number, cost: number): DimensionRow => ({
  key,
  sessions,
  usage_sessions: sessions,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  est_reasoning_tokens: 0,
  estimated_cost_usd: cost,
});

describe("outcomes panel", () => {
  const rows = [
    outcome("completed", 1462, 32_195.26),
    outcome("abandoned", 1465, 11_948),
    outcome("failed", 7, 8.43),
    outcome("(unclassified)", 19, 509.79),
  ];
  const html = renderToStaticMarkup(<OutcomesPanel perCompleted={30.55} rows={rows} />);

  test("labels each share with its own rounding", () => {
    expect(html).toContain("<small>49.5%</small>");
    expect(html).toContain("<small>49.6%</small>");
    expect(html).toContain("<small>0.2%</small>");
    expect(html).toContain("<small>0.6%</small>");
  });

  test("shows a dash when the range has only subagent runs", () => {
    const empty = renderToStaticMarkup(
      <OutcomesPanel perCompleted={null} rows={[outcome("completed", 0, 1)]} />,
    );
    expect(empty).toContain("<small>-</small>");
  });

  test("says the per-completed figure divides all spend", () => {
    expect(html).toContain("of all spend per completed session");
    expect(html).toContain("abandoned and failed sessions included");
  });
});
