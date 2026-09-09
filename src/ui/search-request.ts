export type SearchRequestScope = {
  from?: string;
  project?: string;
  to?: string;
  tool?: string;
};

export function searchRequestScope(
  path: string,
  dateRange: { from: string | null; to: string | null },
): SearchRequestScope {
  const params = new URLSearchParams(path.split("?", 2)[1] ?? "");
  const scope: SearchRequestScope = {};
  if (dateRange.from != null) {
    scope.from = dateRange.from;
  }
  if (dateRange.to != null) {
    scope.to = dateRange.to;
  }
  const tool = params.get("tool");
  if (tool != null && tool !== "") {
    scope.tool = tool;
  }
  const project = params.get("project");
  if (project != null && project !== "") {
    scope.project = project;
  }
  return scope;
}

export function searchRouteHref(query: string, currentPath: string): string {
  const current = new URLSearchParams(
    currentPath.startsWith("/search") ? (currentPath.split("?", 2)[1] ?? "") : "",
  );
  const next = new URLSearchParams();
  for (const key of ["tool", "project"] as const) {
    const value = current.get(key);
    if (value != null && value !== "") {
      next.set(key, value);
    }
  }
  const trimmed = query.trimStart();
  if (trimmed !== "") {
    next.set("q", trimmed);
  }
  const params = next.toString();
  return params === "" ? "/search" : `/search?${params}`;
}
