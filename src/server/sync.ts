import type { Config } from "../config.ts";
import type { EconomicsCache } from "../economics-cache.ts";
import type { sync as ingestSync, SyncOptions, SyncProgress, SyncReport } from "../ingest.ts";
import type { SyncWorkerSyncOptions } from "../sync-worker.ts";
import type {
  SyncReason,
  SyncRunnerFailure,
  SyncRunnerResult,
  SyncStatusStore,
  WatchEvent,
} from "../watch.ts";
import { workerError, workerUrl } from "../worker-runtime.ts";
import type { Db } from "./context.ts";
import { json } from "./http.ts";
import { publishServerEvent } from "./sse.ts";

export type SyncWorkerRunner = (
  config: Config,
  cancel?: { aborted: boolean },
  onProgress?: (progress: SyncProgress) => void,
  syncOptions?: SyncOptions,
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
    syncOptions?: SyncOptions,
  ): SyncRunHandle;
  close(): Promise<void>;
}

export interface SyncCoordinatorOptions {
  progressEveryFiles?: number;
  progressEveryMs?: number;
  now?: () => number;
  onProgress?: (progress: SyncProgress) => void;
  onCompleted?: (report: SyncReport) => void;
}

interface SyncReportMeta {
  sessionIds: number[];
  tombstoned: boolean;
}

const syncReportMeta = new WeakMap<SyncReport, SyncReportMeta>();

export const syncStatus = {
  last_sync_at: null as string | null,
  in_progress: false,
  last_report: null as string | null,
  last_error: null as string | null,
  ingested_count: null as number | null,
};

const syncActivity = {
  reason: null as SyncReason | null,
  progress: null as SyncProgress | null,
  archiveSynced: true,
};

export function noteArchiveOpened(db: Db): void {
  const row = db
    .query<{ synced: number }, []>(
      "SELECT EXISTS(SELECT 1 FROM ingest_source) OR EXISTS(SELECT 1 FROM session) AS synced",
    )
    .get();
  syncActivity.archiveSynced = row?.synced === 1;
  syncActivity.reason = null;
  syncActivity.progress = null;
}

function endSyncActivity(report?: SyncReport): void {
  syncActivity.reason = null;
  syncActivity.progress = null;
  if (report != null && !report.cancelled) {
    syncActivity.archiveSynced = true;
  }
}

export function syncStatusBody() {
  return {
    ...syncStatus,
    reason: syncStatus.in_progress ? syncActivity.reason : null,
    progress: syncStatus.in_progress ? syncActivity.progress : null,
    archive_synced: syncActivity.archiveSynced,
    timestamp: new Date().toISOString(),
  };
}

function refreshEconomicsForReport(
  economics: EconomicsCache | undefined,
  report: SyncReport,
): void {
  if (economics == null) {
    return;
  }
  const meta = syncReportMeta.get(report);
  if (
    meta != null &&
    !meta.tombstoned &&
    (report.repriced ?? 0) === 0 &&
    meta.sessionIds.length > 0 &&
    typeof economics.refreshSessions === "function"
  ) {
    economics.refreshSessions(meta.sessionIds);
  } else {
    economics.invalidate();
  }
}

export async function syncNow(
  config: Config,
  economics?: EconomicsCache,
  runSync: SyncWorkerRunner = (workerConfig, cancel, onProgress, syncOptions) =>
    runSyncWorker(workerConfig, cancel, onProgress, {}, syncOptions),
  runWithOwnership?: SyncCoordinator["runWithOwnership"],
): Promise<Response> {
  const progress = (update: SyncProgress): void => {
    syncActivity.reason = "manual";
    syncActivity.progress = update;
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
    endSyncActivity(report);
    publishServerEvent({ type: "sync", reason: "manual", report, status: { ...syncStatus } });
    if (report.ingested > 0 || (report.repriced ?? 0) > 0) {
      refreshEconomicsForReport(economics, report);
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
      endSyncActivity();
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

// Bun cannot interrupt a worker inside a native SQLite call, so terminate()
// takes effect once the current statement returns. SQLite rolls back the
// worker's uncommitted transaction when its connection is torn down.
export const SYNC_WORKER_CANCEL_GRACE_MS = 5_000;
const CANCEL_POLL_MS = 150;
const WORKER_CLOSE_TIMEOUT_MS = 2_000;

export class SyncWorkerStopTimeoutError extends Error {
  constructor(graceMs: number) {
    super(`sync worker did not stop within ${graceMs}ms of cancellation`);
    this.name = "SyncWorkerStopTimeoutError";
  }
}

export interface SyncWorkerOptions {
  cancelGraceMs?: number;
  spawn?: () => Worker;
}

function toWorkerSyncOptions(syncOptions?: SyncOptions): SyncWorkerSyncOptions | undefined {
  if (syncOptions == null) {
    return undefined;
  }
  return {
    ...(syncOptions.candidatePaths != null
      ? { candidatePaths: [...syncOptions.candidatePaths] }
      : {}),
    ...(syncOptions.deferDerivedRefresh === true ? { deferDerivedRefresh: true } : {}),
    ...(syncOptions.recommendationMinIntervalMs != null
      ? { recommendationMinIntervalMs: syncOptions.recommendationMinIntervalMs }
      : {}),
  };
}

export function runSyncWorker(
  config: Config,
  cancel?: { aborted: boolean },
  onProgress?: (progress: SyncProgress) => void,
  options: SyncWorkerOptions = {},
  syncOptions?: SyncOptions,
): Promise<ReturnType<typeof ingestSync>> {
  const graceMs = Math.max(0, options.cancelGraceMs ?? SYNC_WORKER_CANCEL_GRACE_MS);
  return new Promise((resolve, reject) => {
    const worker = options.spawn?.() ?? new Worker(workerUrl("sync-worker.ts"), { type: "module" });
    const cancelView =
      cancel == null ? null : new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    let cancelPoll: Timer | null = null;
    let stopDeadline: Timer | null = null;
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (cancelPoll != null) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
      if (stopDeadline != null) {
        clearTimeout(stopDeadline);
        stopDeadline = null;
      }
      outcome();
    };
    const forwardCancel = (): void => {
      if (cancel?.aborted !== true || cancelView == null || stopDeadline != null || settled) {
        return;
      }
      Atomics.store(cancelView, 0, 1);
      if (cancelPoll != null) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
      stopDeadline = setTimeout(() => {
        finish(() => reject(new SyncWorkerStopTimeoutError(graceMs)));
        worker.terminate();
      }, graceMs);
    };
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { type: "progress"; progress: SyncProgress }
        | {
            type: "complete";
            ok: true;
            report: ReturnType<typeof ingestSync>;
            changedSessionIds?: number[];
            tombstoned?: boolean;
          }
        | { type: "complete"; ok: false; error: string };
      if (data.type === "progress") {
        if (!settled) {
          onProgress?.(data.progress);
        }
        return;
      }
      finish(() => {
        if (data.ok) {
          if (data.changedSessionIds != null) {
            syncReportMeta.set(data.report, {
              sessionIds: data.changedSessionIds,
              tombstoned: data.tombstoned === true,
            });
          }
          resolve(data.report);
        } else {
          reject(new Error(data.error));
        }
      });
    });
    worker.addEventListener("error", (event) => {
      finish(() => reject(workerError(event, "sync worker failed")));
    });
    worker.addEventListener("close", (event) => {
      const code = (event as Event & { code?: number }).code ?? "unknown";
      finish(() => reject(new Error(`sync worker exited with code ${code} before reporting`)));
    });
    if (cancel != null) {
      forwardCancel();
      if (stopDeadline == null) {
        cancelPoll = setInterval(forwardCancel, CANCEL_POLL_MS);
      }
    }
    const workerOpts = toWorkerSyncOptions(syncOptions);
    worker.postMessage({
      config,
      cancelBuffer: cancelView?.buffer ?? null,
      ...(workerOpts != null ? { options: workerOpts } : {}),
    });
  });
}

class PersistentSyncWorker {
  #worker: Worker | null = null;
  #exited: PromiseWithResolvers<void> | null = null;
  #nextId = 0;
  #active: {
    id: number;
    onProgress?: (progress: SyncProgress) => void;
    finish: (outcome: () => void) => void;
  } | null = null;
  #closing = false;

  run(
    config: Config,
    cancel?: { aborted: boolean },
    onProgress?: (progress: SyncProgress) => void,
    syncOptions?: SyncOptions,
  ): Promise<ReturnType<typeof ingestSync>> {
    if (this.#closing) {
      return Promise.reject(new Error("sync worker is closed"));
    }
    const graceMs = SYNC_WORKER_CANCEL_GRACE_MS;
    const worker = this.#ensureWorker();
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const cancelView =
        cancel == null ? null : new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      let cancelPoll: Timer | null = null;
      let stopDeadline: Timer | null = null;
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.#active?.id === id) {
          this.#active = null;
        }
        if (cancelPoll != null) {
          clearInterval(cancelPoll);
          cancelPoll = null;
        }
        if (stopDeadline != null) {
          clearTimeout(stopDeadline);
          stopDeadline = null;
        }
        outcome();
      };
      const forwardCancel = (): void => {
        if (cancel?.aborted !== true || cancelView == null || stopDeadline != null || settled) {
          return;
        }
        Atomics.store(cancelView, 0, 1);
        if (cancelPoll != null) {
          clearInterval(cancelPoll);
          cancelPoll = null;
        }
        stopDeadline = setTimeout(() => {
          finish(() => reject(new SyncWorkerStopTimeoutError(graceMs)));
          this.#dropWorker(worker, true);
        }, graceMs);
      };

      this.#active = { id, onProgress, finish };
      this.#resolveActive = (report) => finish(() => resolve(report));
      this.#rejectActive = (error) => finish(() => reject(error));
      if (cancel != null) {
        forwardCancel();
        if (stopDeadline == null) {
          cancelPoll = setInterval(forwardCancel, CANCEL_POLL_MS);
        }
      }
      const workerOpts = toWorkerSyncOptions(syncOptions);
      try {
        worker.postMessage({
          type: "sync",
          id,
          config,
          cancelBuffer: cancelView?.buffer ?? null,
          ...(workerOpts != null ? { options: workerOpts } : {}),
        });
      } catch (error) {
        this.#resolveActive = null;
        this.#rejectActive = null;
        this.#dropWorker(worker, true);
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  #resolveActive: ((report: ReturnType<typeof ingestSync>) => void) | null = null;
  #rejectActive: ((error: Error) => void) | null = null;

  async close(): Promise<void> {
    this.#closing = true;
    const worker = this.#worker;
    if (worker == null) {
      return;
    }
    const exited = this.#exited ?? Promise.withResolvers<void>();
    this.#exited = exited;
    let timer: Timer | null = null;
    try {
      worker.postMessage({ type: "close" });
      await Promise.race([
        exited.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, WORKER_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch {
    } finally {
      if (timer != null) {
        clearTimeout(timer);
      }
      if (this.#worker === worker) {
        this.#dropWorker(worker, true);
      }
    }
  }

  #ensureWorker(): Worker {
    if (this.#worker != null) {
      return this.#worker;
    }
    const worker = new Worker(workerUrl("sync-worker.ts"), { type: "module" });
    this.#worker = worker;
    this.#exited = Promise.withResolvers<void>();
    worker.addEventListener("message", (event) => {
      if (this.#worker !== worker) {
        return;
      }
      const data = event.data as
        | { type: "progress"; id?: number; progress: SyncProgress }
        | {
            type: "complete";
            id?: number;
            ok: true;
            report: ReturnType<typeof ingestSync>;
            changedSessionIds?: number[];
            tombstoned?: boolean;
          }
        | { type: "complete"; id?: number; ok: false; error: string };
      if (data.type === "progress") {
        if (this.#active != null && (data.id == null || data.id === this.#active.id)) {
          this.#active.onProgress?.(data.progress);
        }
        return;
      }
      if (this.#active != null && (data.id == null || data.id === this.#active.id)) {
        const resolve = this.#resolveActive;
        const reject = this.#rejectActive;
        this.#resolveActive = null;
        this.#rejectActive = null;
        if (data.ok) {
          if (data.changedSessionIds != null) {
            syncReportMeta.set(data.report, {
              sessionIds: data.changedSessionIds,
              tombstoned: data.tombstoned === true,
            });
          }
          resolve?.(data.report);
        } else {
          reject?.(new Error(data.error));
        }
      }
    });
    worker.addEventListener("error", (event) => {
      const error = workerError(event, "sync worker failed");
      this.#dropWorker(worker, true);
      const reject = this.#rejectActive;
      this.#resolveActive = null;
      this.#rejectActive = null;
      reject?.(error);
    });
    worker.addEventListener("close", (event) => {
      this.#exited?.resolve();
      const code = (event as Event & { code?: number }).code ?? "unknown";
      this.#dropWorker(worker, false);
      const reject = this.#rejectActive;
      this.#resolveActive = null;
      this.#rejectActive = null;
      reject?.(new Error(`sync worker exited with code ${code} before reporting`));
    });
    return worker;
  }

  #dropWorker(worker: Worker, terminate: boolean): void {
    if (this.#worker === worker) {
      this.#worker = null;
    }
    if (terminate) {
      try {
        worker.terminate();
      } catch {}
    }
  }
}

export function createSyncCoordinator(
  worker?: SyncWorkerRunner,
  options: SyncCoordinatorOptions = {},
): SyncCoordinator {
  const persistentWorker = worker == null ? new PersistentSyncWorker() : null;
  const runWorker: SyncWorkerRunner =
    worker ??
    ((config, cancel, onProgress, syncOptions) => {
      if (persistentWorker == null) {
        throw new Error("Persistent sync worker is unavailable");
      }
      return persistentWorker.run(config, cancel, onProgress, syncOptions);
    });
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
    syncOptions?: SyncOptions,
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
      runIsolated(() => options.onProgress?.(progress));
      for (const listener of [...listeners]) {
        runIsolated(() => listener(progress));
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
      .then(() => runWorker(config, sharedCancel, forward, syncOptions))
      .then(
        (report) => {
          flush();
          runIsolated(() => options.onCompleted?.(report));
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
  const run: SyncWorkerRunner = (config, cancel, onProgress, syncOptions) =>
    start(config, cancel, onProgress, true, syncOptions).promise;
  const runWithOwnership: SyncCoordinator["runWithOwnership"] = (
    config,
    cancel,
    onProgress,
    syncOptions,
  ) => start(config, cancel, onProgress, false, syncOptions);

  const close = async (): Promise<void> => {
    closed = true;
    ownedCancel.aborted = true;
    try {
      await active?.promise;
    } catch {}
    await persistentWorker?.close();
  };

  return { run, runWithOwnership, close };
}

export async function workerSyncRunner(
  config: Config,
  status: SyncStatusStore,
  cancel: { aborted: boolean },
  onProgress: (progress: SyncProgress) => void,
  runSync: SyncCoordinator["runWithOwnership"] = (
    workerConfig,
    workerCancel,
    workerProgress,
    workerSyncOptions,
  ) => ({
    promise: runSyncWorker(workerConfig, workerCancel, workerProgress, {}, workerSyncOptions),
    owned: true,
  }),
  syncOptions?: SyncOptions,
): Promise<SyncRunnerResult | SyncRunnerFailure> {
  status.start();
  syncStatus.in_progress = true;
  const handle = runSync(config, cancel, onProgress, syncOptions);
  try {
    const report = await handle.promise;
    status.finishOk(report);
    return { report, emitTerminal: handle.owned };
  } catch (error) {
    status.finishErr(error instanceof Error ? error.message : String(error));
    return { error, emitTerminal: handle.owned };
  } finally {
    if (!handle.owned) {
      syncStatus.in_progress = false;
    }
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
  if (event.type === "sync_progress") {
    syncActivity.reason = event.reason;
    syncActivity.progress = event.progress;
  } else if (!syncStatus.in_progress) {
    endSyncActivity(event.type === "sync" ? event.report : undefined);
  }
  publishServerEvent(event);
  if (event.type === "sync" && (event.report.ingested > 0 || (event.report.repriced ?? 0) > 0)) {
    refreshEconomicsForReport(economics, event.report);
    publishServerEvent({
      type: "archive_updated",
      reason: event.reason,
      ingested: event.report.ingested,
      last_sync_at: syncStatus.last_sync_at,
    });
  }
}

function runIsolated(observer: () => void): void {
  try {
    observer();
  } catch {}
}
