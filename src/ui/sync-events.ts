import { formatInt } from "./format.ts";
import {
  pathOnly,
  sessionIncludesArchived,
  sessionPageFromPath,
  sessionProjectFilter,
  sessionRepoFilter,
} from "./navigation.ts";
import type { SyncProgress, SyncStatus } from "./types.ts";

export function isForegroundSync(reason: string | undefined): boolean {
  return reason === "manual" || reason === "startup";
}

export function showsSync(reason: string | undefined, archiveSynced: boolean): boolean {
  return !archiveSynced || isForegroundSync(reason);
}

export interface ArchiveUpdatePlan {
  refresh: boolean;
  offerUpdate: boolean;
  awaitingStats: boolean;
}

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
  return { refresh: false, offerUpdate: !foregroundSyncRunning, awaitingStats };
}

export const LIVE_SESSIONS_REFRESH_MS = 5_000;

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
    sessionRepoFilter(path) == null &&
    !sessionIncludesArchived(path) &&
    !textFilterActive &&
    !paletteOpen
  );
}

export type LiveSessionsAction = "refresh" | "offer_update" | "none";

export const LIVE_SESSIONS_TOP_PX = 64;

export interface LiveSessionsViewer {
  nearTop: boolean;
  visible: boolean;
}

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

export interface RestoredSync {
  syncing: boolean;
  progress: SyncProgress | null;
  archiveSynced: boolean;
  ended: boolean;
  failure: string | null;
}

function runningShownSync(status: SyncStatus): boolean {
  return status.in_progress && showsSync(status.reason ?? undefined, status.archive_synced);
}

export function restoreSync(
  status: SyncStatus,
  shown: { syncing: boolean; manualPending: boolean; sawSync?: boolean },
): RestoredSync {
  const running = runningShownSync(status);
  const ended = (shown.syncing || shown.sawSync === true) && !shown.manualPending && !running;
  return {
    syncing: running || shown.manualPending,
    progress: running ? status.progress : null,
    archiveSynced: status.archive_synced,
    ended,
    failure: ended && !status.in_progress ? status.last_error : null,
  };
}

export function supersededStatus(
  status: SyncStatus,
  tab: { newerApplied: boolean; syncing: boolean },
): { sawSync: boolean; readAgain: boolean } {
  const sawSync = runningShownSync(status);
  return { sawSync, readAgain: sawSync && tab.newerApplied && !tab.syncing };
}

export function showsSyncComplete(complete: boolean, syncing: boolean): boolean {
  return complete && !syncing;
}

export function syncFraction(progress: SyncProgress | null): number | null {
  if (progress == null || progress.total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(1, progress.scanned / progress.total));
}

export function syncProgressLabel(progress: SyncProgress | null): string {
  if (progress == null || progress.total <= 0) {
    return "Syncing session logs";
  }
  const files = progress.total === 1 ? "file" : "files";
  return `Syncing ${formatInt(progress.scanned)} of ${formatInt(progress.total)} ${files}`;
}

export function syncCompleteLabel(progress: SyncProgress | null): string {
  if (progress == null || progress.ingested <= 0) {
    return "Sync complete";
  }
  const files = progress.ingested === 1 ? "file" : "files";
  return `Sync complete, ${formatInt(progress.ingested)} ${files} ingested`;
}

export function syncAnnouncement(progress: SyncProgress | null): string {
  const fraction = syncFraction(progress);
  const step = fraction == null ? 0 : Math.min(90, Math.floor(fraction * 10) * 10);
  return step === 0 ? "Syncing session logs" : `Syncing session logs, ${step}% done`;
}

export const SYNC_NOTICE_DELAY_MS = 700;

export function syncNoticeDelay(sync: { firstSync: boolean; requested: boolean }): number {
  return sync.firstSync || sync.requested ? 0 : SYNC_NOTICE_DELAY_MS;
}
