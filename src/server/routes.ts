import { isAbsolute } from "node:path";
import { SESSION_LIST_MAX_LIMIT } from "../api-limits.ts";
import type { Config } from "../config.ts";
import { contextWindowForSession } from "../context-window.ts";
import type { dateFilterFromSearch } from "../date-filter.ts";
import { parseFileOperation } from "../distill.ts";
import {
  canLaunch,
  isSafeRecommendationKey,
  launchAgent,
  command as launchCommand,
  openIde,
} from "../launcher.ts";
import { openApiDocument } from "../openapi.ts";
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
} from "../query.ts";
import {
  list as listRecommendations,
  markImplemented,
  parseStatusFilter,
  refreshForSessionStateChange,
  STATUS_FILTERS,
} from "../recommendations.ts";
import {
  API_ROUTE_PATHS,
  type ApiRoutePath,
  compileRoutePath,
  type RouteMatcher,
} from "../route-paths.ts";
import { type SessionUserStateUpdate, setSessionUserState } from "../session-user-state.ts";
import {
  agentOptions,
  getSettings,
  ideOptions,
  saveSettings,
  settingsPath,
  terminalOptions,
} from "../settings.ts";
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
} from "../stats.ts";
import { tokenEconomics, tokenEconomicsForSession } from "../token-economics.ts";
import { DECANT_VERSION } from "../version.ts";
import { type Db, type RequestContext, withDb } from "./context.ts";
import { errorResponse, isJsonObject, json } from "./http.ts";
import { integerParam, isNonNegativeInteger, isValidSessionId, usageLimit } from "./params.ts";
import { eventStream, publishServerEvent } from "./sse.ts";
import { syncNow, syncStatus } from "./sync.ts";

type DateFilter = ReturnType<typeof dateFilterFromSearch>;

export interface RouteContext {
  request: Request;
  url: URL;
  config: Config;
  context: RequestContext;
  dateFilter: DateFilter;
  params: { id: string };
}

export type RouteResult = Response | Promise<Response>;

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

export const ROUTES: Record<ApiRoutePath, RouteSpec> = {
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
      const { assembleAnalyticsReport, renderAnalyticsReport } = await import("../report/index.ts");
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
      const { assembleSessionReport, renderSessionReport } = await import("../report/index.ts");
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

export const COMPILED_ROUTES: CompiledRoute[] = API_ROUTE_PATHS.map((path) => ({
  ...compileRoutePath(path),
  spec: ROUTES[path],
}));

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

function isKnownProjectDir(config: Config, context: RequestContext, dir: string): boolean {
  let known = false;
  withDb(config, context, (db) => {
    known =
      db.query("SELECT 1 FROM project WHERE path = ?1 OR root_path = ?1 LIMIT 1").get(dir) != null;
    return json(null);
  });
  return known;
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
