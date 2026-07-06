import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { dateFilterFromSearch } from "./date-filter.ts";
import { openDb } from "./db.ts";
import { refreshDerivedMetadata } from "./derived.ts";
import type { Operation } from "./enrich.ts";
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
import { runSyncWorker } from "./sync-runner.ts";
import { tokenEconomics, tokenEconomicsForSession } from "./token-economics.ts";
import uiBundle from "./ui/index.html";

export const DEFAULT_SERVE_HOST = "127.0.0.1";
export const DEFAULT_SERVE_PORT = 3000;

export interface ServeOptions {
  config: Config;
  port?: number;
  hostname?: string;
  trustedPeers?: string[];
  onConfigChanged?: (config: Config) => void;
}

type Db = ReturnType<typeof openDb>;
type ServerEvent = { type: string };
interface RequestContext {
  db?: Db;
  boundHostname?: string;
  remoteAddress?: string | null;
  trustedPeers?: string[];
  onConfigChanged?: (config: Config) => void;
  getSettings?: typeof getSettings;
  launchAgent?: typeof launchAgent;
  openIde?: typeof openIde;
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
        cursorDir: config.cursorDir,
        cursorChatsDir: config.cursorChatsDir,
        cursorChatsEnabled: config.cursorChatsEnabled,
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
      const saved = saveSettings(body);
      config.cursorChatsEnabled = saved.experimental.cursorChats;
      context.onConfigChanged?.(config);
      publishServerEvent({
        type: "config_changed",
        cursorChatsEnabled: config.cursorChatsEnabled,
      } as ServerEvent);
      return json({ ...settingsResponse(saved), saved: true });
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
      const settings = (context.getSettings ?? getSettings)();
      const result = (context.launchAgent ?? launchAgent)(
        body.agent,
        body.prompt,
        body.key ?? null,
        settings,
      );
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
      const result = (context.openIde ?? openIde)(body.dir, (context.getSettings ?? getSettings)());
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
      return await syncNow(config);
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
      return withDb(config, context, (db) => json(listProjects(db)), {
        hydrateMetadata: true,
      });
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

async function syncNow(config: Config): Promise<Response> {
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
  const trustedPeers = options.trustedPeers ?? parsePeerList(process.env.DECANT_TRUSTED_PEERS);
  mkdirSync(dirname(options.config.dbPath), { recursive: true });
  const db = openDb(options.config.dbPath);
  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 255,
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
        boundHostname: hostname,
        remoteAddress: bunServer.requestIP(request)?.address ?? null,
        trustedPeers,
        onConfigChanged: options.onConfigChanged,
      }),
  });
  const stop = server.stop.bind(server);
  let closed = false;
  server.stop = async (closeActiveConnections?: boolean): Promise<void> => {
    try {
      await stop(closeActiveConnections);
    } finally {
      if (!closed) {
        closed = true;
        db.close();
      }
    }
  };
  return server;
}

function withDb(
  config: Config,
  context: RequestContext,
  callback: (db: Db) => Response,
  options: { hydrateMetadata?: boolean } = {},
): Response {
  if (context.db != null) {
    if (options.hydrateMetadata === true) {
      ensureDerivedMetadata(context.db);
    }
    return callback(context.db);
  }
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDb(config.dbPath);
  try {
    if (options.hydrateMetadata === true) {
      ensureDerivedMetadata(db);
    }
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
  return new Response(JSON.stringify(value), {
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

function html(value: string): Response {
  return new Response(value, {
    headers: { "content-type": "text/html; charset=utf-8" },
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
