import { isAbsolute } from "node:path";
import {
  SEARCH_INDEX_PAGE_MAX,
  SESSION_LIST_MAX_LIMIT,
  SESSION_MESSAGE_PAGE_DEFAULT,
  SESSION_MESSAGE_PAGE_MAX,
} from "../api-limits.ts";
import type { Config } from "../config.ts";
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
import { getSessionSummary } from "../query.ts";
import {
  launchDir,
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
import { DEFAULT_SERVE_PORT } from "../serve-defaults.ts";
import {
  installService,
  isServiceProcess,
  removeService,
  ServiceCommandError,
  ServiceUnavailableError,
  serviceStatus,
  stopService,
} from "../service.ts";
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
  availableSessionSources,
  parseSessionSource,
  SESSION_SOURCES,
  type SessionSource,
} from "../source-filter.ts";
import {
  DIMENSIONS,
  dateBounds,
  parseDimension,
  parseFileGroup,
  type StatsFilter,
  todayTotals,
} from "../stats.ts";
import { checkForUpdate } from "../update.ts";
import { DECANT_VERSION } from "../version.ts";
import { type Db, type RequestContext, withDb } from "./context.ts";
import { errorResponse, isJsonObject, json } from "./http.ts";
import { integerParam, isNonNegativeInteger, isValidSessionId, usageLimit } from "./params.ts";
import { isLoopbackPeer } from "./peers.ts";
import { readOutputResponse, runRead } from "./read.ts";
import type { ReadOpArgs, ReadOpName } from "./read-ops.ts";
import { eventStream, publishServerEvent } from "./sse.ts";
import { syncNow, syncStatus, syncStatusBody } from "./sync.ts";

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

/** Answer from a read operation (see read-ops.ts), which runs on the server's
 * read pool when there is one. A null result means the session is missing. */
async function read<N extends ReadOpName>(
  { config, context, request }: RouteContext,
  name: N,
  args: ReadOpArgs<N>,
): Promise<Response> {
  // The request's signal aborts when the client disconnects, so a read still
  // waiting for a worker is dropped instead of computed for nobody.
  const output = await runRead(config, context, name, args, request.signal);
  return output == null ? withDb(config, context, sessionNotFound) : readOutputResponse(output);
}

type SessionReadOpName = {
  [N in ReadOpName]: ReadOpArgs<N> extends { id: number } ? N : never;
}[ReadOpName];

const sessionScoped =
  (
    name: SessionReadOpName,
    args: (ctx: RouteContext) => Record<string, unknown> = () => ({}),
  ): RouteHandler =>
  (ctx) =>
    // biome-ignore lint/suspicious/noExplicitAny: each caller pairs a session operation with that operation's own extra arguments.
    read(ctx, name, { ...args(ctx), id: Number(ctx.params.id) } as any);

// Analytics routes share this guard so an unknown source value is rejected
// before any archive read.
const sourceScoped =
  (handle: (ctx: RouteContext, source: SessionSource | null) => RouteResult): RouteHandler =>
  (ctx) => {
    const value = ctx.url.searchParams.get("source");
    const source = parseSessionSource(value);
    if (value != null && source == null) {
      return errorResponse("invalid_request", "unknown source", { allowed: SESSION_SOURCES }, 400);
    }
    return handle(ctx, source);
  };

function statsFilter({ url, dateFilter }: RouteContext, source: SessionSource | null): StatsFilter {
  return {
    ...dateFilter,
    includeArchived: url.searchParams.get("include_archived") === "true",
    project: url.searchParams.get("project"),
    repo: url.searchParams.get("repo"),
    source,
    tool: url.searchParams.get("tool"),
  };
}

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
        opencodeDir: config.opencodeDir,
        cursorDir: config.cursorDir,
        copilotDir: config.copilotDir,
        vscodeCopilotDir: config.vscodeCopilotDir,
        atifDir: config.atifDir ?? null,
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
  "/api/update": { GET: async () => json(await checkForUpdate()) },
  "/api/background": {
    GET: async ({ context }) =>
      json({ ...(await serviceStatus(context.service)), handoff: false, stopping: false }),
    POST: { body: "object", handle: backgroundRoute },
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
    GET: (ctx) => {
      const { url, dateFilter } = ctx;
      return read(ctx, "sessions", {
        tool: url.searchParams.get("tool"),
        model: url.searchParams.get("model"),
        project: url.searchParams.get("project"),
        repo: url.searchParams.get("repo"),
        includeSubagents: url.searchParams.get("include_subagents") === "true",
        includeNestedSubagents: url.searchParams.get("with_subagents") === "true",
        includeArchived: url.searchParams.get("include_archived") === "true",
        limit: Math.min(integerParam(url, "limit", 50), SESSION_LIST_MAX_LIMIT),
        offset: integerParam(url, "offset", 0, true),
        ...dateFilter,
      });
    },
  },
  "/api/sessions/search-index": {
    GET: (ctx) =>
      read(ctx, "sessionSearchIndex", {
        limit: Math.min(
          integerParam(ctx.url, "limit", SEARCH_INDEX_PAGE_MAX),
          SEARCH_INDEX_PAGE_MAX,
        ),
        offset: integerParam(ctx.url, "offset", 0, true),
      }),
  },
  "/api/projects": {
    GET: (ctx) => read(ctx, "projects", {}),
  },
  "/api/sessions/{id}/state": {
    validateId: SESSION_ID_METHODS,
    POST: { body: "json", handle: sessionStateRoute },
  },
  "/api/sessions/{id}/token-economics": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped("sessionTokenEconomics"),
  },
  "/api/sessions/{id}/context-window": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped("sessionContextWindow"),
  },
  "/api/sessions/{id}/outline": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped("sessionOutline"),
  },
  "/api/sessions/{id}/issues": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped("sessionIssues"),
  },
  "/api/sessions/{id}": {
    validateId: SESSION_ID_METHODS,
    GET: sessionScoped("session", ({ url }) => {
      // Zero or omitted used to mean the whole transcript, which made one
      // response as large as the longest session. Now it means one page.
      const messageLimit = integerParam(url, "message_limit", 0, true);
      return {
        messageLimit: Math.min(
          messageLimit > 0 ? messageLimit : SESSION_MESSAGE_PAGE_DEFAULT,
          SESSION_MESSAGE_PAGE_MAX,
        ),
        messageOffset: integerParam(url, "message_offset", 0, true),
      };
    }),
  },
  "/api/search": { POST: { body: "object", handle: searchRoute } },
  "/api/stats/summary": {
    GET: sourceScoped((ctx, source) => read(ctx, "statsSummary", statsFilter(ctx, source))),
  },
  "/api/stats/by-dimension": {
    GET: sourceScoped((ctx, source) => {
      const dimension = parseDimension(ctx.url.searchParams.get("dim") ?? "");
      if (dimension == null) {
        return errorResponse(
          "unknown_dimension",
          "unknown dimension",
          { allowed: DIMENSIONS },
          400,
        );
      }
      return read(ctx, "statsByDimension", { dimension, filter: statsFilter(ctx, source) });
    }),
  },
  "/api/analytics/activity": {
    GET: sourceScoped((ctx, source) => read(ctx, "activity", { ...ctx.dateFilter, source })),
  },
  "/api/analytics/model-sparklines": {
    GET: sourceScoped((ctx, source) => read(ctx, "modelSparklines", { ...ctx.dateFilter, source })),
  },
  "/api/analytics/token-economics": {
    GET: sourceScoped(async (ctx, source) => {
      // The in-memory cache holds archive-wide vectors only; a source-scoped
      // request reads persisted vectors so one source never answers for another.
      if (ctx.context.economics != null && source == null) {
        return json(await ctx.context.economics.get(ctx.dateFilter));
      }
      return read(ctx, "tokenEconomics", { ...ctx.dateFilter, source });
    }),
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
    GET: sourceScoped((ctx, source) =>
      read(ctx, "analyticsReport", { filter: { ...ctx.dateFilter, source } }),
    ),
  },
  "/api/reports/session/{id}.html": {
    validateId: ["GET"],
    GET: sessionScoped("sessionReport"),
  },
  "/api/date-bounds": {
    GET: ({ config, context }) => withDb(config, context, (db) => json(dateBounds(db))),
  },
  "/api/metadata/date-bounds": {
    GET: ({ config, context }) => withDb(config, context, (db) => json(dateBounds(db))),
  },
  "/api/metadata/session-sources": {
    GET: ({ config, context }) =>
      withDb(config, context, (db) => json(availableSessionSources(db))),
  },
  "/api/files": { GET: filesRoute },
  "/api/tools/calls": { GET: toolCallsRoute },
  "/api/tools/usage": {
    GET: (ctx) =>
      read(ctx, "toolUsage", {
        errorsOnly: ctx.url.searchParams.get("errors_only") === "true",
        limit: usageLimit(ctx.url, 50),
        filter: ctx.dateFilter,
      }),
  },
  "/api/tools/mcp-usage": {
    GET: (ctx) => read(ctx, "mcpUsage", { limit: usageLimit(ctx.url, 50), filter: ctx.dateFilter }),
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
  return json(syncStatusBody());
}

// Long enough for the response to reach the browser before this process
// releases its port or is stopped by the service manager.
const BACKGROUND_HANDOFF_DELAY_MS = 250;

async function backgroundRoute(
  { config, context }: RouteContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const { enabled } = body;
  if (typeof enabled !== "boolean" || Object.keys(body).length !== 1) {
    return errorResponse("invalid_request", "send exactly { enabled: boolean }", {}, 400);
  }
  // Registering a login item is persistence on this machine, so only a
  // browser on this machine may do it, even when trusted peers can reach the API.
  if (context.remoteAddress != null && !isLoopbackPeer(context.remoteAddress)) {
    return errorResponse("forbidden_remote", "forbidden remote", {}, 403);
  }
  const options = context.service;
  const current = isServiceProcess(options?.env);
  if (!enabled) {
    await removeService(options);
    if (current) {
      // Stopping the service stops this process, so answer first.
      setTimeout(() => void stopService(options), BACKGROUND_HANDOFF_DELAY_MS);
    } else {
      await stopService(options);
    }
    const status = await serviceStatus(options);
    return json({ ...status, handoff: false, stopping: current });
  }
  const port = context.boundPort ?? DEFAULT_SERVE_PORT;
  try {
    const status = await installService({ dbPath: config.dbPath, port }, options);
    // The service binds this server's port, so this server steps aside. The
    // service retries the bind until the port is free.
    const handoff =
      !current && context.requestShutdown != null && status.url === `http://127.0.0.1:${port}`;
    if (handoff) {
      setTimeout(() => context.requestShutdown?.(), BACKGROUND_HANDOFF_DELAY_MS);
    }
    return json({ ...status, handoff, stopping: false });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return errorResponse("background_unsupported", error.message, {}, 409);
    }
    if (error instanceof ServiceCommandError) {
      return errorResponse("background_failed", error.message, {}, 500);
    }
    // Anything else may carry paths or internals; the router logs it and
    // answers with a generic internal_error.
    throw error;
  }
}

async function launchAgentRoute(
  { config, context }: RouteContext,
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
    // The directory comes from the archive, never from the request body.
    dir: key == null || key === "" ? null : recommendationLaunchDir(config, context, key),
  });
  if (result.ok) {
    return json(result);
  }
  const command = result.command ?? launchCommand(agent, prompt);
  return errorResponse(
    isUnsupportedLaunchError(result.error) ? "launch_unsupported_platform" : "launch_failed",
    result.error ?? "launch failed",
    {
      ok: false,
      ...(command == null ? {} : { command }),
      ...(result.dir == null ? {} : { dir: result.dir }),
    },
    400,
  );
}

function recommendationLaunchDir(
  config: Config,
  context: RequestContext,
  key: string,
): string | null {
  try {
    return withDb(config, context, (db) => launchDir(db, key));
  } catch {
    // An unreadable archive must not stop a launch. It starts where it used to.
    return null;
  }
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

function searchRoute(ctx: RouteContext, body: Record<string, unknown>): RouteResult {
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
  return read(ctx, "search", {
    query,
    filter: {
      tool,
      project,
      includeSubagents: includeSubagents === true,
      includeTotal: includeTotal !== false,
      from,
      to,
      limit,
      offset,
    },
  });
}

function filesRoute(ctx: RouteContext): RouteResult {
  const { url, dateFilter } = ctx;
  const group = parseFileGroup(url.searchParams.get("group") ?? "path");
  const opParam = url.searchParams.get("op");
  const op = opParam == null || opParam === "" ? null : (parseFileOperation(opParam) ?? false);
  if (group == null || op === false) {
    return errorResponse("invalid_files_query", "invalid files query", {}, 400);
  }
  return read(ctx, "files", { group, op, limit: usageLimit(url, 25), filter: dateFilter });
}

function toolCallsRoute(ctx: RouteContext): RouteResult {
  const { url, dateFilter } = ctx;
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
  return read(ctx, "toolCalls", {
    tool: url.searchParams.get("tool"),
    server: url.searchParams.get("server"),
    errorsOnly: errorsOnlyValue === "true",
    sessionId: sessionValue == null ? null : Number(sessionValue),
    project: url.searchParams.get("project"),
    ...dateFilter,
    minMs: minMsValue == null ? null : Number(minMsValue),
    limit: integerParam(url, "limit", 50),
    offset: integerParam(url, "offset", 0, true),
  });
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
