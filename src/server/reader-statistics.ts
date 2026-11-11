import type { Database } from "bun:sqlite";
import type { SyncProgress } from "../ingest.ts";

/** Fewest sessions a sync ingests between two reloads it triggers. */
const MIN_RELOAD_GAP = 25;

/** The planner statistics stored in the archive, as text. Empty when it has none. */
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
  /** The statistics stored in the archive now. */
  stored: () => string;
  /** Have every long-lived connection load the stored statistics. */
  reload: () => void;
}

/**
 * Decides when serve's long-lived connections reload planner statistics while
 * a sync runs. The sync worker analyzes the archive every few sessions, but a
 * connection keeps the statistics it loaded when it opened, so on a first sync
 * every reader would plan without any until the sync ended.
 *
 * A reload happens only when the stored statistics differ from the loaded
 * ones, and the next one waits until the sync has ingested twice as many
 * sessions, because reloading a read worker reopens its connection.
 */
export class ReaderStatistics {
  readonly #options: ReaderStatisticsOptions;
  #loaded: string;
  #checkedAt = 0;
  #nextReloadAt = 0;

  constructor(options: ReaderStatisticsOptions) {
    this.#options = options;
    this.#loaded = options.stored();
  }

  /** Call with each progress update of a running sync. */
  onProgress(progress: SyncProgress): void {
    const { ingested } = progress;
    if (ingested < this.#checkedAt) {
      // The count went back to zero: a new sync started.
      this.#checkedAt = 0;
      this.#nextReloadAt = 0;
    }
    // Statistics only change after the worker has written sessions.
    if (ingested === this.#checkedAt || ingested < this.#nextReloadAt) {
      return;
    }
    this.#checkedAt = ingested;
    const stored = this.#options.stored();
    if (stored === this.#loaded) {
      return;
    }
    // A reload that throws leaves both unset, so the next update tries again.
    this.#options.reload();
    this.#loaded = stored;
    this.#nextReloadAt = Math.max(ingested * 2, ingested + MIN_RELOAD_GAP);
  }

  /** Call after every reader has loaded the stored statistics some other way. */
  markLoaded(): void {
    this.#loaded = this.#options.stored();
    this.#checkedAt = 0;
    this.#nextReloadAt = 0;
  }
}
