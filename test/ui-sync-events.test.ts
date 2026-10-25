import { describe, expect, test } from "bun:test";
import {
  isForegroundSync,
  LIVE_SESSIONS_REFRESH_MS,
  liveSessionsAction,
  parseSyncFailure,
  planArchiveUpdate,
  sessionsAutoRefresh,
} from "../src/ui/sync-events.ts";

test("manual and startup syncs run in the foreground", () => {
  expect(isForegroundSync("manual")).toBe(true);
  // The startup sync fills a fresh archive while the page first opens, so the
  // UI shows it and loads its results instead of waiting for an Update click.
  expect(isForegroundSync("startup")).toBe(true);
});

test("watcher and sweep syncs stay in the background", () => {
  expect(isForegroundSync("watch")).toBe(false);
  expect(isForegroundSync("sweep")).toBe(false);
  expect(isForegroundSync(undefined)).toBe(false);
});

test("foreground syncs and session state refresh immediately; background updates wait", () => {
  for (const reason of ["manual", "startup", "session_state"]) {
    expect(planArchiveUpdate(reason, false, false)).toMatchObject({
      refresh: true,
      offerUpdate: false,
    });
  }
  for (const reason of ["watch", "sweep", "stats", undefined]) {
    expect(planArchiveUpdate(reason, false, false)).toMatchObject({
      refresh: false,
      offerUpdate: true,
    });
  }
});

test("the stats rebuild that follows a foreground sync loads without an Update click", () => {
  const afterStartup = planArchiveUpdate("startup", false, false);
  expect(afterStartup.awaitingStats).toBe(true);
  expect(planArchiveUpdate("stats", afterStartup.awaitingStats, false)).toEqual({
    refresh: true,
    offerUpdate: false,
    awaitingStats: false,
  });
});

test("stats rebuilds unrelated to a foreground sync stay deferred", () => {
  expect(planArchiveUpdate("stats", false, false)).toEqual({
    refresh: false,
    offerUpdate: true,
    awaitingStats: false,
  });
  // A background sync between the foreground sync and its rebuild does not
  // consume the pending stats refresh.
  expect(planArchiveUpdate("watch", true, false)).toEqual({
    refresh: false,
    offerUpdate: true,
    awaitingStats: true,
  });
});

test("background updates during a foreground sync wait for that sync's refresh", () => {
  // On first launch the boot-time stats rebuild lands mid startup sync; it must
  // not relabel the busy sync button as "Load new activity".
  expect(planArchiveUpdate("stats", false, true)).toEqual({
    refresh: false,
    offerUpdate: false,
    awaitingStats: false,
  });
  expect(planArchiveUpdate("watch", false, true).offerUpdate).toBe(false);
});

test("server sync failures are told apart from EventSource connection errors", () => {
  expect(parseSyncFailure(new Event("error"))).toBeNull();
  expect(
    parseSyncFailure(
      new MessageEvent("error", {
        data: JSON.stringify({ type: "error", reason: "startup", error: "disk full" }),
      }),
    ),
  ).toEqual({ reason: "startup", error: "disk full" });
  expect(parseSyncFailure(new MessageEvent("error", { data: "not json" }))).toEqual({
    error: "sync failed",
  });
});

describe("live Sessions refresh", () => {
  const visibleList = { textFilterActive: false, paletteOpen: false };

  test("applies only to the unfiltered first page of the Sessions list", () => {
    expect(sessionsAutoRefresh({ path: "/sessions", ...visibleList })).toBe(true);
    expect(sessionsAutoRefresh({ path: "/sessions?page=1", ...visibleList })).toBe(true);
    for (const path of [
      "/sessions?page=2",
      "/sessions?project=%2Frepo",
      "/sessions?include_archived=true",
      "/sessions/42",
      "/analytics",
      "/projects",
    ]) {
      expect(sessionsAutoRefresh({ path, ...visibleList })).toBe(false);
    }
  });

  test("pauses while a text filter or the command palette is in use", () => {
    expect(
      sessionsAutoRefresh({ path: "/sessions", textFilterActive: true, paletteOpen: false }),
    ).toBe(false);
    expect(
      sessionsAutoRefresh({ path: "/sessions", textFilterActive: false, paletteOpen: true }),
    ).toBe(false);
  });

  test("a due refresh reloads the list, falls back to Update, or defers to a foreground sync", () => {
    expect(liveSessionsAction(true, false)).toBe("refresh");
    // The page stopped qualifying while the refresh waited, so the change is
    // offered through Update instead of being dropped.
    expect(liveSessionsAction(false, false)).toBe("offer_update");
    // A running foreground sync refreshes the page when it finishes.
    expect(liveSessionsAction(true, true)).toBe("none");
    expect(liveSessionsAction(false, true)).toBe("none");
  });

  test("refreshes at most once every five to ten seconds", () => {
    expect(LIVE_SESSIONS_REFRESH_MS).toBeGreaterThanOrEqual(5_000);
    expect(LIVE_SESSIONS_REFRESH_MS).toBeLessThanOrEqual(10_000);
  });
});
