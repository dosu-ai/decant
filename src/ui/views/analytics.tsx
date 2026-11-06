import { useMemo, useState } from "react";
import { alignToSeries, buildDaySeries, type DaySeries } from "../../day-series.ts";
import {
  cacheDetail,
  cacheHitRate,
  costPerCompletedSession,
  orderedOutcomes,
  outcomeDescription,
  outcomeLabel,
  percentDelta,
  previousPeriodLabel,
  previousRange,
} from "../analytics-metrics.ts";
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
import { Bar, CostValue, EmptyState, Sparkline, StatCard, Tooltip } from "../common.tsx";
import { ALL_DATE_RANGE, dateRangeQuery, withDateQuery } from "../date-range.ts";
import { DateRangeControl } from "../date-range-control.tsx";
import { DOSU_ANALYTICS_DISMISSAL_KEY, shouldShowDosuCta } from "../dosu-cta.ts";
import { dosuLink } from "../dosu-links.ts";
import {
  basename,
  compact,
  costDisplay,
  duration,
  formatInt,
  money,
  NO_USAGE_TITLE,
  roundedPercents,
  usageMetric,
} from "../format.ts";
import { Icon } from "../icons.tsx";
import { Link } from "../link.tsx";
import { repoSessionsHref } from "../navigation.ts";
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
import { type DashboardSource, dashboardSourceOptions, sourceScopeQuery } from "../source-scope.ts";
import type {
  Activity,
  ActivityBucket,
  BadgeTone,
  DashboardData,
  DataSlice,
  DateRangeSelection,
  DimensionRow,
  TokenEconomics,
} from "../types.ts";

/** Where a slice stands for the filter on screen. */
export type SliceStatus = "ready" | "loading" | "failed";

const ALWAYS_READY = (): SliceStatus => "ready";

/** Repositories shown before the table stops; the cut keeps the costliest. */
const REPO_ROW_LIMIT = 12;

const NO_PROJECT_KEY = "(none)";

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
          Decant reads the session logs Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI, GitHub
          Copilot CLI, and Copilot Chat in VS Code already write, plus any ATIF trajectories you
          import, and turns them into a searchable session-log index with token, cost, and
          context-window analytics wherever the source records usage. Nothing leaves this machine.
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
  onSourceChange,
  onSync,
  sliceStatus = ALWAYS_READY,
  source,
  syncing,
}: {
  data: DashboardData;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
  onSourceChange: (source: DashboardSource) => void;
  onSync: () => void;
  /** Whether each slice matches the current filter. Defaults to ready. */
  sliceStatus?: (slice: DataSlice) => SliceStatus;
  source: DashboardSource;
  syncing: boolean;
}) {
  const analyticsQuery = sourceScopeQuery(dateRangeQuery(dateRange), source);
  const [dosuDismissed, setDosuDismissed] = useState(
    () => readStorage(DOSU_ANALYTICS_DISMISSAL_KEY) === "1",
  );
  const [modelSort, setModelSort] = useState<SortState<ModelSortKey>>({
    key: "cost",
    direction: "desc",
  });
  const [repoSort, setRepoSort] = useState<SortState<ProjectSortKey>>({
    key: "cost",
    direction: "desc",
  });
  const daySeries = useMemo(
    () => buildDaySeries(data.byDay, { from: dateRange.from, to: dateRange.to }),
    [data.byDay, dateRange.from, dateRange.to],
  );
  const rangeLabels = useMemo(() => daySeries.points.map((point) => point.key), [daySeries]);
  const modelRows = useMemo(
    () => sortRows(data.byModel, modelSort, modelSortValue),
    [data.byModel, modelSort],
  );
  // Keep the costliest repositories, then apply the chosen order to those.
  const repoRows = useMemo(
    () =>
      sortRows(
        [...data.byRepo]
          .sort((left, right) => right.estimated_cost_usd - left.estimated_cost_usd)
          .slice(0, REPO_ROW_LIMIT),
        repoSort,
        projectSortValue,
      ),
    [data.byRepo, repoSort],
  );
  const modelCostPercents = useMemo(
    () => roundedPercents(modelRows.map((row) => row.estimated_cost_usd)),
    [modelRows],
  );
  const totalModelCost = modelRows.reduce((sum, row) => sum + row.estimated_cost_usd, 0);

  const status = (slice: DataSlice) => sliceStatus(slice);
  const summary = data.summary;
  const summaryStatus = status("summary");
  const summaryLoading = summary == null && summaryStatus === "loading";
  const summaryUpdating = summary != null && summaryStatus === "loading";
  const sessions = summary?.sessions ?? 0;
  const usageSessions = summary?.usage_sessions ?? 0;
  const estCost = costDisplay(summary?.estimated_cost_usd ?? 0, sessions, usageSessions);
  const hitRate = summary == null ? null : cacheHitRate(summary);
  const summaryReady = summary != null && summaryStatus === "ready";
  const previous = previousRange(dateRange.from, dateRange.to);
  // Compare only once both sides describe the selected range; while one is
  // still loading, a delta would mix the old filter with the new one.
  const previousSummary =
    summaryReady && status("previousSummary") === "ready" ? data.previousSummary : null;
  const delta = (current: number, before: number | undefined) =>
    previous == null || previousSummary == null
      ? null
      : percentDelta(current, before, previous.days);
  const previousHitRate = previousSummary == null ? null : cacheHitRate(previousSummary);
  const outcomesReady = status("byOutcome") === "ready";
  const perCompleted =
    !summaryReady || !outcomesReady
      ? null
      : costPerCompletedSession(summary.estimated_cost_usd, data.byOutcome);
  const completed = data.byOutcome.find((row) => row.key === "completed")?.sessions ?? 0;
  const usageUnavailable = sessions > 0 && usageSessions === 0;
  // A summary that failed to load is unknown, not zero.
  const tile = (text: string) => (summary == null ? "-" : text);

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
            href={withDateQuery("/api/reports/analytics.html", analyticsQuery)}
            includes={ANALYTICS_REPORT_INCLUDES}
            previewHref={withDateQuery("/reports/analytics", analyticsQuery)}
            title="Review analytics report"
          />
          <SourceControl onChange={onSourceChange} sources={data.sessionSources} value={source} />
          <DateRangeControl
            bounds={data.dateBounds}
            range={dateRange}
            onChange={onDateRangeChange}
          />
        </div>
      </header>

      <div className="stat-grid analytics-stat-grid">
        <StatCard
          detail={delta(sessions, previousSummary?.sessions)}
          icon="sessions"
          label="Sessions"
          loading={summaryLoading}
          updating={summaryUpdating}
          value={tile(formatInt(sessions))}
          valueTitle="Top-level sessions. Subagent runs count toward the session that started them."
        />
        <StatCard
          detail={delta(summary?.messages ?? 0, previousSummary?.messages)}
          icon="messages"
          label="Messages"
          loading={summaryLoading}
          updating={summaryUpdating}
          value={tile(formatInt(summary?.messages ?? 0))}
        />
        <StatCard
          detail={delta(summary?.tool_calls ?? 0, previousSummary?.tool_calls)}
          icon="bolt"
          label="Tool calls"
          loading={summaryLoading}
          updating={summaryUpdating}
          value={tile(formatInt(summary?.tool_calls ?? 0))}
        />
        <StatCard
          detail={
            outcomesReady && sessions > 0
              ? `${formatInt(completed)} of ${formatInt(sessions)} completed`
              : null
          }
          detailTitle="Completed means the transcript ended on an assistant reply. It does not show that the work shipped."
          icon="check"
          label="Per completed session"
          loading={
            summaryLoading ||
            (perCompleted == null &&
              (summaryStatus === "loading" || status("byOutcome") === "loading"))
          }
          updating={summaryUpdating}
          value={
            usageUnavailable ? "Unavailable" : perCompleted == null ? "-" : money(perCompleted)
          }
          valueTitle="All estimated cost in range, abandoned and failed sessions included, divided by the sessions that completed."
        />
        <StatCard
          detail={delta(summary?.input_tokens ?? 0, previousSummary?.input_tokens)}
          icon="download"
          label="Input tokens"
          loading={summaryLoading}
          updating={summaryUpdating}
          value={tile(usageMetric(sessions, usageSessions, compact(summary?.input_tokens ?? 0)))}
          valueTitle="Prompt tokens sent without a cache hit."
        />
        <StatCard
          detail={cacheDetail(hitRate, previousHitRate)}
          detailTitle={
            hitRate == null
              ? undefined
              : `${Math.round(hitRate * 100)}% of prompt tokens were read from the provider's cache${
                  previousHitRate == null || previous == null
                    ? "."
                    : `, against ${Math.round(previousHitRate * 100)}% in the ${previousPeriodLabel(previous.days)}.`
                }`
          }
          icon="layers"
          label="Cache reads"
          loading={summaryLoading}
          updating={summaryUpdating}
          value={tile(
            usageMetric(sessions, usageSessions, compact(summary?.cache_read_tokens ?? 0)),
          )}
          valueTitle="Prompt tokens read from the provider's cache. They bill at a fraction of the input rate but are usually most of the volume."
        />
        <StatCard
          detail={delta(summary?.output_tokens ?? 0, previousSummary?.output_tokens)}
          icon="upload"
          label="Output tokens"
          loading={summaryLoading}
          updating={summaryUpdating}
          value={tile(usageMetric(sessions, usageSessions, compact(summary?.output_tokens ?? 0)))}
        />
        <StatCard
          detail={delta(summary?.estimated_cost_usd ?? 0, previousSummary?.estimated_cost_usd)}
          icon="money"
          label="Est. cost"
          loading={summaryLoading}
          updating={summaryUpdating}
          value={tile(estCost.text)}
          valueTitle={
            estCost.title ??
            "Token usage priced at current API list prices. A subscription bill can differ."
          }
        />
      </div>

      <TokenEconomicsPanel
        costAvailable={sessions === 0 || usageSessions > 0}
        economics={data.tokenEconomics}
        loading={status("tokenEconomics") === "loading"}
      />

      <OutcomesPanel
        loading={status("byOutcome") === "loading"}
        perCompleted={usageUnavailable ? null : perCompleted}
        rows={data.byOutcome}
      />

      <div className="split">
        <DailyPanel
          metric="sessions"
          status={status("byDay")}
          onShowAllTime={() => onDateRangeChange(ALL_DATE_RANGE)}
          range={dateRange}
          rows={data.byDay}
        />
        <DailyPanel
          metric="cost"
          status={status("byDay")}
          onShowAllTime={() => onDateRangeChange(ALL_DATE_RANGE)}
          range={dateRange}
          rows={data.byDay}
        />
      </div>

      <div className="split">
        <ActivityPanel
          activity={data.activity}
          loading={status("activity") === "loading"}
          rangeLabels={rangeLabels}
        />
        <WeekdayPanel
          activity={data.activity}
          loading={status("activity") === "loading"}
          rangeLabels={rangeLabels}
        />
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

      <section
        className="panel"
        {...updatingProps(
          modelRows.length > 0 &&
            (status("byModel") === "loading" || status("modelSparklines") === "loading"),
        )}
      >
        <div className="panel-heading">
          <div>
            <h2>By model</h2>
            <p>
              Trend is sessions per {daySeries.granularity} over the selected range. Share is each
              model's part of the estimated cost.
            </p>
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
                <th>Share of cost</th>
              </tr>
            </thead>
            <tbody>
              {modelRows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    {status("byModel") === "loading" ? "Loading models…" : "No model activity."}
                  </td>
                </tr>
              ) : null}
              {modelRows.map((row, index) => (
                <tr key={row.key}>
                  <td>
                    <ModelBadge model={row.key} />
                  </td>
                  <td>
                    <Sparkline
                      tone={brandTone(row.key)}
                      values={
                        // Sparklines from another range would be padded with
                        // zeros to this one, so show none until they match.
                        data.modelSparklines == null || status("modelSparklines") !== "ready"
                          ? []
                          : alignToSeries(
                              daySeries,
                              data.modelSparklines.days,
                              data.modelSparklines.models[row.key] ?? [],
                            )
                      }
                    />
                  </td>
                  <td className="numeric">{formatInt(row.sessions)}</td>
                  <td className="numeric muted">
                    <UsageTokens row={row} value={row.input_tokens} />
                  </td>
                  <td className="numeric muted">
                    <UsageTokens row={row} value={row.output_tokens} />
                  </td>
                  <td className="numeric muted">
                    {row.reasoning_tokens > 0
                      ? compact(row.reasoning_tokens)
                      : row.est_reasoning_tokens > 0
                        ? `~${compact(row.est_reasoning_tokens)}`
                        : "-"}
                  </td>
                  <td className="numeric">
                    <CostValue
                      cost={row.estimated_cost_usd}
                      dense
                      sessions={row.sessions}
                      usageSessions={row.usage_sessions}
                    />
                  </td>
                  <td className="share-cell">
                    <span className="share-cell-inner">
                      <Bar
                        fraction={totalModelCost > 0 ? row.estimated_cost_usd / totalModelCost : 0}
                        tone={brandTone(row.key)}
                      />
                      <small>{modelCostPercents[index] ?? 0}%</small>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {repoRows.length > 0 ? (
        <section className="panel" {...updatingProps(status("byRepo") === "loading")}>
          <div className="panel-heading">
            <div>
              <h2>By repository</h2>
              <p>
                Worktrees count toward the repository they came from.
                {data.byRepo.length > REPO_ROW_LIMIT
                  ? ` The ${REPO_ROW_LIMIT} costliest of ${formatInt(data.byRepo.length)} are shown.`
                  : ""}
              </p>
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <SortableHeader
                    label="Repository"
                    onSort={(key) => setRepoSort((sort) => nextSort(sort, key))}
                    sort={repoSort}
                    sortKey="key"
                  />
                  <SortableHeader
                    align="right"
                    label="Sessions"
                    onSort={(key) => setRepoSort((sort) => nextSort(sort, key))}
                    sort={repoSort}
                    sortKey="sessions"
                  />
                  <SortableHeader
                    align="right"
                    label="Cost"
                    onSort={(key) => setRepoSort((sort) => nextSort(sort, key))}
                    sort={repoSort}
                    sortKey="cost"
                  />
                </tr>
              </thead>
              <tbody>
                {repoRows.map((row) => (
                  <tr key={row.key}>
                    <td className="mono truncate-cell" title={row.key}>
                      {row.key === NO_PROJECT_KEY ? (
                        <span className="muted">No project</span>
                      ) : (
                        <Link href={repoSessionsHref(row.key)}>{basename(row.key)}</Link>
                      )}
                    </td>
                    <td className="numeric muted">{formatInt(row.sessions)}</td>
                    <td className="numeric">
                      <CostValue
                        cost={row.estimated_cost_usd}
                        dense
                        sessions={row.sessions}
                        usageSessions={row.usage_sessions}
                      />
                    </td>
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

/** A dense token cell: "-" when none of the row's sessions recorded usage. */
function UsageTokens({ row, value }: { row: DimensionRow; value: number }) {
  return row.sessions > 0 && row.usage_sessions === 0 ? (
    <span className="faint" title={NO_USAGE_TITLE}>
      -
    </span>
  ) : (
    compact(value)
  );
}

/** Marks a panel whose rows are from the previous filter while new ones load. */
function updatingProps(updating: boolean): {
  "aria-busy"?: true;
  "data-updating"?: "true";
} {
  return updating ? { "aria-busy": true, "data-updating": "true" } : {};
}

function LoadingState({ what }: { what: string }) {
  return <EmptyState icon="chart" message={`Reading ${what} from the archive.`} title="Loading" />;
}

function FailedState() {
  return (
    <EmptyState
      icon="chart"
      message="Decant could not read this chart. Reload the page or run Sync."
      title="Not loaded"
    />
  );
}

export function OutcomesPanel({
  loading = false,
  perCompleted,
  rows,
}: {
  loading?: boolean;
  perCompleted: number | null;
  rows: DimensionRow[];
}) {
  const ordered = orderedOutcomes(rows);
  const sessionPercents = roundedPercents(ordered.map((row) => row.sessions));
  const totalSessions = ordered.reduce((sum, row) => sum + row.sessions, 0);
  return (
    <section className="panel outcomes-panel" {...updatingProps(loading && rows.length > 0)}>
      <div className="panel-heading">
        <div>
          <h2>How sessions ended</h2>
          <p>
            Labels come from how each transcript ended, not from whether the work shipped. Cost
            includes each session's subagents.
          </p>
        </div>
        {perCompleted != null ? (
          <div className="activity-summary">
            <span>
              <strong>{money(perCompleted)}</strong>
              per completed session
            </span>
          </div>
        ) : null}
      </div>
      {ordered.length === 0 ? (
        <div className="panel-body">
          {loading ? (
            <LoadingState what="session outcomes" />
          ) : (
            <EmptyState icon="chart" message="Widen the date range." title="No sessions in range" />
          )}
        </div>
      ) : (
        <div className="table-scroll">
          <table aria-label="Sessions by outcome">
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th className="numeric" scope="col">
                  Sessions
                </th>
                <th scope="col">Share of sessions</th>
                <th className="numeric" scope="col">
                  Est. cost
                </th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((row, index) => (
                <tr key={row.key}>
                  <td title={outcomeDescription(row.key)}>{outcomeLabel(row.key)}</td>
                  <td className="numeric">{formatInt(row.sessions)}</td>
                  <td className="share-cell">
                    <span className="share-cell-inner">
                      <Bar
                        fraction={totalSessions > 0 ? row.sessions / totalSessions : 0}
                        tone={outcomeTone(row.key)}
                      />
                      <small>{sessionPercents[index] ?? 0}%</small>
                    </span>
                  </td>
                  <td className="numeric">
                    <CostValue
                      cost={row.estimated_cost_usd}
                      dense
                      sessions={row.sessions}
                      usageSessions={row.usage_sessions}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function outcomeTone(key: string): BadgeTone {
  switch (key) {
    case "completed":
      return "success";
    case "abandoned":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function ActivityPanel({
  activity,
  loading = false,
  rangeLabels,
}: {
  activity: Activity | null;
  loading?: boolean;
  rangeLabels: string[];
}) {
  const labels = HOUR_LABELS;
  const values = activity?.by_hour ?? NO_VALUES;
  const peak = activity?.peak_hour ?? peakIndex(activity?.by_hour ?? []);
  const range = shareRange(rangeLabels);
  const timezone = activity?.timezone ?? localTimezone();
  const shareInput: ShareCardCopyInput = {
    kind: "busiest_hours",
    labels,
    values,
    start: range.start,
    end: range.end,
    timezone,
  };
  return (
    <section className="panel" {...updatingProps(loading && activity != null)}>
      <div className="panel-heading">
        <div>
          <h2>Busiest hours</h2>
          <p>
            {peak == null
              ? `Sessions started per hour, ${timezone}`
              : `Most sessions start around ${hourLabel(peak)}, ${timezone}`}
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
        {activity == null && loading ? (
          <LoadingState what="activity" />
        ) : (
          <AnalyticsChart
            description={`Bar chart of sessions started per hour of the day in ${timezone}${
              peak == null ? "" : `, peaking at ${hourLabel(peak)}`
            }.`}
            labels={labels}
            metric="int"
            values={values}
            variant="bar"
          />
        )}
      </div>
    </section>
  );
}

export function TokenEconomicsPanel({
  compact: isCompact = false,
  costAvailable = true,
  description = "Estimated tokens, cost, and agent time by activity; capped user response time is shown separately.",
  economics,
  loading = false,
  subagentRuns = 0,
  title = "Activity breakdown",
}: {
  compact?: boolean;
  /** False when none of the sessions in scope recorded token usage. */
  costAvailable?: boolean;
  description?: string;
  economics: TokenEconomics | null;
  /** True while the breakdown for the current filter is still loading. */
  loading?: boolean;
  subagentRuns?: number;
  title?: string;
}) {
  const buckets = economics?.buckets ?? [];
  const totalCost = economics?.totals.estimated_cost_usd ?? 0;
  const totalActiveMs = economics?.totals.active_ms ?? 0;
  const costPercents = roundedPercents(buckets.map((bucket) => bucket.cost_share));
  const timePercents = roundedPercents(buckets.map((bucket) => bucket.active_ms));
  const showAgentRuns = !isCompact;
  return (
    <section
      className={`panel token-economics-panel${isCompact ? " is-compact" : ""}`}
      {...updatingProps(loading && economics != null)}
    >
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {economics != null ? (
          <div className="activity-summary">
            <span>
              <strong>{costAvailable ? money(totalCost) : "Unavailable"}</strong>
              total
            </span>
            <span title={WINDOW_TITLE}>
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
          {economics == null && loading ? (
            <LoadingState what="the activity breakdown" />
          ) : (
            <EmptyState
              icon="chart"
              message="Sync sessions to populate the breakdown."
              title="No token data"
            />
          )}
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
                  <span title={WINDOW_TITLE}>Window</span>
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
              {buckets.map((bucket, index) => {
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
                          {costAvailable ? (
                            <span className="activity-share-inner">
                              <span className="activity-bar">
                                <span
                                  className={`tone-${tone}`}
                                  style={{ width: `${share * 100}%` }}
                                />
                              </span>
                              <small>{costPercents[index]}%</small>
                            </span>
                          ) : (
                            <span className="faint">-</span>
                          )}
                        </td>
                        <td className="numeric activity-number">
                          {costAvailable ? money(bucket.estimated_cost_usd) : "-"}
                        </td>
                        <td className="activity-share">
                          <span className="activity-share-inner">
                            <span className="activity-bar">
                              <span
                                className={`tone-${tone}`}
                                style={{ width: `${timeShare * 100}%` }}
                              />
                            </span>
                            <small>{timePercents[index]}%</small>
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

const WINDOW_TITLE =
  "Context-window volume: tokens each activity put into the model's context, such as tool results and file reads.";

export function WeekdayPanel({
  activity,
  loading = false,
  rangeLabels,
}: {
  activity: Activity | null;
  loading?: boolean;
  rangeLabels: string[];
}) {
  const labels = WEEKDAY_LABELS;
  const values = activity?.by_weekday ?? NO_VALUES;
  const peak = activity?.peak_weekday ?? peakIndex(activity?.by_weekday ?? []);
  const range = shareRange(rangeLabels);
  const timezone = activity?.timezone ?? localTimezone();
  const shareInput: ShareCardCopyInput = {
    kind: "busiest_days",
    labels,
    values,
    start: range.start,
    end: range.end,
    timezone,
  };
  return (
    <section className="panel" {...updatingProps(loading && activity != null)}>
      <div className="panel-heading">
        <div>
          <h2>Busiest days</h2>
          <p>
            {peak == null
              ? `Sessions started per weekday, ${timezone}`
              : `Most sessions start on ${weekdayLabel(peak)}, ${timezone}`}
          </p>
        </div>
        <ShareChartButton
          disabled={!hasShareCardValues(activity?.by_weekday)}
          input={shareInput}
          metric="int"
          variant="bar"
        />
      </div>
      <div className="panel-body chart-panel-body">
        {activity == null && loading ? (
          <LoadingState what="activity" />
        ) : (
          <AnalyticsChart
            description={`Bar chart of sessions started per weekday in ${timezone}${
              peak == null ? "" : `, highest on ${weekdayLabel(peak)}`
            }.`}
            labels={labels}
            metric="int"
            values={values}
            variant="bar"
          />
        )}
      </div>
    </section>
  );
}

export function DailyPanel({
  metric,
  onShowAllTime,
  range,
  rows,
  status = "ready",
}: {
  metric: "sessions" | "cost";
  onShowAllTime: () => void;
  range?: Pick<DateRangeSelection, "from" | "to">;
  rows: DimensionRow[];
  /** Whether `rows` belong to the selected range yet. */
  status?: SliceStatus;
}) {
  const series: DaySeries = useMemo(
    () => buildDaySeries(rows, { from: range?.from, to: range?.to }),
    [rows, range?.from, range?.to],
  );
  const weekly = series.granularity === "week";
  const title =
    metric === "sessions"
      ? weekly
        ? "Sessions per week"
        : "Sessions per day"
      : weekly
        ? "Estimated cost per week"
        : "Estimated cost per day";
  const labels = useMemo(() => series.points.map((point) => point.key), [series]);
  const values = useMemo(
    () => series.points.map((point) => (metric === "sessions" ? point.sessions : point.cost)),
    [series, metric],
  );
  const missingUsage = metric === "cost" ? series.missingUsage : 0;
  // A bounded range pads every day with zeros, so "has data" must come from
  // the rows themselves, not from the number of points.
  const hasData = series.observedDays > 0 && series.points.length > 0;
  const costUnknown = metric === "cost" && hasData && values.every((value) => value === null);
  const shareSpan = shareRange(labels);
  const shareInput: ShareCardCopyInput = {
    kind:
      metric === "sessions"
        ? weekly
          ? "sessions_per_week"
          : "sessions_per_day"
        : weekly
          ? "estimated_cost_per_week"
          : "estimated_cost_per_day",
    labels,
    missingUsage,
    values,
    start: shareSpan.start,
    end: shareSpan.end,
    timezone: "UTC",
  };
  const unit = weekly ? "UTC weeks starting Monday" : "UTC days";
  return (
    <section
      aria-busy={status === "loading" ? true : undefined}
      className="panel"
      data-updating={status === "loading" && hasData ? "true" : undefined}
    >
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p title={missingUsage > 0 ? NO_USAGE_TITLE : undefined}>
            {missingUsage > 0
              ? `${unit}. Leaves out ${formatInt(missingUsage)} ${
                  missingUsage === 1 ? "session" : "sessions"
                } without usage data.`
              : `${unit}.`}
          </p>
        </div>
        <ShareChartButton
          disabled={!hasData || costUnknown || status !== "ready"}
          input={shareInput}
          metric={metric === "cost" ? "money" : "int"}
          variant={metric === "cost" ? "line" : "bar"}
        />
      </div>
      <div className="panel-body">
        {status === "failed" && !hasData ? (
          <FailedState />
        ) : !hasData && status === "loading" ? (
          <LoadingState what={metric === "cost" ? "daily cost" : "daily sessions"} />
        ) : costUnknown ? (
          <EmptyState icon="chart" message={NO_USAGE_TITLE} title="Cost unavailable" />
        ) : !hasData ? (
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
            description={dailyDescription(title, series, metric)}
            labels={labels}
            metric={metric === "cost" ? "money" : "int"}
            period={series.granularity}
            values={values}
            variant={metric === "cost" ? "line" : "bar"}
          />
        )}
      </div>
    </section>
  );
}

function dailyDescription(title: string, series: DaySeries, metric: "sessions" | "cost"): string {
  const first = series.points[0]?.key ?? "";
  const last = series.points.at(-1)?.key ?? "";
  const total =
    metric === "sessions"
      ? `${formatInt(series.points.reduce((sum, point) => sum + point.sessions, 0))} sessions`
      : `${money(series.points.reduce((sum, point) => sum + (point.cost ?? 0), 0))} estimated`;
  return `${title} from ${first} to ${last} (UTC): ${total} in total.`;
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

function SourceControl({
  onChange,
  sources,
  value,
}: {
  onChange: (source: DashboardSource) => void;
  sources: DashboardData["sessionSources"];
  value: DashboardSource;
}) {
  return (
    <label className="source-filter-control">
      <span className="sr-only">Source</span>
      <span className="select-shell">
        <select
          aria-label="Source"
          onChange={(event) => onChange(event.target.value as DashboardSource)}
          value={value}
        >
          {dashboardSourceOptions(sources).map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" />
      </span>
    </label>
  );
}
