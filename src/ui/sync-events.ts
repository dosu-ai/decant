import {
  pathOnly,
  sessionIncludesArchived,
  sessionPageFromPath,
  sessionProjectFilter,
} from "./navigation.ts";

/**
 * Whether the UI should show a sync's progress and load its results without
 * waiting for the user. Manual syncs were asked for, and the startup sync runs
 * while the page is first opening, so nobody is mid-read; on a fresh install it
 * is the sync that fills an empty archive. Watcher and sweep syncs stay
 * deferred so background activity never reshuffles a page someone is reading.
 * The unfiltered Sessions list is the one exception (see sessionsAutoRefresh).
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

/**
 * Minimum gap between automatic Sessions refreshes. An agent mid-run appends to
 * its log every few seconds, and each watcher sync is followed by a stats
 * rebuild, so without a floor the list would reload on nearly every event.
 */
export const LIVE_SESSIONS_REFRESH_MS = 5_000;

/**
 * Whether a background archive change reloads the Sessions list in place
 * instead of lighting Update. Only the unfiltered first page qualifies. It is
 * newest first, so new sessions land at the top of what is already on screen.
 * Later pages would shift rows between pages, and a project, archive, or text
 * filter is a narrowed view someone is working through. The command palette
 * covers the list and would reload its own index on every refresh.
 */
export function sessionsAutoRefresh({
  path,
  textFilterActive,
  paletteOpen,
}: {
  path: string;
  textFilterActive: boolean;
  paletteOpen: boolean;
}): boolean {
  return (
    pathOnly(path) === "/sessions" &&
    sessionPageFromPath(path) === 1 &&
    sessionProjectFilter(path) == null &&
    !sessionIncludesArchived(path) &&
    !textFilterActive &&
    !paletteOpen
  );
}

export type LiveSessionsAction = "refresh" | "offer_update" | "none";

/**
 * How far down the window can be scrolled and still take a live refresh. The
 * Sessions panel turns off scroll anchoring, so rows inserted at the top push
 * everything below them down, which only goes unnoticed near the top.
 */
export const LIVE_SESSIONS_TOP_PX = 64;

export interface LiveSessionsViewer {
  /** Whether the window is scrolled within LIVE_SESSIONS_TOP_PX of the top. */
  nearTop: boolean;
  /** Whether the tab is visible. A hidden tab has no reader to keep current. */
  visible: boolean;
}

/**
 * What a throttled Sessions refresh does when it comes due. The page may have
 * changed since the change was queued, so a view that no longer qualifies
 * gets Update instead and the change is not lost. The same goes for a reader
 * scrolled down the list and for a hidden tab, which load it once they are
 * back at the top. A running foreground sync refreshes the page itself when it
 * finishes.
 */
export function liveSessionsAction(
  autoRefresh: boolean,
  foregroundSyncRunning: boolean,
  viewer: LiveSessionsViewer,
): LiveSessionsAction {
  if (foregroundSyncRunning) {
    return "none";
  }
  return autoRefresh && viewer.nearTop && viewer.visible ? "refresh" : "offer_update";
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
