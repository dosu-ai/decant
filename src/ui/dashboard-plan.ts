// Pure decision logic for the dashboard's data loading: which JSON endpoints
// the active route needs, and which of those are stale for the current date
// range (`dateQuery`) and archive generation (`reloadKey`). The App component
// maps the planned endpoint keys to actual fetches; nothing here touches the
// network or React.

export type DashboardRoute =
  | "analytics"
  | "files"
  | "insights"
  | "projects"
  | "search"
  | "session-detail"
  | "sessions"
  | "settings"
  | "tools";

/** Route classification for data loading. Expects a pathname without query. */
export function dashboardRouteForPath(pathname: string): DashboardRoute {
  if (pathname.startsWith("/sessions/")) {
    return "session-detail";
  }
  switch (pathname) {
    case "/analytics":
      return "analytics";
    case "/files":
      return "files";
    case "/insights":
      return "insights";
    case "/projects":
      return "projects";
    case "/search":
      return "search";
    case "/settings":
      return "settings";
    case "/tools":
      return "tools";
    default:
      return "sessions";
  }
}

export type DashboardEndpoint =
  | "activity"
  | "byDay"
  | "byModel"
  | "byProject"
  | "config"
  | "dateBounds"
  | "files"
  | "mcp"
  | "modelSparklines"
  | "now"
  | "projects"
  | "recommendations"
  | "settings"
  | "summary"
  | "tokenEconomics"
  | "tools";

type EndpointSpec = {
  /** Refetch when the archive changes (sync, archive_updated, manual refresh). */
  archiveSensitive: boolean;
  /** Refetch when the selected date range changes. */
  dateSensitive: boolean;
  /** Routes that render this data. "all" covers the sidebar/topbar chrome. */
  routes: "all" | readonly DashboardRoute[];
};

/** Routes that show the date-range control and therefore need its bounds. */
const DATE_CONTROL_ROUTES: readonly DashboardRoute[] = ["analytics", "files", "sessions", "tools"];

const ENDPOINT_SPECS: Record<DashboardEndpoint, EndpointSpec> = {
  activity: { archiveSensitive: true, dateSensitive: true, routes: ["analytics"] },
  byDay: { archiveSensitive: true, dateSensitive: true, routes: ["analytics"] },
  byModel: { archiveSensitive: true, dateSensitive: true, routes: ["analytics"] },
  byProject: { archiveSensitive: true, dateSensitive: true, routes: ["analytics"] },
  config: { archiveSensitive: false, dateSensitive: false, routes: ["settings"] },
  dateBounds: { archiveSensitive: true, dateSensitive: false, routes: DATE_CONTROL_ROUTES },
  files: { archiveSensitive: true, dateSensitive: true, routes: ["files"] },
  mcp: { archiveSensitive: true, dateSensitive: true, routes: ["tools"] },
  modelSparklines: { archiveSensitive: true, dateSensitive: true, routes: ["analytics"] },
  now: { archiveSensitive: true, dateSensitive: false, routes: "all" },
  projects: { archiveSensitive: true, dateSensitive: false, routes: ["projects"] },
  recommendations: { archiveSensitive: true, dateSensitive: false, routes: ["insights"] },
  settings: { archiveSensitive: false, dateSensitive: false, routes: ["insights", "settings"] },
  summary: { archiveSensitive: true, dateSensitive: true, routes: "all" },
  tokenEconomics: { archiveSensitive: true, dateSensitive: true, routes: ["analytics"] },
  tools: { archiveSensitive: true, dateSensitive: true, routes: ["tools"] },
};

export type DashboardFetchContext = {
  dateQuery: string;
  reloadKey: number;
};

/**
 * Cache stamp for one endpoint under the given context. An endpoint is fresh
 * while its recorded stamp matches; axes an endpoint is insensitive to are
 * pinned so they never invalidate it.
 */
export function dashboardEndpointStamp(
  endpoint: DashboardEndpoint,
  context: DashboardFetchContext,
): string {
  const spec = ENDPOINT_SPECS[endpoint];
  const datePart = spec.dateSensitive ? context.dateQuery : "*";
  const archivePart = spec.archiveSensitive ? String(context.reloadKey) : "*";
  return `${datePart}|${archivePart}`;
}

/**
 * Endpoints the active route needs that are missing or stale. Deep links only
 * plan what their route renders (plus the shared chrome), date changes only
 * invalidate date-sensitive data, and archive updates leave mount-only
 * endpoints (config, settings) alone.
 */
export function planDashboardFetches({
  dateQuery,
  loaded,
  reloadKey,
  route,
}: DashboardFetchContext & {
  loaded: Partial<Record<DashboardEndpoint, string>>;
  route: DashboardRoute;
}): DashboardEndpoint[] {
  return (Object.keys(ENDPOINT_SPECS) as DashboardEndpoint[]).filter((endpoint) => {
    const spec = ENDPOINT_SPECS[endpoint];
    if (spec.routes !== "all" && !spec.routes.includes(route)) {
      return false;
    }
    return loaded[endpoint] !== dashboardEndpointStamp(endpoint, { dateQuery, reloadKey });
  });
}

/** Only the sessions list route loads the paged sessions collection. */
export function routeLoadsSessionList(route: DashboardRoute): boolean {
  return route === "sessions";
}
