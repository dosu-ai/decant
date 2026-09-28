import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { SESSION_LIST_MAX_LIMIT, USAGE_LIST_MAX_LIMIT } from "./api-limits.ts";
import type { Config } from "./config.ts";
import { contextWindowForSession } from "./context-window.ts";
import { dateFilterFromSearch } from "./date-filter.ts";
import {
  ARCHIVE_DIR_MODE,
  closeDb,
  openDb,
  SchemaDriftError,
  SchemaTooNewError,
  SchemaTooOldError,
} from "./db.ts";
import { refreshDerivedMetadata } from "./derived.ts";
import { parseFileOperation } from "./distill.ts";
import { EconomicsCache, type EconomicsCacheOptions } from "./economics-cache.ts";
import type { sync as ingestSync, SyncProgress, SyncReport } from "./ingest.ts";
import {
  canLaunch,
  isSafeRecommendationKey,
  launchAgent,
  command as launchCommand,
  openIde,
} from "./launcher.ts";
import { exceptionAttributes, logHttpRequest, type StructuredLogger } from "./logging.ts";
import { openApiDocument } from "./openapi.ts";
import {
  getSession,
  getSessionOutline,
  getSessionSummary,
  listProjects,
  listSessions,
  listToolCalls,
  searchPage,
  sessionIngestIssues,
  sessionSearchIndex,
} from "./query.ts";
import {
  list as listRecommendations,
  markImplemented,
  parseStatusFilter,
  refreshForSessionStateChange,
  STATUS_FILTERS,
} from "./recommendations.ts";
import {
  API_ROUTE_PATHS,
  type ApiRoutePath,
  compileRoutePath,
  type RouteMatcher,
} from "./route-paths.ts";
import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT } from "./serve-defaults.ts";
import { type SessionUserStateUpdate, setSessionUserState } from "./session-user-state.ts";
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
import { DECANT_VERSION } from "./version.ts";
import {
  type SyncRunnerFailure,
  type SyncRunnerResult,
  type SyncStatusStore,
  startWatch,
  type WatchEvent,
  type WatchHandle,
} from "./watch.ts";
import { workerError, workerUrl } from "./worker-runtime.ts";

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

function publishServerEvent<T extends ServerEvent>(event: T): void {
  for (const client of [...eventClients]) {
    try {
      client.send(event);
    } catch {
      client.close();
    }
  }
}

type DateFilter = ReturnType<typeof dateFilterFromSearch>;

interface RouteContext {
  request: Request;
  url: URL;
  config: Config;
  context: RequestContext;
  dateFilter: DateFilter;
  params: { id: string };
}

type RouteResult = Response | Promise<Response>;
type RouteHandler = (ctx: RouteContext) => RouteResult;
interface ObjectBodyEndpoint {
  body: "object";
  rejectExtras?: Record<string, unknown>;
  handle: (ctx: RouteContext, body: Record<string, unknown>) => RouteResult;
}
interface JsonBodyEndpoint {
  body: "json";
  handle: (ctx: RouteContext, body: unknown) => RouteResult;
}
type RouteEndpoint = RouteHandler | ObjectBodyEndpoint | JsonBodyEndpoint;
type RouteMethod = "GET" | "POST";

interface RouteSpec {
  GET?: RouteEndpoint;
  POST?: RouteEndpoint;
  /** Methods for which a malformed `{id}` is a 400 rather than a 404, even
   * when the path has no handler for that method. */
  validateId?: readonly RouteMethod[];
}

const SESSION_ID_METHODS = ["GET", "POST"] as const;

const sessionScoped =
  (compute: (db: Db, id: number, ctx: RouteContext) => unknown): RouteHandler =>
  (ctx) =>
    withDb(ctx.config, ctx.context, (db) => {
      const result = compute(db, Number(ctx.params.id), ctx);
      return result == null ? sessionNotFound(db) : json(result);
    });

const ROUTES: Record<ApiRoutePath, RouteSpec> = {
  "/api/health": { GET: () => json({ ok: true }) },
  "/api/openapi.json": { GET: () => json(openApiDocument(DECANT_VERSION)) },
  "/api/events": { GET: () => eventStream() },
  "/api/config": {
    GET: ({ config }) =>
      json({
        dbPath: config.dbPath,
        claudeDir: config.claudeDir,
        codexDir: config.codexDir,
        geminiDir: config.geminiDir,
        version: DECANT_VERSION,
      }),
  },
  "/api/settings": {
    GET: () => json(settingsResponse()),
    POST: {
      body: "json",
      handle: (_ctx, body) =>
        json({ ...settingsResponse(saveSettings(body as Record<string, unknown>)), saved: true }),
    },
  },
  "/api/launch/agent": {
    POST: { body: "object", rejectExtras: { ok: false }, handle: launchAgentRoute },
  },
  "/api/launch/ide": {
    POST: { body: "object", rejectExtras: { ok: false }, handle: launchIdeRoute },
  },
  "/api/sync-status": { GET: () => syncStatusResponse() },
  "/api/metadata/sync-status": { GET: () => syncStatusResponse() },
  "/api/sync": {
    POST: {
      body: "object",
      handle: ({ config, context }) =>
        syncNow(
          config,
          context.economics,
          context.runSync,
          context.syncCoordinator?.runWithOwnership,
        ),
    },
  },
  "/api/sessions": {
    GET: ({ config, context, url, dateFilter }) =>
      withDb(config, context, (db) =>
        json(
          listSessions(db, {
            tool: url.searchParams.get("tool"),
            model: url.searchParams.get("model"),
            project: url.searchParams.get("project"),
            includeSubagents: url.searchParams.get("include_subagents") === "true",
            includeNestedSubagents: url.searchParams.get("with_subagents") === "true",
            includeArchived: url.searchParams.get("include_archived") === "true",
            limit: Math.min(integerParam(url, "limit", 50), SESSION_LIST_MAX_LIMIT),
            offset: integerParam(url, "offset", 0, true),
            ...dateFilter,
          }),
        ),
      ),
  },
  "/api/sessions/search-index": {
    GET: ({ config, context }) => withDb(config, context, (db) => json(sessionSearchIndex(db))),
  },
  "/api/projects": {
    GET: ({ config, context }) => withDb(config, context, (db) => json(listProjects(db))),
  },
  "/api/sessions/{id}/state": {
    validateId: SESSION_ID_METHODS,
    POST: { body: "json", handle: sessionStateRoute },
  },
  "/api/sessions/{id}/token-economics": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped(tokenEconomicsForSession),
  },
  "/api/sessions/{id}/context-window": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped(contextWindowForSession),
  },
  "/api/sessions/{id}/outline": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped(getSessionOutline),
  },
  "/api/sessions/{id}/issues": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped(sessionIngestIssues),
  },
  "/api/sessions/{id}": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped((db, id, { url }) => {
      const messageLimit = integerParam(url, "message_limit", 0, true);
      return getSession(db, id, {
        messageLimit: messageLimit > 0 ? messageLimit : null,
        messageOffset: integerParam(url, "message_offset", 0, true),
      });
    }),
  },
  "/api/search": { POST: { body: "object", handle: searchRoute } },
  "/api/stats/summary": {
    GET: ({ config, context, url, dateFilter }) =>
      withDb(config, context, (db) =>
        json(
          totals(db, {
            ...dateFilter,
            includeArchived: url.searchParams.get("include_archived") === "true",
            project: url.searchParams.get("project"),
            tool: url.searchParams.get("tool"),
          }),
        ),
      ),
  },
  "/api/stats/by-dimension": {
    GET: ({ config, context, url, dateFilter }) => {
      const dimension = parseDimension(url.searchParams.get("dim") ?? "");
      if (dimension == null) {
        return errorResponse(
          "unknown_dimension",
          "unknown dimension",
          { allowed: DIMENSIONS },
          400,
        );
      }
      return withDb(config, context, (db) =>
        json(
          byDimension(db, dimension, {
            ...dateFilter,
            includeArchived: url.searchParams.get("include_archived") === "true",
            project: url.searchParams.get("project"),
            tool: url.searchParams.get("tool"),
          }),
        ),
      );
    },
  },
  "/api/analytics/activity": {
    GET: ({ config, context, dateFilter }) =>
      withDb(config, context, (db) => json(activityStats(db, dateFilter))),
  },
  "/api/analytics/model-sparklines": {
    GET: ({ config, context, dateFilter }) =>
      withDb(config, context, (db) => json(modelSparklines(db, dateFilter))),
  },
  "/api/analytics/token-economics": {
    GET: async ({ config, context, dateFilter }) => {
      if (context.economics != null) {
        return json(await context.economics.get(dateFilter));
      }
      return withDb(config, context, (db) => json(tokenEconomics(db, dateFilter)));
    },
  },
  "/api/analytics/now": {
    GET: ({ config, context }) =>
      withDb(config, context, (db) =>
        json({
          today: todayTotals(db),
          active_sessions: [],
          last_sync_at: syncStatus.last_sync_at,
          sync_in_progress: syncStatus.in_progress,
        }),
      ),
  },
  "/api/reports/analytics.html": {
    GET: async ({ config, context, dateFilter }) => {
      const { assembleAnalyticsReport, renderAnalyticsReport } = await import("./report/index.ts");
      return withDb(config, context, (db) =>
        reportHtmlResponse(
          renderAnalyticsReport(assembleAnalyticsReport(db, { filter: dateFilter })),
          "decant-analytics-report.html",
        ),
      );
    },
  },
  "/api/reports/session/{id}.html": {
    validateId: ["GET"],
    GET: async ({ config, context, params }) => {
      const { assembleSessionReport, renderSessionReport } = await import("./report/index.ts");
      return withDb(config, context, (db) => {
        const report = assembleSessionReport(db, Number(params.id));
        if (report == null) {
          return sessionNotFound(db);
        }
        return reportHtmlResponse(
          renderSessionReport(report),
          `decant-session-${report.summary.id}-${reportFilenamePart(report.summary.title)}.html`,
        );
      });
    },
  },
  "/api/date-bounds": {
    GET: ({ config, context }) => withDb(config, context, (db) => json(dateBounds(db))),
  },
  "/api/metadata/date-bounds": {
    GET: ({ config, context }) => withDb(config, context, (db) => json(dateBounds(db))),
  },
  "/api/files": { GET: filesRoute },
  "/api/tools/calls": { GET: toolCallsRoute },
  "/api/tools/usage": {
    GET: ({ config, context, url, dateFilter }) =>
      withDb(config, context, (db) =>
        json(
          toolUsage(
            db,
            url.searchParams.get("errors_only") === "true",
            usageLimit(url, 50),
            dateFilter,
          ),
        ),
      ),
  },
  "/api/tools/mcp-usage": {
    GET: ({ config, context, url, dateFilter }) =>
      withDb(config, context, (db) => json(mcpUsage(db, usageLimit(url, 50), dateFilter))),
  },
  "/api/recommendations": {
    GET: ({ config, context, url }) => {
      const status = parseStatusFilter(url.searchParams.get("status") ?? "open");
      if (status == null) {
        return errorResponse("unknown_status", "unknown status", { allowed: STATUS_FILTERS }, 400);
      }
      return withDb(config, context, (db) => json(listRecommendations(db, status)));
    },
  },
  "/api/recommendations/mark": { POST: { body: "object", handle: markRecommendationRoute } },
};

interface CompiledRoute extends RouteMatcher {
  spec: RouteSpec;
}

const COMPILED_ROUTES: CompiledRoute[] = API_ROUTE_PATHS.map((path) => ({
  ...compileRoutePath(path),
  spec: ROUTES[path],
}));

async function dispatch(ctx: Omit<RouteContext, "params">): Promise<Response> {
  const { method } = ctx.request;
  if (method !== "GET" && method !== "POST") {
    return notFoundResponse();
  }
  for (const route of COMPILED_ROUTES) {
    const match = route.pattern.exec(ctx.url.pathname);
    if (match == null) {
      continue;
    }
    const id = match[1] ?? "";
    if (route.spec.validateId?.includes(method) && !isValidSessionId(id)) {
      return errorResponse("invalid_session_id", "invalid session id", {}, 400);
    }
    const endpoint = route.spec[method];
    if (endpoint == null) {
      continue;
    }
    const routeCtx = { ...ctx, params: { id } };
    if (typeof endpoint === "function") {
      return await endpoint(routeCtx);
    }
    const parsed =
      endpoint.body === "object"
        ? await readJsonBody(ctx.request, endpoint.rejectExtras)
        : await readJsonBody(ctx.request, null);
    if (parsed instanceof Response) {
      return parsed;
    }
    return await (endpoint.handle as (ctx: RouteContext, body: unknown) => RouteResult)(
      routeCtx,
      parsed.body,
    );
  }
  return notFoundResponse();
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
    return await dispatch({ request, url, config, context, dateFilter });
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

function notFoundResponse(): Response {
  return errorResponse("not_found", "not found", {}, 404);
}

function syncStatusResponse(): Response {
  return json({ ...syncStatus, timestamp: new Date().toISOString() });
}

async function launchAgentRoute(
  { context }: RouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const { agent, prompt, key } = body;
  if (
    typeof agent !== "string" ||
    agent.trim() === "" ||
    typeof prompt !== "string" ||
    prompt.trim() === ""
  ) {
    return errorResponse("invalid_request", "agent and prompt are required", { ok: false }, 400);
  }
  if (key != null && typeof key !== "string") {
    return errorResponse("invalid_request", "key must be a string or null", { ok: false }, 400);
  }
  if (key != null && key !== "" && !isSafeRecommendationKey(key)) {
    return errorResponse(
      "invalid_request",
      "key contains unsupported characters",
      { ok: false },
      400,
    );
  }
  const result = await launchAgent(agent, prompt, key ?? null, getSettings(), {
    platform: context.launchPlatform,
  });
  if (result.ok) {
    return json(result);
  }
  const command = result.command ?? launchCommand(agent, prompt);
  return errorResponse(
    isUnsupportedLaunchError(result.error) ? "launch_unsupported_platform" : "launch_failed",
    result.error ?? "launch failed",
    { ok: false, ...(command == null ? {} : { command }) },
    400,
  );
}

async function launchIdeRoute(
  { config, context }: RouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const { dir } = body;
  if (typeof dir !== "string" || dir.trim() === "") {
    return errorResponse("invalid_request", "dir is required", { ok: false }, 400);
  }
  if (!isAbsolute(dir)) {
    return errorResponse("invalid_request", "dir must be an absolute path", { ok: false }, 400);
  }
  if (!isKnownProjectDir(config, context, dir)) {
    return errorResponse(
      "invalid_request",
      "dir is not a project in the archive",
      { ok: false },
      400,
    );
  }
  const result = await openIde(dir, getSettings(), { platform: context.launchPlatform });
  return result.ok
    ? json(result)
    : errorResponse(
        isUnsupportedLaunchError(result.error) ? "launch_unsupported_platform" : "launch_failed",
        result.error ?? "launch failed",
        { ok: false, ...(result.command == null ? {} : { command: result.command }) },
        400,
      );
}

function sessionStateRoute({ config, context, params }: RouteContext, rawBody: unknown): Response {
  const state = isJsonObject(rawBody) ? rawBody.state : undefined;
  const allowed = ["archived", "deleted", "visible"] as const;
  if (!allowed.includes(state as SessionUserStateUpdate)) {
    return errorResponse(
      "invalid_request",
      "state must be archived, deleted, or visible",
      { allowed },
      400,
    );
  }
  const id = Number(params.id);
  return withDb(config, context, (db) => {
    const changed = setSessionUserState(db, id, state as SessionUserStateUpdate, {
      afterApply: () =>
        refreshForSessionStateChange(db, {
          alreadyInTransaction: true,
        }),
    });
    if (!changed) {
      return sessionNotFound(db);
    }
    context.economics?.invalidate();
    publishServerEvent({ type: "archive_updated", reason: "session_state" });
    if (state === "deleted") {
      return json({ ok: true, id, state });
    }
    const summary = getSessionSummary(db, id);
    return json({
      ok: true,
      id,
      state,
      user_state: summary?.user_state ?? null,
      is_user_archived: summary?.is_user_archived ?? false,
    });
  });
}

function searchRoute({ config, context }: RouteContext, body: Record<string, unknown>): Response {
  if (typeof body.query !== "string" || body.query.trim() === "") {
    return errorResponse("query_required", "query is required", {}, 400);
  }
  for (const field of ["tool", "project", "from", "to"] as const) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return errorResponse("invalid_request", `${field} must be a string or null`, {}, 400);
    }
  }
  for (const field of ["include_subagents", "include_total"] as const) {
    if (field in body && typeof body[field] !== "boolean") {
      return errorResponse("invalid_request", `${field} must be a boolean`, {}, 400);
    }
  }
  if (
    body.limit !== undefined &&
    (!Number.isSafeInteger(body.limit) ||
      (body.limit as number) < 1 ||
      (body.limit as number) > 100)
  ) {
    return errorResponse("invalid_request", "limit must be an integer from 1 to 100", {}, 400);
  }
  if (
    body.offset !== undefined &&
    (!Number.isSafeInteger(body.offset) || (body.offset as number) < 0)
  ) {
    return errorResponse("invalid_request", "offset must be a non-negative integer", {}, 400);
  }
  const query = body.query;
  const tool = body.tool as string | null | undefined;
  const project = body.project as string | null | undefined;
  const includeSubagents = body.include_subagents as boolean | undefined;
  const includeTotal = body.include_total as boolean | undefined;
  const from = body.from as string | null | undefined;
  const to = body.to as string | null | undefined;
  const limit = body.limit as number | undefined;
  const offset = body.offset as number | undefined;
  return withDb(config, context, (db) => {
    return json(
      searchPage(db, query, {
        tool,
        project,
        includeSubagents: includeSubagents === true,
        includeTotal: includeTotal !== false,
        from,
        to,
        limit,
        offset,
      }),
    );
  });
}

function filesRoute({ config, context, url, dateFilter }: RouteContext): Response {
  const group = parseFileGroup(url.searchParams.get("group") ?? "path");
  const opParam = url.searchParams.get("op");
  const op = opParam == null || opParam === "" ? null : (parseFileOperation(opParam) ?? false);
  if (group == null || op === false) {
    return errorResponse("invalid_files_query", "invalid files query", {}, 400);
  }
  return withDb(config, context, (db) =>
    json(fileHotspots(db, group, op, usageLimit(url, 25), dateFilter)),
  );
}

function toolCallsRoute({ config, context, url, dateFilter }: RouteContext): Response {
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

function markRecommendationRoute(
  { config, context }: RouteContext,
  body: Record<string, unknown>,
): Response {
  const { key, source, note } = body;
  if (typeof key !== "string" || key.trim() === "") {
    return errorResponse("invalid_request", "key is required", {}, 400);
  }
  if (source != null && typeof source !== "string") {
    return errorResponse("invalid_request", "source must be a string or null", {}, 400);
  }
  if (note != null && typeof note !== "string") {
    return errorResponse("invalid_request", "note must be a string or null", {}, 400);
  }
  return withDb(config, context, (db) => {
    const ok = markImplemented(db, key, source ?? "agent", note);
    return ok
      ? json({ ok: true, key, status: "implemented" })
      : errorResponse(
          "recommendation_not_found",
          "recommendation not found",
          { ok: false, key },
          404,
        );
  });
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
    if (report.ingested > 0 || (report.repriced ?? 0) > 0) {
      economics?.invalidate();
      publishServerEvent({
        type: "archive_updated",
        reason: "manual",
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
      publishServerEvent({
        type: "error",
        reason: "manual",
        error: syncStatus.last_error,
        status: { ...syncStatus },
      });
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
    const worker = new Worker(workerUrl("sync-worker.ts"), { type: "module" });
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
      reject(workerError(event, "sync worker failed"));
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
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
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

/** Runs one watcher-triggered sync in a worker thread, keeping request
 * handling responsive while multi-second ingests run. */
export async function workerSyncRunner(
  config: Config,
  status: SyncStatusStore,
  cancel: { aborted: boolean },
  onProgress: (progress: SyncProgress) => void,
  runSync: SyncCoordinator["runWithOwnership"] = (workerConfig, workerCancel, workerProgress) => ({
    promise: runSyncWorker(workerConfig, workerCancel, workerProgress),
    owned: true,
  }),
): Promise<SyncRunnerResult | SyncRunnerFailure> {
  status.start();
  const handle = runSync(config, cancel, onProgress);
  try {
    const report = await handle.promise;
    status.finishOk(report);
    return { report, emitTerminal: handle.owned };
  } catch (error) {
    status.finishErr(error instanceof Error ? error.message : String(error));
    return { error, emitTerminal: handle.owned };
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
  if (event.type === "sync" && (event.report.ingested > 0 || (event.report.repriced ?? 0) > 0)) {
    economics.invalidate();
    publishServerEvent({
      type: "archive_updated",
      reason: event.reason,
      ingested: event.report.ingested,
      last_sync_at: syncStatus.last_sync_at,
    });
  }
}

function isKnownProjectDir(config: Config, context: RequestContext, dir: string): boolean {
  let known = false;
  withDb(config, context, (db) => {
    known =
      db.query("SELECT 1 FROM project WHERE path = ?1 OR root_path = ?1 LIMIT 1").get(dir) != null;
    return json(null);
  });
  return known;
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

function errorResponse(
  code: ApiErrorCode,
  message: string,
  extras: Record<string, unknown> = {},
  status = 400,
): Response {
  return json({ error: message, code, ...extras }, status);
}

/** Stable startup response shared by the live guard and contract tests. */
export function serviceStartingResponse(): Response {
  return errorResponse(
    "service_starting",
    "Decant is still starting. Please try again.",
    { retryable: true },
    503,
  );
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
  if (error instanceof SchemaTooNewError || error instanceof SchemaTooOldError) {
    return { code: error.code, message, status: 409 };
  }
  const normalized = message.toLowerCase();
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
  return pathname.startsWith("/api/");
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

function assertValidPeers(peers: string[]): string[] {
  for (const peer of peers) {
    if (!isValidPeer(peer)) {
      throw new Error(
        `invalid trusted peer ${JSON.stringify(peer)}: expected an IP address ` +
          "or an IPv4 CIDR such as 203.0.113.0/24",
      );
    }
  }
  return peers;
}

function isValidPeer(peer: string): boolean {
  if (!peer.includes("/")) {
    return isIP(normalizeHost(peer)) !== 0;
  }
  const [address, bits, ...extra] = peer.split("/");
  return (
    extra.length === 0 &&
    ipv4ToInt(address ?? "") != null &&
    /^\d{1,2}$/.test(bits ?? "") &&
    Number(bits) <= 32
  );
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
/** Bound on gateway auto-trust, not an allowlist. Only the detected bridge
 * gateway is trusted; host, macvlan, ipvlan, LAN, and VPC gateways are excluded. */
const GATEWAY_AUTO_TRUST_RANGE = "172.16.0.0/12";

/** Test seam: where the Linux network facts are read from. */
export interface TrustedPeerSources {
  routeTablePath?: string;
  sysClassNetPath?: string;
}

/** Peers admitted on a non-loopback bind, resolved once at startup. The first
 * present source replaces the rest (an empty DECANT_TRUSTED_PEERS trusts
 * nobody); precedence is documented in docs/api/routes.md. */
export function resolveTrustedPeers(
  configured?: string[],
  env: Record<string, string | undefined> = process.env,
  sources: TrustedPeerSources = {},
): string[] {
  if (configured != null) {
    return assertValidPeers(configured);
  }
  if (env.DECANT_TRUSTED_PEERS != null) {
    return assertValidPeers(parsePeerList(env.DECANT_TRUSTED_PEERS));
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
 * Runtimes rewrite the source of `-p`-published host traffic to this address,
 * so it stands in for the host while sibling containers stay denied. That only
 * holds for a veth into another network namespace: on host networking, macvlan
 * or ipvlan the default gateway is a LAN or VPC router that must never be
 * trusted implicitly, so every unproven shape (and any non-Linux host) fails
 * closed. See docs/distribution.md#docker. */
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

async function readJsonBody(
  request: Request,
  rejectExtras?: Record<string, unknown>,
): Promise<Response | { body: Record<string, unknown> }>;
async function readJsonBody(
  request: Request,
  rejectExtras: null,
): Promise<Response | { body: unknown }>;
async function readJsonBody(
  request: Request,
  rejectExtras: Record<string, unknown> | null = {},
): Promise<Response | { body: unknown }> {
  const contentTypeFailure = requireJsonRequest(request);
  if (contentTypeFailure != null) {
    return contentTypeFailure;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RequestBodyError();
  }
  if (rejectExtras != null && !isJsonObject(body)) {
    return errorResponse(
      "invalid_request",
      "request body must be a JSON object",
      rejectExtras,
      400,
    );
  }
  return { body };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function integerParam(url: URL, name: string, fallback: number, allowZero = false): number {
  const raw = url.searchParams.get(name);
  if (raw == null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && (parsed > 0 || (allowZero && parsed === 0)) ? parsed : fallback;
}

function usageLimit(url: URL, fallback: number): number {
  return Math.min(integerParam(url, "limit", fallback), USAGE_LIST_MAX_LIMIT);
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
