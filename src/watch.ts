import type { Database } from "bun:sqlite";
import { existsSync, type FSWatcher, mkdirSync, statSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { cursorNativeProjectsDir } from "./cursor-native.ts";
import { openDb } from "./db.ts";
import { sync as ingestSync, type SyncReport } from "./ingest.ts";

export const DEFAULT_SYNC_INTERVAL_MS = 45_000;
export const DEFAULT_DEBOUNCE_MS = 1_500;

export type SyncReason = "startup" | "watch" | "sweep" | "manual";

export interface SyncStatus {
  last_sync_at: string | null;
  in_progress: boolean;
  last_report: string | null;
  last_error: string | null;
  ingested_count: number | null;
  runs: number;
}

export interface SyncEvent {
  type: "sync";
  reason: SyncReason;
  report: SyncReport;
  status: SyncStatus;
}

export interface SyncErrorEvent {
  type: "error";
  reason: SyncReason | "watch";
  error: string;
  status: SyncStatus;
}

export interface WatchReadyEvent {
  type: "ready";
  dirs: string[];
  status: SyncStatus;
}

export interface WatchStoppedEvent {
  type: "stopped";
  status: SyncStatus;
}

export type WatchEvent = SyncEvent | SyncErrorEvent | WatchReadyEvent | WatchStoppedEvent;

export interface WatchOptions {
  config: Config;
  intervalMs?: number;
  debounceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: WatchEvent) => void;
  open?: (path: string) => Database;
  enableWatch?: boolean;
  syncOnStart?: boolean;
  runSync?: (config: Config, cancel: { aborted: boolean }) => SyncReport | Promise<SyncReport>;
}

export interface WatchHandle {
  status: SyncStatusStore;
  dirs: string[];
  refresh(): string[];
  trigger(reason?: SyncReason): void;
  stop(): Promise<void>;
  done: Promise<void>;
}

export class SyncStatusStore {
  #status: SyncStatus = {
    last_sync_at: null,
    in_progress: false,
    last_report: null,
    last_error: null,
    ingested_count: null,
    runs: 0,
  };

  snapshot(): SyncStatus {
    return { ...this.#status };
  }

  start(): void {
    this.#status = { ...this.#status, in_progress: true };
  }

  finishOk(report: SyncReport): SyncStatus {
    this.#status = {
      ...this.#status,
      last_sync_at: new Date().toISOString(),
      in_progress: false,
      last_report: reportSummary(report),
      last_error: null,
      ingested_count: report.ingested,
      runs: this.#status.runs + 1,
    };
    return this.snapshot();
  }

  finishErr(error: string): SyncStatus {
    this.#status = {
      ...this.#status,
      last_sync_at: new Date().toISOString(),
      in_progress: false,
      last_error: error,
      runs: this.#status.runs + 1,
    };
    return this.snapshot();
  }
}

export function watchDirs(config: Config): string[] {
  return [
    config.claudeDir,
    join(config.codexDir, "sessions"),
    join(config.codexDir, "archived_sessions"),
    config.cursorDir,
    config.cursorChatsEnabled ? cursorNativeProjectsDir(config.cursorChatsDir) : null,
  ].filter((dir): dir is string => {
    if (dir == null) {
      return false;
    }
    try {
      return existsSync(dir) && statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

export function runSyncOnce(
  config: Config,
  status: SyncStatusStore = new SyncStatusStore(),
  cancel: { aborted: boolean } = { aborted: false },
  open: (path: string) => Database = openDb,
): SyncReport {
  return runSyncWithStatusSync(status, () => syncArchive(config, cancel, open));
}

function syncArchive(
  config: Config,
  cancel: { aborted: boolean },
  open: (path: string) => Database,
): SyncReport {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = open(config.dbPath);
  try {
    return ingestSync(db, config, cancel);
  } finally {
    db.close();
  }
}

function runSyncWithStatusSync(status: SyncStatusStore, run: () => SyncReport): SyncReport {
  status.start();
  try {
    const report = run();
    status.finishOk(report);
    return report;
  } catch (error) {
    status.finishErr(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function runSyncWithStatus(
  status: SyncStatusStore,
  run: () => SyncReport | Promise<SyncReport>,
): Promise<SyncReport> {
  status.start();
  try {
    const report = await run();
    status.finishOk(report);
    return report;
  } catch (error) {
    status.finishErr(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function startWatch(options: WatchOptions): WatchHandle {
  const status = new SyncStatusStore();
  let dirs = watchDirs(options.config);
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const open = options.open ?? openDb;
  const enableWatch = options.enableWatch !== false;
  const syncOnStart = options.syncOnStart !== false;
  const cancel = { aborted: false };
  const runSync =
    options.runSync ??
    ((config: Config, state: { aborted: boolean }) => syncArchive(config, state, open));
  const watchers = new Map<string, FSWatcher>();
  let stopped = false;
  let debounceTimer: Timer | null = null;
  let intervalTimer: Timer | null = null;
  let running = false;
  let pendingReason: SyncReason | null = null;
  let activeRun = Promise.resolve();
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const emit = (event: WatchEvent): void => options.onEvent?.(event);

  const closeWatcher = (dir: string): void => {
    const watcher = watchers.get(dir);
    if (watcher == null) {
      return;
    }
    watcher.close();
    watchers.delete(dir);
  };

  const openWatcher = (dir: string): void => {
    if (watchers.has(dir)) {
      return;
    }
    try {
      const watcher = watch(dir, { recursive: true }, (eventType) => {
        if (eventType === "rename" || eventType === "change") {
          schedule("watch", debounceMs);
        }
      });
      watcher.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", reason: "watch", error: message, status: status.snapshot() });
      });
      watchers.set(dir, watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", reason: "watch", error: message, status: status.snapshot() });
    }
  };

  const refresh = (): string[] => {
    const next = watchDirs(options.config);
    if (enableWatch) {
      const wanted = new Set(next);
      for (const dir of watchers.keys()) {
        if (!wanted.has(dir)) {
          closeWatcher(dir);
        }
      }
      for (const dir of next) {
        openWatcher(dir);
      }
    }
    dirs = next;
    return [...dirs];
  };

  const requestRun = (reason: SyncReason): void => {
    if (running) {
      pendingReason = reason;
      return;
    }
    activeRun = run(reason);
  };

  const schedule = (reason: SyncReason, delay: number): void => {
    if (stopped) {
      return;
    }
    if (delay > 0) {
      if (debounceTimer != null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        requestRun(reason);
      }, delay);
      return;
    }
    requestRun(reason);
  };

  const run = async (reason: SyncReason): Promise<void> => {
    if (stopped) {
      return;
    }
    if (running) {
      pendingReason = reason;
      return;
    }
    running = true;
    let nextReason: SyncReason | null = reason;
    try {
      while (nextReason != null && !stopped) {
        const current = nextReason;
        nextReason = null;
        pendingReason = null;
        try {
          const report = await runSyncWithStatus(status, () => runSync(options.config, cancel));
          emit({ type: "sync", reason: current, report, status: status.snapshot() });
        } catch (error) {
          emit({
            type: "error",
            reason: current,
            error: error instanceof Error ? error.message : String(error),
            status: status.snapshot(),
          });
        }
        nextReason = pendingReason;
      }
    } finally {
      running = false;
    }
  };

  const stop = async (): Promise<void> => {
    if (stopped) {
      await activeRun;
      return;
    }
    stopped = true;
    cancel.aborted = true;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (intervalTimer != null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
    await activeRun;
    emit({ type: "stopped", status: status.snapshot() });
    resolveDone?.();
  };

  if (enableWatch) {
    refresh();
  }

  if (intervalMs > 0) {
    intervalTimer = setInterval(() => schedule("sweep", 0), intervalMs);
  }

  const abort = (): void => {
    void stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  emit({ type: "ready", dirs, status: status.snapshot() });
  if (syncOnStart) {
    schedule("startup", 0);
  }

  if (options.signal?.aborted === true) {
    void stop();
  }

  const handle: WatchHandle = {
    status,
    get dirs() {
      return [...dirs];
    },
    refresh,
    trigger(reason = "manual") {
      schedule(reason, 0);
    },
    stop,
    done,
  };

  void done.then(() => options.signal?.removeEventListener("abort", abort));

  return handle;
}

function reportSummary(report: SyncReport): string {
  return (
    `scanned ${report.scanned}, ingested ${report.ingested}, skipped ${report.skipped}, ` +
    `issues ${report.issues}, failed ${report.failed}${report.cancelled ? ", cancelled" : ""}`
  );
}
