import type { Database } from "bun:sqlite";

export type SqlParam = string | number | bigint | boolean | null;

export function queryRows<T>(db: Database, sql: string, params: SqlParam[] = []): T[] {
  const statement = db.prepare<T, SqlParam[]>(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

export function queryRow<T>(db: Database, sql: string, params: SqlParam[] = []): T | null {
  const statement = db.prepare<T, SqlParam[]>(sql);
  try {
    return statement.get(...params);
  } finally {
    statement.finalize();
  }
}

/** Runs one statement and returns the inserted rowid (meaningful for INSERT only). */
export function runStatement(db: Database, sql: string, params: SqlParam[] = []): number {
  const statement = db.prepare<unknown, SqlParam[]>(sql);
  try {
    return Number(statement.run(...params).lastInsertRowid);
  } finally {
    statement.finalize();
  }
}
