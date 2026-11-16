export interface NavDestination {
  key: string;
  href: string;
  label: string;
}

const HOME_KEY = "analytics";
const NOT_FOUND_LABEL = "Not found";
const NOT_FOUND_KEY = "not-found";
const ANALYTICS_REPORT_LABEL = "Analytics report";
const ANALYTICS_REPORT_KEY = "analytics-report";
const SESSION_REPORT_LABEL = "Session report";
const SESSION_REPORT_KEY = "session-report";

const ALIASES: Record<string, string> = { "/analytics": HOME_KEY };

export function isSessionDetailPath(pathname: string): boolean {
  return /^\/sessions\/\d+$/.test(pathname);
}

export function pathOnly(path: string): string {
  const pathname = path.split("?", 1)[0];
  return pathname == null || pathname === "" ? "/" : pathname;
}

export function sessionProjectFilter(path: string): string | null {
  if (pathOnly(path) !== "/sessions") {
    return null;
  }
  const project = sessionParams(path).get("project")?.trim();
  return project == null || project === "" ? null : project;
}

export function projectSessionsHref(project: string): string {
  const params = new URLSearchParams({ project });
  return `/sessions?${params.toString()}`;
}

export function sessionRepoFilter(path: string): string | null {
  if (pathOnly(path) !== "/sessions") {
    return null;
  }
  const repo = sessionParams(path).get("repo")?.trim();
  return repo == null || repo === "" ? null : repo;
}

export function repoSessionsHref(repo: string): string {
  const params = new URLSearchParams({ repo });
  return `/sessions?${params.toString()}`;
}

export function sessionIncludesArchived(path: string): boolean {
  return pathOnly(path) === "/sessions" && sessionParams(path).get("include_archived") === "true";
}

export function sessionPageFromPath(path: string): number {
  if (pathOnly(path) !== "/sessions") {
    return 1;
  }
  const page = Number(sessionParams(path).get("page") ?? "1");
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function sessionsPageHref(path: string, page: number): string {
  const params = pathOnly(path) === "/sessions" ? sessionParams(path) : new URLSearchParams();
  const normalizedPage = Number.isSafeInteger(page) && page > 1 ? page : 1;
  if (normalizedPage === 1) {
    params.delete("page");
  } else {
    params.set("page", String(normalizedPage));
  }
  const query = params.toString();
  return query === "" ? "/sessions" : `/sessions?${query}`;
}

export function sessionsArchivedHref(path: string, includeArchived: boolean): string {
  const params = pathOnly(path) === "/sessions" ? sessionParams(path) : new URLSearchParams();
  params.delete("page");
  if (includeArchived) {
    params.set("include_archived", "true");
  } else {
    params.delete("include_archived");
  }
  const query = params.toString();
  return query === "" ? "/sessions" : `/sessions?${query}`;
}

export function sessionsClearFilterHref(path: string, filter: "project" | "repo"): string {
  const params = pathOnly(path) === "/sessions" ? sessionParams(path) : new URLSearchParams();
  params.delete(filter);
  params.delete("page");
  const query = params.toString();
  return query === "" ? "/sessions" : `/sessions?${query}`;
}

function sessionParams(path: string): URLSearchParams {
  const query = path.includes("?") ? (path.split("?", 2)[1] ?? "") : "";
  return new URLSearchParams(query);
}

function resolve(path: string, items: readonly NavDestination[]): NavDestination | null {
  const pathname = pathOnly(path);
  if (pathname === "/sessions" || isSessionDetailPath(pathname)) {
    return items.find((item) => item.key === "sessions") ?? null;
  }
  if (pathname === "/reports/analytics") {
    return {
      key: ANALYTICS_REPORT_KEY,
      href: pathname,
      label: ANALYTICS_REPORT_LABEL,
    };
  }
  if (/^\/reports\/session\/\d+$/.test(pathname)) {
    return {
      key: SESSION_REPORT_KEY,
      href: pathname,
      label: SESSION_REPORT_LABEL,
    };
  }
  if (pathname === "/settings") {
    return { key: "settings", href: "/settings", label: "Settings" };
  }
  const aliased = ALIASES[pathname];
  if (pathname === "/" || aliased != null) {
    const key = aliased ?? HOME_KEY;
    return items.find((item) => item.key === key) ?? null;
  }
  return items.find((item) => item.href === pathname) ?? null;
}

export function activeRoute(path: string, items: readonly NavDestination[]): string {
  return resolve(path, items)?.label ?? NOT_FOUND_LABEL;
}

export function activeRouteKey(path: string, items: readonly NavDestination[]): string {
  return resolve(path, items)?.key ?? NOT_FOUND_KEY;
}

export function isKnownRoute(path: string, items: readonly NavDestination[]): boolean {
  return resolve(path, items) != null;
}

export function titleFor(active: string): string {
  return active === "Sessions" ? "Session Logs" : active;
}

export function documentTitleFor(path: string, items: readonly NavDestination[]): string {
  const pathname = pathOnly(path);
  if (isSessionDetailPath(pathname)) {
    return "Session detail · Decant";
  }
  if (pathname === "/reports/analytics") {
    return "Analytics report · Decant";
  }
  if (/^\/reports\/session\/\d+$/.test(pathname)) {
    return "Session report · Decant";
  }
  const active = resolve(path, items)?.label ?? NOT_FOUND_LABEL;
  const label = active === "Files" ? "File hotspots" : active;
  return `${label} · Decant`;
}
