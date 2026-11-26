import type { Database } from "bun:sqlite";
import { queryRow, runStatement } from "./sqlite-statements.ts";

export const SYNC_STATE_DERIVED_PENDING = "derived_pending";
export const SYNC_STATE_DERIVED_CLEARED = "derived_cleared";
export const SYNC_STATE_RECOMMENDATIONS_PENDING = "recommendations_pending";
export const SYNC_STATE_RECOMMENDATIONS_CLEARED = "recommendations_cleared";
export const SYNC_STATE_RECOMMENDATIONS_REFRESH_SEQ = "recommendations_refresh_seq";
export const SYNC_STATE_ECONOMICS_SEQ = "economics_seq";

const committedEconomicsWritesByDb = new WeakMap<Database, number>();
const pendingTxEconomicsWritesByDb = new WeakMap<Database, number>();

export function readSyncStateGeneration(db: Database, key: string): number {
  const row = queryRow<{ value: string }>(
    db,
    "SELECT value FROM sync_state WHERE key = ?1 LIMIT 1",
    [key],
  );
  if (row == null) {
    return 0;
  }
  const parsed = Number(row.value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function bumpSyncStateGeneration(db: Database, key: string): void {
  runStatement(
    db,
    `INSERT INTO sync_state(key, value) VALUES (?1, '1')
     ON CONFLICT(key) DO UPDATE SET
       value = CAST(COALESCE(NULLIF(CAST(value AS INTEGER), 0), 0) + 1 AS TEXT)`,
    [key],
  );
}

export function markSyncStateCleared(db: Database, clearedKey: string, generation: number): void {
  if (generation <= 0) {
    return;
  }
  runStatement(
    db,
    `INSERT INTO sync_state(key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
    [clearedKey, String(generation)],
  );
}

export function beginEconomicsTransaction(db: Database): void {
  pendingTxEconomicsWritesByDb.set(db, 0);
}

export function commitEconomicsTransaction(db: Database): void {
  const pending = pendingTxEconomicsWritesByDb.get(db) ?? 0;
  pendingTxEconomicsWritesByDb.delete(db);
  if (pending > 0) {
    committedEconomicsWritesByDb.set(db, (committedEconomicsWritesByDb.get(db) ?? 0) + pending);
  }
}

export function rollbackEconomicsTransaction(db: Database): void {
  pendingTxEconomicsWritesByDb.delete(db);
}

export function bumpEconomicsSeq(db: Database): void {
  bumpSyncStateGeneration(db, SYNC_STATE_ECONOMICS_SEQ);
  const pending = pendingTxEconomicsWritesByDb.get(db);
  if (pending !== undefined) {
    pendingTxEconomicsWritesByDb.set(db, pending + 1);
  } else {
    committedEconomicsWritesByDb.set(db, (committedEconomicsWritesByDb.get(db) ?? 0) + 1);
  }
}

export function readEconomicsSeq(db: Database): number | null {
  try {
    return readSyncStateGeneration(db, SYNC_STATE_ECONOMICS_SEQ);
  } catch {
    return null;
  }
}

export function committedEconomicsWrites(db: Database): number {
  return committedEconomicsWritesByDb.get(db) ?? 0;
}
