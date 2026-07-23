import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { dateFilterFromSearch } from "./date-filter.ts";
import { ARCHIVE_DIR_MODE, openDb } from "./db.ts";
import { refreshDerivedMetadata } from "./derived.ts";
import { EconomicsCache, type EconomicsCacheOptions } from "./economics-cache.ts";
import type { Operation } from "./enrich.ts";
import type { sync as ingestSync } from "./ingest.ts";
import { canLaunch, launchAgent, command as launchCommand, openIde } from "./launcher.ts";
import { getSession, listProjects, listSessions, search } from "./query.ts";
import {
  list as listRecommendations,
  markImplemented,
  parseStatusFilter,
} from "./recommendations.ts";
import {
  agentOptions,
  getSettings,
  ideOptions,
  saveSettings,
  settingsPath,
  terminalOptions,
} from "./settings.ts";
import {
  activity as activityStats,
  byDimension,
  dateBounds,
  fileHotspots,
  mcpUsage,
  modelSparklines,
  parseDimension,
  parseFileGroup,
  todayTotals,
  toolUsage,
  totals,
} from "./stats.ts";
import { tokenEconomics, tokenEconomicsForSession } from "./token-economics.ts";
import uiBundle from "./ui/index.html";
import { type SyncStatusStore, startWatch, type WatchEvent, type WatchHandle } from "./watch.ts";

export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 3000;

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
  /** Test seam: override how the economics cache computes vectors, e.g. to
   * simulate a rebuild that is still in flight when the server is stopped. */
  economicsComputeVectors?: EconomicsCacheOptions["computeVectors"];
}

type Db = ReturnType<typeof openDb>;
type ServerEvent = { type: string };
interface RequestContext {
  db?: Db;
  economics?: EconomicsCache;
  boundHostname?: string;
  remoteAddress?: string | null;
  trustedPeers?: string[];
}

const syncStatus = {
  last_sync_at: null as string | null,
  in_progress: false,
  last_report: null as string | null,
  last_error: null as string | null,
  ingested_count: null as number | null,
};
const eventClients = new Set<EventClient>();
const metadataHydrated = new WeakSet<Db>();

export function publishServerEvent<T extends ServerEvent>(event: T): void {
  for (const client of [...eventClients]) {
    try {
      client.send(event);
    } catch {
      client.close();
    }
  }
}

export async function handleRequest(
  request: Request,
  config: Config,
  context: RequestContext = {},
): Promise<Response> {
  const url = new URL(request.url);
  const securityFailure = validateLocalRequest(request, url, context);
  if (securityFailure != null) {
    return securityFailure;
  }
  const dateFilter = dateFilterFromSearch(url.searchParams);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      return html(indexHtml());
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      return eventStream();
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      return json({
        dbPath: config.dbPath,
        claudeDir: config.claudeDir,
        codexDir: config.codexDir,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      return json(settingsResponse());
    }
    if (request.method === "POST" && url.pathname === "/api/settings") {
      const contentTypeFailure = requireJsonRequest(request);
      if (contentTypeFailure != null) {
        return contentTypeFailure;
      }
      const body = await readJson<Record<string, unknown>>(request);
      return json({ ...settingsResponse(saveSettings(body)), saved: true });
    }
    if (request.method === "POST" && url.pathname === "/api/launch/agent") {
      const contentTypeFailure = requireJsonRequest(request);
      if (contentTypeFailure != null) {
        return contentTypeFailure;
      }
      const body = await readJson<{ agent?: string; prompt?: string; key?: string }>(request);
      if (body.agent == null || body.prompt == null || body.prompt.trim() === "") {
        return json({ ok: false, error: "agent and prompt are required" }, 400);
      }
      const result = launchAgent(body.agent, body.prompt, body.key ?? null, getSettings());
      return json(
        result.ok
          ? result
          : { ...result, command: result.command ?? launchCommand(body.agent, body.prompt) },
        result.ok ? 200 : 400,
      );
    }
    if (request.method === "POST" && url.pathname === "/api/launch/ide") {
      const contentTypeFailure = requireJsonRequest(request);
      if (contentTypeFailure != null) {
        return contentTypeFailure;
      }
      const body = await readJson<{ dir?: string }>(request);
      if (body.dir == null || body.dir.trim() === "") {
        return json({ ok: false, error: "dir is required" }, 400);
      }
      const result = openIde(body.dir, getSettings());
      return json(result, result.ok ? 200 : 400);
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/api/sync-status" || url.pathname === "/api/metadata/sync-status")
    ) {
      return json({
        ...syncStatus,
        timestamp: new Date().toISOString(),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      const contentTypeFailure = requireJsonRequest(request);
      if (contentTypeFailure != null) {
        return contentTypeFailure;
      }
      return await syncNow(config, context.economics);
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      return withDb(config, context, (db) =>
        json(
          listSessions(db, {
            tool: url.searchParams.get("tool"),
            model: url.searchParams.get("model"),
            project: url.searchParams.get("project"),
            includeSubagents: url.searchParams.get("include_subagents") === "true",
            includeNestedSubagents: url.searchParams.get("with_subagents") === "true",
            limit: integerParam(url, "limit", 50),
            offset: integerParam(url, "offset", 0, true),
            ...dateFilter,
          }),
        ),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      return withDb(config, context, (db) => json(listProjects(db)));
    }
    const sessionEconomicsMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/token-economics$/);
    if (request.method === "GET" && sessionEconomicsMatch != null) {
      return withDb(config, context, (db) => {
        const economics = tokenEconomicsForSession(db, Number(sessionEconomicsMatch[1]));
        return economics == null ? json({ error: "session not found" }, 404) : json(economics);
      });
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/(\d+)$/);
    if (request.method === "GET" && sessionMatch != null) {
      return withDb(config, context, (db) => {
        const messageLimit = integerParam(url, "message_limit", 0, true);
        const detail = getSession(db, Number(sessionMatch[1]), {
          messageLimit: messageLimit > 0 ? messageLimit : null,
          messageOffset: integerParam(url, "message_offset", 0, true),
        });
        return detail == null ? json({ error: "session not found" }, 404) : json(detail);
      });
    }
    if (request.method === "POST" && url.pathname === "/api/search") {
      const contentTypeFailure = requireJsonRequest(request);
      if (contentTypeFailure != null) {
        return contentTypeFailure;
      }
      const body = await readJson<{ query?: string; limit?: number }>(request);
      if (body.query == null || body.query.trim() === "") {
        return json({ error: "query is required" }, 400);
      }
      return withDb(config, context, (db) => {
        try {
          return json(search(db, body.query as string, body.limit ?? 30));
        } catch (error) {
          if (isSearchSyntaxError(error)) {
            return json({ error: "invalid search query" }, 400);
          }
          throw error;
        }
      });
    }
    if (request.method === "GET" && url.pathname === "/api/stats/summary") {
      return withDb(config, context, (db) => json(totals(db, dateFilter)));
    }
    if (request.method === "GET" && url.pathname === "/api/stats/by-dimension") {
      const dimension = parseDimension(url.searchParams.get("dim") ?? "");
      if (dimension == null) {
        return json({ error: "unknown dimension" }, 400);
      }
      return withDb(config, context, (db) => json(byDimension(db, dimension, dateFilter)));
    }
    if (request.method === "GET" && url.pathname === "/api/analytics/activity") {
      return withDb(config, context, (db) => json(activityStats(db, dateFilter)));
    }
    if (request.method === "GET" && url.pathname === "/api/analytics/model-sparklines") {
      return withDb(config, context, (db) => json(modelSparklines(db, dateFilter)));
    }
    if (request.method === "GET" && url.pathname === "/api/analytics/token-economics") {
      if (context.economics != null) {
        return json(await context.economics.get(dateFilter));
      }
      return withDb(config, context, (db) => json(tokenEconomics(db, dateFilter)));
    }
    if (request.method === "GET" && url.pathname === "/api/analytics/now") {
      return withDb(config, context, (db) =>
        json({
          today: todayTotals(db),
          active_sessions: [],
          last_sync_at: syncStatus.last_sync_at,
          sync_in_progress: syncStatus.in_progress,
        }),
      );
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/api/date-bounds" || url.pathname === "/api/metadata/date-bounds")
    ) {
      return withDb(config, context, (db) => json(dateBounds(db)));
    }
    if (request.method === "GET" && url.pathname === "/api/files") {
      const group = parseFileGroup(url.searchParams.get("group") ?? "path");
      const op = parseOperation(url.searchParams.get("op"));
      if (group == null || op === false) {
        return json({ error: "invalid files query" }, 400);
      }
      return withDb(config, context, (db) =>
        json(fileHotspots(db, group, op, integerParam(url, "limit", 25), dateFilter)),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/tools/usage") {
      return withDb(config, context, (db) =>
        json(
          toolUsage(
            db,
            url.searchParams.get("errors_only") === "true",
            integerParam(url, "limit", 50),
            dateFilter,
          ),
        ),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/tools/mcp-usage") {
      return withDb(config, context, (db) =>
        json(mcpUsage(db, integerParam(url, "limit", 50), dateFilter)),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/recommendations") {
      const status = parseStatusFilter(url.searchParams.get("status") ?? "open");
      if (status == null) {
        return json({ error: "unknown status" }, 400);
      }
      return withDb(config, context, (db) => json(listRecommendations(db, status)));
    }
    if (request.method === "POST" && url.pathname === "/api/recommendations/mark") {
      const contentTypeFailure = requireJsonRequest(request);
      if (contentTypeFailure != null) {
        return contentTypeFailure;
      }
      const body = await readJson<{ key?: string; source?: string; note?: string }>(request);
      if (body.key == null || body.key.trim() === "") {
        return json({ error: "key is required" }, 400);
      }
      return withDb(config, context, (db) => {
        const ok = markImplemented(db, body.key as string, body.source ?? "agent", body.note);
        return ok
          ? json({ ok: true, key: body.key, status: "implemented" })
          : json({ ok: false, key: body.key, error: "recommendation not found" }, 404);
      });
    }
    if (request.method === "GET" && isUiPath(url.pathname)) {
      return html(indexHtml());
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

function settingsResponse(settings = getSettings()): Record<string, unknown> {
  return {
    settings,
    path: settingsPath(),
    can_launch: canLaunch(),
    options: {
      agents: agentOptions,
      terminals: terminalOptions,
      ides: ideOptions,
    },
  };
}

async function syncNow(config: Config, economics?: EconomicsCache): Promise<Response> {
  syncStatus.in_progress = true;
  syncStatus.last_error = null;
  try {
    const report = await runSyncWorker(config);
    syncStatus.in_progress = false;
    syncStatus.last_sync_at = new Date().toISOString();
    syncStatus.last_report =
      `scanned ${report.scanned}, ingested ${report.ingested}, skipped ${report.skipped}, ` +
      `issues ${report.issues}, failed ${report.failed}`;
    syncStatus.ingested_count = report.ingested;
    publishServerEvent({ type: "sync", reason: "manual", report, status: { ...syncStatus } });
    if (report.ingested > 0) {
      economics?.invalidate();
      publishServerEvent({
        type: "archive_updated",
        ingested: report.ingested,
        last_sync_at: syncStatus.last_sync_at,
      });
    }
    return json(report);
  } catch (error) {
    syncStatus.in_progress = false;
    syncStatus.last_sync_at = new Date().toISOString();
    syncStatus.last_error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function runSyncWorker(
  config: Config,
  cancel?: { aborted: boolean },
): Promise<ReturnType<typeof ingestSync>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sync-worker.ts", import.meta.url), { type: "module" });
    let cancelPoll: Timer | null = null;
    const settle = (): void => {
      if (cancelPoll != null) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
      worker.terminate();
    };
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { ok: true; report: ReturnType<typeof ingestSync> }
        | { ok: false; error: string };
      settle();
      if (data.ok) {
        resolve(data.report);
      } else {
        reject(new Error(data.error));
      }
    });
    worker.addEventListener("error", (event) => {
      settle();
      reject(event.error instanceof Error ? event.error : new Error(String(event.error)));
    });
    if (cancel != null) {
      // The in-process runner aborts between files; a worker cannot observe the
      // flag, so poll it and terminate, resolving with the same cancelled-report
      // shape so shutdown stays prompt instead of waiting out a long ingest.
      cancelPoll = setInterval(() => {
        if (cancel.aborted) {
          settle();
          resolve({ scanned: 0, ingested: 0, skipped: 0, issues: 0, failed: 0, cancelled: true });
        }
      }, 150);
    }
    worker.postMessage(config);
  });
}

interface EventClient {
  send(event: ServerEvent): void;
  close(): void;
}

function eventStream(heartbeatMs = 5_000): Response {
  const encoder = new TextEncoder();
  let client: EventClient | null = null;
  let heartbeat: Timer | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ServerEvent): void =>
        controller.enqueue(encoder.encode(formatSse(event)));
      const close = (): void => {
        if (heartbeat != null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (client != null) {
          eventClients.delete(client);
          client = null;
        }
      };
      client = { send, close };
      eventClients.add(client);
      send({ type: "hello", timestamp: new Date().toISOString() } as ServerEvent);
      heartbeat = setInterval(() => {
        if (client == null) {
          return;
        }
        try {
          send({ type: "ping", timestamp: new Date().toISOString() } as ServerEvent);
        } catch {
          close();
        }
      }, heartbeatMs);
    },
    cancel() {
      client?.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function formatSse(event: ServerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function serve(options: ServeOptions): ReturnType<typeof Bun.serve> {
  const hostname = options.hostname ?? DEFAULT_SERVE_HOST;
  const port = options.port ?? DEFAULT_SERVE_PORT;
  const trustedPeers = resolveTrustedPeers(options.trustedPeers);
  mkdirSync(dirname(options.config.dbPath), { recursive: true, mode: ARCHIVE_DIR_MODE });
  const db = openDb(options.config.dbPath);
  ensureDerivedMetadata(db);
  const economics = new EconomicsCache({
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
  let watchHandle: WatchHandle | null = null;
  if (options.watch != null) {
    const onEvent = options.watch.onEvent;
    watchHandle = startWatch({
      config: options.config,
      intervalMs: options.watch.intervalMs,
      debounceMs: options.watch.debounceMs,
      enableWatch: options.watch.enableWatch,
      runner: workerSyncRunner,
      onEvent: (event) => {
        applyWatchEvent(event, economics);
        onEvent?.(event);
      },
    });
  }
  const server = Bun.serve({
    hostname,
    port,
    routes: {
      "/": uiBundle,
      "/projects": uiBundle,
      "/sessions": uiBundle,
      "/sessions/:id": uiBundle,
      "/search": uiBundle,
      "/analytics": uiBundle,
      "/insights": uiBundle,
      "/tools": uiBundle,
      "/files": uiBundle,
      "/settings": uiBundle,
    },
    fetch: (request, bunServer) =>
      handleRequest(request, options.config, {
        db,
        economics,
        boundHostname: hostname,
        remoteAddress: bunServer.requestIP(request)?.address ?? null,
        trustedPeers,
      }),
  });
  const stop = server.stop.bind(server);
  let closed = false;
  server.stop = async (closeActiveConnections?: boolean): Promise<void> => {
    try {
      await watchHandle?.stop();
    } finally {
      // Abort any in-flight economics rebuild BEFORE awaiting the native
      // stop(): forcing TCP connections closed doesn't make an in-flight
      // request handler's own awaited Promise settle, so a request still
      // awaiting a multi-second rebuild would otherwise block native stop()
      // from ever resolving, even with closeActiveConnections=true.
      economics.dispose();
      try {
        await stop(closeActiveConnections);
      } finally {
        if (!closed) {
          closed = true;
          db.close();
        }
      }
    }
  };
  return server;
}

/** Runs one watcher-triggered sync in a worker thread, keeping request
 * handling responsive while multi-second ingests run. */
async function workerSyncRunner(
  config: Config,
  status: SyncStatusStore,
  cancel: { aborted: boolean },
): Promise<ReturnType<typeof ingestSync>> {
  status.start();
  try {
    const report = await runSyncWorker(config, cancel);
    status.finishOk(report);
    return report;
  } catch (error) {
    status.finishErr(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function applyWatchEvent(event: WatchEvent, economics: EconomicsCache): void {
  if ("status" in event && event.status != null) {
    syncStatus.last_sync_at = event.status.last_sync_at;
    syncStatus.in_progress = event.status.in_progress;
    syncStatus.last_report = event.status.last_report;
    syncStatus.last_error = event.status.last_error;
    syncStatus.ingested_count = event.status.ingested_count;
  }
  publishServerEvent(event);
  if (event.type === "sync" && event.report.ingested > 0) {
    economics.invalidate();
    publishServerEvent({
      type: "archive_updated",
      ingested: event.report.ingested,
      last_sync_at: syncStatus.last_sync_at,
    });
  }
}

function withDb(config: Config, context: RequestContext, callback: (db: Db) => Response): Response {
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
    db.close();
  }
}

function ensureDerivedMetadata(db: Db): void {
  if (metadataHydrated.has(db)) {
    return;
  }
  refreshDerivedMetadata(db, { ignoreReadonly: true });
  metadataHydrated.add(db);
}

function isSearchSyntaxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("fts5") ||
    lower.includes("malformed") ||
    lower.includes("unterminated") ||
    lower.includes("syntax")
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function validateLocalRequest(
  request: Request,
  url: URL,
  context: RequestContext,
): Response | null {
  if (!isProtectedPath(url.pathname)) {
    return null;
  }
  if (!isLoopbackHost(url.hostname)) {
    return json({ error: "forbidden host" }, 403);
  }
  const boundToLoopback = isLoopbackHost(context.boundHostname ?? "127.0.0.1");
  if (
    !boundToLoopback &&
    !isLoopbackPeer(context.remoteAddress) &&
    !isTrustedPeer(context.remoteAddress, context.trustedPeers ?? [])
  ) {
    return json({ error: "forbidden remote" }, 403);
  }
  if (isMutatingMethod(request.method) && !isAllowedWriteRequest(request, boundToLoopback)) {
    return json({ error: "cross-origin writes are forbidden" }, 403);
  }
  return null;
}

function isProtectedPath(pathname: string): boolean {
  return pathname === "/api/events" || pathname.startsWith("/api/");
}

function isMutatingMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function isAllowedWriteRequest(request: Request, boundToLoopback: boolean): boolean {
  const origin = request.headers.get("origin");
  if (origin != null && !isLoopbackOrigin(origin)) {
    return false;
  }
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (!boundToLoopback && origin == null && site == null) {
    return false;
  }
  return site == null || site === "same-origin" || site === "same-site" || site === "none";
}

function isLoopbackOrigin(origin: string): boolean {
  if (origin === "null") {
    return false;
  }
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return normalized === "localhost" || normalized === "::1" || isIpv4Loopback(normalized);
}

function isLoopbackPeer(address: string | null | undefined): boolean {
  if (address == null) {
    return false;
  }
  const normalized = normalizeHost(address);
  if (normalized.startsWith("::ffff:")) {
    return isIpv4Loopback(normalized.slice("::ffff:".length));
  }
  return normalized === "::1" || isIpv4Loopback(normalized);
}

function isTrustedPeer(address: string | null | undefined, trustedPeers: string[]): boolean {
  if (address == null) {
    return false;
  }
  const normalized = normalizeHost(address);
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  for (const peer of trustedPeers) {
    if (peer.includes("/")) {
      if (ipv4CidrContains(peer, ipv4)) {
        return true;
      }
    } else if (normalizeHost(peer) === normalized || normalizeHost(peer) === ipv4) {
      return true;
    }
  }
  return false;
}

export function parsePeerList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((peer) => peer.trim())
    .filter((peer) => peer !== "");
}

const DEFAULT_ROUTE_TABLE_PATH = "/proc/net/route";
const DEFAULT_SYS_CLASS_NET_PATH = "/sys/class/net";
/** `/proc/net/route` flag bits: the route is usable, and it hops through a
 * gateway instead of being on-link. */
const RTF_UP = 0x1;
const RTF_GATEWAY = 0x2;
/** Bound on gateway auto-trust, not an allowlist: no address in this range is
 * trusted unless it is *this* container's own bridge gateway. Container
 * runtimes carve their default bridge networks out of it (Docker's default
 * address pool starts at 172.17.0.0/16), while LAN and VPC routers -- the
 * addresses a `--network host`, macvlan or ipvlan container would otherwise
 * resolve -- practically never sit in it. Bounding the derived address this way
 * also keeps the image's default trust set a strict subset of the
 * `172.16.0.0/12` allowlist it used to ship, so no deployment shape gains trust
 * it did not already have. */
const GATEWAY_AUTO_TRUST_RANGE = "172.16.0.0/12";

/** Test seam: where the Linux network facts are read from. */
export interface TrustedPeerSources {
  routeTablePath?: string;
  sysClassNetPath?: string;
}

/** Peers the local API guard admits when `serve` is bound to a non-loopback
 * host, resolved once at startup.
 *
 * Precedence, highest first. The first source that is present wins outright and
 * the rest are not consulted, so explicit configuration always *replaces* the
 * gateway default rather than adding to it:
 *
 * 1. `--trusted-peer` (`configured`), when the CLI collected any.
 * 2. `DECANT_TRUSTED_PEERS`, whenever the variable is set at all -- setting it
 *    to an empty string means "trust nobody", not "fall through".
 * 3. `DECANT_TRUST_DEFAULT_GATEWAY=1`, which trusts exactly one address: this
 *    container's own bridge gateway, and only when `containerBridgeGateway`
 *    can prove that is what the default route points at. Every other value,
 *    including `0` and an unset variable, trusts nobody.
 *
 * Nothing re-resolves afterwards: a host whose default route changes keeps the
 * address resolved at startup until `serve` restarts. */
export function resolveTrustedPeers(
  configured?: string[],
  env: Record<string, string | undefined> = process.env,
  sources: TrustedPeerSources = {},
): string[] {
  if (configured != null) {
    return configured;
  }
  if (env.DECANT_TRUSTED_PEERS != null) {
    return parsePeerList(env.DECANT_TRUSTED_PEERS);
  }
  if (!isEnvEnabled(env.DECANT_TRUST_DEFAULT_GATEWAY)) {
    return [];
  }
  const gateway = containerBridgeGateway(
    sources.routeTablePath ?? DEFAULT_ROUTE_TABLE_PATH,
    sources.sysClassNetPath ?? DEFAULT_SYS_CLASS_NET_PATH,
  );
  return gateway == null ? [] : [gateway];
}

/** This container's own bridge gateway, or `null` when that cannot be proven.
 *
 * That single address is worth trusting only because container runtimes rewrite
 * the source address of `-p`-published host traffic to it: it stands in for the
 * host that started the container, while a sibling container on the same bridge
 * keeps its own source address and stays denied. The reasoning holds only for a
 * bridge-networked container, so all of the following must hold and anything
 * unexpected -- including a non-Linux host, where `/proc/net/route` is absent --
 * fails closed:
 *
 * - exactly one usable IPv4 default route, so a multi-homed host cannot
 *   contribute a gateway from some other network;
 * - the gateway is on-link on that route's interface;
 * - the gateway is inside `GATEWAY_AUTO_TRUST_RANGE`;
 * - the interface is a veth into another network namespace: it publishes no
 *   device kind other than `veth`, has no backing bus device, is not stacked on
 *   a local parent, and its link peer does not resolve here. That rules out
 *   sharing the host's namespace (`--network host`, where the default route
 *   runs over a physical NIC, bridge, bond or tunnel) and a container attached
 *   straight to the LAN (macvlan, ipvlan). In those shapes the "default
 *   gateway" is the LAN or VPC router, which must never be trusted
 *   implicitly. */
function containerBridgeGateway(routeTablePath: string, sysClassNetPath: string): string | null {
  const routes = readRouteTable(routeTablePath);
  if (routes == null) {
    return null;
  }
  const defaults = routes.filter(
    (route) =>
      route.destination === 0 &&
      route.gateway !== 0 &&
      (route.flags & RTF_UP) !== 0 &&
      (route.flags & RTF_GATEWAY) !== 0,
  );
  const route = defaults.length === 1 ? defaults[0] : undefined;
  if (route == null) {
    return null;
  }
  const gateway = formatIpv4(route.gateway);
  if (!ipv4CidrContains(GATEWAY_AUTO_TRUST_RANGE, gateway)) {
    return null;
  }
  if (!hasOnLinkRoute(routes, route.iface, route.gateway)) {
    return null;
  }
  return isContainerVeth(route.iface, sysClassNetPath) ? gateway : null;
}

interface RouteRow {
  iface: string;
  destination: number;
  gateway: number;
  flags: number;
  mask: number;
}

/** Rows of the Linux IPv4 route table, or `null` when it cannot be read (any
 * non-Linux host), which leaves the guard closed rather than guessing. */
function readRouteTable(routeTablePath: string): RouteRow[] | null {
  let table: string;
  try {
    table = readFileSync(routeTablePath, "utf8");
  } catch {
    return null;
  }
  const rows: RouteRow[] = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const iface = fields[0] ?? "";
    const destination = routeHexToIpv4(fields[1]);
    const gateway = routeHexToIpv4(fields[2]);
    const flags = Number.parseInt(fields[3] ?? "", 16);
    const mask = routeHexToIpv4(fields[7]);
    if (
      iface === "" ||
      destination == null ||
      gateway == null ||
      mask == null ||
      !Number.isFinite(flags)
    ) {
      continue;
    }
    rows.push({ iface, destination, gateway, flags, mask });
  }
  return rows;
}

/** A gateway reachable without another hop on the same interface, which is how
 * a container's bridge gateway always appears. */
function hasOnLinkRoute(routes: RouteRow[], iface: string, gateway: number): boolean {
  return routes.some(
    (route) =>
      route.iface === iface &&
      route.mask !== 0 &&
      (route.flags & RTF_UP) !== 0 &&
      (route.flags & RTF_GATEWAY) === 0 &&
      (route.destination & route.mask) >>> 0 === (gateway & route.mask) >>> 0,
  );
}

/** Whether `iface` is this container's veth: a virtual device, not stacked on a
 * parent in this namespace, whose link peer lives in another namespace. The
 * host's own namespace never satisfies all three for its default route. */
function isContainerVeth(iface: string, sysClassNetPath: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(iface)) {
    return false;
  }
  const dir = join(sysClassNetPath, iface);
  // vlan, macvlan, ipvlan, bridge and bond devices all publish their kind here,
  // so a container sitting directly on the LAN is refused. Kernels that publish
  // no DEVTYPE for veth leave the structural checks below to decide.
  const devType = readDevType(join(dir, "uevent"));
  if (devType != null && devType !== "veth") {
    return false;
  }
  // A physical NIC -- so, the host's namespace -- has a backing bus device.
  if (existsSync(join(dir, "device"))) {
    return false;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  // Devices stacked on a parent in this namespace publish lower_* links.
  if (entries.some((entry) => entry.startsWith("lower_"))) {
    return false;
  }
  const ifIndex = readIfIndex(join(dir, "ifindex"));
  const ifLink = readIfIndex(join(dir, "iflink"));
  // A container veth names a peer that lives in another namespace, so the index
  // it links to must not resolve here. A bridge, bond or tunnel links to itself
  // (the degenerate case of the same rule), and a veth pair with both ends in
  // this namespace is not a container boundary.
  if (ifIndex == null || ifLink == null || ifIndex === ifLink) {
    return false;
  }
  const localIndexes = collectIfIndexes(sysClassNetPath);
  return localIndexes != null && !localIndexes.has(ifLink);
}

function readDevType(ueventPath: string): string | null {
  let uevent: string;
  try {
    uevent = readFileSync(ueventPath, "utf8");
  } catch {
    return null;
  }
  for (const line of uevent.split("\n")) {
    const [key, value] = line.split("=", 2);
    if (key?.trim() === "DEVTYPE") {
      return value?.trim().toLowerCase() ?? null;
    }
  }
  return null;
}

function readIfIndex(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Every interface index visible in this network namespace, or `null` when the
 * directory cannot be listed. */
function collectIfIndexes(sysClassNetPath: string): Set<number> | null {
  let entries: string[];
  try {
    entries = readdirSync(sysClassNetPath);
  } catch {
    return null;
  }
  const indexes = new Set<number>();
  for (const entry of entries) {
    const value = readIfIndex(join(sysClassNetPath, entry, "ifindex"));
    if (value != null) {
      indexes.add(value);
    }
  }
  return indexes;
}

/** `/proc/net/route` prints each address as the little-endian reading of its
 * network-byte-order word, so the low byte is the first octet. The image ships
 * for amd64 and arm64 only; on a big-endian host this misreads into an address
 * outside `GATEWAY_AUTO_TRUST_RANGE`, which fails closed. */
function routeHexToIpv4(value: string | undefined): number | null {
  if (value == null || !/^[0-9a-fA-F]{8}$/.test(value)) {
    return null;
  }
  const raw = Number.parseInt(value, 16) >>> 0;
  return (
    (((raw & 0xff) << 24) |
      (((raw >>> 8) & 0xff) << 16) |
      (((raw >>> 16) & 0xff) << 8) |
      ((raw >>> 24) & 0xff)) >>>
    0
  );
}

function formatIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    ".",
  );
}

function isEnvEnabled(value: string | undefined): boolean {
  return value?.trim() === "1";
}

function ipv4CidrContains(cidr: string, address: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number.parseInt(bitsRaw ?? "", 10);
  const baseInt = ipv4ToInt(base ?? "");
  const addressInt = ipv4ToInt(address);
  if (baseInt == null || addressInt == null || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (baseInt & mask) === (addressInt & mask);
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    !octets.every((octet, index) => String(octet) === parts[index] && octet >= 0 && octet <= 255)
  ) {
    return null;
  }
  return (
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0
  );
}

function normalizeHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isIpv4Loopback(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  return (
    octets.every((octet, index) => String(octet) === parts[index] && octet >= 0 && octet <= 255) &&
    octets[0] === 127
  );
}

function requireJsonRequest(request: Request): Response | null {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json"
    ? null
    : json({ error: "content-type must be application/json" }, 415);
}

/** Shells returned from here deny framing. Note this covers only the fallback
 * shell built by this handler: `serve()` answers the UI paths from Bun's
 * HTMLBundle routes, which emit their own fixed headers and cannot carry these,
 * so the SPA itself refuses to render when framed (src/ui/frame-guard.ts). */
function html(value: string): Response {
  return new Response(value, {
    headers: {
      "content-security-policy": "frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function integerParam(url: URL, name: string, fallback: number, allowZero = false): number {
  const raw = url.searchParams.get(name);
  if (raw == null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && (parsed > 0 || (allowZero && parsed === 0)) ? parsed : fallback;
}

function parseOperation(value: string | null): Operation | null | false {
  if (value == null || value === "") {
    return null;
  }
  return value === "read" || value === "edit" || value === "write" || value === "delete"
    ? value
    : false;
}

function isUiPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/projects" ||
    pathname === "/sessions" ||
    pathname === "/search" ||
    pathname === "/analytics" ||
    pathname === "/insights" ||
    pathname === "/tools" ||
    pathname === "/files" ||
    pathname === "/settings" ||
    /^\/sessions\/\d+$/.test(pathname)
  );
}

function indexHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>decant</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ui/main.tsx"></script>
  </body>
</html>
`;
}
