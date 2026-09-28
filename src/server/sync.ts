import type { Config } from "../config.ts";
import type { EconomicsCache } from "../economics-cache.ts";
import type { sync as ingestSync, SyncProgress, SyncReport } from "../ingest.ts";
import type { SyncRunnerFailure, SyncRunnerResult, SyncStatusStore, WatchEvent } from "../watch.ts";
import { workerError, workerUrl } from "../worker-runtime.ts";
import { json } from "./http.ts";
import { publishServerEvent } from "./sse.ts";

export type SyncWorkerRunner = (
  config: Config,
  cancel?: { aborted: boolean },
  onProgress?: (progress: SyncProgress) => void,
) => Promise<SyncReport>;

export interface SyncRunHandle {
  promise: Promise<SyncReport>;
  owned: boolean;
}

export interface SyncCoordinator {
  run: SyncWorkerRunner;
  runWithOwnership(
    config: Config,
    cancel?: { aborted: boolean },
    onProgress?: (progress: SyncProgress) => void,
  ): SyncRunHandle;
  close(): Promise<void>;
}

export interface SyncCoordinatorOptions {
  progressEveryFiles?: number;
  progressEveryMs?: number;
  now?: () => number;
}

export const syncStatus = {
  last_sync_at: null as string | null,
  in_progress: false,
  last_report: null as string | null,
  last_error: null as string | null,
  ingested_count: null as number | null,
};

export async function syncNow(
  config: Config,
  economics?: EconomicsCache,
  runSync: SyncWorkerRunner = runSyncWorker,
  runWithOwnership?: SyncCoordinator["runWithOwnership"],
): Promise<Response> {
  const progress = (update: SyncProgress): void => {
    publishServerEvent({
      type: "sync_progress",
      reason: "manual",
      progress: update,
      status: { ...syncStatus },
    });
  };
  const handle =
    runWithOwnership?.(config, undefined, progress) ??
    ({ promise: runSync(config, undefined, progress), owned: true } satisfies SyncRunHandle);
  if (handle.owned) {
    syncStatus.in_progress = true;
    syncStatus.last_error = null;
  }
  try {
    const report = await handle.promise;
    if (!handle.owned) {
      return json(report);
    }
    syncStatus.in_progress = false;
    syncStatus.last_sync_at = new Date().toISOString();
    syncStatus.last_report =
      `scanned ${report.scanned}, ingested ${report.ingested}, skipped ${report.skipped}, ` +
      `issues ${report.issues}, failed ${report.failed}`;
    syncStatus.ingested_count = report.ingested;
    publishServerEvent({ type: "sync", reason: "manual", report, status: { ...syncStatus } });
    if (report.ingested > 0 || (report.repriced ?? 0) > 0) {
      economics?.invalidate();
      publishServerEvent({
        type: "archive_updated",
        reason: "manual",
        ingested: report.ingested,
        last_sync_at: syncStatus.last_sync_at,
      });
    }
    return json(report);
  } catch (error) {
    if (handle.owned) {
      syncStatus.in_progress = false;
      syncStatus.last_sync_at = new Date().toISOString();
      syncStatus.last_error = error instanceof Error ? error.message : String(error);
      publishServerEvent({
        type: "error",
        reason: "manual",
        error: syncStatus.last_error,
        status: { ...syncStatus },
      });
    }
    throw error;
  }
}

function runSyncWorker(
  config: Config,
  cancel?: { aborted: boolean },
  onProgress?: (progress: SyncProgress) => void,
): Promise<ReturnType<typeof ingestSync>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl("sync-worker.ts"), { type: "module" });
    const cancelBuffer =
      cancel == null ? null : new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancelView = cancelBuffer == null ? null : new Int32Array(cancelBuffer);
    let cancelPoll: Timer | null = null;
    const settle = (): void => {
      if (cancelPoll != null) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
    };
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { type: "progress"; progress: SyncProgress }
        | { type: "complete"; ok: true; report: ReturnType<typeof ingestSync> }
        | { type: "complete"; ok: false; error: string };
      if (data.type === "progress") {
        onProgress?.(data.progress);
        return;
      }
      settle();
      if (data.ok) {
        resolve(data.report);
      } else {
        reject(new Error(data.error));
      }
    });
    worker.addEventListener("error", (event) => {
      settle();
      reject(workerError(event, "sync worker failed"));
    });
    if (cancel != null) {
      // Share cancellation with the worker so it can stop between files and
      // close SQLite itself. Terminating a worker while it owns a native
      // connection can race Bun's SQLite finalizers during server shutdown.
      if (cancel.aborted && cancelView != null) {
        Atomics.store(cancelView, 0, 1);
      }
      cancelPoll = setInterval(() => {
        if (cancel.aborted && cancelView != null) {
          Atomics.store(cancelView, 0, 1);
        }
      }, 150);
    }
    worker.postMessage({ config, cancelBuffer });
  });
}

/**
 * Owns the one physical sync worker allowed per server. Overlapping watcher and
 * manual requests join the same Promise instead of opening competing SQLite
 * writers. Progress is fanned out at a bounded cadence while retaining the
 * first update and the final update observed before completion.
 */
export function createSyncCoordinator(
  worker: SyncWorkerRunner = runSyncWorker,
  options: SyncCoordinatorOptions = {},
): SyncCoordinator {
  const progressEveryFiles = Math.max(1, options.progressEveryFiles ?? 25);
  const progressEveryMs = Math.max(0, options.progressEveryMs ?? 250);
  const now = options.now ?? (() => performance.now());
  const ownedCancel = { aborted: false };
  let closed = false;
  let active: {
    promise: Promise<SyncReport>;
    listeners: Set<(progress: SyncProgress) => void>;
    cancelSources: Set<{ aborted: boolean }>;
  } | null = null;

  const start = (
    config: Config,
    cancel?: { aborted: boolean },
    onProgress?: (progress: SyncProgress) => void,
    listenWhenJoined = true,
  ): SyncRunHandle => {
    if (closed) {
      return {
        promise: Promise.reject(new Error("sync coordinator is closed")),
        owned: false,
      };
    }
    if (active != null) {
      if (cancel != null) {
        active.cancelSources.add(cancel);
      }
      if (listenWhenJoined && onProgress != null) {
        active.listeners.add(onProgress);
      }
      return { promise: active.promise, owned: false };
    }

    const listeners = new Set<(progress: SyncProgress) => void>();
    const cancelSources = new Set<{ aborted: boolean }>([ownedCancel]);
    if (cancel != null) {
      cancelSources.add(cancel);
    }
    if (onProgress != null) {
      listeners.add(onProgress);
    }
    const sharedCancel = {
      get aborted(): boolean {
        return [...cancelSources].some((source) => source.aborted);
      },
    };
    let lastEmitted: SyncProgress | null = null;
    let lastEmittedAt = Number.NEGATIVE_INFINITY;
    let pending: SyncProgress | null = null;

    const flush = (): void => {
      if (pending == null) {
        return;
      }
      const progress = pending;
      pending = null;
      lastEmitted = progress;
      lastEmittedAt = now();
      for (const listener of [...listeners]) {
        try {
          listener(progress);
        } catch {
          // Progress reporting must never fail the archive sync itself.
        }
      }
    };
    const forward = (progress: SyncProgress): void => {
      pending = progress;
      const first = lastEmitted == null;
      const terminal = progress.scanned >= progress.total;
      const advancedEnough =
        lastEmitted != null && progress.scanned - lastEmitted.scanned >= progressEveryFiles;
      const waitedEnough = now() - lastEmittedAt >= progressEveryMs;
      if (first || terminal || advancedEnough || waitedEnough) {
        flush();
      }
    };

    let promise: Promise<SyncReport>;
    promise = Promise.resolve()
      .then(() => worker(config, sharedCancel, forward))
      .then(
        (report) => {
          flush();
          return report;
        },
        (error) => {
          flush();
          throw error;
        },
      )
      .finally(() => {
        if (active?.promise === promise) {
          active = null;
        }
      });
    active = { promise, listeners, cancelSources };
    return { promise, owned: true };
  };
  const run: SyncWorkerRunner = (config, cancel, onProgress) =>
    start(config, cancel, onProgress).promise;
  const runWithOwnership: SyncCoordinator["runWithOwnership"] = (config, cancel, onProgress) =>
    start(config, cancel, onProgress, false);

  const close = async (): Promise<void> => {
    closed = true;
    ownedCancel.aborted = true;
    try {
      await active?.promise;
    } catch {
      // The request or watcher that started the run owns its user-facing
      // failure. Shutdown only needs to wait until the worker has released its
      // SQLite connection.
    }
  };

  return { run, runWithOwnership, close };
}

/** Runs one watcher-triggered sync in a worker thread, keeping request
 * handling responsive while multi-second ingests run. */
export async function workerSyncRunner(
  config: Config,
  status: SyncStatusStore,
  cancel: { aborted: boolean },
  onProgress: (progress: SyncProgress) => void,
  runSync: SyncCoordinator["runWithOwnership"] = (workerConfig, workerCancel, workerProgress) => ({
    promise: runSyncWorker(workerConfig, workerCancel, workerProgress),
    owned: true,
  }),
): Promise<SyncRunnerResult | SyncRunnerFailure> {
  status.start();
  const handle = runSync(config, cancel, onProgress);
  try {
    const report = await handle.promise;
    status.finishOk(report);
    return { report, emitTerminal: handle.owned };
  } catch (error) {
    status.finishErr(error instanceof Error ? error.message : String(error));
    return { error, emitTerminal: handle.owned };
  }
}

export function applyWatchEvent(event: WatchEvent, economics: EconomicsCache): void {
  if ("status" in event && event.status != null) {
    syncStatus.last_sync_at = event.status.last_sync_at;
    syncStatus.in_progress = event.status.in_progress;
    syncStatus.last_report = event.status.last_report;
    syncStatus.last_error = event.status.last_error;
    syncStatus.ingested_count = event.status.ingested_count;
  }
  publishServerEvent(event);
  if (event.type === "sync" && (event.report.ingested > 0 || (event.report.repriced ?? 0) > 0)) {
    economics.invalidate();
    publishServerEvent({
      type: "archive_updated",
      reason: event.reason,
      ingested: event.report.ingested,
      last_sync_at: syncStatus.last_sync_at,
    });
  }
}
