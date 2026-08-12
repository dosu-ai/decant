import { describe, expect, test } from "bun:test";
import {
  clearToolCallFilters,
  isDrilldownActivationKey,
  toolDateRangeFromFilters,
  toolFiltersFromSearch,
  toolFiltersHref,
  withToolDateRange,
} from "../src/ui/tool-filters.ts";

describe("tool URL filters", () => {
  test("parses every call filter, including bookmarkable dates", () => {
    expect(
      toolFiltersFromSearch(
        "?tool=read&server=filesystem&errors_only=1&min_ms=1000&from=2026-07-01&to=2026-07-28&offset=50",
      ),
    ).toEqual({
      errorsOnly: true,
      from: "2026-07-01",
      minMs: 1000,
      offset: 50,
      server: "filesystem",
      to: "2026-07-28",
      tool: "read",
    });
  });

  test("round-trips dates without dropping the other filters", () => {
    const href = toolFiltersHref({
      errorsOnly: true,
      from: "2026-07-01",
      minMs: 5000,
      offset: 100,
      server: "github",
      to: "2026-07-28",
      tool: "search_code",
    });
    const filters = toolFiltersFromSearch(new URL(href, "http://localhost").search);

    expect(filters).toEqual({
      errorsOnly: true,
      from: "2026-07-01",
      minMs: 5000,
      offset: 100,
      server: "github",
      to: "2026-07-28",
      tool: "search_code",
    });
  });

  test("rejects malformed dates and invalid numeric filters", () => {
    expect(toolFiltersFromSearch("?from=2026-02-30&to=tomorrow&min_ms=-1&offset=1.5")).toEqual({
      errorsOnly: false,
      from: null,
      minMs: 0,
      offset: 0,
      server: "",
      to: null,
      tool: "",
    });
  });

  test("restores all-time and partial custom ranges from the URL", () => {
    expect(toolDateRangeFromFilters(toolFiltersFromSearch(""))).toEqual({
      preset: "all",
      from: null,
      to: null,
    });
    expect(toolDateRangeFromFilters(toolFiltersFromSearch("?from=2026-07-01"))).toEqual({
      preset: "custom",
      from: "2026-07-01",
      to: null,
    });
  });

  test("changes dates without losing call filters and resets pagination", () => {
    const current = toolFiltersFromSearch(
      "?tool=read&server=filesystem&errors_only=1&min_ms=1000&offset=50",
    );

    expect(
      withToolDateRange(current, {
        from: "2026-07-01",
        to: "2026-07-28",
      }),
    ).toEqual({
      ...current,
      from: "2026-07-01",
      offset: 0,
      to: "2026-07-28",
    });
  });

  test("clears call filters without discarding the page date scope", () => {
    const filtered = toolFiltersFromSearch(
      "?tool=read&server=filesystem&errors_only=1&min_ms=1000&offset=50&from=2026-07-01&to=2026-07-28",
    );

    expect(clearToolCallFilters(filtered)).toEqual({
      errorsOnly: false,
      from: "2026-07-01",
      minMs: 0,
      offset: 0,
      server: "",
      to: "2026-07-28",
      tool: "",
    });
  });
});

describe("tool aggregate row activation", () => {
  test("accepts link activation keys only", () => {
    expect(isDrilldownActivationKey("Enter")).toBe(true);
    expect(isDrilldownActivationKey(" ")).toBe(true);
    expect(isDrilldownActivationKey("Escape")).toBe(false);
  });
});
