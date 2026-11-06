import { describe, expect, test } from "bun:test";
import {
  alignToSeries,
  buildDaySeries,
  isolatedPoints,
  WEEKLY_AFTER_DAYS,
  weekStart,
} from "../src/day-series.ts";

const row = (key: string, sessions: number, usageSessions = sessions, cost = sessions) => ({
  key,
  sessions,
  usage_sessions: usageSessions,
  estimated_cost_usd: cost,
});

describe("buildDaySeries", () => {
  test("fills idle days with zero between the first and last day", () => {
    const series = buildDaySeries([row("2026-03-01", 2), row("2026-03-04", 1)]);
    expect(series.granularity).toBe("day");
    expect(series.points).toEqual([
      { key: "2026-03-01", sessions: 2, cost: 2 },
      { key: "2026-03-02", sessions: 0, cost: 0 },
      { key: "2026-03-03", sessions: 0, cost: 0 },
      { key: "2026-03-04", sessions: 1, cost: 1 },
    ]);
  });

  test("covers the selected range even past the data", () => {
    const series = buildDaySeries([row("2026-03-02", 1)], { from: "2026-03-01", to: "2026-03-03" });
    expect(series.points.map((point) => [point.key, point.sessions])).toEqual([
      ["2026-03-01", 0],
      ["2026-03-02", 1],
      ["2026-03-03", 0],
    ]);
  });

  test("leaves cost unknown where no session recorded usage", () => {
    const series = buildDaySeries([
      row("2026-03-01", 2, 0, 0),
      row("2026-03-02", 3, 1, 5),
      // Only subagent runs: no top-level session, but a real cost.
      row("2026-03-03", 0, 0, 4),
    ]);
    expect(series.points.map((point) => point.cost)).toEqual([null, 5, 4]);
    expect(series.missingUsage).toBe(4);
  });

  test("switches to Monday-start weeks for long ranges", () => {
    const series = buildDaySeries([row("2026-01-01", 1), row("2026-12-31", 2)]);
    expect(series.granularity).toBe("week");
    expect(series.points[0]).toEqual({ key: "2025-12-29", sessions: 1, cost: 1 });
    expect(series.points.at(-1)).toEqual({ key: "2026-12-28", sessions: 2, cost: 2 });
    expect(series.points.reduce((sum, point) => sum + point.sessions, 0)).toBe(3);
    // 2026-01-01 through 2026-04-02 is exactly WEEKLY_AFTER_DAYS days.
    expect(WEEKLY_AFTER_DAYS).toBe(92);
    const edge = buildDaySeries([row("2026-01-01", 1)], { from: "2026-01-01", to: "2026-04-02" });
    expect(edge.granularity).toBe("day");
    expect(edge.points).toHaveLength(92);
    const past = buildDaySeries([row("2026-01-01", 1)], { from: "2026-01-01", to: "2026-04-03" });
    expect(past.granularity).toBe("week");
  });

  test("a week is unknown when every session in it lacks usage", () => {
    const rows = [row("2026-01-05", 1, 0, 0), row("2026-01-12", 1, 0, 0), row("2026-01-13", 1)];
    const series = buildDaySeries(rows, { from: "2026-01-05", to: "2026-06-30" });
    expect(series.points.slice(0, 3)).toEqual([
      // Idle days around a no-usage session do not make the week $0.
      { key: "2026-01-05", sessions: 1, cost: null },
      // One known day makes the week known; the unknown day stays out of it.
      { key: "2026-01-12", sessions: 2, cost: 1 },
      // A week with no sessions is a real zero.
      { key: "2026-01-19", sessions: 0, cost: 0 },
    ]);
    // A day with only subagent runs has a real cost and makes its week known.
    const subagentOnly = buildDaySeries([row("2026-01-07", 0, 0, 4)], {
      from: "2026-01-05",
      to: "2026-06-30",
    });
    expect(subagentOnly.points[0]).toEqual({ key: "2026-01-05", sessions: 0, cost: 4 });
  });

  test("ignores malformed keys and ranges", () => {
    expect(buildDaySeries([row("", 3), row("2026-02-30", 1)]).points).toEqual([]);
    expect(buildDaySeries([], { from: "2026-03-05", to: "2026-03-01" }).points).toEqual([]);
  });

  test("isolatedPoints flags known values with no known neighbour", () => {
    expect(isolatedPoints([5])).toEqual([true]);
    expect(isolatedPoints([null, 5, null, 1, 2])).toEqual([false, true, false, false, false]);
    expect(isolatedPoints([0, null])).toEqual([true, false]);
    expect(isolatedPoints([])).toEqual([]);
  });

  test("weekStart returns the Monday of the ISO week", () => {
    expect(weekStart("2026-11-05")).toBe("2026-11-02");
    expect(weekStart("2026-11-02")).toBe("2026-11-02");
    expect(weekStart("2026-11-08")).toBe("2026-11-02");
  });

  test("alignToSeries places per-day values on the series points", () => {
    const daily = buildDaySeries([row("2026-03-01", 1), row("2026-03-03", 1)]);
    expect(alignToSeries(daily, ["2026-03-01", "2026-03-03"], [4, 2])).toEqual([4, 0, 2]);
    const weekly = buildDaySeries([row("2026-01-01", 1), row("2026-12-31", 1)]);
    const aligned = alignToSeries(weekly, ["2026-01-01", "2026-01-02", "2026-12-31"], [1, 2, 5]);
    expect(aligned[0]).toBe(3);
    expect(aligned.at(-1)).toBe(5);
  });
});
