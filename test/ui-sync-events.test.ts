import { expect, test } from "bun:test";
import { isForegroundSync, parseSyncFailure, planArchiveUpdate } from "../src/ui/sync-events.ts";

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
