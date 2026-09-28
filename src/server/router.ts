import type { Config } from "../config.ts";
import { dateFilterFromSearch } from "../date-filter.ts";
import { exceptionAttributes } from "../logging.ts";
import type { RequestContext } from "./context.ts";
import { errorResponse, notFoundResponse, readJsonBody, responseForError } from "./http.ts";
import { isValidSessionId } from "./params.ts";
import { COMPILED_ROUTES, type RouteContext, type RouteResult } from "./routes.ts";
import { validateLocalRequest } from "./security.ts";

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
