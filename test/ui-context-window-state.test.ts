import { describe, expect, test } from "bun:test";
import { contextWindowDisplayMode } from "../src/ui/context-window-state.ts";

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
