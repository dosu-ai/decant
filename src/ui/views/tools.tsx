import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { previewOmittedCount } from "../../tools.ts";
import { getJson } from "../api.ts";
import { Badge } from "../badges.tsx";
import { EmptyState, ErrorState, StatCard, Tooltip } from "../common.tsx";
import { DateRangeControl } from "../date-range-control.tsx";
import { relativeTime } from "../date-time.ts";
import { errorRateDisplay } from "../error-rate.ts";
import { useDialogFocusTrap } from "../focus.ts";
import {
  capitalize,
  durationPrecise,
  errorMessage,
  firstLine,
  formatBytes,
  formatInt,
  isPresent,
} from "../format.ts";
import { Icon } from "../icons.tsx";
import { Link } from "../link.tsx";
import { mcpServerLabel, mcpServerLabels } from "../mcp-server.ts";
import {
  type McpSortKey,
  mcpSortValue,
  nextSort,
  SortableHeader,
  type SortState,
  sortRows,
  type ToolSortKey,
  toolSortValue,
} from "../sorting.tsx";
import { toolCallStatus } from "../tool-call-status.ts";
import {
  clearToolCallFilters,
  isDrilldownActivationKey,
  type ToolFilters,
  toolDateRangeFromFilters,
  toolFiltersFromSearch,
  toolFiltersHref,
  withToolDateRange,
} from "../tool-filters.ts";
import { toolTableColumns } from "../tool-table-layout.ts";
import type {
  DashboardData,
  DateRangeSelection,
  ToolCallPage,
  ToolCallRow,
  ToolRow,
} from "../types.ts";

export function toolAggregate(
  tools: ToolRow[],
  summary: ToolCallPage["summary"],
  scope: Pick<ToolFilters, "tool" | "server"> = { tool: "", server: "" },
) {
  const resolvedSummary = summary ?? { calls: 0, errors: 0, p50_ms: null, p95_ms: null };
  const totalCalls = resolvedSummary.calls;
  const totalErrors = resolvedSummary.errors;
  const scopedTools = tools.filter(
    (row) =>
      (scope.tool === "" || row.tool_name === scope.tool) &&
      (scope.server === "" || row.mcp_server === scope.server),
  );
  return {
    totalCalls,
    errorRate: totalCalls === 0 ? 0 : (totalErrors / totalCalls) * 100,
    p50: resolvedSummary.p50_ms,
    p95: resolvedSummary.p95_ms,
    topTool:
      scopedTools.slice().sort((left, right) => right.calls - left.calls)[0]?.tool_name ?? null,
  };
}

export function toolCallInputLabel(value: string | null): string {
  if (!isPresent(value)) {
    return "—";
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["path", "file_path", "command", "cmd", "query", "url"]) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim() !== "") {
          return firstLine(candidate, 120);
        }
      }
    }
  } catch {
    // Providers may store an abbreviated preview that is no longer valid JSON.
  }
  return firstLine(value, 120);
}

export function prettyToolValue(value: string | null): string {
  if (!isPresent(value)) {
    return "No value recorded.";
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** An elided value cannot parse as JSON, so Preview would silently render the
 * same raw text as Raw with nothing explaining why. */
export function ToolValueElision({ value }: { value: string | null }) {
  const omitted = previewOmittedCount(value);
  if (omitted == null) {
    return null;
  }
  return (
    <p className="tool-detail-elision">
      <Icon name="minus" />
      <span>
        Middle elided, {formatInt(omitted)} characters omitted. Open the transcript for the whole
        value.
      </span>
    </p>
  );
}

export function ToolCallStatus({ call }: { call: ToolCallRow }) {
  const status = toolCallStatus(call.is_error, call.has_result);
  const badge = (
    <Badge className="tool-call-status" tone={status.tone}>
      <Icon name={status.icon} />
      {status.label}
    </Badge>
  );
  if (status.title == null) {
    return badge;
  }
  return (
    <Tooltip content={status.title}>
      {(tooltipProps) => (
        <span {...tooltipProps}>
          {badge}
          <span className="sr-only">{status.title}</span>
        </span>
      )}
    </Tooltip>
  );
}

export function DrilldownTableRow({
  children,
  href,
  label,
}: {
  children: ReactNode;
  href: string;
  label: string;
}) {
  const activate = () => {
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: An anchor cannot legally wrap a table row.
    <tr
      aria-label={label}
      className="clickable-row drilldown-row"
      onClick={activate}
      onKeyDown={(event: ReactKeyboardEvent<HTMLTableRowElement>) => {
        if (!isDrilldownActivationKey(event.key)) {
          return;
        }
        event.preventDefault();
        activate();
      }}
      role="link"
      tabIndex={0}
    >
      {children}
    </tr>
  );
}

export function ToolCallDetail({
  call,
  onClose,
  onTabChange,
  serverLabel,
  tab,
}: {
  call: ToolCallRow;
  onClose: () => void;
  onTabChange: (tab: "preview" | "raw") => void;
  serverLabel: string;
  tab: "preview" | "raw";
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const transcriptHref =
    call.seq == null
      ? `/sessions/${call.session_id}`
      : `/sessions/${call.session_id}#message-${call.seq}`;
  useDialogFocusTrap(true, dialogRef, onClose);
  return (
    <>
      <button
        aria-label="Close tool call details"
        className="tool-detail-backdrop"
        onClick={onClose}
        type="button"
      />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="tool-detail-panel"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div className="tool-detail-heading">
            <span className="section-eyebrow" title={call.mcp_server ?? undefined}>
              {serverLabel || call.tool_kind || "Tool call"}
            </span>
            <h2 id={titleId}>{call.tool_name ?? "Unknown tool"}</h2>
          </div>
          <button
            aria-label="Close details"
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <Icon name="x" />
          </button>
        </header>
        <dl className="tool-detail-meta">
          <div>
            <dt>Status</dt>
            <dd>
              <ToolCallStatus call={call} />
            </dd>
          </div>
          <div>
            <dt>Elapsed</dt>
            <dd>{durationPrecise(call.duration_ms)}</dd>
          </div>
          <div>
            <dt>Input size</dt>
            <dd>{formatBytes(call.input_bytes)}</dd>
          </div>
          <div>
            <dt>Output size</dt>
            <dd>{formatBytes(call.output_bytes)}</dd>
          </div>
        </dl>
        <div className="segment-row">
          <fieldset className="segmented-control">
            <legend className="sr-only">Detail format</legend>
            {(["preview", "raw"] as const).map((choice) => (
              <button
                aria-pressed={tab === choice}
                key={choice}
                onClick={() => onTabChange(choice)}
                type="button"
              >
                {capitalize(choice)}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="tool-detail-content">
          <section>
            <h3>Input</h3>
            <ToolValueElision value={call.input_preview} />
            <pre>
              {tab === "raw" ? (call.input_preview ?? "") : prettyToolValue(call.input_preview)}
            </pre>
          </section>
          <section>
            <h3>{call.is_error === true ? "Error output" : "Output preview"}</h3>
            <ToolValueElision value={call.output_preview} />
            <pre>
              {tab === "raw" ? (call.output_preview ?? "") : prettyToolValue(call.output_preview)}
            </pre>
          </section>
        </div>
        <footer>
          <div className="tool-detail-session">
            <span>Session</span>
            <strong title={call.session_title ?? undefined}>
              {call.session_title ?? `Session ${call.session_id}`}
            </strong>
          </div>
          <Link className="secondary-button tool-detail-transcript-link" href={transcriptHref}>
            <Icon name="messages" />
            View in transcript
            <Icon name="chevronRight" />
          </Link>
        </footer>
      </section>
    </>
  );
}

export function ToolsView({
  data,
  dateRange,
  onDateRangeChange,
}: {
  data: DashboardData;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
}) {
  const locationFilters = toolFiltersFromSearch(window.location.search);
  const [mcpSort, setMcpSort] = useState<SortState<McpSortKey>>({
    key: "calls",
    direction: "desc",
  });
  const [toolSort, setToolSort] = useState<SortState<ToolSortKey>>({
    key: "calls",
    direction: "desc",
  });
  const [callPage, setCallPage] = useState<ToolCallPage>({
    calls: [],
    total: 0,
    limit: 50,
    offset: locationFilters.offset,
    summary: { calls: 0, errors: 0, p50_ms: null, p95_ms: null },
  });
  const [callError, setCallError] = useState<string | null>(null);
  const [callsLoading, setCallsLoading] = useState(true);
  const [selectedCall, setSelectedCall] = useState<ToolCallRow | null>(null);
  const [detailTab, setDetailTab] = useState<"preview" | "raw">("preview");
  const closeToolDetail = useCallback(() => setSelectedCall(null), []);
  const mcpRows = useMemo(() => sortRows(data.mcp, mcpSort, mcpSortValue), [data.mcp, mcpSort]);
  const toolRows = useMemo(
    () => sortRows(data.tools, toolSort, toolSortValue),
    [data.tools, toolSort],
  );
  // Built from every server in view, so two registrations of the same server
  // (`dosu` and `claude_ai_Dosu`) never render as two identical rows. Both
  // tables and the filter share one map so a server reads the same everywhere.
  // The two tables are limited independently, so the union is what is on
  // screen -- a server in one but not the other still gets a stable label.
  const serverLabels = useMemo(
    () =>
      mcpServerLabels([
        ...data.mcp.map((row) => row.mcp_server),
        ...data.tools.map((row) => row.mcp_server),
      ]),
    [data.mcp, data.tools],
  );
  const callQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (locationFilters.tool !== "") {
      params.set("tool", locationFilters.tool);
    }
    if (locationFilters.server !== "") {
      params.set("server", locationFilters.server);
    }
    if (locationFilters.errorsOnly) {
      params.set("errors_only", "true");
    }
    if (locationFilters.minMs > 0) {
      params.set("min_ms", String(locationFilters.minMs));
    }
    if (locationFilters.from != null) {
      params.set("from", locationFilters.from);
    }
    if (locationFilters.to != null) {
      params.set("to", locationFilters.to);
    }
    params.set("limit", "50");
    params.set("offset", String(locationFilters.offset));
    return params.toString();
  }, [
    locationFilters.errorsOnly,
    locationFilters.from,
    locationFilters.minMs,
    locationFilters.offset,
    locationFilters.server,
    locationFilters.to,
    locationFilters.tool,
  ]);
  const aggregate = useMemo(
    () =>
      toolAggregate(data.tools, callPage.summary, {
        tool: locationFilters.tool,
        server: locationFilters.server,
      }),
    [data.tools, callPage.summary, locationFilters.tool, locationFilters.server],
  );
  const durationAvailable =
    data.tools.some((row) => row.p50_ms != null) ||
    callPage.calls.some((row) => row.duration_ms != null);
  const mcpColumns = toolTableColumns("mcp", durationAvailable);
  const toolColumns = toolTableColumns("tools", durationAvailable);
  const callColumns = toolTableColumns("calls", durationAvailable);

  useEffect(() => {
    const restored = toolDateRangeFromFilters({
      from: locationFilters.from,
      to: locationFilters.to,
    });
    if (restored.from === dateRange.from && restored.to === dateRange.to) {
      return;
    }
    onDateRangeChange(restored);
  }, [dateRange.from, dateRange.to, locationFilters.from, locationFilters.to, onDateRangeChange]);

  useEffect(() => {
    const controller = new AbortController();
    setCallsLoading(true);
    setCallError(null);
    void getJson<ToolCallPage>(`/api/tools/calls?${callQuery}`, {
      signal: controller.signal,
    })
      .then((page) =>
        setCallPage((current) => ({
          ...page,
          summary: page.summary ?? current.summary,
        })),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setCallError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setCallsLoading(false);
        }
      });
    return () => controller.abort();
  }, [callQuery]);

  const updateFilters = (patch: Partial<ToolFilters>) => {
    const next = { ...locationFilters, ...patch };
    if (
      patch.tool != null ||
      patch.server != null ||
      patch.errorsOnly != null ||
      patch.minMs != null ||
      patch.from !== undefined ||
      patch.to !== undefined
    ) {
      next.offset = 0;
    }
    const href = toolFiltersHref(next);
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const clearedCallFilters = clearToolCallFilters(locationFilters);
  const clearedFiltersHref = toolFiltersHref(clearedCallFilters);
  const errorRate = errorRateDisplay(aggregate.totalCalls, aggregate.errorRate);

  return (
    <div className="view-stack">
      <header className="page-heading inline-heading">
        <div>
          <h1>Tools &amp; MCP</h1>
          <p>Tool and MCP-server call volume, scoped to your session logs.</p>
        </div>
        <DateRangeControl
          bounds={data.dateBounds}
          range={dateRange}
          onChange={(range) => {
            onDateRangeChange(range);
            const href = toolFiltersHref(withToolDateRange(locationFilters, range));
            window.history.pushState(null, "", href);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }}
        />
      </header>

      <section aria-label="Tool call summary" className="stat-grid tool-stat-grid">
        <StatCard icon="tools" label="Total calls" value={formatInt(aggregate.totalCalls)} />
        <StatCard alert={errorRate.alert} icon="info" label="Error rate" value={errorRate.label} />
        <StatCard
          icon="clock"
          label="Median / p95 elapsed"
          value={
            aggregate.p50 == null || aggregate.p95 == null
              ? "—"
              : `${durationPrecise(aggregate.p50)} / ${durationPrecise(aggregate.p95)}`
          }
        />
        <StatCard icon="bolt" label="Top tool" value={aggregate.topTool ?? "—"} />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>MCP servers</h2>
            <p>Model Context Protocol servers and their call volume</p>
          </div>
        </div>
        {mcpRows.length === 0 ? (
          <EmptyState
            icon="cpu"
            message="No MCP tool calls in this range."
            title="No MCP servers"
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table mcp-table">
              <colgroup>
                {mcpColumns.map((column) => (
                  <col
                    className={column.className}
                    key={column.className}
                    style={{ width: `${column.width}%` }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <SortableHeader
                    label="Server"
                    onSort={(key) => setMcpSort((sort) => nextSort(sort, key))}
                    sort={mcpSort}
                    sortKey="server"
                  />
                  <SortableHeader
                    align="right"
                    label="Tools"
                    onSort={(key) => setMcpSort((sort) => nextSort(sort, key))}
                    sort={mcpSort}
                    sortKey="tools"
                  />
                  <SortableHeader
                    align="right"
                    label="Calls"
                    onSort={(key) => setMcpSort((sort) => nextSort(sort, key))}
                    sort={mcpSort}
                    sortKey="calls"
                  />
                  <SortableHeader
                    align="right"
                    label="Errors"
                    onSort={(key) => setMcpSort((sort) => nextSort(sort, key))}
                    sort={mcpSort}
                    sortKey="errors"
                  />
                  {durationAvailable ? (
                    <SortableHeader
                      align="right"
                      label="Median elapsed"
                      onSort={(key) => setMcpSort((sort) => nextSort(sort, key))}
                      sort={mcpSort}
                      sortKey="p50"
                    />
                  ) : null}
                  <SortableHeader
                    align="right"
                    label="Last used"
                    onSort={(key) => setMcpSort((sort) => nextSort(sort, key))}
                    sort={mcpSort}
                    sortKey="last_used"
                  />
                </tr>
              </thead>
              <tbody>
                {mcpRows.map((row) => {
                  const href = toolFiltersHref({
                    ...clearedCallFilters,
                    server: row.mcp_server,
                  });
                  return (
                    <DrilldownTableRow
                      href={href}
                      key={row.mcp_server}
                      label={`Show calls from MCP server ${mcpServerLabel(serverLabels, row.mcp_server)}`}
                    >
                      <td className="mono">
                        <span className="icon-cell drilldown-label">
                          <Icon name="cpu" />
                          <span title={row.mcp_server ?? undefined}>
                            {mcpServerLabel(serverLabels, row.mcp_server)}
                          </span>
                        </span>
                      </td>
                      <td className="numeric muted">{formatInt(row.tools)}</td>
                      <td className="numeric">{formatInt(row.calls)}</td>
                      <td className="numeric">
                        {row.errors > 0 ? (
                          <Badge tone="danger">{formatInt(row.errors)}</Badge>
                        ) : (
                          <span className="faint">0</span>
                        )}
                      </td>
                      {durationAvailable ? (
                        <td className="numeric muted">{durationPrecise(row.p50_ms)}</td>
                      ) : null}
                      <td className="numeric muted">{relativeTime(row.last_used_at)}</td>
                    </DrilldownTableRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Tools</h2>
            <p>Built-in vs MCP, most-called first</p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table tools-table">
            <colgroup>
              {toolColumns.map((column) => (
                <col
                  className={column.className}
                  key={column.className}
                  style={{ width: `${column.width}%` }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                <SortableHeader
                  label="Tool"
                  onSort={(key) => setToolSort((sort) => nextSort(sort, key))}
                  sort={toolSort}
                  sortKey="tool"
                />
                <SortableHeader
                  label="Kind"
                  onSort={(key) => setToolSort((sort) => nextSort(sort, key))}
                  sort={toolSort}
                  sortKey="kind"
                />
                <SortableHeader
                  label="Server"
                  onSort={(key) => setToolSort((sort) => nextSort(sort, key))}
                  sort={toolSort}
                  sortKey="server"
                />
                <SortableHeader
                  align="right"
                  label="Calls"
                  onSort={(key) => setToolSort((sort) => nextSort(sort, key))}
                  sort={toolSort}
                  sortKey="calls"
                />
                <SortableHeader
                  align="right"
                  label="Errors"
                  onSort={(key) => setToolSort((sort) => nextSort(sort, key))}
                  sort={toolSort}
                  sortKey="errors"
                />
                {durationAvailable ? (
                  <SortableHeader
                    align="right"
                    label="Median elapsed"
                    onSort={(key) => setToolSort((sort) => nextSort(sort, key))}
                    sort={toolSort}
                    sortKey="p50"
                  />
                ) : null}
                <SortableHeader
                  align="right"
                  label="Last used"
                  onSort={(key) => setToolSort((sort) => nextSort(sort, key))}
                  sort={toolSort}
                  sortKey="last_used"
                />
              </tr>
            </thead>
            <tbody>
              {toolRows.length === 0 ? (
                <tr>
                  <td colSpan={durationAvailable ? 7 : 6}>No tool calls.</td>
                </tr>
              ) : null}
              {toolRows.map((row) => {
                const href = toolFiltersHref({
                  ...clearedCallFilters,
                  tool: row.tool_name,
                });
                return (
                  <DrilldownTableRow
                    href={href}
                    key={`${row.tool_name}-${row.tool_kind}-${row.mcp_server ?? ""}`}
                    label={`Show calls to tool ${row.tool_name}`}
                  >
                    <td className="mono drilldown-label">{row.tool_name}</td>
                    <td>
                      <Badge tone={row.tool_kind === "mcp" ? "accent" : "neutral"}>
                        {row.tool_kind === "mcp" ? "MCP" : "built-in"}
                      </Badge>
                    </td>
                    <td className="mono muted">
                      {row.mcp_server != null && row.mcp_server !== "" ? (
                        <span className="icon-cell">
                          <Icon name="cpu" />
                          <span title={row.mcp_server}>
                            {mcpServerLabel(serverLabels, row.mcp_server)}
                          </span>
                        </span>
                      ) : (
                        <span className="faint">-</span>
                      )}
                    </td>
                    <td className="numeric">{formatInt(row.calls)}</td>
                    <td className="numeric">
                      {row.errors > 0 ? (
                        <Badge tone="danger">{formatInt(row.errors)}</Badge>
                      ) : (
                        <span className="faint">0</span>
                      )}
                    </td>
                    {durationAvailable ? (
                      <td className="numeric muted">{durationPrecise(row.p50_ms)}</td>
                    ) : null}
                    <td className="numeric muted">{relativeTime(row.last_used_at)}</td>
                  </DrilldownTableRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading tool-calls-heading">
          <div>
            <h2>Calls</h2>
            <p>Inspect individual tool activity, inputs, results, and elapsed time</p>
          </div>
          <span className="muted">{formatInt(callPage.total)} matching</span>
        </div>
        <div className="tool-filter-bar">
          <label>
            <span>Tool</span>
            <select
              onChange={(event) => updateFilters({ tool: event.target.value })}
              value={locationFilters.tool}
            >
              <option value="">All tools</option>
              {data.tools.map((row) => (
                <option key={`${row.tool_name}-${row.mcp_server ?? ""}`} value={row.tool_name}>
                  {row.tool_name} ({formatInt(row.calls)})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Server</span>
            <select
              onChange={(event) => updateFilters({ server: event.target.value })}
              value={locationFilters.server}
            >
              <option value="">All servers</option>
              {data.mcp.map((row) => (
                <option key={row.mcp_server} title={row.mcp_server} value={row.mcp_server}>
                  {mcpServerLabel(serverLabels, row.mcp_server)} ({formatInt(row.calls)})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Minimum elapsed</span>
            <select
              onChange={(event) => updateFilters({ minMs: Number(event.target.value) })}
              value={locationFilters.minMs}
            >
              <option value={0}>Any elapsed time</option>
              <option value={100}>100 ms+</option>
              <option value={1000}>1 s+</option>
              <option value={5000}>5 s+</option>
              <option value={30000}>30 s+</option>
            </select>
          </label>
          <label className="tool-error-toggle">
            <input
              checked={locationFilters.errorsOnly}
              onChange={(event) => updateFilters({ errorsOnly: event.target.checked })}
              type="checkbox"
            />
            Errors only
          </label>
          {locationFilters.tool !== "" ||
          locationFilters.server !== "" ||
          locationFilters.errorsOnly ||
          locationFilters.minMs > 0 ? (
            <Link className="secondary-button" href={clearedFiltersHref}>
              Clear filters
            </Link>
          ) : null}
        </div>
        {callError != null ? (
          <ErrorState
            action={
              <button className="secondary-button" onClick={() => updateFilters({})} type="button">
                Retry
              </button>
            }
            detail={callError}
            title="Tool calls could not be loaded"
          />
        ) : callsLoading && callPage.calls.length === 0 ? (
          <div className="panel-body muted">Loading calls…</div>
        ) : callPage.calls.length === 0 ? (
          <EmptyState
            icon="tools"
            message="Try a wider date range or clear one of the filters."
            title="No matching tool calls"
          />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table tool-calls-table">
                <colgroup>
                  {callColumns.map((column) => (
                    <col
                      className={column.className}
                      key={column.className}
                      style={{ width: `${column.width}%` }}
                    />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Tool</th>
                    <th>Input preview</th>
                    {durationAvailable ? <th className="numeric">Elapsed</th> : null}
                    <th className="numeric">Output</th>
                    <th className="numeric">When</th>
                    <th>Session</th>
                  </tr>
                </thead>
                <tbody>
                  {callPage.calls.map((call) => (
                    <tr
                      className="clickable-row"
                      key={call.id}
                      onClick={() => {
                        setSelectedCall(call);
                        setDetailTab("preview");
                      }}
                    >
                      <td>
                        <ToolCallStatus call={call} />
                      </td>
                      <td className="mono">
                        <button
                          aria-label={`Inspect ${call.tool_name ?? "unknown tool"} call`}
                          className="tool-call-detail-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedCall(call);
                            setDetailTab("preview");
                          }}
                          type="button"
                        >
                          {call.tool_name ?? "Unknown"}
                        </button>
                      </td>
                      <td className="truncate-cell muted">
                        {toolCallInputLabel(call.input_preview)}
                      </td>
                      {durationAvailable ? (
                        <td className="numeric muted">{durationPrecise(call.duration_ms)}</td>
                      ) : null}
                      <td className="numeric muted">{formatBytes(call.output_bytes)}</td>
                      <td className="numeric muted">{relativeTime(call.timestamp)}</td>
                      <td>
                        <Link
                          href={`/sessions/${call.session_id}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {call.session_title ?? `Session ${call.session_id}`} →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="tool-call-pagination">
              <button
                className="secondary-button"
                disabled={callPage.offset === 0}
                onClick={() =>
                  updateFilters({ offset: Math.max(0, callPage.offset - callPage.limit) })
                }
                type="button"
              >
                <Icon name="chevronLeft" />
                Previous
              </button>
              <span className="muted">
                {formatInt(callPage.offset + 1)}–
                {formatInt(Math.min(callPage.offset + callPage.calls.length, callPage.total))} of{" "}
                {formatInt(callPage.total)}
              </span>
              <button
                className="secondary-button"
                disabled={callPage.offset + callPage.calls.length >= callPage.total}
                onClick={() => updateFilters({ offset: callPage.offset + callPage.limit })}
                type="button"
              >
                Next
                <Icon name="chevronRight" />
              </button>
            </div>
          </>
        )}
      </section>

      {selectedCall != null ? (
        <ToolCallDetail
          call={selectedCall}
          onClose={closeToolDetail}
          onTabChange={setDetailTab}
          serverLabel={mcpServerLabel(serverLabels, selectedCall.mcp_server)}
          tab={detailTab}
        />
      ) : null}
    </div>
  );
}
