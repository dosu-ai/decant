import type { Database } from "bun:sqlite";
import type { SyncProgress } from "../ingest.ts";

const MIN_RELOAD_GAP = 25;

export function storedPlannerStatistics(db: Database): string {
  // sqlite_stat1 does not exist until the first ANALYZE creates it.
  const analyzed =
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get() !=
    null;
  if (!analyzed) {
    return "";
  }
  return db
    .query("SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx")
    .values()
    .map((row) => row.join("\t"))
    .join("\n");
}

/**
 * Reread the schema, which is when a connection loads planner statistics.
 * Unlike `ANALYZE sqlite_schema` this takes no write lock, so it works while a
 * sync worker is writing.
 */
export function rereadPlannerStatistics(db: Database): void {
  db.exec("PRAGMA writable_schema = RESET;");
}

export interface ReaderStatisticsOptions {
  stored: () => string;
  reload: () => void;
}

export class ReaderStatistics {
  readonly #options: ReaderStatisticsOptions;
  #loaded: string;
  #checkedAt = 0;
  #nextReloadAt = 0;

  constructor(options: ReaderStatisticsOptions) {
    this.#options = options;
    this.#loaded = options.stored();
  }

  onProgress(progress: SyncProgress): void {
    const { ingested } = progress;
    if (ingested < this.#checkedAt) {
      this.#checkedAt = 0;
      this.#nextReloadAt = 0;
    }
    if (ingested === this.#checkedAt || ingested < this.#nextReloadAt) {
      return;
    }
    const stored = this.#options.stored();
    if (stored === this.#loaded) {
      this.#checkedAt = ingested;
      return;
    }
    this.#options.reload();
    this.#checkedAt = ingested;
    this.#loaded = stored;
    this.#nextReloadAt = Math.max(ingested * 2, ingested + MIN_RELOAD_GAP);
  }

  markLoaded(): void {
    this.#loaded = this.#options.stored();
    this.#checkedAt = 0;
    this.#nextReloadAt = 0;
  }
}
