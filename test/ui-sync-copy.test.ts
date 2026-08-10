import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const main = readFileSync(join(root, "src", "ui", "main.tsx"), "utf8");
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
  expect(main).toContain('if (payload.reason !== "manual")');
  expect(main.match(/if \(payload\.reason !== "manual"\) \{\s*return;\s*\}/g)).toHaveLength(2);
  expect(main).toContain('payload.reason === "manual" || payload.reason === "session_state"');
  expect(main).toContain('events.addEventListener("archive_updated", handleArchiveUpdated');
  expect(main).not.toContain('events.addEventListener("archive_updated", requestRefresh)');
  expect(main).toContain('archiveUpdateAvailable ? "Update" : "Sync"');
  expect(main).toContain("archiveUpdateAvailable ? loadArchiveUpdates : runSync");
  // The shell stopped rendering server-wide sync status, so the slice that
  // carried it must not be fetched on every route either.
  expect(main).not.toContain("/api/analytics/now");
});
