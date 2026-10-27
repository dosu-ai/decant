import type { Database } from "bun:sqlite";
import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
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
/** An agent mid-run can append to its log faster than the debounce window, and
 * each event restarts the window, so without a cap its session stays out of
 * the archive until it pauses or the sweep runs. */
export const DEFAULT_DEBOUNCE_MAX_WAIT_MS = 5_000;
/** OpenCode's live appends raise no file event (see `openCodeEvents`), so its
 * databases are also checked by file signature on this interval. */
export const DEFAULT_OPENCODE_POLL_MS = 2_000;

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
  /** Longest a burst of events can hold off a sync. It is never shorter than
   * debounceMs. */
  debounceMaxWaitMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: WatchEvent) => void;
  open?: (path: string) => Database;
  enableWatch?: boolean;
  /** How often to check OpenCode databases by file signature; 0 disables the
   * poll. It runs whether or not native watching is enabled, and only when an
   * OpenCode root exists. */
  openCodePollMs?: number;
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
  /** Present on roots holding OpenCode databases: re-stats them against the
   * same baseline `accepts` keeps, and reports whether any changed. */
  poll?: () => boolean;
}

type EventFilter = (filename: string | null) => boolean;

const anyEvent: EventFilter = () => true;

/**
 * Events beside an OpenCode database warrant a sync only when the database or
 * its `-wal` actually changed. Every connection that opens the database,
 * Decant's own read-only sync included, rewrites the `-shm` index, so reacting
 * to the event alone would loop forever. Events are also incomplete: on macOS
 * a writer that keeps its connection open, as a running OpenCode does, raises
 * an event for its first commit and for its checkpoint or close, but later
 * `-wal` appends raise none at all. So any event naming a database or one of
 * its sidecars is only a hint that re-stats the database and `-wal` and
 * compares against the last size and mtime seen; a read never moves either.
 * The watcher's poll calls the same filter with a null filename on an
 * interval, which re-checks every database in the directory, so a change seen
 * by either path updates the one baseline and is synced once. Everything else
 * in the directory (logs, snapshots, journals, subdirectories) is ignored.
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
  const explicitDb = explicitOpenCodeDb(config);
  const candidates: {
    dir: string;
    recursive: boolean;
    /** OpenCode databases, whose filter the watcher also polls. */
    polled?: boolean;
    accepts: () => EventFilter;
  }[] = [
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
      polled: true,
      accepts: () => openCodeEvents(config.opencodeDir, isOpenCodeDatabaseName),
    },
    ...(explicitDb != null
      ? [
          {
            dir: dirname(explicitDb),
            recursive: false,
            polled: true,
            accepts: () =>
              openCodeEvents(dirname(explicitDb), (name) => name === basename(explicitDb)),
          },
        ]
      : []),
  ];
  // One watcher per directory: a directory named twice reacts to the events
  // either source would, and recurses if either needs it.
  const roots = new Map<
    string,
    { recursive: boolean; filters: { polled: boolean; make: () => EventFilter }[] }
  >();
  for (const candidate of candidates) {
    const filter = { polled: candidate.polled === true, make: candidate.accepts };
    const root = roots.get(candidate.dir);
    if (root == null) {
      roots.set(candidate.dir, { recursive: candidate.recursive, filters: [filter] });
    } else {
      root.recursive ||= candidate.recursive;
      root.filters.push(filter);
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
      const built = filters.map(({ polled, make }) => ({ polled, accept: make() }));
      // Every filter sees every event so each keeps its baseline current.
      const anyOf = (accepts: EventFilter[], filename: string | null): boolean =>
        accepts.reduce((any, accept) => accept(filename) || any, false);
      const all = built.map(({ accept }) => accept);
      const polled = built.filter((filter) => filter.polled).map(({ accept }) => accept);
      return {
        dir,
        recursive,
        accepts: (filename: string | null) => anyOf(all, filename),
        // A null filename re-checks every database the filter tracks.
        ...(polled.length > 0 ? { poll: () => anyOf(polled, null) } : {}),
      };
    });
}

/** OPENCODE_DB resolved through symlinks, so the watcher sits in the directory
 * the writer actually touches and matches the file names it reports. Falls
 * back to the configured path when it cannot be resolved (not created yet). */
function explicitOpenCodeDb(config: Config): string | null {
  if (config.opencodeDb == null || config.opencodeDb === "") {
    return null;
  }
  try {
    return realpathSync(config.opencodeDb);
  } catch {
    return config.opencodeDb;
  }
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
  const debounceMaxWaitMs = Math.max(
    options.debounceMaxWaitMs ?? DEFAULT_DEBOUNCE_MAX_WAIT_MS,
    debounceMs,
  );
  const open = options.open ?? openDb;
  const runner: SyncRunner =
    options.runner ??
    (async (config, syncStatus, cancelFlag, onProgress) =>
      runSyncOnce(config, syncStatus, cancelFlag, open, onProgress));
  const enableWatch = options.enableWatch !== false;
  const openCodePollMs = options.openCodePollMs ?? DEFAULT_OPENCODE_POLL_MS;
  const syncOnStart = options.syncOnStart !== false;
  const cancel = { aborted: false };
  const watchers: FSWatcher[] = [];
  let stopped = false;
  let debounceTimer: Timer | null = null;
  let debounceDeadline: number | null = null;
  let intervalTimer: Timer | null = null;
  let pollTimer: Timer | null = null;
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
      const now = Date.now();
      debounceDeadline ??= now + debounceMaxWaitMs;
      debounceTimer = setTimeout(
        () => {
          debounceTimer = null;
          debounceDeadline = null;
          requestRun(reason);
        },
        Math.max(0, Math.min(delay, debounceDeadline - now)),
      );
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
      debounceDeadline = null;
    }
    if (intervalTimer != null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    if (pollTimer != null) {
      clearInterval(pollTimer);
      pollTimer = null;
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

  // Stat-only: the poll never opens a database, so it cannot disturb -shm or
  // trigger itself. It shares each root's baseline with the event filter, so
  // a change either path sees first is synced once.
  const polls = roots.flatMap((root) => (root.poll != null ? [root.poll] : []));
  if (openCodePollMs > 0 && polls.length > 0) {
    pollTimer = setInterval(() => {
      if (polls.reduce((any, poll) => poll() || any, false)) {
        schedule("watch", debounceMs);
      }
    }, openCodePollMs);
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
