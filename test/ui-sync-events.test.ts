import { describe, expect, test } from "bun:test";
import {
  isForegroundSync,
  LIVE_SESSIONS_REFRESH_MS,
  liveSessionsAction,
  parseSyncFailure,
  planArchiveUpdate,
  restoreSync,
  SYNC_NOTICE_DELAY_MS,
  sessionsAutoRefresh,
  showsSync,
  syncAnnouncement,
  syncCompleteLabel,
  syncFraction,
  syncNoticeDelay,
  syncProgressLabel,
} from "../src/ui/sync-events.ts";
import type { SyncProgress, SyncStatus } from "../src/ui/types.ts";

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
    const reading = { nearTop: true, visible: true };
    expect(liveSessionsAction(true, false, reading)).toBe("refresh");
    // The page stopped qualifying while the refresh waited, so the change is
    // offered through Update instead of being dropped.
    expect(liveSessionsAction(false, false, reading)).toBe("offer_update");
    // A running foreground sync refreshes the page when it finishes.
    expect(liveSessionsAction(true, true, reading)).toBe("none");
    expect(liveSessionsAction(false, true, reading)).toBe("none");
  });

  test("holds a refresh for a reader scrolled down the list or a hidden tab", () => {
    // Rows inserted at the top would push a scrolled reader's place down the
    // page, and a hidden tab has no one to keep current.
    expect(liveSessionsAction(true, false, { nearTop: false, visible: true })).toBe("offer_update");
    expect(liveSessionsAction(true, false, { nearTop: true, visible: false })).toBe("offer_update");
  });

  test("refreshes at most once every five to ten seconds", () => {
    expect(LIVE_SESSIONS_REFRESH_MS).toBeGreaterThanOrEqual(5_000);
    expect(LIVE_SESSIONS_REFRESH_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("sync state restored from the status route", () => {
  const progress: SyncProgress = {
    scanned: 312,
    ingested: 300,
    skipped: 12,
    failed: 0,
    total: 1254,
  };
  const status = (overrides: Partial<SyncStatus> = {}): SyncStatus => ({
    in_progress: false,
    last_error: null,
    reason: null,
    progress: null,
    archive_synced: true,
    ...overrides,
  });
  const idleTab = { syncing: false, manualPending: false };
  const watchingTab = { syncing: true, manualPending: false };

  test("a reload during a foreground sync shows it at once, with its progress", () => {
    for (const reason of ["startup", "manual"]) {
      expect(restoreSync(status({ in_progress: true, reason, progress }), idleTab)).toEqual({
        syncing: true,
        progress,
        archiveSynced: true,
        ended: false,
        failure: null,
      });
    }
  });

  test("watcher and sweep syncs stay quiet after a reload too", () => {
    for (const reason of ["watch", "sweep"]) {
      expect(restoreSync(status({ in_progress: true, reason, progress }), idleTab)).toMatchObject({
        syncing: false,
        progress: null,
        ended: false,
      });
    }
  });

  test("any sync filling an archive that has never completed one is shown", () => {
    for (const reason of ["watch", "sweep"]) {
      expect(showsSync(reason, false)).toBe(true);
      expect(showsSync(reason, true)).toBe(false);
      expect(
        restoreSync(
          status({ in_progress: true, reason, progress, archive_synced: false }),
          idleTab,
        ),
      ).toMatchObject({ syncing: true, progress, archiveSynced: false, ended: false });
    }
    expect(showsSync("startup", true)).toBe(true);
    expect(showsSync(undefined, true)).toBe(false);
  });

  test("a sync that has not said what started it shows only while it fills a new archive", () => {
    const starting = { in_progress: true, reason: null, progress: null };
    expect(restoreSync(status({ ...starting, archive_synced: false }), idleTab)).toMatchObject({
      syncing: true,
      archiveSynced: false,
    });
    expect(restoreSync(status(starting), idleTab).syncing).toBe(false);
  });

  test("an idle server reports whether the archive has ever been synced", () => {
    expect(restoreSync(status({ archive_synced: false }), idleTab)).toEqual({
      syncing: false,
      progress: null,
      archiveSynced: false,
      ended: false,
      failure: null,
    });
  });

  test("a sync that ended while the stream was down stops showing and loads its results", () => {
    expect(restoreSync(status(), watchingTab)).toMatchObject({
      syncing: false,
      ended: true,
      failure: null,
    });
  });

  test("a sync that failed while the stream was down surfaces its error", () => {
    expect(restoreSync(status({ last_error: "disk full" }), watchingTab)).toMatchObject({
      syncing: false,
      ended: true,
      failure: "disk full",
    });
    // An older failure is not blamed on a background sync that is running now.
    expect(
      restoreSync(
        status({ in_progress: true, reason: "watch", last_error: "disk full" }),
        watchingTab,
      ),
    ).toMatchObject({ syncing: false, ended: true, failure: null });
  });

  test("a sync still running after a reconnect keeps showing", () => {
    expect(
      restoreSync(status({ in_progress: true, reason: "startup", progress }), watchingTab),
    ).toMatchObject({ syncing: true, progress, ended: false });
  });

  test("this tab's own pending manual sync keeps its indicator whatever the server says", () => {
    const pending = { syncing: true, manualPending: true };
    expect(restoreSync(status(), pending)).toMatchObject({
      syncing: true,
      progress: null,
      ended: false,
      failure: null,
    });
  });
});

describe("sync progress copy", () => {
  const at = (scanned: number, total: number, ingested = scanned): SyncProgress => ({
    scanned,
    ingested,
    skipped: 0,
    failed: 0,
    total,
  });

  test("the fraction is unknown until the sync has counted its sources", () => {
    expect(syncFraction(null)).toBeNull();
    expect(syncFraction(at(0, 0))).toBeNull();
    expect(syncFraction(at(0, 1254))).toBe(0);
    expect(syncFraction(at(627, 1254))).toBe(0.5);
    expect(syncFraction(at(2000, 1254))).toBe(1);
  });

  test("the visible label counts files with grouped digits", () => {
    expect(syncProgressLabel(null)).toBe("Syncing session logs");
    expect(syncProgressLabel(at(0, 0))).toBe("Syncing session logs");
    expect(syncProgressLabel(at(312, 1254))).toBe("Syncing 312 of 1,254 files");
    expect(syncProgressLabel(at(0, 1))).toBe("Syncing 0 of 1 file");
  });

  test("the completion label reports what was ingested", () => {
    expect(syncCompleteLabel(null)).toBe("Sync complete");
    expect(syncCompleteLabel(at(1254, 1254, 0))).toBe("Sync complete");
    expect(syncCompleteLabel(at(1254, 1254, 1))).toBe("Sync complete, 1 file ingested");
    expect(syncCompleteLabel(at(1254, 1254))).toBe("Sync complete, 1,254 files ingested");
  });

  test("the live announcement changes once per ten percent, not once per file", () => {
    const spoken = new Set<string>();
    for (let scanned = 0; scanned <= 1254; scanned += 1) {
      spoken.add(syncAnnouncement(at(scanned, 1254)));
    }
    expect(spoken.size).toBe(10);
    expect(syncAnnouncement(null)).toBe("Syncing session logs");
    expect(syncAnnouncement(at(100, 1254))).toBe("Syncing session logs");
    expect(syncAnnouncement(at(627, 1254))).toBe("Syncing session logs, 50% done");
    expect(syncAnnouncement(at(1253, 1254))).toBe("Syncing session logs, 90% done");
    // The last file is not the end of the sync, so "Sync complete" says 100%.
    expect(syncAnnouncement(at(1254, 1254))).toBe("Syncing session logs, 90% done");
  });

  test("the progress notice opens at once for a first or requested sync, later otherwise", () => {
    expect(syncNoticeDelay({ firstSync: true, requested: false })).toBe(0);
    expect(syncNoticeDelay({ firstSync: false, requested: true })).toBe(0);
    expect(syncNoticeDelay({ firstSync: false, requested: false })).toBe(SYNC_NOTICE_DELAY_MS);
    expect(SYNC_NOTICE_DELAY_MS).toBeGreaterThanOrEqual(500);
  });
});
