import { Database } from "bun:sqlite";
import { closeDb } from "./db.ts";

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

  constructor(path: string) {
    this.#path = path;
  }

  /** Run `read` with the connection, counting it as in use until it settles. */
  async use<T>(read: (db: Database) => T | Promise<T>): Promise<T> {
    const db = this.#connection();
    this.#active += 1;
    try {
      return await read(db);
    } finally {
      this.#active -= 1;
    }
  }

  /** Pick up statistics another connection wrote, at the next idle moment. */
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
  }

  #connection(): Database {
    if (this.#reopenPending && this.#active === 0) {
      this.close();
    }
    if (this.#db == null) {
      // strict matches openDb, so bound parameters behave the same here as on
      // the server's own connection.
      const db = new Database(this.#path, { readonly: true, strict: true });
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA mmap_size = 1073741824;");
      this.#db = db;
    }
    return this.#db;
  }
}
