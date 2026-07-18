import { Database } from "bun:sqlite";
import { computeSessionEconomicsVectors } from "./token-economics.ts";

self.addEventListener("message", (event) => {
  const { dbPath } = event.data as { dbPath: string };
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA mmap_size = 1073741824;");
    self.postMessage({ ok: true, vectors: computeSessionEconomicsVectors(db) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    db?.close();
  }
});
