/**
 * Whether the UI should show a sync's progress and load its results without
 * waiting for the user. Manual syncs were asked for, and the startup sync runs
 * while the page is first opening, so nobody is mid-read; on a fresh install it
 * is the sync that fills an empty archive. Watcher and sweep syncs stay
 * deferred so background activity never reshuffles a page someone is reading.
 */
export function isForegroundSync(reason: string | undefined): boolean {
  return reason === "manual" || reason === "startup";
}

export interface ArchiveUpdatePlan {
  refresh: boolean;
  /** Whether to light Update so the user can load the change when ready. */
  offerUpdate: boolean;
  /** Whether the next `stats` update still belongs to a foreground sync. */
  awaitingStats: boolean;
}

/**
 * Decides whether an `archive_updated` event refreshes the page now. A sync
 * that changes the archive also rebuilds token economics in the background,
 * and that rebuild lands later as its own `stats` update; without following
 * it, the refreshed page keeps the pre-sync activity breakdown until the user
 * clicks Update.
 */
export function planArchiveUpdate(
  reason: string | undefined,
  awaitingStats: boolean,
  foregroundSyncRunning: boolean,
): ArchiveUpdatePlan {
  if (isForegroundSync(reason)) {
    return { refresh: true, offerUpdate: false, awaitingStats: true };
  }
  if (reason === "stats" && awaitingStats) {
    return { refresh: true, offerUpdate: false, awaitingStats: false };
  }
  if (reason === "session_state") {
    return { refresh: true, offerUpdate: false, awaitingStats };
  }
  // A running foreground sync refreshes the page when it finishes, which
  // covers this update too. Lighting Update meanwhile would relabel the busy
  // sync button "Load new activity" mid-sync, as the boot-time stats rebuild
  // does during a first launch's startup sync.
  return { refresh: false, offerUpdate: !foregroundSyncRunning, awaitingStats };
}

export interface SyncFailure {
  reason?: string;
  error: string;
}

/**
 * The server publishes sync failures as SSE `error` events, which EventSource
 * delivers to the same listener as its own connection errors. Only the server
 * event carries a data payload, so that is what tells the two apart.
 */
export function parseSyncFailure(event: Event): SyncFailure | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    return null;
  }
  try {
    const payload = JSON.parse(event.data) as { reason?: unknown; error?: unknown };
    return {
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
      error: typeof payload.error === "string" ? payload.error : "sync failed",
    };
  } catch {
    return { error: "sync failed" };
  }
}
