import type { Config } from "./config.ts";
import { closeDb, openDb } from "./db.ts";
import { type SyncProgress, sync } from "./ingest.ts";

type SyncWorkerMessage =
  | { type: "progress"; progress: SyncProgress }
  | { type: "complete"; ok: true; report: ReturnType<typeof sync> }
  | { type: "complete"; ok: false; error: string };

self.addEventListener("message", function onMessage(event) {
  // Dedicated worker: the only sender is the spawning parent thread, whose
  // messages carry an empty origin. Drop anything else.
  if (event.origin !== "") {
    return;
  }
  // Bun keeps a worker alive while its global message listener is attached.
  // This worker handles one request, then exits naturally after closing SQLite.
  self.removeEventListener("message", onMessage);
  const { config, cancelBuffer } = event.data as {
    config: Config;
    cancelBuffer: SharedArrayBuffer | null;
  };
  const cancelView = cancelBuffer == null ? null : new Int32Array(cancelBuffer);
  const cancel =
    cancelView == null
      ? undefined
      : {
          get aborted(): boolean {
            return Atomics.load(cancelView, 0) !== 0;
          },
        };
  let db: ReturnType<typeof openDb> | null = null;
  let result: SyncWorkerMessage;
  try {
    db = openDb(config.dbPath);
    const report = sync(db, config, cancel, (progress) => {
      self.postMessage({ type: "progress", progress } satisfies SyncWorkerMessage);
    });
    result = { type: "complete", ok: true, report };
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
  // Completion means every native SQLite resource has been released. Return
  // to the drained event loop rather than racing a parent-thread termination.
  self.postMessage(result);
});
