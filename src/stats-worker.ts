import { Database } from "bun:sqlite";
import { closeDb } from "./db.ts";
import { computeSessionEconomicsVectors } from "./token-economics.ts";

self.addEventListener("message", (event) => {
  const { dbPath, cancelBuffer } = event.data as {
    dbPath: string;
    cancelBuffer: SharedArrayBuffer | null;
  };
  const cancelView = cancelBuffer == null ? null : new Int32Array(cancelBuffer);
  const cancelled = (): boolean => cancelView != null && Atomics.load(cancelView, 0) !== 0;
  let db: Database | null = null;
  let result:
    | { ok: true; vectors: ReturnType<typeof computeSessionEconomicsVectors> }
    | { ok: false; error: string };
  try {
    if (cancelled()) {
      throw new Error("aborted");
    }
    db = new Database(dbPath, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA mmap_size = 1073741824;");
    result = { ok: true, vectors: computeSessionEconomicsVectors(db, { cancelled }) };
    if (cancelled()) {
      throw new Error("aborted");
    }
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (db != null) {
      closeDb(db);
    }
  }
  // Completion is emitted only after the native connection is closed so the
  // worker can close its own event loop without a parent-thread teardown
  // racing SQLite finalization.
  self.postMessage(result);
  self.close();
});
