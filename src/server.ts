import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { contextWindowForSession } from "./context-window.ts";
import { dateFilterFromSearch } from "./date-filter.ts";
import { ARCHIVE_DIR_MODE, closeDb, openDb, SchemaDriftError } from "./db.ts";
import { refreshDerivedMetadata } from "./derived.ts";
import { DECANT_VERSION } from "./distill.ts";
import { EconomicsCache, type EconomicsCacheOptions } from "./economics-cache.ts";
import type { Operation } from "./enrich.ts";
import type { sync as ingestSync, SyncProgress, SyncReport } from "./ingest.ts";
import { canLaunch, launchAgent, command as launchCommand, openIde } from "./launcher.ts";
import { exceptionAttributes, logHttpRequest, type StructuredLogger } from "./logging.ts";
import {
  getSession,
  getSessionOutline,
  listProjects,
  listSessions,
  listToolCalls,
  searchPage,
  sessionIngestIssues,
} from "./query.ts";
import {
  list as listRecommendations,
  markImplemented,
  parseStatusFilter,
  STATUS_FILTERS,
} from "./recommendations.ts";
import {
  assembleAnalyticsReport,
  assembleSessionReport,
  renderAnalyticsReport,
  renderSessionReport,
} from "./report/index.ts";
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
  DIMENSIONS,
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
import appleTouchIconPath from "./ui/assets/apple-touch-icon.png" with { type: "file" };
import faviconPath from "./ui/assets/favicon.ico" with { type: "file" };
import uiBundle from "./ui/index.html";
import {
  type SyncRunnerResult,
  type SyncStatusStore,
  startWatch,
  type WatchEvent,
  type WatchHandle,
} from "./watch.ts";

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
  /** Structured operational logger supplied by the CLI entry point. */
  logger?: StructuredLogger;
  /** Test seam: override how the economics cache computes vectors, e.g. to
   * simulate a rebuild that is still in flight when the server is stopped. */
  economicsComputeVectors?: EconomicsCacheOptions["computeVectors"];
  /** Test seam: override the physical sync worker while retaining the server's
   * serialization and progress-coalescing behavior. */
  syncRunner?: SyncWorkerRunner;
}

type Db = ReturnType<typeof openDb>;
type ServerEvent = { type: string };
export type SyncWorkerRunner = (
  config: Config,
  cancel?: { aborted: boolean },
  onProgress?: (progress: SyncProgress) => void,
) => Promise<SyncReport>;
export interface SyncRunHandle {
  promise: Promise<SyncReport>;
  owned: boolean;
}
export interface SyncCoordinator {
  run: SyncWorkerRunner;
  runWithOwnership(
    config: Config,
    cancel?: { aborted: boolean },
    onProgress?: (progress: SyncProgress) => void,
  ): SyncRunHandle;
  close(): Promise<void>;
}
export interface SyncCoordinatorOptions {
  progressEveryFiles?: number;
  progressEveryMs?: number;
  now?: () => number;
}
export type ApiErrorCode =
  | "archive_locked"
  | "cross_origin_write"
  | "forbidden_host"
  | "forbidden_remote"
  | "internal_error"
  | "invalid_files_query"
  | "invalid_request"
  | "invalid_session_id"
  | "launch_failed"
  | "launch_unsupported_platform"
  | "malformed_body"
  | "not_found"
  | "query_required"
  | "recommendation_not_found"
  | "schema_drift"
  | "schema_too_new"
  | "schema_too_old"
  | "service_starting"
  | "session_not_found"
  | "unknown_dimension"
  | "unknown_status"
  | "unsupported_media_type";

interface ApiError {
  code: ApiErrorCode;
  message: string;
  extras?: Record<string, unknown>;
  status: number;
}

class RequestBodyError extends Error {
  constructor() {
    super("request body must be valid JSON");
    this.name = "RequestBodyError";
  }
}

interface RequestContext {
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
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      return embeddedAsset(faviconPath, "image/x-icon");
    }
    if (request.method === "GET" && url.pathname === "/apple-touch-icon.png") {
      return embeddedAsset(appleTouchIconPath, "image/png");
    }
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
        version: DECANT_VERSION,
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
        return errorResponse(
          "invalid_request",
          "agent and prompt are required",
          { ok: false },
          400,
        );
      }
      const result = launchAgent(body.agent, body.prompt, body.key ?? null, getSettings(), {
        platform: context.launchPlatform,
      });
      if (result.ok) {
        return json(result);
      }
      const command = result.command ?? launchCommand(body.agent, body.prompt);
      return errorResponse(
        isUnsupportedLaunchError(result.error) ? "launch_unsupported_platform" : "launch_failed",
        result.error ?? "launch failed",
        { ok: false, ...(command == null ? {} : { command }) },
        400,
      );
    }
    if (request.method === "POST" && url.pathname === "/api/launch/ide") {
      const contentTypeFailure = requireJsonRequest(request);
      if (contentTypeFailure != null) {
        return contentTypeFailure;
      }
      const body = await readJson<{ dir?: string }>(request);
      if (body.dir == null || body.dir.trim() === "") {
        return errorResponse("invalid_request", "dir is required", { ok: false }, 400);
      }
      const result = openIde(body.dir, getSettings(), { platform: context.launchPlatform });
      return result.ok
        ? json(result)
        : errorResponse(
            isUnsupportedLaunchError(result.error)
              ? "launch_unsupported_platform"
              : "launch_failed",
            result.error ?? "launch failed",
            { ok: false, ...(result.command == null ? {} : { command: result.command }) },
            400,
          );
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
      return await syncNow(
        config,
        context.economics,
        context.runSync,
        context.syncCoordinator?.runWithOwnership,
      );
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
    const possibleSessionRoute = url.pathname.match(
      /^\/api\/sessions\/([^/]+)(?:\/(?:token-economics|context-window|outline|issues))?$/,
    );
    if (
      request.method === "GET" &&
      possibleSessionRoute != null &&
      !isValidSessionId(possibleSessionRoute[1] ?? "")
    ) {
      return errorResponse("invalid_session_id", "invalid session id", {}, 400);
    }
    const sessionEconomicsMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/token-economics$/);
    if (request.method === "GET" && sessionEconomicsMatch != null) {
      return withDb(config, context, (db) => {
        const economics = tokenEconomicsForSession(db, Number(sessionEconomicsMatch[1]));
        return economics == null ? sessionNotFound(db) : json(economics);
      });
    }
    const contextWindowMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/context-window$/);
    if (request.method === "GET" && contextWindowMatch != null) {
      return withDb(config, context, (db) => {
        const timeline = contextWindowForSession(db, Number(contextWindowMatch[1]));
        return timeline == null ? sessionNotFound(db) : json(timeline);
      });
    }
    const sessionOutlineMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/outline$/);
    if (request.method === "GET" && sessionOutlineMatch != null) {
      return withDb(config, context, (db) => {
        const outline = getSessionOutline(db, Number(sessionOutlineMatch[1]));
        return outline == null ? sessionNotFound(db) : json(outline);
      });
    }
    const sessionIssuesMatch = url.pathname.match(/^\/api\/sessions\/(\d+)\/issues$/);
    if (request.method === "GET" && sessionIssuesMatch != null) {
      return withDb(config, context, (db) => {
        const issues = sessionIngestIssues(db, Number(sessionIssuesMatch[1]));
        return issues == null ? sessionNotFound(db) : json(issues);
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
        return detail == null ? sessionNotFound(db) : json(detail);
      });
    }
    if (request.method === "POST" && url.pathname === "/api/search") {
      const contentTypeFailure = requireJsonRequest(request);
      if (contentTypeFailure != null) {
        return contentTypeFailure;
      }
      const body = await readJson<{
        query?: string;
        tool?: string | null;
        project?: string | null;
        include_subagents?: boolean;
        from?: string | null;
        to?: string | null;
        limit?: number;
        offset?: number;
      }>(request);
      if (typeof body.query !== "string" || body.query.trim() === "") {
        return errorResponse("query_required", "query is required", {}, 400);
      }
      const query = body.query;
      return withDb(config, context, (db) => {
        return json(
          searchPage(db, query, {
            tool: body.tool,
            project: body.project,
            includeSubagents: body.include_subagents === true,
            from: body.from,
            to: body.to,
            limit: body.limit,
            offset: body.offset,
          }),
        );
      });
    }
    if (request.method === "GET" && url.pathname === "/api/stats/summary") {
      return withDb(config, context, (db) => json(totals(db, dateFilter)));
    }
    if (request.method === "GET" && url.pathname === "/api/stats/by-dimension") {
      const dimension = parseDimension(url.searchParams.get("dim") ?? "");
      if (dimension == null) {
        return errorResponse(
          "unknown_dimension",
          "unknown dimension",
          { allowed: DIMENSIONS },
          400,
        );
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
    if (request.method === "GET" && url.pathname === "/api/reports/analytics.html") {
      return withDb(config, context, (db) =>
        reportHtmlResponse(
          renderAnalyticsReport(assembleAnalyticsReport(db, { filter: dateFilter })),
          "decant-analytics-report.html",
        ),
      );
    }
    const possibleSessionReportRoute = url.pathname.match(
      /^\/api\/reports\/session\/([^/]+)\.html$/,
    );
    if (
      request.method === "GET" &&
      possibleSessionReportRoute != null &&
      !isValidSessionId(possibleSessionReportRoute[1] ?? "")
    ) {
      return errorResponse("invalid_session_id", "invalid session id", {}, 400);
    }
    const sessionReportMatch = url.pathname.match(/^\/api\/reports\/session\/(\d+)\.html$/);
    if (request.method === "GET" && sessionReportMatch != null) {
      return withDb(config, context, (db) => {
        const report = assembleSessionReport(db, Number(sessionReportMatch[1]));
        if (report == null) {
          return sessionNotFound(db);
        }
        return reportHtmlResponse(
          renderSessionReport(report),
          `decant-session-${report.summary.id}-${reportFilenamePart(report.summary.title)}.html`,
        );
      });
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
        return errorResponse("invalid_files_query", "invalid files query", {}, 400);
      }
      return withDb(config, context, (db) =>
        json(fileHotspots(db, group, op, integerParam(url, "limit", 25), dateFilter)),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/tools/calls") {
      const sessionValue = url.searchParams.get("session");
      if (sessionValue != null && !isValidSessionId(sessionValue)) {
        return errorResponse("invalid_request", "session must be a positive integer", {}, 400);
      }
      const minMsValue = url.searchParams.get("min_ms");
      if (minMsValue != null && !isNonNegativeInteger(minMsValue)) {
        return errorResponse("invalid_request", "min_ms must be a non-negative integer", {}, 400);
      }
      const errorsOnlyValue = url.searchParams.get("errors_only");
      if (errorsOnlyValue != null && errorsOnlyValue !== "true" && errorsOnlyValue !== "false") {
        return errorResponse("invalid_request", "errors_only must be true or false", {}, 400);
      }
      return withDb(config, context, (db) =>
        json(
          listToolCalls(db, {
            tool: url.searchParams.get("tool"),
            server: url.searchParams.get("server"),
            errorsOnly: errorsOnlyValue === "true",
            sessionId: sessionValue == null ? null : Number(sessionValue),
            project: url.searchParams.get("project"),
            ...dateFilter,
            minMs: minMsValue == null ? null : Number(minMsValue),
            limit: integerParam(url, "limit", 50),
            offset: integerParam(url, "offset", 0, true),
          }),
        ),
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
        return errorResponse("unknown_status", "unknown status", { allowed: STATUS_FILTERS }, 400);
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
        return errorResponse("invalid_request", "key is required", {}, 400);
      }
      return withDb(config, context, (db) => {
        const ok = markImplemented(db, body.key as string, body.source ?? "agent", body.note);
        return ok
          ? json({ ok: true, key: body.key, status: "implemented" })
          : errorResponse(
              "recommendation_not_found",
              "recommendation not found",
              { ok: false, key: body.key },
              404,
            );
      });
    }
    if (request.method === "GET" && isUiPath(url.pathname)) {
      return html(indexHtml());
    }
    return errorResponse("not_found", "not found", {}, 404);
  } catch (error) {
    const response = responseForError(error);
    if (response.status >= 500) {
      context.logger?.error("HTTP request failed.", {
        "event.name": "http.server.request.exception",
        "http.request.method": request.method,
        "url.path": url.pathname,
        ...exceptionAttributes(error),
      });
    } else {
      context.logger?.warning("HTTP request rejected.", {
        "event.name": "http.server.request.rejected",
        "http.request.method": request.method,
        "http.response.status_code": response.status,
        "url.path": url.pathname,
      });
    }
    return response;
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

async function syncNow(
  config: Config,
  economics?: EconomicsCache,
  runSync: SyncWorkerRunner = runSyncWorker,
  runWithOwnership?: SyncCoordinator["runWithOwnership"],
): Promise<Response> {
  const progress = (update: SyncProgress): void => {
    publishServerEvent({
      type: "sync_progress",
      reason: "manual",
      progress: update,
      status: { ...syncStatus },
    });
  };
  const handle =
    runWithOwnership?.(config, undefined, progress) ??
    ({ promise: runSync(config, undefined, progress), owned: true } satisfies SyncRunHandle);
  if (handle.owned) {
    syncStatus.in_progress = true;
    syncStatus.last_error = null;
  }
  try {
    const report = await handle.promise;
    if (!handle.owned) {
      return json(report);
    }
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
    if (handle.owned) {
      syncStatus.in_progress = false;
      syncStatus.last_sync_at = new Date().toISOString();
      syncStatus.last_error = error instanceof Error ? error.message : String(error);
    }
    throw error;
  }
}

function runSyncWorker(
  config: Config,
  cancel?: { aborted: boolean },
  onProgress?: (progress: SyncProgress) => void,
): Promise<ReturnType<typeof ingestSync>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sync-worker.ts", import.meta.url), { type: "module" });
    const cancelBuffer =
      cancel == null ? null : new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancelView = cancelBuffer == null ? null : new Int32Array(cancelBuffer);
    let cancelPoll: Timer | null = null;
    const settle = (): void => {
      if (cancelPoll != null) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
    };
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { type: "progress"; progress: SyncProgress }
        | { type: "complete"; ok: true; report: ReturnType<typeof ingestSync> }
        | { type: "complete"; ok: false; error: string };
      if (data.type === "progress") {
        onProgress?.(data.progress);
        return;
      }
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
      // Share cancellation with the worker so it can stop between files and
      // close SQLite itself. Terminating a worker while it owns a native
      // connection can race Bun's SQLite finalizers during server shutdown.
      if (cancel.aborted && cancelView != null) {
        Atomics.store(cancelView, 0, 1);
      }
      cancelPoll = setInterval(() => {
        if (cancel.aborted && cancelView != null) {
          Atomics.store(cancelView, 0, 1);
        }
      }, 150);
    }
    worker.postMessage({ config, cancelBuffer });
  });
}

/**
 * Owns the one physical sync worker allowed per server. Overlapping watcher and
 * manual requests join the same Promise instead of opening competing SQLite
 * writers. Progress is fanned out at a bounded cadence while retaining the
 * first update and the final update observed before completion.
 */
export function createSyncCoordinator(
  worker: SyncWorkerRunner = runSyncWorker,
  options: SyncCoordinatorOptions = {},
): SyncCoordinator {
  const progressEveryFiles = Math.max(1, options.progressEveryFiles ?? 25);
  const progressEveryMs = Math.max(0, options.progressEveryMs ?? 250);
  const now = options.now ?? (() => performance.now());
  const ownedCancel = { aborted: false };
  let closed = false;
  let active: {
    promise: Promise<SyncReport>;
    listeners: Set<(progress: SyncProgress) => void>;
    cancelSources: Set<{ aborted: boolean }>;
  } | null = null;

  const start = (
    config: Config,
    cancel?: { aborted: boolean },
    onProgress?: (progress: SyncProgress) => void,
    listenWhenJoined = true,
  ): SyncRunHandle => {
    if (closed) {
      return {
        promise: Promise.reject(new Error("sync coordinator is closed")),
        owned: false,
      };
    }
    if (active != null) {
      if (cancel != null) {
        active.cancelSources.add(cancel);
      }
      if (listenWhenJoined && onProgress != null) {
        active.listeners.add(onProgress);
      }
      return { promise: active.promise, owned: false };
    }

    const listeners = new Set<(progress: SyncProgress) => void>();
    const cancelSources = new Set<{ aborted: boolean }>([ownedCancel]);
    if (cancel != null) {
      cancelSources.add(cancel);
    }
    if (onProgress != null) {
      listeners.add(onProgress);
    }
    const sharedCancel = {
      get aborted(): boolean {
        return [...cancelSources].some((source) => source.aborted);
      },
    };
    let lastEmitted: SyncProgress | null = null;
    let lastEmittedAt = Number.NEGATIVE_INFINITY;
    let pending: SyncProgress | null = null;

    const flush = (): void => {
      if (pending == null) {
        return;
      }
      const progress = pending;
      pending = null;
      lastEmitted = progress;
      lastEmittedAt = now();
      for (const listener of [...listeners]) {
        try {
          listener(progress);
        } catch {
          // Progress reporting must never fail the archive sync itself.
        }
      }
    };
    const forward = (progress: SyncProgress): void => {
      pending = progress;
      const first = lastEmitted == null;
      const terminal = progress.scanned >= progress.total;
      const advancedEnough =
        lastEmitted != null && progress.scanned - lastEmitted.scanned >= progressEveryFiles;
      const waitedEnough = now() - lastEmittedAt >= progressEveryMs;
      if (first || terminal || advancedEnough || waitedEnough) {
        flush();
      }
    };

    let promise: Promise<SyncReport>;
    promise = Promise.resolve()
      .then(() => worker(config, sharedCancel, forward))
      .then(
        (report) => {
          flush();
          return report;
        },
        (error) => {
          flush();
          throw error;
        },
      )
      .finally(() => {
        if (active?.promise === promise) {
          active = null;
        }
      });
    active = { promise, listeners, cancelSources };
    return { promise, owned: true };
  };
  const run: SyncWorkerRunner = (config, cancel, onProgress) =>
    start(config, cancel, onProgress).promise;
  const runWithOwnership: SyncCoordinator["runWithOwnership"] = (config, cancel, onProgress) =>
    start(config, cancel, onProgress, false);

  const close = async (): Promise<void> => {
    closed = true;
    ownedCancel.aborted = true;
    try {
      await active?.promise;
    } catch {
      // The request or watcher that started the run owns its user-facing
      // failure. Shutdown only needs to wait until the worker has released its
      // SQLite connection.
    }
  };

  return { run, runWithOwnership, close };
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
    routes: {
      "/favicon.ico": new Response(Bun.file(faviconPath), {
        headers: { "cache-control": "public, max-age=86400", "content-type": "image/x-icon" },
      }),
      "/apple-touch-icon.png": new Response(Bun.file(appleTouchIconPath), {
        headers: { "cache-control": "public, max-age=86400", "content-type": "image/png" },
      }),
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
      "/reports/analytics": uiBundle,
      "/reports/session/:id": uiBundle,
    },
    fetch: async (request, bunServer) => {
      const startedAt = performance.now();
      const requestLogger = options.logger?.with({ "request.id": crypto.randomUUID() });
      const activeDb = db;
      const activeEconomics = economics;
      if (activeDb == null || activeEconomics == null) {
        return errorResponse(
          "service_starting",
          "Decant is still starting. Please try again.",
          { retryable: true },
          503,
        );
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

/** Runs one watcher-triggered sync in a worker thread, keeping request
 * handling responsive while multi-second ingests run. */
async function workerSyncRunner(
  config: Config,
  status: SyncStatusStore,
  cancel: { aborted: boolean },
  onProgress: (progress: SyncProgress) => void,
  runSync: SyncCoordinator["runWithOwnership"] = (workerConfig, workerCancel, workerProgress) => ({
    promise: runSyncWorker(workerConfig, workerCancel, workerProgress),
    owned: true,
  }),
): Promise<SyncRunnerResult> {
  status.start();
  try {
    const handle = runSync(config, cancel, onProgress);
    const report = await handle.promise;
    status.finishOk(report);
    return { report, emitTerminal: handle.owned };
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
    closeDb(db);
  }
}

function ensureDerivedMetadata(db: Db): void {
  if (metadataHydrated.has(db)) {
    return;
  }
  refreshDerivedMetadata(db, { ignoreReadonly: true });
  metadataHydrated.add(db);
}

export function errorResponse(
  code: ApiErrorCode,
  message: string,
  extras: Record<string, unknown> = {},
  status = 400,
): Response {
  return json({ error: message, code, ...extras }, status);
}

function responseForError(error: unknown): Response {
  const mapped = classifyError(error);
  return errorResponse(mapped.code, mapped.message, mapped.extras, mapped.status);
}

function classifyError(error: unknown): ApiError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RequestBodyError) {
    return { code: "malformed_body", message, status: 400 };
  }
  if (error instanceof SchemaDriftError) {
    return { code: "schema_drift", message, status: 409 };
  }
  const normalized = message.toLowerCase();
  if (normalized.includes("is newer than this build supports")) {
    return { code: "schema_too_new", message, status: 409 };
  }
  if (normalized.includes("predates this build's baseline")) {
    return { code: "schema_too_old", message, status: 409 };
  }
  if (isArchiveLockedError(error, normalized)) {
    return {
      code: "archive_locked",
      message: "Session logs are temporarily busy. Please try again.",
      extras: { retryable: true },
      status: 503,
    };
  }
  return {
    code: "internal_error",
    message: "Decant could not complete this request.",
    status: 500,
  };
}

function isArchiveLockedError(error: unknown, normalizedMessage: string): boolean {
  const code =
    typeof error === "object" && error != null && "code" in error
      ? String((error as { code?: unknown }).code).toUpperCase()
      : "";
  return (
    code.startsWith("SQLITE_BUSY") ||
    code.startsWith("SQLITE_LOCKED") ||
    normalizedMessage.includes("database is locked") ||
    normalizedMessage.includes("database table is locked") ||
    normalizedMessage.includes("database is busy")
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
    return errorResponse("forbidden_host", "forbidden host", {}, 403);
  }
  const boundToLoopback = isLoopbackHost(context.boundHostname ?? "127.0.0.1");
  if (
    !boundToLoopback &&
    !isLoopbackPeer(context.remoteAddress) &&
    !isTrustedPeer(context.remoteAddress, context.trustedPeers ?? [])
  ) {
    return errorResponse("forbidden_remote", "forbidden remote", {}, 403);
  }
  if (isMutatingMethod(request.method) && !isAllowedWriteRequest(request, boundToLoopback)) {
    return errorResponse("cross_origin_write", "cross-origin writes are forbidden", {}, 403);
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
    : errorResponse("unsupported_media_type", "content-type must be application/json", {}, 415);
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

function reportHtmlResponse(value: string, filename: string): Response {
  return new Response(value, {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function reportFilenamePart(value: string | null): string {
  const normalized = (value ?? "report")
    .normalize("NFKD")
    .replaceAll(/[^a-zA-Z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64);
  return normalized === "" ? "report" : normalized;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new RequestBodyError();
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

function isValidSessionId(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0;
}

function isNonNegativeInteger(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0;
}

function sessionNotFound(db: Db): Response {
  const archiveEmpty =
    (
      db.query("SELECT NOT EXISTS (SELECT 1 FROM session LIMIT 1) AS empty").get() as {
        empty: number;
      }
    ).empty === 1;
  return errorResponse(
    "session_not_found",
    "session not found",
    { archive_empty: archiveEmpty },
    404,
  );
}

function isUnsupportedLaunchError(error: string | undefined): boolean {
  return error?.includes("only supported on macOS") ?? false;
}

function isUiPath(pathname: string): boolean {
  return !pathname.startsWith("/api/") && !/\/[^/]*\.[^/]+$/.test(pathname);
}

function indexHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      name="description"
      content="Local-first analytics for Claude Code and Codex sessions. Search transcripts, inspect cost and context, and turn repeated work into durable agent knowledge."
    />
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48 256x256" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
    <title>Decant</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/ui/main.tsx"></script>
  </body>
</html>
`;
}

function embeddedAsset(path: string, contentType: string): Response {
  return new Response(Bun.file(path), {
    headers: {
      "cache-control": "public, max-age=86400",
      "content-type": contentType,
    },
  });
}
