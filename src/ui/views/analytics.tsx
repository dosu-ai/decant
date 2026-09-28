import { useMemo, useState } from "react";
import dosuOfficialUrl from "../assets/dosu-official.svg";
import { brandTone, ModelBadge } from "../badges.tsx";
import {
  AnalyticsChart,
  HOUR_LABELS,
  hourLabel,
  NO_VALUES,
  peakIndex,
  WEEKDAY_LABELS,
  weekdayLabel,
} from "../charts.tsx";
import { Bar, EmptyState, Sparkline, StatCard, Tooltip } from "../common.tsx";
import { ALL_DATE_RANGE, dateRangeQuery, withDateQuery } from "../date-range.ts";
import { DateRangeControl } from "../date-range-control.tsx";
import { DOSU_ANALYTICS_DISMISSAL_KEY, shouldShowDosuCta } from "../dosu-cta.ts";
import { dosuLink } from "../dosu-links.ts";
import { basename, compact, duration, formatInt, money } from "../format.ts";
import { Icon } from "../icons.tsx";
import { Link } from "../link.tsx";
import { projectSessionsHref } from "../navigation.ts";
import {
  ANALYTICS_REPORT_INCLUDES,
  ANALYTICS_REPORT_NEVER_INCLUDES,
  ReportExportButton,
} from "../report-export.tsx";
import { readStorage, writeStorage } from "../safe-storage.ts";
import { hasShareCardValues, type ShareCardCopyInput } from "../share-card.ts";
import { localTimezone, ShareChartButton, shareRange } from "../share-chart.tsx";
import {
  type ModelSortKey,
  modelSortValue,
  nextSort,
  type ProjectSortKey,
  projectSortValue,
  SortableHeader,
  type SortState,
  sortRows,
} from "../sorting.tsx";
import type {
  Activity,
  ActivityBucket,
  BadgeTone,
  DashboardData,
  DateRangeSelection,
  DimensionRow,
  TokenEconomics,
} from "../types.ts";

/** An empty archive, not "No data in range": widening a date range cannot help someone with no sessions. */
export function FirstRunPanel({ onSync, syncing }: { onSync: () => void; syncing: boolean }) {
  return (
    <section className="panel first-run">
      <div className="panel-body">
        <span className="first-run-icon">
          <Icon name="beaker" />
        </span>
        <h2>No sessions yet</h2>
        <p>
          Decant reads the JSONL logs Claude Code, Codex, and Gemini CLI already write and turns
          them into a searchable session-log index with token, cost, and context-window analytics.
          Nothing leaves this machine.
        </p>
        <code>decant sync</code>
        <button
          aria-busy={syncing}
          aria-label="Sync session logs"
          className={`secondary-button sync-button${syncing ? " is-syncing" : ""}`}
          disabled={syncing}
          onClick={onSync}
          type="button"
        >
          <Icon name="refresh" />
          {syncing ? null : "Sync now"}
        </button>
      </div>
    </section>
  );
}

export function AnalyticsView({
  data,
  dateRange,
  onDateRangeChange,
  onSync,
  syncing,
}: {
  data: DashboardData;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const [dosuDismissed, setDosuDismissed] = useState(
    () => readStorage(DOSU_ANALYTICS_DISMISSAL_KEY) === "1",
  );
  const [modelSort, setModelSort] = useState<SortState<ModelSortKey>>({
    key: "cost",
    direction: "desc",
  });
  const [projectSort, setProjectSort] = useState<SortState<ProjectSortKey>>({
    key: "cost",
    direction: "desc",
  });
  const byDay = useMemo(
    () =>
      data.byDay
        .filter((row) => row.key !== "")
        .sort((left, right) => left.key.localeCompare(right.key)),
    [data.byDay],
  );
  const rangeLabels = useMemo(() => byDay.map((row) => row.key), [byDay]);
  const modelRows = useMemo(
    () => sortRows(data.byModel, modelSort, modelSortValue),
    [data.byModel, modelSort],
  );
  const projectRows = useMemo(
    () => sortRows(data.byProject, projectSort, projectSortValue).slice(0, 12),
    [data.byProject, projectSort],
  );
  const maxModelCost = Math.max(1.0e-9, ...modelRows.map((row) => row.estimated_cost_usd));
  // Date bounds span the whole archive and ignore the active filter, so this
  // separates "nothing ingested" from "nothing in the selected range".
  if (data.dateBounds != null && data.dateBounds.min == null && data.dateBounds.max == null) {
    return (
      <div className="view-stack">
        <FirstRunPanel onSync={onSync} syncing={syncing} />
      </div>
    );
  }
  return (
    <div className="view-stack">
      <header className="page-heading inline-heading">
        <div>
          <h1>Analytics</h1>
          <p>Usage and cost across your sessions.</p>
        </div>
        <div className="page-heading-actions">
          <ReportExportButton
            excluded={ANALYTICS_REPORT_NEVER_INCLUDES}
            href={withDateQuery("/api/reports/analytics.html", dateRangeQuery(dateRange))}
            includes={ANALYTICS_REPORT_INCLUDES}
            previewHref={withDateQuery("/reports/analytics", dateRangeQuery(dateRange))}
            title="Review analytics report"
          />
          <DateRangeControl
            bounds={data.dateBounds}
            range={dateRange}
            onChange={onDateRangeChange}
          />
        </div>
      </header>

      <div className="stat-grid analytics-stat-grid">
        <StatCard icon="sessions" label="Sessions" value={formatInt(data.summary?.sessions ?? 0)} />
        <StatCard icon="messages" label="Messages" value={formatInt(data.summary?.messages ?? 0)} />
        <StatCard icon="bolt" label="Tool calls" value={formatInt(data.summary?.tool_calls ?? 0)} />
        <StatCard
          icon="download"
          label="Input tokens"
          value={compact(data.summary?.input_tokens ?? 0)}
        />
        <StatCard
          icon="upload"
          label="Output tokens"
          value={compact(data.summary?.output_tokens ?? 0)}
        />
        <StatCard
          icon="money"
          label="Est. cost"
          value={money(data.summary?.estimated_cost_usd ?? 0)}
        />
      </div>

      <TokenEconomicsPanel economics={data.tokenEconomics} />

      <div className="split">
        <DailyPanel
          onShowAllTime={() => onDateRangeChange(ALL_DATE_RANGE)}
          rows={byDay}
          metric="sessions"
          timezone={data.activity?.timezone}
          title="Sessions per day"
        />
        <DailyPanel
          onShowAllTime={() => onDateRangeChange(ALL_DATE_RANGE)}
          rows={byDay}
          metric="cost"
          timezone={data.activity?.timezone}
          title="Cost per day"
        />
      </div>

      <div className="split">
        <ActivityPanel activity={data.activity} rangeLabels={rangeLabels} />
        <WeekdayPanel activity={data.activity} rangeLabels={rangeLabels} />
      </div>

      {shouldShowDosuCta({
        dismissed: dosuDismissed,
        route: "analytics",
      }) ? (
        <aside className="dosu-callout">
          <img alt="" src={dosuOfficialUrl} />
          <div>
            <strong>Your agents keep relearning what your team already knows.</strong>
            <span>Dosu gets them that knowledge faster and cheaper.</span>
          </div>
          <a href={dosuLink("analytics_callout")} rel="noopener" target="_blank">
            Learn about Dosu →
          </a>
          <button
            aria-label="Dismiss Dosu suggestion"
            className="icon-button"
            onClick={() => {
              writeStorage(DOSU_ANALYTICS_DISMISSAL_KEY, "1");
              setDosuDismissed(true);
            }}
            type="button"
          >
            <Icon name="x" />
          </button>
        </aside>
      ) : null}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>By model</h2>
            <p>Trend is sessions per day over the selected range</p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <SortableHeader
                  label="Model"
                  onSort={(key) => setModelSort((sort) => nextSort(sort, key))}
                  sort={modelSort}
                  sortKey="key"
                />
                <th>Trend</th>
                <SortableHeader
                  align="right"
                  label="Sessions"
                  onSort={(key) => setModelSort((sort) => nextSort(sort, key))}
                  sort={modelSort}
                  sortKey="sessions"
                />
                <SortableHeader
                  align="right"
                  label="In tok"
                  onSort={(key) => setModelSort((sort) => nextSort(sort, key))}
                  sort={modelSort}
                  sortKey="input_tokens"
                />
                <SortableHeader
                  align="right"
                  label="Out tok"
                  onSort={(key) => setModelSort((sort) => nextSort(sort, key))}
                  sort={modelSort}
                  sortKey="output_tokens"
                />
                <SortableHeader
                  align="right"
                  label="Reason tok"
                  onSort={(key) => setModelSort((sort) => nextSort(sort, key))}
                  sort={modelSort}
                  sortKey="reasoning_tokens"
                />
                <SortableHeader
                  align="right"
                  label="Cost"
                  onSort={(key) => setModelSort((sort) => nextSort(sort, key))}
                  sort={modelSort}
                  sortKey="cost"
                />
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {modelRows.length === 0 ? (
                <tr>
                  <td colSpan={8}>No model activity.</td>
                </tr>
              ) : null}
              {modelRows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <ModelBadge model={row.key} />
                  </td>
                  <td>
                    <Sparkline
                      tone={brandTone(row.key)}
                      values={data.modelSparklines?.models[row.key] ?? []}
                    />
                  </td>
                  <td className="numeric">{formatInt(row.sessions)}</td>
                  <td className="numeric muted">{compact(row.input_tokens)}</td>
                  <td className="numeric muted">{compact(row.output_tokens)}</td>
                  <td className="numeric muted">
                    {row.reasoning_tokens > 0
                      ? compact(row.reasoning_tokens)
                      : row.est_reasoning_tokens > 0
                        ? `~${compact(row.est_reasoning_tokens)}`
                        : "-"}
                  </td>
                  <td className="numeric">{money(row.estimated_cost_usd)}</td>
                  <td className="share-cell">
                    <Bar
                      fraction={row.estimated_cost_usd / maxModelCost}
                      tone={brandTone(row.key)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {projectRows.length > 0 ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>By project</h2>
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <SortableHeader
                    label="Project"
                    onSort={(key) => setProjectSort((sort) => nextSort(sort, key))}
                    sort={projectSort}
                    sortKey="key"
                  />
                  <SortableHeader
                    align="right"
                    label="Sessions"
                    onSort={(key) => setProjectSort((sort) => nextSort(sort, key))}
                    sort={projectSort}
                    sortKey="sessions"
                  />
                  <SortableHeader
                    align="right"
                    label="Cost"
                    onSort={(key) => setProjectSort((sort) => nextSort(sort, key))}
                    sort={projectSort}
                    sortKey="cost"
                  />
                </tr>
              </thead>
              <tbody>
                {projectRows.map((row) => (
                  <tr key={row.key}>
                    <td className="mono truncate-cell" title={row.key}>
                      <Link href={projectSessionsHref(row.key)}>{basename(row.key)}</Link>
                    </td>
                    <td className="numeric muted">{formatInt(row.sessions)}</td>
                    <td className="numeric">{money(row.estimated_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function ActivityPanel({
  activity,
  rangeLabels,
}: {
  activity: Activity | null;
  rangeLabels: string[];
}) {
  const labels = HOUR_LABELS;
  const values = activity?.by_hour ?? NO_VALUES;
  const peak = activity?.peak_hour ?? peakIndex(activity?.by_hour ?? []);
  const range = shareRange(rangeLabels);
  const shareInput: ShareCardCopyInput = {
    kind: "busiest_hours",
    labels,
    values,
    start: range.start,
    end: range.end,
    timezone: activity?.timezone ?? localTimezone(),
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Busiest hours</h2>
          <p>
            {peak == null
              ? "Sessions by hour, local time"
              : `Local time, you ship most around ${hourLabel(peak)}`}
          </p>
        </div>
        <ShareChartButton
          disabled={!hasShareCardValues(activity?.by_hour)}
          input={shareInput}
          metric="int"
          variant="bar"
        />
      </div>
      <div className="panel-body chart-panel-body">
        <AnalyticsChart labels={labels} metric="int" values={values} variant="bar" />
      </div>
    </section>
  );
}

export function TokenEconomicsPanel({
  compact: isCompact = false,
  description = "Estimated tokens, cost, and agent time by activity; capped user response time is shown separately.",
  economics,
  subagentRuns = 0,
  title = "Activity breakdown",
}: {
  compact?: boolean;
  description?: string;
  economics: TokenEconomics | null;
  subagentRuns?: number;
  title?: string;
}) {
  const buckets = economics?.buckets ?? [];
  const totalCost = economics?.totals.estimated_cost_usd ?? 0;
  const totalActiveMs = economics?.totals.active_ms ?? 0;
  const showAgentRuns = !isCompact;
  return (
    <section className={`panel token-economics-panel${isCompact ? " is-compact" : ""}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {economics != null ? (
          <div className="activity-summary">
            <span>
              <strong>{money(totalCost)}</strong>
              total
            </span>
            <span>
              <strong>{compact(economics.totals.context_window_tokens)}</strong>
              window
            </span>
            <span>
              <strong>{duration(economics.totals.active_ms)}</strong>
              agent time
            </span>
            <span>
              <strong>{duration(economics.totals.waiting_on_user_ms)}</strong>
              waiting
            </span>
            {isCompact && subagentRuns > 0 ? (
              <span>
                <strong>1 root + {formatInt(subagentRuns)}</strong>
                {subagentRuns === 1 ? "subagent" : "subagents"}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {buckets.length === 0 ? (
        <div className="panel-body">
          <EmptyState
            icon="chart"
            message="Sync sessions to populate the breakdown."
            title="No token data"
          />
        </div>
      ) : (
        <div className="activity-table-wrap">
          <table className="activity-table" aria-label="Activity token economics">
            <colgroup>
              <col className="col-activity" />
              <col className="col-share" />
              <col className="col-activity-number" />
              <col className="col-share" />
              <col className="col-activity-number" />
              <col className="col-activity-number" />
              <col className="col-activity-number" />
              {showAgentRuns ? <col className="col-activity-number" /> : null}
            </colgroup>
            <thead>
              <tr className="activity-table-head">
                <th scope="col">Activity</th>
                <th scope="col">Cost share</th>
                <th className="numeric activity-number" scope="col">
                  Cost
                </th>
                <th scope="col">Time spent</th>
                <th className="numeric activity-number" scope="col">
                  Time
                </th>
                <th className="numeric activity-number" scope="col">
                  Generated
                </th>
                <th className="numeric activity-number" scope="col">
                  Window
                </th>
                {showAgentRuns ? (
                  <th className="numeric activity-number" scope="col">
                    <span title="Root sessions and nested subagent runs contributing to this activity">
                      Agent runs
                    </span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => {
                const tone = activityTone(bucket.bucket);
                const share = Math.max(0, Math.min(1, bucket.cost_share));
                const timeShare = totalActiveMs > 0 ? bucket.active_ms / totalActiveMs : 0;
                return (
                  <Tooltip content={activityDescription(bucket.bucket)} key={bucket.bucket}>
                    {(tooltipProps) => (
                      <tr className="activity-table-row" {...tooltipProps}>
                        <td className="activity-name">
                          <span className="activity-name-inner">
                            <span className={`activity-swatch tone-${tone}`} />
                            <span className="activity-label-text">
                              {activityLabel(bucket.bucket)}
                              <span aria-hidden="true" className="info-tooltip">
                                <Icon name="info" />
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="activity-share">
                          <span className="activity-share-inner">
                            <span className="activity-bar">
                              <span
                                className={`tone-${tone}`}
                                style={{ width: `${share * 100}%` }}
                              />
                            </span>
                            <small>{Math.round(share * 100)}%</small>
                          </span>
                        </td>
                        <td className="numeric activity-number">
                          {money(bucket.estimated_cost_usd)}
                        </td>
                        <td className="activity-share">
                          <span className="activity-share-inner">
                            <span className="activity-bar">
                              <span
                                className={`tone-${tone}`}
                                style={{ width: `${timeShare * 100}%` }}
                              />
                            </span>
                            <small>{Math.round(timeShare * 100)}%</small>
                          </span>
                        </td>
                        <td className="numeric muted activity-number">
                          {duration(bucket.active_ms)}
                        </td>
                        <td className="numeric muted activity-number">
                          {compact(bucket.generation_tokens)}
                        </td>
                        <td className="numeric muted activity-number">
                          {compact(bucket.context_window_tokens)}
                        </td>
                        {showAgentRuns ? (
                          <td className="numeric muted activity-number">
                            {formatInt(bucket.sessions)}
                          </td>
                        ) : null}
                      </tr>
                    )}
                  </Tooltip>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function WeekdayPanel({
  activity,
  rangeLabels,
}: {
  activity: Activity | null;
  rangeLabels: string[];
}) {
  const labels = WEEKDAY_LABELS;
  const values = activity?.by_weekday ?? NO_VALUES;
  const peak = activity?.peak_weekday ?? peakIndex(activity?.by_weekday ?? []);
  const range = shareRange(rangeLabels);
  const shareInput: ShareCardCopyInput = {
    kind: "busiest_days",
    labels,
    values,
    start: range.start,
    end: range.end,
    timezone: activity?.timezone ?? localTimezone(),
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Busiest days</h2>
          <p>{peak == null ? "Sessions by weekday" : `You ship most on ${weekdayLabel(peak)}`}</p>
        </div>
        <ShareChartButton
          disabled={!hasShareCardValues(activity?.by_weekday)}
          input={shareInput}
          metric="int"
          variant="bar"
        />
      </div>
      <div className="panel-body chart-panel-body">
        <AnalyticsChart labels={labels} metric="int" values={values} variant="bar" />
      </div>
    </section>
  );
}

export function DailyPanel({
  onShowAllTime,
  rows,
  metric,
  timezone,
  title,
}: {
  onShowAllTime: () => void;
  rows: DimensionRow[];
  metric: "sessions" | "cost";
  timezone: string | undefined;
  title: string;
}) {
  const labels = useMemo(() => rows.map((row) => row.key), [rows]);
  const values = useMemo(
    () => rows.map((row) => (metric === "sessions" ? row.sessions : row.estimated_cost_usd)),
    [rows, metric],
  );
  const range = shareRange(labels);
  const shareInput: ShareCardCopyInput = {
    kind: metric === "sessions" ? "sessions_per_day" : "estimated_cost_per_day",
    labels,
    values,
    start: range.start,
    end: range.end,
    timezone: timezone ?? localTimezone(),
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
        </div>
        <ShareChartButton
          disabled={rows.length === 0}
          input={shareInput}
          metric={metric === "cost" ? "money" : "int"}
          variant={metric === "cost" ? "line" : "bar"}
        />
      </div>
      <div className="panel-body">
        {rows.length === 0 ? (
          <EmptyState
            action={
              <button className="secondary-button" onClick={onShowAllTime} type="button">
                All time
              </button>
            }
            icon="chart"
            message="Widen the date range."
            title="No data in range"
          />
        ) : (
          <AnalyticsChart
            labels={labels}
            metric={metric === "cost" ? "money" : "int"}
            values={values}
            variant={metric === "cost" ? "line" : "bar"}
          />
        )}
      </div>
    </section>
  );
}

export function activityLabel(bucket: ActivityBucket): string {
  switch (bucket) {
    case "planning":
      return "Planning";
    case "communicating":
      return "Communicating";
    case "context":
      return "Context";
    case "code":
      return "Code";
  }
}

export function activityDescription(bucket: ActivityBucket): string {
  switch (bucket) {
    case "planning":
      return "Thinking, plan-mode events, and todo/planning tool use.";
    case "communicating":
      return "Assistant prose written for the user outside tool calls.";
    case "context":
      return "Reads, searches, MCP calls, read-only shell commands, and their returned context.";
    case "code":
      return "Edits, writes, installs, tests, builds, and other mutating commands.";
  }
}

export function activityTone(bucket: ActivityBucket): BadgeTone {
  switch (bucket) {
    case "planning":
      return "warning";
    case "communicating":
      return "accent";
    case "context":
      return "info";
    case "code":
      return "success";
  }
}
