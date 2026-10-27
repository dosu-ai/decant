import { describe, expect, test } from "bun:test";
import { toolFiltersFromSearch } from "../src/ui/tool-filters.ts";
import {
  toolSummaryForScope,
  toolSummaryKey,
  toolSummaryNeedsRefresh,
  toolSummaryQuery,
  topToolLabel,
} from "../src/ui/tool-summary.ts";

describe("Tools summary scope", () => {
  const all = toolFiltersFromSearch("");
  const summary = { calls: 19, errors: 2, p50_ms: 10, p95_ms: 90 };
  const saved = { scopeKey: toolSummaryKey(all), reloadKey: 0, summary };

  test("retains a summary only while its tool, server, and dates match", () => {
    expect(toolSummaryForScope(saved, toolSummaryKey(all))).toBe(summary);
    for (const patch of [
      { tool: "Read" },
      { server: "docs" },
      { from: "2026-05-01" },
      { to: "2026-05-02" },
    ]) {
      expect(toolSummaryForScope(saved, toolSummaryKey({ ...all, ...patch }))).toBeNull();
    }
    expect(toolSummaryForScope(null, toolSummaryKey(all))).toBeNull();
  });

  test("pagination and row-only filters retain the same aggregate summary", () => {
    const rowFilters = { ...all, offset: 100, minMs: 1_000, errorsOnly: true };
    expect(toolSummaryKey(rowFilters)).toBe(saved.scopeKey);
    expect(toolSummaryForScope(saved, toolSummaryKey(rowFilters))).toBe(summary);
  });

  test("an empty summary remains visible during sync refresh and updates when the new generation arrives", async () => {
    const scopeKey = toolSummaryKey(all);
    const emptySummary = { calls: 0, errors: 0, p50_ms: null, p95_ms: null };
    let current = {
      scopeKey,
      reloadKey: 0,
      summary: emptySummary as typeof summary | typeof emptySummary,
    };
    const updated = Promise.withResolvers<typeof summary>();

    expect(toolSummaryNeedsRefresh(current, scopeKey, 0)).toBe(false);
    expect(toolSummaryNeedsRefresh(current, scopeKey, 1)).toBe(true);
    expect(toolSummaryForScope(current, scopeKey)?.calls).toBe(0);

    const refresh = updated.promise.then((value) => {
      current = { scopeKey, reloadKey: 1, summary: value };
    });
    updated.resolve(summary);
    await refresh;

    expect(toolSummaryForScope(current, scopeKey)?.calls).toBe(19);
    expect(toolSummaryNeedsRefresh(current, scopeKey, 1)).toBe(false);
  });

  test("later pages refresh their summary once per archive generation rather than once per page", () => {
    const pageOne = { ...all, offset: 50 };
    const pageTwo = { ...all, offset: 100 };
    expect(toolSummaryNeedsRefresh(saved, toolSummaryKey(pageOne), 0)).toBe(false);
    expect(toolSummaryNeedsRefresh(saved, toolSummaryKey(pageTwo), 0)).toBe(false);
    expect(toolSummaryNeedsRefresh(saved, toolSummaryKey(pageOne), 1)).toBe(true);
    const refreshed = { ...saved, reloadKey: 1, summary: { ...summary, calls: 20 } };
    expect(toolSummaryNeedsRefresh(refreshed, toolSummaryKey(pageTwo), 1)).toBe(false);
    expect(toolSummaryForScope(refreshed, toolSummaryKey(pageTwo))?.calls).toBe(20);
  });

  test("a later-page deep link requests an uncapped first-page summary with the same scope", () => {
    const deepLink = toolFiltersFromSearch(
      "?tool=mcp__docs__search&server=docs&from=2026-05-01&to=2026-05-03&offset=100&errors_only=1&min_ms=1000",
    );
    const params = new URLSearchParams(toolSummaryQuery(deepLink));
    expect(Object.fromEntries(params)).toEqual({
      limit: "1",
      offset: "0",
      tool: "mcp__docs__search",
      server: "docs",
      from: "2026-05-01",
      to: "2026-05-03",
    });
  });

  test("displays the MCP tool name without its transport prefix", () => {
    expect(topToolLabel("mcp__exa__web_search_exa")).toBe("web_search_exa");
    expect(topToolLabel("mcp__docs__nested__search")).toBe("nested__search");
    expect(topToolLabel("Read")).toBe("Read");
  });
});
