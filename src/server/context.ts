import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import { ARCHIVE_DIR_MODE, closeDb, openDb } from "../db.ts";
import { refreshDerivedMetadata } from "../derived.ts";
import type { EconomicsCache } from "../economics-cache.ts";
import type { StructuredLogger } from "../logging.ts";
import type { ServiceOptions } from "../service.ts";
import type { ReadPool } from "./read-pool.ts";
import type { SyncCoordinator, SyncWorkerRunner } from "./sync.ts";

export type Db = ReturnType<typeof openDb>;

export interface RequestContext {
  db?: Db;
  economics?: EconomicsCache;
  /** Worker threads with their own read-only connections. When present, the
   * heavy archive reads run there so they never queue behind each other on
   * `db`, which stays free for fast routes and writes. */
  readPool?: ReadPool;
  runSync?: SyncWorkerRunner;
  syncCoordinator?: SyncCoordinator;
  launchPlatform?: NodeJS.Platform;
  boundHostname?: string;
  remoteAddress?: string | null;
  trustedPeers?: string[];
  logger?: StructuredLogger;
  /** The port this server is listening on, which the background service reuses. */
  boundPort?: number;
  /** Test seam: how the background service routes reach launchd or systemd. */
  service?: ServiceOptions;
  /** Stop this server so the background service can take over its port. */
  requestShutdown?: () => void;
}

const metadataHydrated = new WeakSet<Db>();

export function withDb<T = Response>(
  config: Config,
  context: RequestContext,
  callback: (db: Db) => T,
): T {
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
