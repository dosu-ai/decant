import type { Config } from "./config.ts";
import { closeDb, openDb } from "./db.ts";
import { type SyncProgress, sync } from "./ingest.ts";

type SyncWorkerMessage =
  | { type: "progress"; progress: SyncProgress }
  | { type: "complete"; ok: true; report: ReturnType<typeof sync> }
  | { type: "complete"; ok: false; error: string };

self.addEventListener("message", (event) => {
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
  // Completion means every native SQLite resource has been released. The
  // worker can now close its own event loop without a parent-thread teardown
  // racing the SQLite callback that produced the result.
  self.postMessage(result);
  self.close();
});
