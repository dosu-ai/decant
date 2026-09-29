import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import { ARCHIVE_DIR_MODE, closeDb, openDb } from "../db.ts";
import { refreshDerivedMetadata } from "../derived.ts";
import type { EconomicsCache } from "../economics-cache.ts";
import type { StructuredLogger } from "../logging.ts";
import type { SyncCoordinator, SyncWorkerRunner } from "./sync.ts";

export type Db = ReturnType<typeof openDb>;

export interface RequestContext {
  db?: Db;
  economics?: EconomicsCache;
  runSync?: SyncWorkerRunner;
  syncCoordinator?: SyncCoordinator;
  launchPlatform?: NodeJS.Platform;
  boundHostname?: string;
  remoteAddress?: string | null;
  trustedPeers?: string[];
  logger?: StructuredLogger;
}

const metadataHydrated = new WeakSet<Db>();

export function withDb(
  config: Config,
  context: RequestContext,
  callback: (db: Db) => Response,
): Response {
  if (context.db != null) {
    ensureDerivedMetadata(context.db);
    return callback(context.db);
  }
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: ARCHIVE_DIR_MODE });
  const db = openDb(config.dbPath);
  try {
    ensureDerivedMetadata(db);
    return callback(db);
  } finally {
    closeDb(db);
  }
}

export function ensureDerivedMetadata(db: Db): void {
  if (metadataHydrated.has(db)) {
    return;
  }
  refreshDerivedMetadata(db, { ignoreReadonly: true });
  metadataHydrated.add(db);
}
