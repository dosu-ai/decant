import { describe, expect, test } from "bun:test";
import {
  cacheDetail,
  cacheHitRate,
  costPerCompletedSession,
  orderedOutcomes,
  percentDelta,
  pointDelta,
  previousRange,
} from "../src/ui/analytics-metrics.ts";
import { compact, duration, money } from "../src/ui/format.ts";

const outcome = (key: string, sessions: number) => ({
  key,
  sessions,
  usage_sessions: sessions,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  est_reasoning_tokens: 0,
  estimated_cost_usd: 0,
});

describe("analytics metrics", () => {
  test("cache hit rate counts reads against every prompt-side token", () => {
    expect(
      cacheHitRate({ input_tokens: 10, cache_read_tokens: 80, cache_creation_tokens: 10 }),
    ).toBeCloseTo(0.8);
    expect(
      cacheHitRate({ input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }),
    ).toBeNull();
  });

  test("previous range has the same length and ends the day before", () => {
    expect(previousRange("2026-10-07", "2026-11-05")).toEqual({
      from: "2026-09-07",
      to: "2026-10-06",
      days: 30,
    });
    expect(previousRange("2026-03-01", "2026-03-01")).toEqual({
      from: "2026-02-28",
      to: "2026-02-28",
      days: 1,
    });
    expect(previousRange(null, "2026-03-01")).toBeNull();
    expect(previousRange("2026-03-05", "2026-03-01")).toBeNull();
  });

  test("deltas name the comparison period and skip empty baselines", () => {
    expect(percentDelta(112, 100, 30)).toBe("+12% vs previous 30 days");
    expect(percentDelta(92, 100, 1)).toBe("−8% vs previous day");
    expect(percentDelta(100, 100, 7)).toBe("Flat vs previous 7 days");
    expect(percentDelta(5, 0, 7)).toBeNull();
    expect(percentDelta(5, null, 7)).toBeNull();
    expect(pointDelta(0.9, 0.87)).toBe("+3 pts");
    expect(pointDelta(0.88, 0.87)).toBe("+1 pt");
    expect(pointDelta(0.87, 0.87)).toBe("flat");
    expect(pointDelta(null, 0.87)).toBeNull();
    expect(cacheDetail(0.976, 0.968)).toBe("98% hit rate (+1 pt)");
    expect(cacheDetail(0.976, null)).toBe("98% hit rate");
    expect(cacheDetail(null, 0.5)).toBeNull();
    expect(compact(8_106_700_000)).toBe("8.1B");
  });

  test("cost per completed session spreads all cost over completions", () => {
    const rows = [outcome("abandoned", 6), outcome("completed", 4)];
    expect(costPerCompletedSession(20, rows)).toBe(5);
    expect(costPerCompletedSession(20, [outcome("abandoned", 6)])).toBeNull();
    expect(orderedOutcomes([outcome("(unclassified)", 1), ...rows]).map((row) => row.key)).toEqual([
      "completed",
      "abandoned",
      "(unclassified)",
    ]);
  });

  test("money groups thousands and durations roll into days", () => {
    expect(money(2939.384)).toBe(
      `$${(2939.38).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
    );
    expect(money(0.5)).toBe(`$${(0.5).toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
    expect(duration(3 * 3_600_000 + 4 * 60_000)).toBe("3h 4m");
    expect(duration(155 * 3_600_000 + 14 * 60_000)).toBe("6d 11h");
  });
});
