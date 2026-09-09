import { describe, expect, test } from "bun:test";
import { prepareAnalyticsChartState } from "../src/ui/chart-state.ts";

describe("analytics chart state", () => {
  test("keeps the render key stable for equivalent data", () => {
    const first = prepareAnalyticsChartState({
      labels: ["Mon", "Tue"],
      metric: "int",
      values: [2, 4],
      variant: "bar",
    });
    const equivalent = prepareAnalyticsChartState({
      labels: ["Mon", "Tue"],
      metric: "int",
      values: [2, 4],
      variant: "bar",
    });

    expect(equivalent.key).toBe(first.key);
  });

  test("changes the render key when visible chart data changes", () => {
    const first = prepareAnalyticsChartState({
      labels: ["Mon", "Tue"],
      metric: "int",
      values: [2, 4],
      variant: "bar",
    });
    const changed = prepareAnalyticsChartState({
      labels: ["Mon", "Tue"],
      metric: "int",
      values: [2, 5],
      variant: "bar",
    });

    expect(changed.key).not.toBe(first.key);
  });

  test("normalizes missing and negative values before keying the chart", () => {
    const state = prepareAnalyticsChartState({
      labels: ["Mon", "Tue", "Wed"],
      metric: "money",
      values: [-2, 4],
      variant: "line",
    });

    expect(state.values).toEqual([0, 4, 0]);
  });
});
