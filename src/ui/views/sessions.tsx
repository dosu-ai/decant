import { type CSSProperties, memo, type ReactNode, useCallback, useEffect, useState } from "react";
import { getJson } from "../api.ts";
import dosuOfficialUrl from "../assets/dosu-official.svg";
import { Badge, displayModelLabel, ModelBadge, ReasoningBadge, ToolBadge } from "../badges.tsx";
import { StatCard, Tooltip } from "../common.tsx";
import { EMPTY_SESSION_IDS, SESSION_PAGE_SIZE, SESSION_TABLE_SKELETON_KEYS } from "../constants.ts";
import { dateRangeQuery } from "../date-range.ts";
import { DateRangeControl } from "../date-range-control.tsx";
import { fullDateTime, sessionListDate } from "../date-time.ts";
import { dosuBadgeAriaLabel, dosuBadgeVisualLabel, dosuEvidenceSummary } from "../dosu-badge.ts";
import { dosuLink } from "../dosu-links.ts";
import { basename, compact, formatInt, money } from "../format.ts";
import { Icon } from "../icons.tsx";
import { Link, visit } from "../link.tsx";
import { shouldShowSessionSkeleton } from "../loading-state.ts";
import {
  projectSessionsHref,
  sessionIncludesArchived,
  sessionPageFromPath,
  sessionProjectFilter,
  sessionsArchivedHref,
  sessionsPageHref,
} from "../navigation.ts";
import {
  scopedSessionSummaryKey,
  sessionCardMetrics,
  sessionSummaryPath,
  sessionThreadCost,
} from "../session-summary.ts";
import { sessionDisplayTitle, subagentDescriptor } from "../session-title.ts";
import type {
  DashboardData,
  DateRangeSelection,
  SessionPageState,
  SessionSummary,
  Summary,
} from "../types.ts";

export function SessionsView({
  data,
  dateRange,
  onDateRangeChange,
  path,
  reloadKey,
  sessionPageState,
}: {
  data: DashboardData;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
  path: string;
  reloadKey: number;
  sessionPageState: SessionPageState;
}) {
  const [query, setQuery] = useState("");
  const [scopedSummary, setScopedSummary] = useState<{
    key: string;
    value: Summary;
  } | null>(null);
  const [expandedSessionState, setExpandedSessionState] = useState<{
    ids: Set<number>;
    key: string;
  }>(() => ({ ids: new Set(), key: "" }));
  const { exhausted, loadedPage, loading, sessions } = sessionPageState;
  const filtered = filterSessions(sessions, query);
  const project = sessionProjectFilter(path);
  const includeArchived = sessionIncludesArchived(path);
  const page = sessionPageFromPath(path);
  const displayedPage = loadedPage ?? page;
  const pageLoading = loading || (loadedPage != null && page !== loadedPage);
  const dateQuery = dateRangeQuery(dateRange);
  const sessionFilterKey = JSON.stringify([dateQuery, project, includeArchived, page]);
  const expandedSessions =
    expandedSessionState.key === sessionFilterKey ? expandedSessionState.ids : EMPTY_SESSION_IDS;
  const scopedSummaryRequest =
    project == null && !includeArchived
      ? null
      : sessionSummaryPath(project, dateQuery, includeArchived);
  const scopedSummaryRequestKey =
    scopedSummaryRequest == null ? null : scopedSessionSummaryKey(scopedSummaryRequest, reloadKey);
  const currentScopedSummary =
    scopedSummary?.key === scopedSummaryRequestKey ? scopedSummary.value : null;
  const cardSummary = sessionCardMetrics(
    scopedSummaryRequest == null ? data.summary : currentScopedSummary,
    filtered,
    query,
  );
  const visibleTotal =
    project == null ? (data.summary?.sessions ?? null) : (currentScopedSummary?.sessions ?? null);
  const listTotal = includeArchived ? null : visibleTotal;
  const pageCount =
    listTotal == null ? null : Math.max(1, Math.ceil(listTotal / SESSION_PAGE_SIZE));
  // The page request asks for one row past the page, so a full response is the
  // only signal a next page needs. Deriving it from a total instead would hide
  // Next while a scoped summary is still in flight.
  const hasNextPage = !exhausted;
  const showPagination = displayedPage > 1 || page > 1 || hasNextPage;
  const waitingForSessions = shouldShowSessionSkeleton({
    isLoading: loading,
    loadedRows: sessions.length,
    query,
  });

  useEffect(() => {
    if (scopedSummaryRequest == null) {
      setScopedSummary(null);
      return;
    }
    let cancelled = false;
    setScopedSummary(null);
    void getJson<Summary>(scopedSummaryRequest)
      .then((summary) => {
        if (!cancelled) {
          setScopedSummary({
            key: scopedSessionSummaryKey(scopedSummaryRequest, reloadKey),
            value: summary,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScopedSummary(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, scopedSummaryRequest]);

  const toggleSession = useCallback(
    (id: number) => {
      setExpandedSessionState((current) => {
        const next = new Set(current.key === sessionFilterKey ? current.ids : EMPTY_SESSION_IDS);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return { ids: next, key: sessionFilterKey };
      });
    },
    [sessionFilterKey],
  );

  const renderRows = (session: SessionSummary, depth = 0): ReactNode[] => {
    const expanded = expandedSessions.has(session.id);
    const rows: ReactNode[] = [
      <SessionTableRow
        depth={depth}
        expanded={expanded}
        key={session.id}
        onToggle={toggleSession}
        session={session}
      />,
    ];
    if (expanded) {
      for (const subagent of session.subagents ?? []) {
        rows.push(...renderRows(subagent, depth + 1));
      }
    }
    return rows;
  };

  return (
    <div className="view-stack">
      <header className="page-heading inline-heading">
        <div>
          <h1>Sessions</h1>
          <p>Every Claude Code, Codex, and Gemini CLI session log on this device.</p>
        </div>
        <DateRangeControl bounds={data.dateBounds} range={dateRange} onChange={onDateRangeChange} />
      </header>

      <div className="stat-grid sessions-stat-grid">
        <StatCard icon="sessions" label="Sessions" value={formatInt(cardSummary.sessions)} />
        <StatCard icon="messages" label="Messages" value={formatInt(cardSummary.messages)} />
        <StatCard icon="money" label="Est. cost" value={money(cardSummary.estimated_cost_usd)} />
      </div>

      <section aria-busy={pageLoading} className="panel sessions-panel">
        <div className="panel-heading">
          <div>
            <h2>Sessions</h2>
          </div>
          <div className="session-list-controls">
            <label className="session-archive-toggle">
              <input
                checked={includeArchived}
                onChange={(event) => {
                  visit(sessionsArchivedHref(path, event.target.checked));
                }}
                type="checkbox"
              />
              <span>Show archived</span>
            </label>
            <input
              aria-label="Filter sessions"
              className="session-filter"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title, model, or tool..."
              value={query}
            />
          </div>
        </div>
        {project != null ? (
          <div className="active-filter-row">
            <span className="filter-pill">
              Project: <strong>{basename(project)}</strong>
              <Link
                aria-label="Clear project filter"
                href={sessionsArchivedHref("/sessions", includeArchived)}
              >
                <Icon name="x" />
              </Link>
            </span>
          </div>
        ) : null}
        <div className="table-scroll">
          <table className="data-table sessions-table">
            <colgroup>
              <col className="col-session-tool" />
              <col className="col-session-title" />
              <col className="col-session-project" />
              <col className="col-session-model" />
              <col className="col-session-effort" />
              <col className="col-session-context" />
              <col className="col-session-compactions" />
              <col className="col-session-subagents" />
              <col className="col-session-count" />
              <col className="col-session-cost" />
              <col className="col-session-started" />
            </colgroup>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Title</th>
                <th>Project</th>
                <th>Model</th>
                <th>Effort</th>
                <th className="numeric">Peak ctx</th>
                <th className="numeric">Comp.</th>
                <th className="numeric">Subagents</th>
                <th className="numeric">Msgs</th>
                <th className="numeric">Cost</th>
                <th className="numeric">Started</th>
              </tr>
            </thead>
            <tbody>
              {waitingForSessions ? <SessionTableSkeletonRows /> : null}
              {!waitingForSessions && filtered.length === 0 ? (
                <tr>
                  <td colSpan={11}>
                    {query.trim() !== ""
                      ? "No sessions match that filter."
                      : displayedPage > 1
                        ? "No sessions on this page."
                        : "No sessions ingested yet."}
                  </td>
                </tr>
              ) : null}
              {!waitingForSessions ? filtered.flatMap((session) => renderRows(session)) : null}
            </tbody>
          </table>
        </div>
        <div className="panel-footer">
          <span>
            {sessionsCaption(
              query,
              filtered.length,
              sessions.length,
              listTotal,
              loading,
              includeArchived,
              displayedPage,
            )}
          </span>
          {showPagination ? (
            <nav aria-label="Sessions pagination" className="session-pagination">
              <button
                aria-label={`Go to page ${Math.max(1, displayedPage - 1)}`}
                className="secondary-button"
                disabled={pageLoading || displayedPage <= 1}
                onClick={() => visit(sessionsPageHref(path, displayedPage - 1))}
                type="button"
              >
                <Icon name="chevronLeft" />
                Previous
              </button>
              <span aria-live="polite">
                {pageLoading && page !== displayedPage
                  ? `Loading page ${formatInt(page)}…`
                  : pageCount == null
                    ? `Page ${formatInt(displayedPage)}`
                    : `Page ${formatInt(displayedPage)} of ${formatInt(pageCount)}`}
              </span>
              <button
                aria-label={`Go to page ${displayedPage + 1}`}
                className="secondary-button"
                disabled={pageLoading || !hasNextPage}
                onClick={() => visit(sessionsPageHref(path, displayedPage + 1))}
                type="button"
              >
                Next
                <Icon name="chevronRight" />
              </button>
            </nav>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function SessionTableSkeletonRows() {
  return SESSION_TABLE_SKELETON_KEYS.map((key) => (
    <tr className="session-row-skeleton" key={key}>
      <td>
        <span className="skeleton-line table-skeleton-line tool" />
      </td>
      <td>
        <span className="skeleton-line table-skeleton-line title" />
      </td>
      <td>
        <span className="skeleton-line table-skeleton-line project" />
      </td>
      <td>
        <span className="skeleton-line table-skeleton-line model" />
      </td>
      <td>
        <span className="skeleton-line table-skeleton-line effort" />
      </td>
      <td className="numeric">
        <span className="skeleton-line table-skeleton-line number" />
      </td>
      <td className="numeric">
        <span className="skeleton-line table-skeleton-line number" />
      </td>
      <td className="numeric">
        <span className="skeleton-line table-skeleton-line number" />
      </td>
      <td className="numeric">
        <span className="skeleton-line table-skeleton-line number" />
      </td>
      <td className="numeric">
        <span className="skeleton-line table-skeleton-line cost" />
      </td>
      <td className="numeric">
        <span className="skeleton-line table-skeleton-line started" />
      </td>
    </tr>
  ));
}

export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return sessions;
  }
  return sessions.filter((session) => sessionMatchesQuery(session, needle));
}

export function sessionMatchesQuery(session: SessionSummary, needle: string): boolean {
  return (
    [
      sessionDisplayTitle(session),
      displayModelLabel(session.model),
      session.reasoning_effort,
      ...(session.reasoning_effort_levels ?? []),
      session.tool,
      session.project_path,
      session.agent_type,
      session.agent_id,
    ]
      .filter((value): value is string => value != null)
      .some((value) => value.toLowerCase().includes(needle)) ||
    (session.subagents ?? []).some((subagent) => sessionMatchesQuery(subagent, needle))
  );
}

export function sessionsCaption(
  query: string,
  visible: number,
  loaded: number,
  total: number | null,
  loading: boolean,
  includeArchived: boolean,
  page: number,
): string {
  if (loading && loaded === 0 && query.trim() === "") {
    return `Loading page ${formatInt(page)}…`;
  }
  if (query.trim() !== "") {
    return `Showing ${formatInt(visible)} matching ${visible === 1 ? "row" : "rows"} on page ${formatInt(page)}`;
  }
  if (loaded === 0) {
    return total == null
      ? `No sessions${includeArchived ? ", including archived" : ""}`
      : `Showing 0 of ${formatInt(total)} sessions`;
  }
  const start = (page - 1) * SESSION_PAGE_SIZE + 1;
  const end = start + Math.max(0, loaded - 1);
  if (total == null) {
    return `Showing ${formatInt(start)}–${formatInt(end)} sessions${includeArchived ? ", including archived" : ""}`;
  }
  return `Showing ${formatInt(start)}–${formatInt(Math.min(end, total))} of ${formatInt(total)} sessions`;
}

export const SessionTableRow = memo(function SessionTableRow({
  depth,
  expanded,
  onToggle,
  session,
}: {
  depth: number;
  expanded: boolean;
  onToggle: (id: number) => void;
  session: SessionSummary;
}) {
  const isSubagent = depth > 0;
  const title = sessionDisplayTitle(session);
  const childCount = Math.max(session.subagent_count, session.subagents?.length ?? 0);
  const hasChildren = childCount > 0;
  const indentStyle = { "--depth": Math.max(0, Math.min(depth - 1, 5)) } as CSSProperties;
  return (
    <tr className={`session-row${isSubagent ? " is-subagent" : ""}`}>
      <td>
        <span className="session-tool-cell">
          {hasChildren ? (
            <button
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} subagents for ${title}`}
              className="subagent-disclosure"
              onClick={() => onToggle(session.id)}
              type="button"
            >
              <Icon name={expanded ? "minus" : "plus"} />
            </button>
          ) : (
            <span className="subagent-disclosure-placeholder" />
          )}
          {isSubagent ? (
            <span className="subagent-source">
              <Icon name="cpu" />
              Subagent
            </span>
          ) : (
            <ToolBadge tool={session.tool} />
          )}
        </span>
      </td>
      <td className="truncate-cell">
        <span className="session-title-stack" style={indentStyle}>
          <span className="session-title-line">
            <Link href={`/sessions/${session.id}`} title={title}>
              {title}
            </Link>
            {session.is_user_archived ? <Badge tone="neutral">Archived</Badge> : null}
            <DosuProvenanceBadge session={session} />
          </span>
          {isSubagent ? <small>{subagentDescriptor(session)}</small> : null}
        </span>
      </td>
      <td className="truncate-cell" title={session.project_path ?? ""}>
        {session.project_path == null ? (
          <span className="faint">-</span>
        ) : (
          <Link href={projectSessionsHref(session.project_path)} title={session.project_path}>
            {basename(session.project_path)}
          </Link>
        )}
      </td>
      <td>
        <ModelBadge model={session.model} />
      </td>
      <td>
        <ReasoningBadge
          effort={session.reasoning_effort}
          levels={session.reasoning_effort_levels}
          totalReasoningTokens={session.total_reasoning_tokens}
          reasoningSource={session.reasoning_source}
        />
      </td>
      <td className="numeric">
        <SessionContextPeak session={session} />
      </td>
      <td className="numeric muted">{formatInt(session.compaction_count)}</td>
      <td className="numeric">
        <SubagentRollup session={session} />
      </td>
      <td className="numeric muted">{formatInt(session.message_count)}</td>
      <td className="numeric">{money(sessionThreadCost(session))}</td>
      <td className="numeric muted">
        <SessionStartedAt value={session.started_at} />
      </td>
    </tr>
  );
});

export function DosuProvenanceBadge({ session }: { session: SessionSummary }) {
  if (session.dosu_mcp_tree_calls <= 0) {
    return null;
  }
  const evidence = {
    directCalls: session.dosu_mcp_direct_calls,
    treeCalls: session.dosu_mcp_tree_calls,
  };
  return (
    <Tooltip
      content={
        <div className="dosu-evidence-tooltip">
          <strong>Dosu MCP used in this session</strong>
          <p>{dosuEvidenceSummary(evidence)}</p>
        </div>
      }
    >
      {(tooltipProps) => (
        <a
          {...tooltipProps}
          aria-label={dosuBadgeAriaLabel(evidence)}
          className="dosu-provenance-badge"
          href={dosuLink("session_badge")}
          rel="noopener"
          target="_blank"
        >
          <img alt="" src={dosuOfficialUrl} />
          <span className="dosu-label-full">{dosuBadgeVisualLabel(false)}</span>
          <span className="dosu-label-compact">{dosuBadgeVisualLabel(true)}</span>
        </a>
      )}
    </Tooltip>
  );
}

export function SessionStartedAt({ value }: { value: string | null }) {
  const display = sessionListDate(value);
  if (display == null || value == null) {
    return <span>-</span>;
  }
  return (
    <time dateTime={value} title={fullDateTime(value) ?? display}>
      {display}
    </time>
  );
}

export function SessionContextPeak({ session }: { session: SessionSummary }) {
  const windowTokens = session.context_window_tokens;
  const peak = session.peak_context_tokens;
  const pct =
    windowTokens != null && windowTokens > 0 && peak != null && peak > 0
      ? Math.round((peak / windowTokens) * 100)
      : null;
  if (pct == null || pct === 0) {
    return <span className="faint">-</span>;
  }
  return (
    <span
      className={`session-context-peak${pct >= 80 ? " is-hot" : pct >= 60 ? " is-warm" : ""}`}
      title={`Peak context: ${compact(peak ?? 0)} of ${compact(windowTokens ?? 0)} window`}
    >
      {pct}%
    </span>
  );
}

export function SubagentRollup({ session }: { session: SessionSummary }) {
  const count = Math.max(session.subagent_count, session.subagents?.length ?? 0);
  if (count <= 0) {
    return <span className="faint">-</span>;
  }
  return (
    <span className="subagent-rollup" title={`${formatInt(count)} subagents`}>
      <span>{formatInt(count)}</span>
      {session.subagent_estimated_cost_usd > 0 ? (
        <small>+{money(session.subagent_estimated_cost_usd)}</small>
      ) : null}
    </span>
  );
}
