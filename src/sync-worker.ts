import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { closeDb, openDb } from "./db.ts";
import { type SyncOptions, type SyncProgress, sync } from "./ingest.ts";

export interface SyncWorkerSyncOptions {
  candidatePaths?: string[];
  deferDerivedRefresh?: boolean;
  recommendationMinIntervalMs?: number;
}

type SyncWorkerRequest =
  | {
      type: "sync";
      id: number;
      config: Config;
      cancelBuffer: SharedArrayBuffer | null;
      options?: SyncWorkerSyncOptions;
    }
  | { type: "close" }
  | {
      type?: undefined;
      config: Config;
      cancelBuffer: SharedArrayBuffer | null;
      options?: SyncWorkerSyncOptions;
    };

type SyncWorkerMessage =
  | { type: "progress"; id?: number; progress: SyncProgress }
  | {
      type: "complete";
      id?: number;
      ok: true;
      report: ReturnType<typeof sync>;
      changedSessionIds: number[];
      tombstoned: boolean;
    }
  | { type: "complete"; id?: number; ok: false; error: string };

let persistentDb: Database | null = null;
let persistentDbPath: string | null = null;

function closePersistentDb(): void {
  if (persistentDb != null) {
    try {
      closeDb(persistentDb);
    } catch {}
    persistentDb = null;
    persistentDbPath = null;
  }
}

function makeCancel(cancelBuffer: SharedArrayBuffer | null): { aborted: boolean } | undefined {
  const cancelView = cancelBuffer == null ? null : new Int32Array(cancelBuffer);
  return cancelView == null
    ? undefined
    : {
        get aborted(): boolean {
          return Atomics.load(cancelView, 0) !== 0;
        },
      };
}

function runSyncOnDb(
  db: Database,
  config: Config,
  cancelBuffer: SharedArrayBuffer | null,
  options: SyncWorkerSyncOptions | undefined,
  id?: number,
): SyncWorkerMessage {
  const changedSessionIds: number[] = [];
  let tombstoned = false;
  const syncOptions: SyncOptions = {
    ...(options?.candidatePaths != null ? { candidatePaths: options.candidatePaths } : {}),
    ...(options?.deferDerivedRefresh === true ? { deferDerivedRefresh: true } : {}),
    ...(options?.recommendationMinIntervalMs != null
      ? { recommendationMinIntervalMs: options.recommendationMinIntervalMs }
      : {}),
    onSessionChanged: (sessionId) => {
      changedSessionIds.push(sessionId);
    },
    onTombstoned: () => {
      tombstoned = true;
    },
  };
  const report = sync(
    db,
    config,
    makeCancel(cancelBuffer),
    (progress) => {
      self.postMessage(
        id == null
          ? ({ type: "progress", progress } satisfies SyncWorkerMessage)
          : ({ type: "progress", id, progress } satisfies SyncWorkerMessage),
      );
    },
    syncOptions,
  );
  return id == null
    ? { type: "complete", ok: true, report, changedSessionIds, tombstoned }
    : { type: "complete", id, ok: true, report, changedSessionIds, tombstoned };
}

self.addEventListener("message", function onMessage(event) {
  // Dedicated worker: the only sender is the spawning parent thread, whose
  // messages carry an empty origin. Drop anything else.
  if (event.origin !== "") {
    return;
  }
  const request = event.data as SyncWorkerRequest;
  if (request.type === "close") {
    self.removeEventListener("message", onMessage);
    closePersistentDb();
    return;
  }

  if (request.type === "sync") {
    let result: SyncWorkerMessage;
    try {
      if (persistentDb == null || persistentDbPath !== request.config.dbPath) {
        closePersistentDb();
        persistentDb = openDb(request.config.dbPath);
        persistentDbPath = request.config.dbPath;
      }
      result = runSyncOnDb(
        persistentDb,
        request.config,
        request.cancelBuffer,
        request.options,
        request.id,
      );
    } catch (error) {
      closePersistentDb();
      result = {
        type: "complete",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    self.postMessage(result);
    return;
  }

  // Legacy one-shot request: handle one sync, then exit naturally after closing SQLite.
  self.removeEventListener("message", onMessage);
  let db: ReturnType<typeof openDb> | null = null;
  let result: SyncWorkerMessage;
  try {
    db = openDb(request.config.dbPath);
    result = runSyncOnDb(db, request.config, request.cancelBuffer, request.options);
  } catch (error) {
    result = {
      type: "complete",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (db != null) {
      closeDb(db);
    }
  }
  self.postMessage(result);
});
