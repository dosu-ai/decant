import { describe, expect, test } from "bun:test";
import { prepareAnalyticsChartState } from "../src/ui/chart-state.ts";
import { buildChartOption, type ChartColors } from "../src/ui/charts.tsx";

const COLORS: ChartColors = {
  fg: "#000",
  hover: "#111",
  muted: "#222",
  faint: "#333",
  line: "#444",
  surface: "#555",
  accent: "#666",
  info: "#777",
  success: "#888",
  warning: "#999",
};

function lineData(values: (number | null)[]) {
  const state = prepareAnalyticsChartState({
    labels: values.map((_, index) => `2026-07-2${index}`),
    metric: "money",
    period: "day",
    values,
    variant: "line",
  });
  const series = buildChartOption(state, COLORS).series as { data: unknown }[];
  return series[0]?.data as { value: number | null; symbol: string }[];
}

describe("analytics chart option", () => {
  test("a line marks only points with no known neighbour", () => {
    expect(lineData([null, 2, null, 3, 4]).map((point) => point.symbol)).toEqual([
      "none",
      "circle",
      "none",
      "none",
      "none",
    ]);
    expect(lineData([1]).map((point) => point.symbol)).toEqual(["circle"]);
    expect(lineData([null, 2, null]).map((point) => point.value)).toEqual([null, 2, null]);
  });

  test("bars keep plain values", () => {
    const state = prepareAnalyticsChartState({
      labels: ["a", "b"],
      metric: "int",
      values: [1, 2],
      variant: "bar",
    });
    const series = buildChartOption(state, COLORS).series as { data: unknown }[];
    expect(series[0]?.data).toEqual([1, 2]);
  });
});
