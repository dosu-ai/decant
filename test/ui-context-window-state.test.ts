import { describe, expect, test } from "bun:test";
import { contextWindowDisplayMode, isFullCacheMiss } from "../src/ui/context-window-state.ts";

describe("context window display state", () => {
  test("renders a chart for a valid single-call timeline", () => {
    expect(contextWindowDisplayMode({ window_tokens: 258_400, points: [{ seq: 2 }] })).toBe(
      "chart",
    );
  });

  test("explains incomplete source data instead of silently hiding the panel", () => {
    expect(contextWindowDisplayMode({ window_tokens: null, points: [{ seq: 2 }] })).toBe(
      "unavailable",
    );
    expect(contextWindowDisplayMode({ window_tokens: 258_400, points: [] })).toBe("unavailable");
    expect(contextWindowDisplayMode(null)).toBe("hidden");
  });
});

describe("isFullCacheMiss", () => {
  const points = [
    { seq: 1, context_tokens: 30_000, cache_read_tokens: 0 },
    { seq: 2, context_tokens: 31_000, cache_read_tokens: 10_000 },
    { seq: 4, context_tokens: 32_000, cache_read_tokens: 0 },
    { seq: 5, context_tokens: 33_000, cache_read_tokens: 0 },
  ];

  test("flags a large zero-read call outside reset boundaries", () => {
    expect(isFullCacheMiss(points, 3, [{ seq: 3 }])).toBe(true);
  });

  test("does not flag session starts, post-compaction starts, small calls, or cache hits", () => {
    expect(isFullCacheMiss(points, 0, [])).toBe(false);
    expect(isFullCacheMiss(points, 2, [{ seq: 3 }])).toBe(false);
    expect(isFullCacheMiss(points, 1, [])).toBe(false);
    expect(isFullCacheMiss([{ seq: 1, context_tokens: 10_000, cache_read_tokens: 0 }], 0, [])).toBe(
      false,
    );
  });
});
