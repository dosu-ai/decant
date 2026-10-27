import { describe, expect, test } from "bun:test";
import { sessionPageFailure, sessionPageView } from "../src/ui/session-page.ts";
import type { LoadedSessionPage } from "../src/ui/types.ts";

const scopeKey = JSON.stringify(["", null, false]);

function loadedPage(page: number, overrides: Partial<LoadedSessionPage> = {}): LoadedSessionPage {
  return {
    exhausted: false,
    page,
    requestKey: `${scopeKey}:${page}:0`,
    scopeKey,
    sessions: [],
    ...overrides,
  };
}

describe("sessionPageView", () => {
  test("shows a cached page without loading", () => {
    const cached = loadedPage(1);
    expect(
      sessionPageView({
        cached,
        enabled: true,
        currentError: null,
        page: 1,
        scopeKey,
        settled: null,
      }),
    ).toEqual({ loading: false, refreshing: false, visible: cached });
  });

  test("keeps the same page's rows on screen while a reload fetches it again", () => {
    // A reload changes the request key, so the cache misses, but the rows
    // already shown for this page and scope stay up instead of a skeleton.
    const settled = loadedPage(1);
    expect(
      sessionPageView({
        cached: null,
        enabled: true,
        currentError: null,
        page: 1,
        scopeKey,
        settled,
      }),
    ).toEqual({ loading: false, refreshing: true, visible: settled });
  });

  test("keeps another page's rows visible but busy until the requested page arrives", () => {
    const settled = loadedPage(1);
    expect(
      sessionPageView({
        cached: null,
        enabled: true,
        currentError: null,
        page: 2,
        scopeKey,
        settled,
      }),
    ).toEqual({ loading: true, refreshing: false, visible: settled });
  });

  test("never shows rows from a different scope", () => {
    const settled = loadedPage(1, { scopeKey: JSON.stringify(["days=7", null, false]) });
    expect(
      sessionPageView({
        cached: null,
        enabled: true,
        currentError: null,
        page: 1,
        scopeKey,
        settled,
      }),
    ).toEqual({ loading: true, refreshing: false, visible: null });
  });

  test("stops loading once the request has failed or the view is hidden", () => {
    expect(
      sessionPageView({
        cached: null,
        enabled: true,
        currentError: new Error("offline"),
        page: 1,
        scopeKey,
        settled: null,
      }).loading,
    ).toBe(false);
    expect(
      sessionPageView({
        cached: null,
        enabled: false,
        currentError: null,
        page: 1,
        scopeKey,
        settled: null,
      }).loading,
    ).toBe(false);
  });
});

describe("sessionPageFailure", () => {
  const rows = loadedPage(1, {
    sessions: [{ id: "s1" } as unknown as LoadedSessionPage["sessions"][number]],
  }).sessions;

  test("keeps the rows on screen when a reload of the same page fails", () => {
    expect(
      sessionPageFailure({ error: new Error("offline"), loadedPage: 1, sessions: rows }, 1),
    ).toBe("notice");
  });

  test("shows the error screen when the failed page has no rows of its own", () => {
    // Page 2 failed while page 1's rows were still up, so those rows are not
    // what was asked for.
    expect(
      sessionPageFailure({ error: new Error("offline"), loadedPage: 1, sessions: rows }, 2),
    ).toBe("replace");
    expect(
      sessionPageFailure({ error: new Error("offline"), loadedPage: null, sessions: [] }, 1),
    ).toBe("replace");
  });

  test("reports nothing without an error", () => {
    expect(sessionPageFailure({ error: null, loadedPage: 1, sessions: rows }, 1)).toBeNull();
  });
});
