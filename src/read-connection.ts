import { Database } from "bun:sqlite";
import { closeDb, configureConnectionPragmas } from "./db.ts";
import { storedPlannerStatistics } from "./server/reader-statistics.ts";

/**
 * The read-only SQLite connection behind one read worker.
 *
 * A connection loads planner statistics only when it reads the schema, and a
 * read-only connection cannot run `ANALYZE sqlite_schema` to reload them (it
 * fails with SQLITE_READONLY). So after a sync analyzes the archive, the
 * connection is reopened instead. A reopen waits until no read is using the
 * connection, because report reads await a lazy import partway through.
 */
export class ReadConnection {
  readonly #path: string;
  #db: Database | null = null;
  #active = 0;
  #reopenPending = false;
  #loadedStatistics = "";

  constructor(path: string) {
    this.#path = path;
  }

  async use<T>(read: (db: Database) => T | Promise<T>): Promise<T> {
    const db = this.#connection();
    this.#active += 1;
    try {
      return await read(db);
    } finally {
      this.#active -= 1;
    }
  }

  reloadStatistics(): void {
    if (this.#db != null) {
      this.#reopenPending = true;
    }
  }

  close(): void {
    if (this.#db != null) {
      closeDb(this.#db);
      this.#db = null;
    }
    this.#reopenPending = false;
    this.#loadedStatistics = "";
  }

  #connection(): Database {
    if (this.#reopenPending && this.#active === 0) {
      this.#reopenPending = false;
      if (this.#db != null && storedPlannerStatistics(this.#db) !== this.#loadedStatistics) {
        this.close();
      }
    }
    if (this.#db == null) {
      const db = new Database(this.#path, { readonly: true, strict: true });
      db.exec("PRAGMA busy_timeout = 5000;");
      configureConnectionPragmas(db, "ro");
      this.#loadedStatistics = storedPlannerStatistics(db);
      this.#db = db;
    }
    return this.#db;
  }
}
