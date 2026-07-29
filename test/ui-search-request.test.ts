import { describe, expect, test } from "bun:test";
import { searchRequestScope, searchRouteHref } from "../src/ui/search-request.ts";

describe("search request scope", () => {
  test("includes the active date range and supported URL filters", () => {
    expect(
      searchRequestScope("/search?q=cache&tool=codex&project=%2Fwork%2Fdecant", {
        from: "2026-07-01",
        to: "2026-07-29",
      }),
    ).toEqual({
      from: "2026-07-01",
      project: "/work/decant",
      to: "2026-07-29",
      tool: "codex",
    });
  });

  test("omits blank filters and does not forward unrelated query parameters", () => {
    expect(
      searchRequestScope("/search?q=cache&tool=&project=&model=gpt-5", {
        from: null,
        to: null,
      }),
    ).toEqual({});
  });

  test("preserves search-page tool and project filters while the query changes", () => {
    const path = "/search?q=old&tool=codex&project=%2Fwork%2Fdecant&ignored=yes";

    expect(searchRouteHref("new query", path)).toBe(
      "/search?tool=codex&project=%2Fwork%2Fdecant&q=new+query",
    );
    expect(searchRouteHref("", path)).toBe("/search?tool=codex&project=%2Fwork%2Fdecant");
    expect(searchRouteHref("new query", "/sessions")).toBe("/search?q=new+query");
  });
});
