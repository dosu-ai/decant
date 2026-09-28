import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { ARCHIVE_DIR_MODE, closeDb, openDb } from "./db.ts";
import { EconomicsCache, type EconomicsCacheOptions } from "./economics-cache.ts";
import { exceptionAttributes, logHttpRequest, type StructuredLogger } from "./logging.ts";
import { UI_ROUTE_PATHS } from "./route-paths.ts";
import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT } from "./serve-defaults.ts";
import { type Db, ensureDerivedMetadata } from "./server/context.ts";
import { responseForError, serviceStartingResponse } from "./server/http.ts";
import { resolveTrustedPeers } from "./server/peers.ts";
import { handleRequest } from "./server/router.ts";
import { publishServerEvent } from "./server/sse.ts";
import {
  applyWatchEvent,
  createSyncCoordinator,
  type SyncWorkerRunner,
  syncStatus,
  workerSyncRunner,
} from "./server/sync.ts";
import appleTouchIconPath from "./ui/assets/apple-touch-icon.png" with { type: "file" };
import faviconPath from "./ui/assets/favicon.ico" with { type: "file" };
import uiBundle from "./ui/index.html";
import { startWatch, type WatchEvent, type WatchHandle } from "./watch.ts";

export { type ApiErrorCode, serviceStartingResponse } from "./server/http.ts";
export { parsePeerList, resolveTrustedPeers, type TrustedPeerSources } from "./server/peers.ts";
export { handleRequest } from "./server/router.ts";
export {
  createSyncCoordinator,
  type SyncCoordinator,
  type SyncCoordinatorOptions,
  type SyncRunHandle,
  type SyncWorkerRunner,
  workerSyncRunner,
} from "./server/sync.ts";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export interface ServeWatchOptions {
  intervalMs?: number;
  debounceMs?: number;
  enableWatch?: boolean;
  onEvent?: (event: WatchEvent) => void;
}

export interface ServeOptions {
  config: Config;
  port?: number;
  hostname?: string;
  /** Peers allowed through the local API guard when bound to a non-loopback
   * host. When set, it replaces every default; omit it to let
   * `resolveTrustedPeers` consult the environment. */
  trustedPeers?: string[];
  /** When set, serve() runs the source watcher itself with a worker-backed
   * sync runner so ingests never block the request event loop, and republishes
   * watcher events to SSE clients. */
  watch?: ServeWatchOptions;
  /** Structured operational logger supplied by the CLI entry point. */
  logger?: StructuredLogger;
  /** Test seam: override how the economics cache computes vectors, e.g. to
   * simulate a rebuild that is still in flight when the server is stopped. */
  economicsComputeVectors?: EconomicsCacheOptions["computeVectors"];
  /** Test seam: override the physical sync worker while retaining the server's
   * serialization and progress-coalescing behavior. */
  syncRunner?: SyncWorkerRunner;
}

export function serve(options: ServeOptions): ReturnType<typeof Bun.serve> {
  const hostname = options.hostname ?? DEFAULT_SERVE_HOST;
  const port = options.port ?? DEFAULT_SERVE_PORT;
  const trustedPeers = resolveTrustedPeers(options.trustedPeers);
  let db: Db | null = null;
  let economics: EconomicsCache | null = null;
  let watchHandle: WatchHandle | null = null;
  const syncCoordinator = createSyncCoordinator(options.syncRunner);

  // Bind before touching the archive or starting background work. A second
  // `decant serve` should fail with the truthful port-in-use error, not leave a
  // DB-owning watcher behind and later surface a misleading SQLite lock.
  const server = Bun.serve({
    hostname,
    port,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    routes: {
      "/favicon.ico": new Response(Bun.file(faviconPath), {
        headers: { "cache-control": "public, max-age=86400", "content-type": "image/x-icon" },
      }),
      "/apple-touch-icon.png": new Response(Bun.file(appleTouchIconPath), {
        headers: { "cache-control": "public, max-age=86400", "content-type": "image/png" },
      }),
      ...Object.fromEntries(
        UI_ROUTE_PATHS.map((path) => [path.replace("{id}", ":id"), uiBundle] as const),
      ),
    },
    fetch: async (request, bunServer) => {
      const startedAt = performance.now();
      const requestLogger = options.logger?.with({ "request.id": crypto.randomUUID() });
      const activeDb = db;
      const activeEconomics = economics;
      if (activeDb == null || activeEconomics == null) {
        return serviceStartingResponse();
      }
      try {
        const response = await handleRequest(request, options.config, {
          db: activeDb,
          economics: activeEconomics,
          runSync: syncCoordinator.run,
          syncCoordinator,
          boundHostname: hostname,
          remoteAddress: bunServer.requestIP(request)?.address ?? null,
          trustedPeers,
          logger: requestLogger,
        });
        if (requestLogger != null) {
          logHttpRequest(requestLogger, request, response, performance.now() - startedAt);
        }
        return response;
      } catch (error) {
        requestLogger?.error("Unhandled HTTP request failure.", {
          "event.name": "http.server.request.exception",
          "http.request.method": request.method,
          "url.path": new URL(request.url).pathname,
          ...exceptionAttributes(error),
        });
        const response = responseForError(error);
        if (requestLogger != null) {
          logHttpRequest(requestLogger, request, response, performance.now() - startedAt);
        }
        return response;
      }
    },
  });

  try {
    mkdirSync(dirname(options.config.dbPath), { recursive: true, mode: ARCHIVE_DIR_MODE });
    db = openDb(options.config.dbPath);
    ensureDerivedMetadata(db);
    economics = new EconomicsCache({
      dbPath: options.config.dbPath,
      db,
      computeVectors: options.economicsComputeVectors,
      onRebuilt: () =>
        publishServerEvent({
          type: "archive_updated",
          reason: "stats",
          last_sync_at: syncStatus.last_sync_at,
        }),
    });
    economics.prewarm();
    if (options.watch != null) {
      const onEvent = options.watch.onEvent;
      watchHandle = startWatch({
        config: options.config,
        intervalMs: options.watch.intervalMs,
        debounceMs: options.watch.debounceMs,
        enableWatch: options.watch.enableWatch,
        runner: (config, status, cancel, onProgress) =>
          workerSyncRunner(config, status, cancel, onProgress, syncCoordinator.runWithOwnership),
        onEvent: (event) => {
          if (economics != null) {
            applyWatchEvent(event, economics);
          }
          onEvent?.(event);
        },
      });
    }
  } catch (error) {
    economics?.dispose();
    void Promise.allSettled([
      watchHandle?.stop() ?? Promise.resolve(),
      syncCoordinator.close(),
      economics?.settled() ?? Promise.resolve(),
    ])
      .then(async () => {
        if (db != null) {
          closeDb(db);
        }
        await server.stop(true);
      })
      .catch(() => {
        // Preserve the startup failure already being thrown; cleanup failures
        // must not become a second unhandled rejection.
      });
    throw error;
  }

  const stop = server.stop.bind(server);
  let closed = false;
  server.stop = async (closeActiveConnections?: boolean): Promise<void> => {
    economics?.dispose();
    try {
      await Promise.allSettled([
        watchHandle?.stop() ?? Promise.resolve(),
        syncCoordinator.close(),
        economics?.settled() ?? Promise.resolve(),
      ]);
    } finally {
      try {
        await stop(closeActiveConnections);
      } finally {
        if (!closed) {
          closed = true;
          if (db != null) {
            closeDb(db);
          }
          db = null;
          economics = null;
        }
      }
    }
  };
  return server;
}
