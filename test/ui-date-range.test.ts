import { describe, expect, test } from "bun:test";
import {
  applyDatePreset,
  dateRangePresetLabel,
  dateRangeQuery,
  formatDateLabel,
  RANGE_PRESETS,
  withDateQuery,
} from "../src/ui/date-range.ts";

describe("dashboard date ranges", () => {
  test("offers the supported relative ranges in display order", () => {
    expect(RANGE_PRESETS).toEqual([
      { key: "today", label: "Today", days: 1 },
      { key: "7d", label: "Last 7 days", days: 7 },
      { key: "30d", label: "Last 30 days", days: 30 },
      { key: "90d", label: "Last 90 days", days: 90 },
    ]);
  });

  test("scopes Today to the current calendar date", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(applyDatePreset("today", { min: "2026-01-01", max: "2026-08-26" })).toEqual({
      preset: "today",
      from: today,
      to: today,
    });
  });

  test("anchors relative presets to the newest archived session date", () => {
    expect(applyDatePreset("7d", { min: "2026-01-01", max: "2026-08-26" })).toEqual({
      preset: "7d",
      from: "2026-08-20",
      to: "2026-08-26",
    });
  });

  test("passes arbitrary custom bounds through to API requests", () => {
    const query = dateRangeQuery({ preset: "custom", from: "2026-04-03", to: "2026-05-17" });
    expect(query).toBe("from=2026-04-03&to=2026-05-17");
    expect(withDateQuery("/api/stats/summary", query)).toBe(
      "/api/stats/summary?from=2026-04-03&to=2026-05-17",
    );
  });

  test("keeps the compact control label independent from exact custom dates", () => {
    expect(dateRangePresetLabel({ preset: "all", from: null, to: null })).toBe("All time");
    expect(dateRangePresetLabel({ preset: "custom", from: "2026-04-03", to: "2026-05-17" })).toBe(
      "Custom range",
    );
    expect(dateRangePresetLabel(applyDatePreset("30d", { min: null, max: "2026-08-26" }))).toBe(
      "Last 30 days",
    );
  });

  test("formats ISO calendar dates without shifting them to the local timezone", () => {
    expect(formatDateLabel("2026-08-27")).toMatch(/(^|\D)27(\D|$)/);
  });
});
