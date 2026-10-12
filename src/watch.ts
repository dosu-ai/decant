import type { Database } from "bun:sqlite";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, statSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { ARCHIVE_DIR_MODE, closeDb, openDb } from "./db.ts";
import {
  sync as ingestSync,
  isOpenCodeDatabaseName,
  type SyncProgress,
  type SyncReport,
} from "./ingest.ts";

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

export interface SyncProgressEvent {
  type: "sync_progress";
  reason: SyncReason;
  progress: SyncProgress;
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

export type WatchEvent =
  | SyncEvent
  | SyncProgressEvent
  | SyncErrorEvent
  | WatchReadyEvent
  | WatchStoppedEvent;

export type SyncRunner = (
  config: Config,
  status: SyncStatusStore,
  cancel: { aborted: boolean },
  onProgress: (progress: SyncProgress) => void,
) => Promise<SyncReport | SyncRunnerResult | SyncRunnerFailure>;

export interface SyncRunnerResult {
  report: SyncReport;
  /** False when this watcher joined a run whose terminal events have another owner. */
  emitTerminal: boolean;
}

export interface SyncRunnerFailure {
  error: unknown;
  /** False when this watcher joined a run whose terminal events have another owner. */
  emitTerminal: boolean;
}

export interface WatchOptions {
  config: Config;
  intervalMs?: number;
  debounceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: WatchEvent) => void;
  open?: (path: string) => Database;
  enableWatch?: boolean;
  syncOnStart?: boolean;
  /**
   * How to execute one sync. Defaults to the in-process runSyncOnce; servers
   * pass a worker-backed runner so multi-second ingests cannot stall the
   * request event loop.
   */
  runner?: SyncRunner;
}

export interface WatchHandle {
  status: SyncStatusStore;
  dirs: string[];
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

/** A watched directory and the change events in it that warrant a sync. */
export interface WatchRoot {
  dir: string;
  /** Watch subdirectories too. Off for OpenCode-only roots, whose log/,
   * snapshot/, and storage/ trees never hold a database Decant reads. */
  recursive: boolean;
  /** `filename` is the event path relative to `dir`, or null when the
   * platform does not report one. */
  accepts(filename: string | null): boolean;
}

type EventFilter = (filename: string | null) => boolean;

const anyEvent: EventFilter = () => true;

/**
 * Events beside an OpenCode database warrant a sync only when the database or
 * its `-wal` actually changed. Every connection that opens the database,
 * Decant's own read-only sync included, rewrites the `-shm` index, so reacting
 * to the event alone would loop forever. The `-shm` event is still a useful
 * hint: with Bun's macOS watcher, a writer's `-wal` appends after its first
 * commit surface only as `-shm` changes. So any event naming a database or one of its sidecars re-stats the
 * database and `-wal` and compares against the last size and mtime seen; a
 * read never moves either. Everything else in the directory (logs, snapshots,
 * journals, subdirectories) is ignored. A null filename re-checks every
 * database in the directory the same way, so it can neither loop nor drop a
 * write.
 */
function openCodeEvents(dir: string, isDatabase: (name: string) => boolean): EventFilter {
  const seen = new Map<string, string>();
  const databases = (): string[] => {
    try {
      return readdirSync(dir).filter(isDatabase);
    } catch {
      return [];
    }
  };
  const changed = (name: string): boolean => {
    const signature = databaseSignature(join(dir, name));
    if (seen.get(name) === signature) {
      return false;
    }
    seen.set(name, signature);
    return true;
  };
  for (const name of databases()) {
    seen.set(name, databaseSignature(join(dir, name)));
  }
  return (filename) => {
    if (filename == null) {
      let any = false;
      for (const name of databases()) {
        any = changed(name) || any;
      }
      return any;
    }
    if (filename.includes("/") || filename.includes("\\")) {
      return false;
    }
    const name = databaseFor(filename, isDatabase);
    return name != null && changed(name);
  };
}

function databaseFor(filename: string, isDatabase: (name: string) => boolean): string | null {
  if (isDatabase(filename)) {
    return filename;
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (filename.endsWith(suffix) && isDatabase(filename.slice(0, -suffix.length))) {
      return filename.slice(0, -suffix.length);
    }
  }
  return null;
}

function databaseSignature(path: string): string {
  return `${fileSignature(path)}|${fileSignature(`${path}-wal`)}`;
}

function fileSignature(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "-";
  }
}

export function watchRoots(config: Config): WatchRoot[] {
  const explicitDb =
    config.opencodeDb != null && config.opencodeDb !== "" ? config.opencodeDb : null;
  const candidates: { dir: string; recursive: boolean; accepts: () => EventFilter }[] = [
    { dir: config.claudeDir, recursive: true, accepts: () => anyEvent },
    { dir: join(config.codexDir, "sessions"), recursive: true, accepts: () => anyEvent },
    {
      dir: join(config.codexDir, "archived_sessions"),
      recursive: true,
      accepts: () => anyEvent,
    },
    ...(config.geminiDir != null
      ? [{ dir: config.geminiDir, recursive: true, accepts: () => anyEvent }]
      : []),
    {
      dir: config.opencodeDir,
      recursive: false,
      accepts: () => openCodeEvents(config.opencodeDir, isOpenCodeDatabaseName),
    },
    ...(explicitDb != null
      ? [
          {
            dir: dirname(explicitDb),
            recursive: false,
            accepts: () =>
              openCodeEvents(dirname(explicitDb), (name) => name === basename(explicitDb)),
          },
        ]
      : []),
  ];
  // One watcher per directory: a directory named twice reacts to the events
  // either source would, and recurses if either needs it.
  const roots = new Map<string, { recursive: boolean; filters: (() => EventFilter)[] }>();
  for (const candidate of candidates) {
    const root = roots.get(candidate.dir);
    if (root == null) {
      roots.set(candidate.dir, { recursive: candidate.recursive, filters: [candidate.accepts] });
    } else {
      root.recursive ||= candidate.recursive;
      root.filters.push(candidate.accepts);
    }
  }
  return [...roots]
    .filter(([dir]) => {
      try {
        return existsSync(dir) && statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .map(([dir, { recursive, filters }]) => {
      // Built only for existing directories, so the baseline stat runs once.
      const accepts = filters.map((make) => make());
      return {
        dir,
        recursive,
        // Every filter sees every event so each keeps its baseline current.
        accepts: (filename: string | null) =>
          accepts.reduce((any, accept) => accept(filename) || any, false),
      };
    });
}

export function watchDirs(config: Config): string[] {
  return watchRoots(config).map((root) => root.dir);
}

export function runSyncOnce(
  config: Config,
  status: SyncStatusStore = new SyncStatusStore(),
  cancel: { aborted: boolean } = { aborted: false },
  open: (path: string) => Database = openDb,
  onProgress?: (progress: SyncProgress) => void,
): SyncReport {
  status.start();
  let db: Database | null = null;
  try {
    mkdirSync(dirname(config.dbPath), { recursive: true, mode: ARCHIVE_DIR_MODE });
    db = open(config.dbPath);
    const report = ingestSync(db, config, cancel, onProgress);
    status.finishOk(report);
    return report;
  } catch (error) {
    status.finishErr(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (db != null) {
      closeDb(db);
    }
  }
}

export function startWatch(options: WatchOptions): WatchHandle {
  const status = new SyncStatusStore();
  const roots = watchRoots(options.config);
  const dirs = roots.map((root) => root.dir);
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const open = options.open ?? openDb;
  const runner: SyncRunner =
    options.runner ??
    (async (config, syncStatus, cancelFlag, onProgress) =>
      runSyncOnce(config, syncStatus, cancelFlag, open, onProgress));
  const enableWatch = options.enableWatch !== false;
  const syncOnStart = options.syncOnStart !== false;
  const cancel = { aborted: false };
  const watchers: FSWatcher[] = [];
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
          const result = await runner(options.config, status, cancel, (progress) => {
            emit({ type: "sync_progress", reason: current, progress, status: status.snapshot() });
          });
          if ("error" in result) {
            if (result.emitTerminal) {
              emit({
                type: "error",
                reason: current,
                error: result.error instanceof Error ? result.error.message : String(result.error),
                status: status.snapshot(),
              });
            }
          } else {
            const { report, emitTerminal } =
              "report" in result ? result : { report: result, emitTerminal: true };
            if (emitTerminal) {
              emit({ type: "sync", reason: current, report, status: status.snapshot() });
            }
          }
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
    for (const watcher of watchers) {
      watcher.close();
    }
    await activeRun;
    emit({ type: "stopped", status: status.snapshot() });
    resolveDone?.();
  };

  if (enableWatch) {
    for (const root of roots) {
      try {
        const watcher = watch(root.dir, { recursive: root.recursive }, (eventType, filename) => {
          if ((eventType === "rename" || eventType === "change") && root.accepts(filename)) {
            schedule("watch", debounceMs);
          }
        });
        watcher.on("error", (error) => {
          const message = error instanceof Error ? error.message : String(error);
          emit({ type: "error", reason: "watch", error: message, status: status.snapshot() });
        });
        watchers.push(watcher);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit({ type: "error", reason: "watch", error: message, status: status.snapshot() });
      }
    }
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
    dirs,
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
