export interface SessionCardSummary {
  sessions: number;
  messages: number;
  estimated_cost_usd: number;
}

export interface SessionCardRow {
  message_count: number;
  estimated_cost_usd: number;
  subagent_estimated_cost_usd?: number;
  subagents?: readonly SessionCardRow[];
}

export function scopedSessionSummaryKey(request: string, reloadKey: number): string {
  return `${reloadKey}\0${request}`;
}

export function sessionCardMetrics(
  summary: SessionCardSummary | null,
  visibleRows: readonly SessionCardRow[],
  query: string,
): SessionCardSummary {
  if (query.trim() === "" && summary != null) {
    return summary;
  }
  return visibleRows.reduce<SessionCardSummary>(
    (metrics, row) => ({
      sessions: metrics.sessions + 1,
      // The table's "Msgs" column is the matching root row's own messages,
      // while its cost cell is a recursive thread total.
      messages: metrics.messages + row.message_count,
      estimated_cost_usd: metrics.estimated_cost_usd + sessionThreadCost(row),
    }),
    { sessions: 0, messages: 0, estimated_cost_usd: 0 },
  );
}

export function sessionThreadCost(session: SessionCardRow): number {
  if ((session.subagents?.length ?? 0) > 0) {
    return (
      session.estimated_cost_usd +
      (session.subagents ?? []).reduce((sum, subagent) => sum + sessionThreadCost(subagent), 0)
    );
  }
  return session.estimated_cost_usd + (session.subagent_estimated_cost_usd ?? 0);
}

export function sessionSummaryPath(
  project: string | null,
  dateQuery: string,
  includeArchived = false,
): string {
  const params = new URLSearchParams(dateQuery);
  if (project != null) {
    params.set("project", project);
  }
  if (includeArchived) {
    params.set("include_archived", "true");
  }
  const query = params.toString();
  return query === "" ? "/api/stats/summary" : `/api/stats/summary?${query}`;
}
