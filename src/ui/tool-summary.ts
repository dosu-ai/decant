import { classifyTool } from "../tools.ts";
import type { ToolFilters } from "./tool-filters.ts";
import type { ToolCallPage } from "./types.ts";

type SummaryScope = Pick<ToolFilters, "tool" | "server" | "from" | "to">;

export interface ScopedToolSummary {
  scopeKey: string;
  reloadKey: number;
  summary: NonNullable<ToolCallPage["summary"]>;
}

export function toolSummaryKey(scope: SummaryScope): string {
  return JSON.stringify([scope.tool, scope.server, scope.from, scope.to]);
}

export function toolSummaryForScope(
  saved: ScopedToolSummary | null,
  scopeKey: string,
): ToolCallPage["summary"] {
  return saved?.scopeKey === scopeKey ? saved.summary : null;
}

export function toolSummaryNeedsRefresh(
  saved: ScopedToolSummary | null,
  scopeKey: string,
  reloadKey: number,
): boolean {
  return saved?.scopeKey !== scopeKey || saved.reloadKey !== reloadKey;
}

/** Later call pages omit the summary. A direct link to one requests a single
 * first-page row to obtain it, using only the filters that scope the cards. */
export function toolSummaryQuery(scope: SummaryScope): string {
  const params = new URLSearchParams({ limit: "1", offset: "0" });
  if (scope.tool !== "") {
    params.set("tool", scope.tool);
  }
  if (scope.server !== "") {
    params.set("server", scope.server);
  }
  if (scope.from != null) {
    params.set("from", scope.from);
  }
  if (scope.to != null) {
    params.set("to", scope.to);
  }
  return params.toString();
}

export function topToolLabel(toolName: string): string {
  return classifyTool(toolName).baseName;
}
