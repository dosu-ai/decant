/**
 * Every served path, in match order. Kept free of imports so logging can
 * derive `http.route` from it without loading the server.
 */
export const API_ROUTE_PATHS = [
  "/api/health",
  "/api/openapi.json",
  "/api/events",
  "/api/config",
  "/api/settings",
  "/api/launch/agent",
  "/api/launch/ide",
  "/api/sync-status",
  "/api/metadata/sync-status",
  "/api/sync",
  "/api/sessions",
  "/api/sessions/search-index",
  "/api/projects",
  "/api/sessions/{id}/state",
  "/api/sessions/{id}/token-economics",
  "/api/sessions/{id}/context-window",
  "/api/sessions/{id}/outline",
  "/api/sessions/{id}/issues",
  "/api/sessions/{id}",
  "/api/search",
  "/api/stats/summary",
  "/api/stats/by-dimension",
  "/api/analytics/activity",
  "/api/analytics/model-sparklines",
  "/api/analytics/token-economics",
  "/api/analytics/now",
  "/api/reports/analytics.html",
  "/api/reports/session/{id}.html",
  "/api/date-bounds",
  "/api/metadata/date-bounds",
  "/api/files",
  "/api/tools/calls",
  "/api/tools/usage",
  "/api/tools/mcp-usage",
  "/api/recommendations",
  "/api/recommendations/mark",
] as const;

export type ApiRoutePath = (typeof API_ROUTE_PATHS)[number];

export const UI_ROUTE_PATHS = [
  "/",
  "/projects",
  "/sessions",
  "/sessions/{id}",
  "/search",
  "/analytics",
  "/insights",
  "/tools",
  "/files",
  "/settings",
  "/reports/analytics",
  "/reports/session/{id}",
] as const;

export interface RouteMatcher {
  template: string;
  pattern: RegExp;
}

export function compileRoutePath(template: string): RouteMatcher {
  const source = template
    .split("{id}")
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("([^/]+)");
  return { template, pattern: new RegExp(`^${source}$`) };
}

const MATCHERS = [...API_ROUTE_PATHS, ...UI_ROUTE_PATHS].map(compileRoutePath);

/** Low-cardinality template for a request path, e.g. `/api/sessions/{id}`. */
export function routeTemplate(pathname: string): string {
  for (const matcher of MATCHERS) {
    if (matcher.pattern.test(pathname)) {
      return matcher.template;
    }
  }
  return pathname.startsWith("/src/ui/") ? "/src/ui/*" : pathname;
}
