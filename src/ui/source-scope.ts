import type { AvailableSessionSource, SessionSource } from "../source-filter.ts";

export type DashboardSource = "" | SessionSource;

export function dashboardSourceOptions(
  available: readonly AvailableSessionSource[],
): readonly { key: DashboardSource; label: string }[] {
  return [
    { key: "", label: "All sources" },
    ...available.map(({ key, label }) => ({ key, label })),
  ];
}

export function sourceScopeQuery(dateQuery: string, source: DashboardSource): string {
  const params = new URLSearchParams(dateQuery);
  if (source !== "") {
    params.set("source", source);
  }
  return params.toString();
}
