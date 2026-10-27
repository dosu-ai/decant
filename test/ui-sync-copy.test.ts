import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readUiSource } from "./ui-source.ts";

const root = join(import.meta.dir, "..");
const main = readUiSource();
const styles = readFileSync(join(root, "src", "ui", "styles.css"), "utf8");

test("sync stays visually icon-led while retaining a hidden live announcement", () => {
  expect(main).toContain('archiveUpdateAvailable ? "Load new activity" : "Sync session logs"');
  expect(main).toContain('"Syncing session logs"');
  expect(main).not.toContain("Sync in progress");
  expect(main).not.toContain("Syncing…");
  expect(main).not.toContain("Synced ·");
  expect(main).not.toContain('? "Synced" : "Sync"');
  expect(main).toContain("const LIVE_DISCONNECT_GRACE_MS = 15_000");
  expect(main).toMatch(
    /setArchiveUpdateAvailable\(false\);\s*setLocalSyncing\(false\);\s*setSyncError\(null\);\s*setSyncComplete\(true\);/,
  );
  expect(styles).toContain(".sr-only {");
  expect(styles).toContain("clip-path: inset(50%)");
});

test("background archive activity waits for an explicit update", () => {
  expect(main).toContain("const [archiveUpdateAvailable, setArchiveUpdateAvailable]");
  expect(main.match(/if \(!isForegroundSync\(payload\.reason\)\) \{\s*return;\s*\}/g)).toHaveLength(
    2,
  );
  expect(main).toMatch(
    /planArchiveUpdate\(\s*payload\.reason,\s*awaitingStatsRef\.current,\s*localSyncingRef\.current,\s*\)/,
  );
  expect(main).toContain("localSyncingRef.current = localSyncing;");
  // Server sync failures share EventSource's "error" listener and must end a
  // foreground sync rather than read as a dropped connection.
  expect(main).toContain("const failure = parseSyncFailure(event);");
  // Reconnecting drops a stream-only sync indicator whose terminal event was
  // lost, but never one owned by this tab's own pending POST /api/sync.
  expect(main).toMatch(
    /if \(!manualSyncPendingRef\.current\) \{\s*progressThrottle\.cancel\(\);\s*setLocalSyncing\(false\);/,
  );
  expect(main).toContain('events.addEventListener("archive_updated", handleArchiveUpdated');
  expect(main).not.toContain('events.addEventListener("archive_updated", requestRefresh)');
  expect(main).toContain('archiveUpdateAvailable ? "Update" : "Sync"');
  expect(main).toContain("archiveUpdateAvailable ? loadArchiveUpdates : runSync");
  // The shell stopped rendering server-wide sync status, so the slice that
  // carried it must not be fetched on every route either.
  expect(main).not.toContain("/api/analytics/now");
});

test("the unfiltered Sessions list loads background activity itself, throttled", () => {
  // Background activity goes to the live throttle only while the list
  // qualifies. Anywhere else it still lights Update.
  expect(main).toMatch(
    /if \(liveSessionsRef\.current && liveRefresh != null\) \{\s*liveRefresh\.push\(null\);\s*\} else \{\s*setArchiveUpdateAvailable\(true\);\s*\}/,
  );
  expect(main).toMatch(
    /createLatestThrottle<null>\(\(\) => \{\s*const action = liveSessionsAction\(\s*liveSessionsRef\.current,\s*localSyncingRef\.current,\s*liveSessionsViewer\(\),\s*\);/,
  );
  // Held-back activity loads once the reader is back at the top of a visible tab.
  expect(main).toContain('window.addEventListener("scroll", resume, { passive: true });');
  expect(main).toContain('document.addEventListener("visibilitychange", resume);');
  expect(main).toContain("}, LIVE_SESSIONS_REFRESH_MS);");
  // A refresh does what Update would, so Update goes dark with it.
  expect(main).toMatch(
    /if \(action === "refresh"\) \{\s*setArchiveUpdateAvailable\(false\);\s*requestRefresh\(\);/,
  );
  // Activity that lit Update elsewhere loads on return to the list.
  expect(main).toMatch(
    /if \(liveSessions && archiveUpdateAvailable\) \{\s*liveSessionsThrottleRef\.current\?\.push\(null\);/,
  );
  expect(main).toContain("onTextFilterChange?.(textFilterActive);");
});
