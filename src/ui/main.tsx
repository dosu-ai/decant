import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { previewOmittedCount } from "../tools.ts";
import { getJson } from "./api.ts";
import { ApiFailureState } from "./api-failure.tsx";
import dosuDecantUrl from "./assets/dosu-decant.png";
import dosuOfficialUrl from "./assets/dosu-official.svg";
import {
  Badge,
  ModelBadge,
  providerIdentity,
  ReasoningBadge,
  ToolBadge,
  toneName,
} from "./badges.tsx";
import { copyTextToClipboard } from "./clipboard.ts";
import { paletteShortcutLabel, shouldOpenCommandPalette } from "./command-palette.ts";
import { CommandPalette } from "./command-palette-view.tsx";
import { EmptyState, ErrorState, OverflowMenu, StatCard, Tooltip } from "./common.tsx";
import { SESSION_DETAIL_MESSAGE_PAGE_SIZE, TABLE_ROW_LIMIT } from "./constants.ts";
import {
  contextCurveAreaPath,
  contextCurveLinePath,
  groupContextMarkers,
  layoutContextCurve,
  layoutContextTooltip,
} from "./context-window-layout.ts";
import { contextWindowDisplayMode, isFullCacheMiss } from "./context-window-state.ts";
import { emptyData, SLICE_LOADERS, slicesForView } from "./data-slices.ts";
import { ALL_DATE_RANGE, dateRangeQuery, withDateQuery } from "./date-range.ts";
import { DateRangeControl } from "./date-range-control.tsx";
import { relativeTime } from "./date-time.ts";
import { dosuLink } from "./dosu-links.ts";
import { dosuToolDisplayName, isDosuToolName } from "./dosu-tool.ts";
import { ErrorBoundary } from "./error-boundary.tsx";
import { errorRateDisplay } from "./error-rate.ts";
import { useDialogFocusTrap, useDisabledFocusRescue } from "./focus.ts";
import {
  basename,
  capitalize,
  compact,
  durationPrecise,
  errorMessage,
  field,
  firstLine,
  formatBytes,
  formatDay,
  formatInt,
  isPresent,
  latestSessionDay,
  matchText,
  money,
  shortDate,
  shortPath,
  versionLabel,
} from "./format.ts";
import { isFramed } from "./frame-guard.ts";
import { BrandMark, Icon } from "./icons.tsx";
import { formatIssueBadge, unknownRecordTypeSummary } from "./ingest-issues.ts";
import { createLatestThrottle, type LatestThrottle } from "./latest-throttle.ts";
import { Link, locationPath, visit } from "./link.tsx";
import { mcpServerLabel, mcpServerLabels } from "./mcp-server.ts";
import { navGroups, navItems } from "./nav-items.ts";
import {
  documentTitleFor,
  isKnownRoute,
  isSessionDetailPath,
  pathOnly,
  projectSessionsHref,
  activeRoute as resolveActiveRoute,
  activeRouteKey as resolveActiveRouteKey,
  sessionIncludesArchived,
  sessionPageFromPath,
  sessionProjectFilter,
  sessionsArchivedHref,
  sessionsPageHref,
  titleFor,
} from "./navigation.ts";
import {
  ANALYTICS_REPORT_INCLUDES,
  ANALYTICS_REPORT_NEVER_INCLUDES,
  ReportExportButton,
  ReportRouteView,
  SESSION_REPORT_INCLUDES,
  SESSION_REPORT_NEVER_INCLUDES,
} from "./report-export.tsx";
import { readStorage, removeStorage, writeStorage } from "./safe-storage.ts";
import { useSessionPage } from "./session-page.ts";
import {
  archiveActionFor,
  DELETE_SESSION_EXPLANATION,
  DELETE_SESSION_EYEBROW,
  type SessionStateUpdate,
  sessionStateRequest,
} from "./session-state.ts";
import {
  cleanSessionTitle,
  isPermissionsText,
  sessionDisplayTitle,
  tagAttribute,
} from "./session-title.ts";
import { collectSliceResults } from "./slice-loading.ts";
import {
  type FileSortKey,
  fileSortValue,
  fileTotal,
  type McpSortKey,
  mcpSortValue,
  nextSort,
  SortableHeader,
  type SortState,
  sortRows,
  type ToolSortKey,
  toolSortValue,
} from "./sorting.tsx";
import { toolCallStatus } from "./tool-call-status.ts";
import {
  clearToolCallFilters,
  isDrilldownActivationKey,
  type ToolFilters,
  toolDateRangeFromFilters,
  toolFiltersFromSearch,
  toolFiltersHref,
  withToolDateRange,
} from "./tool-filters.ts";
import { toolTableColumns } from "./tool-table-layout.ts";
import { TranscriptCodeBlock, TranscriptMarkdown } from "./transcript-markdown.tsx";
import {
  hasOpenModal,
  isInteractiveTarget,
  nextTranscriptSeq,
  revealTranscriptMessage,
  type TranscriptNavigationDirection,
  transcriptNavigationDirection,
  transcriptSeqFromHash,
} from "./transcript-navigation.ts";
import {
  appendTranscriptPage,
  prependTranscriptPage,
  previousTranscriptPageRequest,
  runWithTranscriptRequestSlot,
  transcriptPrefixRequest,
} from "./transcript-pagination.ts";
import {
  type StructuredTranscriptKind,
  type StructuredTranscriptLine,
  structuredTranscriptBlock,
} from "./transcript-presentation.ts";
import {
  collapseTranscriptText,
  embeddedAttachmentSummary,
  languageForTool,
  presentationForTool,
  summarizeToolResult,
  type TranscriptToolPresentation,
  transcriptCollapseLabel,
} from "./transcript-rendering.ts";
import type {
  ConfigView,
  ContextWindowCompactionData,
  ContextWindowTimelineData,
  DashboardData,
  DataSlice,
  DateBounds,
  DateRangeSelection,
  FileRow,
  IconName,
  Recommendation,
  ServerEventPayload,
  SessionDetailData,
  SessionIngestIssue,
  SessionOutlineItemData,
  SessionPageState,
  SessionSummary,
  SettingsInfo,
  SubagentDetailData,
  SyncProgress,
  ThemeChoice,
  TokenEconomics,
  ToolCallPage,
  ToolCallRow,
  ToolRow,
  TranscriptBlockData,
  UserSettings,
} from "./types.ts";
import { AnalyticsView, TokenEconomicsPanel } from "./views/analytics.tsx";
import { ProjectsView } from "./views/projects.tsx";
import { SearchView } from "./views/search.tsx";
import { DosuProvenanceBadge, SessionsView } from "./views/sessions.tsx";
import "./styles.css";

const LIVE_DISCONNECT_GRACE_MS = 15_000;
// Every other view renders its own <h1>; the topbar title is then a plain label.
const VIEWS_WITHOUT_HEADING = new Set(["not-found"]);
const SYNC_PROGRESS_RENDER_MS = 150;

function App() {
  const [path, setPath] = useState(locationPath);
  const [data, setData] = useState<DashboardData>(emptyData);
  const [failedSlices, setFailedSlices] = useState<DataSlice[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [recommendationsLoading, setRecommendationsLoading] = useState(
    () => resolveActiveRoute(locationPath(), navItems) === "Insights",
  );
  const [dateRangeSelection, setDateRangeSelection] = useState<DateRangeSelection>(ALL_DATE_RANGE);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [localSyncing, setLocalSyncing] = useState(false);
  const [syncError, setSyncError] = useState<unknown>(null);
  const [syncComplete, setSyncComplete] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [archiveUpdateAvailable, setArchiveUpdateAvailable] = useState(false);
  const [liveDisconnected, setLiveDisconnected] = useState(false);
  const [liveConnectionKey, setLiveConnectionKey] = useState(0);
  const syncCompleteTimerRef = useRef<number | null>(null);
  const syncProgressThrottleRef = useRef<LatestThrottle<SyncProgress> | null>(null);
  const liveDisconnectTimerRef = useRef<number | null>(null);
  const liveDroppedRef = useRef(false);
  const failedSlicesRef = useRef<DataSlice[]>([]);
  const dateQuery = dateRangeQuery(dateRangeSelection);
  const sessionProject = sessionProjectFilter(path);
  const includeArchivedSessions = sessionIncludesArchived(path);
  const sessionPage = sessionPageFromPath(path);
  const refreshTimerRef = useRef<number | null>(null);
  const loadedSlicesRef = useRef(new Map<DataSlice, string>());
  const activeView = resolveActiveRouteKey(path, navItems);
  const showsSessions = activeView === "sessions";
  const sessionPageState = useSessionPage({
    dateQuery,
    enabled: showsSessions,
    includeArchived: includeArchivedSessions,
    page: sessionPage,
    project: sessionProject,
    reloadKey,
  });
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    const stored = readStorage("decant-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  const requestRefresh = useCallback(() => {
    if (refreshTimerRef.current != null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      setReloadKey((key) => key + 1);
    }, 100);
  }, []);

  useEffect(() => {
    const onPop = () => setPath(locationPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useDisabledFocusRescue();

  useEffect(() => {
    document.title = documentTitleFor(path, navItems);
  }, [path]);

  useEffect(
    () => () => {
      if (refreshTimerRef.current != null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
      removeStorage("decant-theme");
    } else {
      document.documentElement.dataset.theme = theme;
      writeStorage("decant-theme", theme);
    }
    window.dispatchEvent(new CustomEvent("decant:set-theme"));
  }, [theme]);

  useLayoutEffect(() => {
    setRecommendationsLoading(
      activeView === "insights" &&
        loadedSlicesRef.current.get("recommendations") !== `${reloadKey}`,
    );
  }, [activeView, reloadKey]);

  useEffect(() => {
    const sliceKey = (slice: DataSlice): string =>
      SLICE_LOADERS[slice].dateScoped ? `${dateQuery}|${reloadKey}` : `${reloadKey}`;
    const needed = slicesForView(activeView);
    const relevantFailures = failedSlicesRef.current.filter((slice) => needed.includes(slice));
    failedSlicesRef.current = relevantFailures;
    setFailedSlices(relevantFailures);
    const missing = needed.filter(
      (slice) => loadedSlicesRef.current.get(slice) !== sliceKey(slice),
    );
    if (missing.length === 0) {
      return;
    }
    let cancelled = false;
    void Promise.allSettled(missing.map((slice) => SLICE_LOADERS[slice].load(dateQuery)))
      .then((results) => {
        if (cancelled) {
          return;
        }
        const settled = collectSliceResults<DataSlice, DashboardData>(missing, results);
        setData((current) => ({ ...current, ...settled.data }));
        for (const slice of settled.loaded) {
          loadedSlicesRef.current.set(slice, sliceKey(slice));
        }
        const failures = settled.failures.map((failure) => failure.slice);
        failedSlicesRef.current = failures;
        setFailedSlices(failures);
      })
      .finally(() => {
        if (!cancelled && missing.includes("recommendations")) {
          setRecommendationsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeView, dateQuery, reloadKey]);

  useEffect(() => {
    // Incrementing this key intentionally replaces the EventSource when the
    // user asks to reconnect immediately instead of waiting for its backoff.
    void liveConnectionKey;
    const events = new EventSource("/api/events");
    const progressThrottle = createLatestThrottle<SyncProgress>(
      setSyncProgress,
      SYNC_PROGRESS_RENDER_MS,
    );
    syncProgressThrottleRef.current = progressThrottle;
    const markConnected = () => {
      if (liveDroppedRef.current) {
        liveDroppedRef.current = false;
        if (failedSlicesRef.current.length > 0) {
          requestRefresh();
        } else {
          setArchiveUpdateAvailable(true);
        }
      }
      if (liveDisconnectTimerRef.current != null) {
        window.clearTimeout(liveDisconnectTimerRef.current);
        liveDisconnectTimerRef.current = null;
      }
      setLiveDisconnected(false);
    };
    const handleProgress = (event: MessageEvent<string>) => {
      markConnected();
      try {
        const payload = JSON.parse(event.data) as {
          progress?: SyncProgress;
          reason?: string;
        };
        if (payload.reason !== "manual") {
          return;
        }
        if (payload.progress != null) {
          progressThrottle.push(payload.progress);
          setLocalSyncing(true);
        }
      } catch {
        // A malformed progress event must not interrupt the live channel.
      }
    };
    const handleSync = (event: MessageEvent<string>) => {
      markConnected();
      let payload: ServerEventPayload = {};
      try {
        payload = JSON.parse(event.data) as ServerEventPayload;
      } catch {
        // Treat malformed events as background updates so a broken optional
        // payload cannot cause an unexpected page refresh.
      }
      if (payload.reason !== "manual") {
        return;
      }
      progressThrottle.flush();
      setArchiveUpdateAvailable(false);
      setLocalSyncing(false);
      setSyncError(null);
      setSyncComplete(true);
      if (syncCompleteTimerRef.current != null) {
        window.clearTimeout(syncCompleteTimerRef.current);
      }
      syncCompleteTimerRef.current = window.setTimeout(() => {
        setSyncComplete(false);
        setSyncProgress(null);
      }, 1_500);
      requestRefresh();
    };
    const handleArchiveUpdated = (event: MessageEvent<string>) => {
      let payload: ServerEventPayload = {};
      try {
        payload = JSON.parse(event.data) as ServerEventPayload;
      } catch {
        // Unknown archive updates remain pending until the user asks to load
        // them, preserving the current page while they scroll or inspect it.
      }
      if (payload.reason === "manual" || payload.reason === "session_state") {
        setArchiveUpdateAvailable(false);
        requestRefresh();
        return;
      }
      setArchiveUpdateAvailable(true);
    };
    const handleOpen = () => markConnected();
    const handleError = () => {
      liveDroppedRef.current = true;
      if (liveDisconnectTimerRef.current != null) {
        return;
      }
      liveDisconnectTimerRef.current = window.setTimeout(() => {
        liveDisconnectTimerRef.current = null;
        if (events.readyState !== EventSource.OPEN) {
          setLiveDisconnected(true);
          setLiveConnectionKey((key) => key + 1);
        }
      }, LIVE_DISCONNECT_GRACE_MS);
    };
    const handleHeartbeat = () => markConnected();
    events.addEventListener("open", handleOpen);
    events.addEventListener("hello", handleHeartbeat);
    events.addEventListener("ping", handleHeartbeat);
    events.addEventListener("sync_progress", handleProgress as EventListener);
    events.addEventListener("sync", handleSync);
    events.addEventListener("archive_updated", handleArchiveUpdated as EventListener);
    events.addEventListener("error", handleError);
    return () => {
      events.removeEventListener("open", handleOpen);
      events.removeEventListener("hello", handleHeartbeat);
      events.removeEventListener("ping", handleHeartbeat);
      events.removeEventListener("sync_progress", handleProgress as EventListener);
      events.removeEventListener("sync", handleSync);
      events.removeEventListener("archive_updated", handleArchiveUpdated as EventListener);
      events.removeEventListener("error", handleError);
      events.close();
      progressThrottle.cancel();
      syncProgressThrottleRef.current = null;
      if (liveDisconnectTimerRef.current != null) {
        window.clearTimeout(liveDisconnectTimerRef.current);
        liveDisconnectTimerRef.current = null;
      }
      if (syncCompleteTimerRef.current != null) {
        window.clearTimeout(syncCompleteTimerRef.current);
      }
    };
  }, [liveConnectionKey, requestRefresh]);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      const targetIsInteractive =
        isInteractiveTarget(event.target) || isInteractiveTarget(document.activeElement);
      if (
        !shouldOpenCommandPalette({
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          interactiveTarget: targetIsInteractive,
          key: event.key,
          metaKey: event.metaKey,
          modalOpen: hasOpenModal(document),
          shiftKey: event.shiftKey,
        })
      ) {
        return;
      }
      event.preventDefault();
      setCommandPaletteOpen(true);
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  const activeLabel = resolveActiveRoute(path, navItems);
  const activeFailedSlices = failedSlices.filter((slice) =>
    slicesForView(activeView).includes(slice),
  );
  const metrics = data.summary;
  // Only page one begins at the newest row, so a later page's first row is not
  // the latest activity and the archive-wide bounds are the better fallback.
  const lastActivity =
    (sessionPageState.loadedPage === 1 ? latestSessionDay(sessionPageState.sessions) : null) ??
    formatDay(data.dateBounds?.max ?? null);
  const syncInProgress = localSyncing;
  const runSync = () => {
    if (syncInProgress) {
      return;
    }
    setSyncError(null);
    setSyncComplete(false);
    syncProgressThrottleRef.current?.cancel();
    setSyncProgress(null);
    setArchiveUpdateAvailable(false);
    setLocalSyncing(true);
    void getJson<unknown>("/api/sync", { method: "POST", body: "{}" })
      .then(() => {
        syncProgressThrottleRef.current?.flush();
        setArchiveUpdateAvailable(false);
        setLocalSyncing(false);
        setSyncComplete(true);
        requestRefresh();
        if (syncCompleteTimerRef.current != null) {
          window.clearTimeout(syncCompleteTimerRef.current);
        }
        syncCompleteTimerRef.current = window.setTimeout(() => {
          setSyncComplete(false);
          setSyncProgress(null);
        }, 1_500);
      })
      .catch((err: unknown) => {
        syncProgressThrottleRef.current?.cancel();
        setLocalSyncing(false);
        setSyncProgress(null);
        setSyncError(err);
      });
  };
  const handleDateRangeChange = useCallback(
    (next: DateRangeSelection) => {
      if (sessionPageFromPath(path) > 1) {
        visit(sessionsPageHref(path, 1), setPath);
      }
      setDateRangeSelection(next);
    },
    [path],
  );
  const loadArchiveUpdates = () => {
    setArchiveUpdateAvailable(false);
    requestRefresh();
  };
  const reconnectLiveUpdates = () => {
    liveDroppedRef.current = false;
    setLiveDisconnected(false);
    setLiveConnectionKey((key) => key + 1);
    requestRefresh();
  };
  const analyticsReport = pathOnly(path) === "/reports/analytics";
  const sessionReportMatch = pathOnly(path).match(/^\/reports\/session\/(\d+)$/);
  if (analyticsReport) {
    const date = path.includes("?") ? (path.split("?", 2)[1] ?? "") : "";
    const sourceHref = withDateQuery("/api/reports/analytics.html", date);
    return (
      <ReportRouteView
        backHref="/"
        downloadHref={sourceHref}
        excluded={ANALYTICS_REPORT_NEVER_INCLUDES}
        includes={ANALYTICS_REPORT_INCLUDES}
        onSync={runSync}
        sourceHref={sourceHref}
        title="Analytics report"
      />
    );
  }
  if (sessionReportMatch != null) {
    const id = Number(sessionReportMatch[1]);
    const sourceHref = `/api/reports/session/${id}.html`;
    return (
      <ReportRouteView
        backHref={`/sessions/${id}`}
        downloadHref={sourceHref}
        excluded={SESSION_REPORT_NEVER_INCLUDES}
        includes={SESSION_REPORT_INCLUDES}
        onSync={runSync}
        sourceHref={sourceHref}
        title="Session report"
      />
    );
  }

  return (
    <div className="app-shell">
      <button
        aria-label="Close menu"
        className={`sidebar-backdrop${menuOpen ? " is-open" : ""}`}
        onClick={() => setMenuOpen(false)}
        type="button"
      />
      <aside className={`sidebar${menuOpen ? " is-open" : ""}`}>
        <div className="brand-row">
          <Link className="brand" href="/" setPath={setPath}>
            <span className="brand-icon">
              <img alt="" src={dosuDecantUrl} />
            </span>
            <span>Decant</span>
          </Link>
          <button
            aria-label="Close menu"
            className="icon-button mobile-only"
            onClick={() => setMenuOpen(false)}
            type="button"
          >
            <Icon name="x" />
          </button>
        </div>
        <nav aria-label="Primary">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              {/* Labelled so the grouping is not purely visual: a screen reader
                  announces which section each destination belongs to. */}
              <h2 className="nav-group-label" id={`nav-group-${group.label.toLowerCase()}`}>
                {group.label}
              </h2>
              <ul aria-labelledby={`nav-group-${group.label.toLowerCase()}`}>
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      aria-current={activeView === item.key ? "page" : undefined}
                      href={item.href}
                      onClick={() => setMenuOpen(false)}
                      setPath={setPath}
                    >
                      <Icon name={item.icon} />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-stat" title="Session logs on this device">
            <span className="sidebar-stat-icon">
              <Icon name="trend" />
            </span>
            <span>
              <strong>{formatInt(metrics?.sessions ?? 0)}</strong> sessions
            </span>
          </div>
          <div className="sidebar-stat">
            <span className="sidebar-stat-icon">
              <Icon name="money" />
            </span>
            <span>
              <strong>{money(metrics?.estimated_cost_usd ?? 0)}</strong> tracked
            </span>
          </div>
          {lastActivity != null ? (
            <div className="sidebar-stat">
              <span className="sidebar-stat-icon">
                <Icon name="clock" />
              </span>
              <span>latest {lastActivity}</span>
            </div>
          ) : null}
          <a className="dosu-attribution" href={dosuLink("sidebar")} rel="noopener" target="_blank">
            <img alt="" src={dosuOfficialUrl} />
            <span>Created by Dosu</span>
          </a>
          <a
            className="sidebar-version"
            href="https://github.com/dosu-ai/decant/releases"
            rel="noopener"
            target="_blank"
            title={`Current build: ${versionLabel(data.config?.version)}`}
          >
            Decant {versionLabel(data.config?.version)}
          </a>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            aria-label="Open menu"
            className="icon-button mobile-only"
            onClick={() => setMenuOpen(true)}
            type="button"
          >
            <Icon name="menu" />
          </button>
          {VIEWS_WITHOUT_HEADING.has(activeView) ? (
            <h1 className="topbar-title">{titleFor(activeLabel)}</h1>
          ) : (
            <p className="topbar-title">{titleFor(activeLabel)}</p>
          )}
          <button
            aria-expanded={commandPaletteOpen}
            aria-haspopup="dialog"
            aria-label="Open command palette"
            className="topbar-search"
            onClick={() => setCommandPaletteOpen(true)}
            type="button"
          >
            <Icon name="search" />
            <span className="topbar-search-label">Search sessions, messages, and tools…</span>
            <kbd>{paletteShortcutLabel(navigator.userAgent)}</kbd>
          </button>
          <div className="topbar-spacer" />
          <button
            aria-expanded={commandPaletteOpen}
            aria-haspopup="dialog"
            aria-label="Search"
            className="icon-button topbar-search-mobile"
            onClick={() => setCommandPaletteOpen(true)}
            type="button"
          >
            <Icon name="search" />
          </button>
          <button
            aria-label={archiveUpdateAvailable ? "Load new activity" : "Sync session logs"}
            aria-busy={syncInProgress}
            className={`secondary-button sync-button${syncInProgress ? " is-syncing" : ""}${archiveUpdateAvailable ? " has-update" : ""}`}
            disabled={syncInProgress}
            onClick={archiveUpdateAvailable ? loadArchiveUpdates : runSync}
            type="button"
          >
            <Icon name="refresh" />
            {syncInProgress ? null : archiveUpdateAvailable ? "Update" : "Sync"}
          </button>
          <span aria-live="polite" className="sr-only" role="status">
            {syncInProgress
              ? syncProgress == null
                ? "Syncing session logs"
                : `Syncing ${syncProgress.scanned} of ${syncProgress.total}`
              : syncComplete
                ? `Sync complete${syncProgress?.ingested ? `, ${syncProgress.ingested} ingested` : ""}`
                : ""}
          </span>
          <Link
            aria-label="Settings"
            className="icon-button"
            href="/settings"
            setPath={setPath}
            title="Settings"
          >
            <Icon name="settings" />
          </Link>
          <fieldset className="theme-toggle">
            <legend>Theme</legend>
            {(["system", "light", "dark"] as const).map((choice) => (
              <button
                aria-label={`${choice} theme`}
                aria-pressed={theme === choice}
                key={choice}
                onClick={() => setTheme(choice)}
                type="button"
              >
                <Icon
                  name={choice === "system" ? "desktop" : choice === "light" ? "sun" : "moon"}
                />
              </button>
            ))}
          </fieldset>
        </header>
        <main className="content">
          <div className="content-wrap">
            {liveDisconnected ? (
              <div className="live-disconnected" role="status">
                <span>Live updates disconnected · the browser will reconnect automatically.</span>
                <button className="secondary-button" onClick={reconnectLiveUpdates} type="button">
                  Reconnect
                </button>
              </div>
            ) : null}
            {syncError != null ? (
              <div className="inline-recovery">
                <ApiFailureState error={syncError} onRetry={runSync} />
              </div>
            ) : null}
            {activeFailedSlices.length > 0 ? (
              <div className="notice danger slice-load-notice" role="alert">
                <span>
                  Some dashboard data could not be loaded. Available data is still shown. Failed:{" "}
                  {activeFailedSlices.join(", ")}.
                </span>
                <button className="secondary-button" onClick={requestRefresh} type="button">
                  Retry
                </button>
              </div>
            ) : null}
            {activeView === "sessions" && sessionPageState.error != null ? (
              <ApiFailureState
                error={sessionPageState.error}
                onRetry={requestRefresh}
                onSync={runSync}
              />
            ) : (
              renderView(activeView, path, data, {
                dateRange: dateRangeSelection,
                onDateRangeChange: handleDateRangeChange,
                refresh: requestRefresh,
                reloadKey,
                runSync,
                failedSlices,
                recommendationsLoading,
                sessionPageState,
                syncing: syncInProgress,
              })
            )}
          </div>
        </main>
      </div>
      <CommandPalette
        analyticsReportHref={withDateQuery("/reports/analytics", dateQuery)}
        onClose={() => setCommandPaletteOpen(false)}
        onNavigate={(href) => {
          setCommandPaletteOpen(false);
          visit(href, setPath);
        }}
        onRunSync={() => {
          setCommandPaletteOpen(false);
          runSync();
        }}
        onToggleTheme={() => {
          setTheme((current) =>
            current === "system" ? "light" : current === "light" ? "dark" : "system",
          );
        }}
        open={commandPaletteOpen}
        refreshKey={reloadKey}
        syncing={syncInProgress}
      />
    </div>
  );
}

function renderView(
  routeKey: string,
  path: string,
  data: DashboardData,
  actions: {
    dateRange: DateRangeSelection;
    onDateRangeChange: (range: DateRangeSelection) => void;
    refresh: () => void;
    reloadKey: number;
    runSync: () => void;
    failedSlices: DataSlice[];
    recommendationsLoading: boolean;
    sessionPageState: SessionPageState;
    syncing: boolean;
  },
) {
  const pathname = pathOnly(path);
  if (isSessionDetailPath(pathname)) {
    return (
      <SessionDetailView
        id={Number(pathname.split("/").at(-1))}
        onSync={actions.runSync}
        syncing={actions.syncing}
      />
    );
  }
  if (!isKnownRoute(path, navItems)) {
    return <NotFoundView pathname={pathname} />;
  }
  switch (routeKey) {
    case "sessions":
      return (
        <SessionsView
          data={data}
          dateRange={actions.dateRange}
          onDateRangeChange={actions.onDateRangeChange}
          path={path}
          reloadKey={actions.reloadKey}
          sessionPageState={actions.sessionPageState}
        />
      );
    case "projects":
      return (
        <ProjectsView onSync={actions.runSync} projects={data.projects} syncing={actions.syncing} />
      );
    case "search":
      return <SearchView dateRange={actions.dateRange} path={path} />;
    case "analytics":
      return (
        <AnalyticsView
          data={data}
          dateRange={actions.dateRange}
          onDateRangeChange={actions.onDateRangeChange}
          onSync={actions.runSync}
          syncing={actions.syncing}
        />
      );
    case "insights":
      return (
        <InsightsView
          loading={actions.recommendationsLoading}
          loadFailed={actions.failedSlices.includes("recommendations")}
          rows={data.recommendations}
          settingsInfo={data.settings}
          onMarked={actions.refresh}
        />
      );
    case "tools":
      return (
        <ToolsView
          data={data}
          dateRange={actions.dateRange}
          onDateRangeChange={actions.onDateRangeChange}
        />
      );
    case "files":
      return (
        <FilesView
          dateBounds={data.dateBounds}
          dateRange={actions.dateRange}
          onDateRangeChange={actions.onDateRangeChange}
          rows={data.files}
        />
      );
    case "settings":
      return (
        <SettingsView config={data.config} onSaved={actions.refresh} settingsInfo={data.settings} />
      );
    default:
      return <NotFoundView pathname={pathname} />;
  }
}

function NotFoundView({ pathname }: { pathname: string }) {
  return (
    <ErrorState
      action={
        <Link className="primary-button" href="/">
          Back to Analytics
        </Link>
      }
      detail={`There is no page at ${pathname}.`}
      icon="inbox"
      title="Page not found"
    />
  );
}

function RecommendationHero({
  canLaunch,
  onComplete,
  pending,
  row,
}: {
  canLaunch: boolean;
  onComplete: (row: Recommendation) => void;
  pending: string | null;
  row: Recommendation;
}) {
  return (
    <article className={`signal-hero tone-${toneName(row.tone)}`}>
      <span className={`signal-icon tone-${toneName(row.tone)}`}>
        <Icon name={recommendationIcon(row)} />
      </span>
      <div>
        <span className={`signal-kicker tone-${toneName(row.tone)}`}>Top signal</span>
        <div className="signal-hero-title">
          <h3>{row.title}</h3>
          {row.impact_label != null ? <strong>{row.impact_label}</strong> : null}
        </div>
        {row.detail != null ? <p>{row.detail}</p> : null}
        {row.suggestion != null ? (
          <div className="suggestion-block">
            <span>Suggested</span>
            <p>{row.suggestion}</p>
          </div>
        ) : null}
        <PromotionPanel row={row} />
        <RecommendationActions
          canLaunch={canLaunch}
          onComplete={onComplete}
          pending={pending}
          row={row}
        />
      </div>
    </article>
  );
}

function RecommendationRow({
  canLaunch,
  onComplete,
  pending,
  row,
}: {
  canLaunch: boolean;
  onComplete: (row: Recommendation) => void;
  pending: string | null;
  row: Recommendation;
}) {
  const [expanded, setExpanded] = useState(false);
  const rationale = row.detail ?? row.suggestion ?? "Open for the evidence and next step.";
  return (
    <article className={`signal-row${expanded ? " is-expanded" : ""}`}>
      <div className="signal-row-summary">
        <span className={`signal-icon tone-${toneName(row.tone)}`}>
          <Icon name={recommendationIcon(row)} />
        </span>
        <button
          aria-expanded={expanded}
          className="signal-row-title"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {row.title}
        </button>
        <span className="signal-row-rationale">{rationale}</span>
        <strong className="signal-row-impact">{row.impact_label ?? toneName(row.tone)}</strong>
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${row.title}`}
          className="signal-row-expand"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span>{expanded ? "Close" : "View"}</span>
          <Icon name={expanded ? "chevronUp" : "chevronDown"} />
        </button>
      </div>
      {expanded ? (
        <div className="signal-row-detail">
          {row.detail != null ? <p>{row.detail}</p> : null}
          {row.suggestion != null ? (
            <div className="suggestion-block">
              <span>Suggested</span>
              <p>{row.suggestion}</p>
            </div>
          ) : null}
          {row.evidence != null ? (
            <p className="signal-row-evidence">
              <strong>Evidence</strong>
              {row.evidence}
            </p>
          ) : null}
          <PromotionPanel row={row} />
          <RecommendationActions
            canLaunch={canLaunch}
            onComplete={onComplete}
            pending={pending}
            row={row}
          />
        </div>
      ) : null}
    </article>
  );
}

function RecommendationActions({
  canLaunch,
  compact = false,
  onComplete,
  pending,
  row,
}: {
  canLaunch: boolean;
  compact?: boolean;
  onComplete: (row: Recommendation) => void;
  pending: string | null;
  row: Recommendation;
}) {
  return (
    <div className="recommendation-actions">
      {row.prompt != null || row.action != null || row.suggestion != null ? (
        <button
          className="secondary-button"
          disabled={pending === row.key}
          onClick={() => onComplete(row)}
          type="button"
        >
          <Icon name={canLaunch ? "bolt" : isPresent(row.prompt) ? "copy" : "check"} />
          {pending === row.key
            ? !canLaunch && isPresent(row.prompt)
              ? "Copying"
              : "Saving"
            : compact
              ? "Run"
              : canLaunch
                ? "Run"
                : "Copy setup prompt"}
        </button>
      ) : null}
      {row.url != null ? (
        <OverflowMenu label={`More actions for ${row.title}`}>
          <a href={row.url} rel="noreferrer" target="_blank">
            <span>{row.link_label ?? "Docs"}</span>
            <span aria-hidden="true">↗</span>
          </a>
        </OverflowMenu>
      ) : null}
    </div>
  );
}

function PromotionPanel({ compact = false, row }: { compact?: boolean; row: Recommendation }) {
  if (!hasPromotion(row)) {
    return null;
  }
  return (
    <div className={`promotion-panel${compact ? " is-compact" : ""}`}>
      <span>Memory card</span>
      <dl>
        {row.memory_layer != null ? (
          <div>
            <dt>Layer</dt>
            <dd>{row.memory_layer}</dd>
          </div>
        ) : null}
        {row.promotion_target != null ? (
          <div>
            <dt>Promote to</dt>
            <dd>{row.promotion_target}</dd>
          </div>
        ) : null}
        {!compact && row.trigger != null ? (
          <div>
            <dt>Trigger</dt>
            <dd>{row.trigger}</dd>
          </div>
        ) : null}
        {!compact && row.success_metric != null ? (
          <div>
            <dt>Done when</dt>
            <dd>{row.success_metric}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function recommendationIcon(row: Recommendation): IconName {
  const icon = row.icon ?? "";
  if (icon.includes("cpu")) {
    return "cpu";
  }
  if (icon.includes("document") || icon.includes("book")) {
    return "file";
  }
  if (icon.includes("wrench")) {
    return "tools";
  }
  if (icon.includes("chart")) {
    return "chart";
  }
  return "lightbulb";
}

function groupByCategory(rows: Recommendation[]): [string, Recommendation[]][] {
  const groups = new Map<string, Recommendation[]>();
  for (const row of rows) {
    const key = row.category ?? "Recommended";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()];
}

function hasPromotion(row: Recommendation): boolean {
  return [row.memory_layer, row.promotion_target, row.trigger, row.success_metric].some(isPresent);
}

function handoffPrompt(row: Recommendation): string {
  return [row.prompt ?? row.action ?? row.suggestion, promotionText(row)]
    .filter(isPresent)
    .join("\n\n");
}

function promotionText(row: Recommendation): string {
  return [
    `# ${row.title}`,
    `Key: ${row.key}`,
    field("Layer", row.memory_layer),
    field("Promote to", row.promotion_target),
    field("Trigger", row.trigger),
    field("Evidence", row.evidence),
    field("Action", row.action),
    field("Done when", row.success_metric),
  ]
    .filter(isPresent)
    .join("\n");
}

function InsightsView({
  loading,
  loadFailed,
  rows,
  settingsInfo,
  onMarked,
}: {
  loading: boolean;
  loadFailed: boolean;
  rows: Recommendation[];
  settingsInfo: SettingsInfo | null;
  onMarked: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [failedAction, setFailedAction] = useState<Recommendation | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const openRows = rows.filter((row) => row.status === "open");
  const implementedRows = rows
    .filter((row) => row.status === "implemented")
    .slice()
    .sort(
      (left, right) =>
        implementedTimestamp(right) - implementedTimestamp(left) || right.score - left.score,
    );
  const signals = openRows
    .filter((row) => row.kind === "signal")
    .slice()
    .sort((left, right) => right.score - left.score);
  const [hero, ...rest] = signals;
  const catalogGroups = groupByCategory(openRows.filter((row) => row.kind === "catalog"));
  const canLaunch = settingsInfo?.can_launch === true;
  const completeRecommendation = (row: Recommendation) => {
    setError(null);
    setFailedAction(null);
    setCopyFeedback(null);
    if (isPresent(row.prompt) && canLaunch && settingsInfo != null) {
      setPending(row.key);
      void getJson<{ ok: boolean }>("/api/launch/agent", {
        method: "POST",
        body: JSON.stringify({
          agent: settingsInfo.settings.agent,
          prompt: handoffPrompt(row),
          key: row.key,
        }),
      })
        .then(() => onMarked())
        .catch((err: unknown) => {
          setError(err);
          setFailedAction(row);
        })
        .finally(() => setPending(null));
      return;
    }
    if (isPresent(row.prompt)) {
      setPending(row.key);
      void copyTextToClipboard(handoffPrompt(row))
        .then(() => {
          setCopyFeedback({
            kind: "success",
            message: `Copied the setup prompt for “${row.title}”.`,
          });
        })
        .catch(() => {
          setCopyFeedback({
            kind: "error",
            message: "Could not copy the setup prompt. Select the insight text and try again.",
          });
        })
        .finally(() => setPending(null));
      return;
    }
    setPending(row.key);
    void getJson<{ ok: boolean }>("/api/recommendations/mark", {
      method: "POST",
      body: JSON.stringify({ key: row.key, source: "ui" }),
    })
      .then(onMarked)
      .catch((err: unknown) => {
        setError(err);
        setFailedAction(row);
      })
      .finally(() => setPending(null));
  };

  return (
    <div className="view-stack insights-stack">
      <header className="page-heading insights-heading">
        <span className="page-eyebrow">Session logs → action</span>
        <h1>Insights</h1>
        <p>
          Decant finds recurring patterns in your local sessions, ranks the ones worth acting on,
          and suggests durable improvements for future agent runs.
        </p>
      </header>

      {error != null ? (
        <ApiFailureState
          error={error}
          onRetry={failedAction == null ? undefined : () => completeRecommendation(failedAction)}
        />
      ) : null}
      {copyFeedback != null ? (
        <div
          className={`notice${copyFeedback.kind === "error" ? " danger" : ""}`}
          role={copyFeedback.kind === "error" ? "alert" : "status"}
        >
          {copyFeedback.message}
        </div>
      ) : null}

      <section className="view-stack insights-section">
        <div className="section-title-row insights-section-heading">
          <div>
            <span className="section-eyebrow">Detected in your session logs</span>
            <h2>Patterns worth acting on</h2>
            <p>Evidence-backed signals from your own sessions, ranked by expected impact.</p>
          </div>
          {signals.length > 0 ? (
            <span className="section-count">{formatInt(signals.length)} active</span>
          ) : null}
        </div>

        {loading && signals.length === 0 ? <InsightsSignalsSkeleton /> : null}

        {!loading && !loadFailed && signals.length === 0 ? (
          <EmptyState
            icon="lightbulb"
            message="More session history will surface patterns."
            title="No signals yet"
          />
        ) : null}

        {hero != null ? (
          <RecommendationHero
            pending={pending}
            row={hero}
            onComplete={completeRecommendation}
            canLaunch={canLaunch}
          />
        ) : null}

        {rest.length > 0 ? (
          <div className="signal-list">
            {rest.map((row) => (
              <RecommendationRow
                key={row.key}
                pending={pending}
                row={row}
                onComplete={completeRecommendation}
                canLaunch={canLaunch}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section className="view-stack insights-section">
        <div className="section-title-row insights-section-heading">
          <div>
            <span className="section-eyebrow">Reusable improvements</span>
            <h2>Set up for future runs</h2>
            <p>Project practices your coding agents can use in every session.</p>
          </div>
        </div>
        {catalogGroups.map(([category, items]) => (
          <div className="catalog-group" key={category}>
            <div className="catalog-group-heading">
              <h3>{category}</h3>
              <span>{formatInt(items.length)}</span>
            </div>
            <div className="signal-list">
              {items.map((row) => (
                <RecommendationRow
                  key={row.key}
                  pending={pending}
                  row={row}
                  onComplete={completeRecommendation}
                  canLaunch={canLaunch}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="signal-list insights-dosu-list">
          <DosuInsightsRow />
        </div>
      </section>

      {implementedRows.length > 0 ? (
        <section className="view-stack insights-history-heading insights-section">
          <div className="section-title-row insights-section-heading">
            <div>
              <span className="section-eyebrow">History</span>
              <h2>Already implemented</h2>
              <p>Improvements you have already marked complete.</p>
            </div>
            <span className="section-count">{formatInt(implementedRows.length)} saved</span>
          </div>
          <div className="implemented-list">
            {implementedRows.map((row) => (
              <ImplementedRecommendationCard key={row.key} row={row} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function InsightsSignalsSkeleton() {
  return (
    <div aria-label="Loading insights" className="insights-signals-skeleton" role="status">
      {["primary", "secondary", "tertiary"].map((key) => (
        <div className="insights-skeleton-card" key={key}>
          <span className="skeleton-line insights-skeleton-kicker" />
          <span className="skeleton-line insights-skeleton-title" />
          <span className="skeleton-line insights-skeleton-detail" />
        </div>
      ))}
    </div>
  );
}

function DosuInsightsRow() {
  return (
    <article className="signal-row dosu-insights-row">
      <div className="signal-row-summary">
        <span className="signal-icon dosu-row-mark">
          <img alt="" src={dosuOfficialUrl} />
        </span>
        <div className="dosu-row-title">
          <span className="dosu-card-kicker">Optional · Dosu</span>
          <strong>Make these patterns available to every coding agent</strong>
        </div>
        <span className="signal-row-rationale">
          Dosu turns repeated fixes and project conventions into durable context your agents can
          retrieve when they need it.
        </span>
        <strong className="signal-row-impact">Optional</strong>
        <a
          aria-label="See how Dosu works with your agents (opens in a new tab)"
          className="signal-row-expand dosu-row-action"
          href={dosuLink("insights_card")}
          rel="noopener"
          target="_blank"
        >
          <span>See how</span>
          <Icon name="chevronRight" />
        </a>
      </div>
    </article>
  );
}

function ImplementedRecommendationCard({ row }: { row: Recommendation }) {
  const implementedLabel =
    row.implemented_at == null ? "Implemented" : `Implemented ${shortDate(row.implemented_at)}`;
  return (
    <article className="catalog-card">
      <div>
        <span className={`signal-icon tone-${toneName(row.tone)}`}>
          <Icon name={recommendationIcon(row)} />
        </span>
        <h4>{row.title}</h4>
      </div>
      <p className="settings-note">
        {implementedLabel}
        {isPresent(row.note) ? `: ${row.note}` : ""}
      </p>
      {row.detail != null ? <p>{row.detail}</p> : null}
      {row.suggestion != null ? <p>{row.suggestion}</p> : null}
      <PromotionPanel compact row={row} />
    </article>
  );
}

function toolAggregate(tools: ToolRow[], summary: ToolCallPage["summary"]) {
  const resolvedSummary = summary ?? { calls: 0, errors: 0, p50_ms: null, p95_ms: null };
  const totalCalls = resolvedSummary.calls;
  const totalErrors = resolvedSummary.errors;
  return {
    totalCalls,
    errorRate: totalCalls === 0 ? 0 : (totalErrors / totalCalls) * 100,
    p50: resolvedSummary.p50_ms,
    p95: resolvedSummary.p95_ms,
    topTool: tools.slice().sort((left, right) => right.calls - left.calls)[0]?.tool_name ?? null,
  };
}

function toolCallInputLabel(value: string | null): string {
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

function prettyToolValue(value: string | null): string {
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
function ToolValueElision({ value }: { value: string | null }) {
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

function ToolCallStatus({ call }: { call: ToolCallRow }) {
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

function DrilldownTableRow({
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

function ToolCallDetail({
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

function ToolsView({
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
    () => toolAggregate(data.tools, callPage.summary),
    [data.tools, callPage],
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

function FilesView({
  dateBounds,
  dateRange,
  onDateRangeChange,
  rows,
}: {
  dateBounds: DateBounds | null;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
  rows: FileRow[];
}) {
  const [group, setGroup] = useState<"path" | "ext">("path");
  const [op, setOp] = useState<"read" | "edit" | "write" | "delete" | null>(null);
  const [fileRows, setFileRows] = useState(rows);
  const [fileError, setFileError] = useState<unknown>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesRetryKey, setFilesRetryKey] = useState(0);
  const [fileSort, setFileSort] = useState<SortState<FileSortKey>>({
    key: "total",
    direction: "desc",
  });
  const sortedFileRows = useMemo(
    () => sortRows(fileRows, fileSort, fileSortValue),
    [fileRows, fileSort],
  );

  useEffect(() => {
    if (group === "path" && op == null) {
      setFileRows(rows);
    }
  }, [group, op, rows]);

  useEffect(() => {
    void filesRetryKey;
    const controller = new AbortController();
    const opParam = op == null ? "" : `&op=${op}`;
    setFileError(null);
    setFilesLoading(true);
    void getJson<FileRow[]>(
      withDateQuery(
        `/api/files?group=${group}&limit=${TABLE_ROW_LIMIT}${opParam}`,
        dateRangeQuery(dateRange),
      ),
      { signal: controller.signal },
    )
      .then(setFileRows)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setFileError(reason);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setFilesLoading(false);
        }
      });
    return () => controller.abort();
  }, [dateRange, filesRetryKey, group, op]);

  return (
    <div className="view-stack">
      <header className="page-heading inline-heading">
        <div>
          <h1>File hotspots</h1>
          <p>
            What agents touch most. Heavy re-reads with few edits are AGENTS.md / skill candidates;
            heavy edits are churn.
          </p>
        </div>
        <DateRangeControl bounds={dateBounds} range={dateRange} onChange={onDateRangeChange} />
      </header>

      <div className="segment-row">
        <fieldset className="segmented-control">
          <legend>Group by</legend>
          <button aria-pressed={group === "path"} onClick={() => setGroup("path")} type="button">
            Files
          </button>
          <button aria-pressed={group === "ext"} onClick={() => setGroup("ext")} type="button">
            Languages
          </button>
        </fieldset>
        <fieldset className="segmented-control">
          <legend>Operation</legend>
          <button aria-pressed={op == null} onClick={() => setOp(null)} type="button">
            All ops
          </button>
          {(["read", "edit", "write", "delete"] as const).map((name) => (
            <button aria-pressed={op === name} key={name} onClick={() => setOp(name)} type="button">
              {capitalize(name)}
            </button>
          ))}
        </fieldset>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{group === "ext" ? "Languages" : "Hotspots"}</h2>
            <p>Per-operation counts from tool-call evidence, ordered by activity</p>
          </div>
        </div>
        {fileError != null ? (
          <ApiFailureState error={fileError} onRetry={() => setFilesRetryKey((key) => key + 1)} />
        ) : filesLoading && fileRows.length === 0 ? (
          <div className="panel-body muted">Loading file activity…</div>
        ) : fileRows.length === 0 ? (
          <EmptyState
            icon="file"
            message="Hotspots appear once your session logs contain file activity."
            title="No file activity"
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table files-table">
              <colgroup>
                <col className="col-file" />
                {group === "path" ? <col className="col-project" /> : null}
                <col className="col-count" />
                <col className="col-count" />
                <col className="col-count" />
                <col className="col-count" />
                <col className="col-sessions" />
                <col className="col-total" />
                <col className="col-date" />
              </colgroup>
              <thead>
                <tr>
                  <SortableHeader
                    label={group === "ext" ? "Extension" : "File"}
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="key"
                  />
                  {group === "path" ? (
                    <SortableHeader
                      label="Project"
                      onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                      sort={fileSort}
                      sortKey="project"
                    />
                  ) : null}
                  <SortableHeader
                    align="right"
                    label="Reads"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="reads"
                  />
                  <SortableHeader
                    align="right"
                    label="Edits"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="edits"
                  />
                  <SortableHeader
                    align="right"
                    label="Writes"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="writes"
                  />
                  <SortableHeader
                    align="right"
                    label="Deletes"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="deletes"
                  />
                  <SortableHeader
                    align="right"
                    label="Sessions"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="sessions"
                  />
                  <SortableHeader
                    align="right"
                    label="Total"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="total"
                  />
                  <SortableHeader
                    align="right"
                    label="Modified"
                    onSort={(key) => setFileSort((sort) => nextSort(sort, key))}
                    sort={fileSort}
                    sortKey="last_touched_at"
                  />
                </tr>
              </thead>
              <tbody>
                {sortedFileRows.map((row) => (
                  <tr key={`${group}-${row.project ?? ""}-${row.key}`}>
                    <td className="mono truncate-cell">
                      <Link href={`/search?q=${encodeURIComponent(`"${row.key}"`)}`}>
                        {row.key}
                      </Link>
                    </td>
                    {group === "path" ? (
                      <td className="muted" title={row.project ?? ""}>
                        {row.project == null ? (
                          <span className="faint">-</span>
                        ) : (
                          <Link href={projectSessionsHref(row.project)}>
                            {basename(row.project)}
                          </Link>
                        )}
                      </td>
                    ) : null}
                    <td className="numeric muted">{formatInt(row.reads)}</td>
                    <td className="numeric muted">{formatInt(row.edits)}</td>
                    <td className="numeric muted">{formatInt(row.writes)}</td>
                    <td className="numeric muted">{formatInt(row.deletes)}</td>
                    <td className="numeric muted">{formatInt(row.sessions)}</td>
                    <td className="numeric">{formatInt(fileTotal(row))}</td>
                    <td className="numeric muted">{relativeTime(row.last_touched_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsView({
  config,
  onSaved,
  settingsInfo,
}: {
  config: ConfigView | null;
  onSaved: () => void;
  settingsInfo: SettingsInfo | null;
}) {
  const [settings, setSettings] = useState<UserSettings | null>(settingsInfo?.settings ?? null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSettings(settingsInfo?.settings ?? null);
    setSaveError(null);
  }, [settingsInfo]);

  const save = (patch: Partial<UserSettings>) => {
    const base = settings ?? settingsInfo?.settings;
    if (base == null) {
      return;
    }
    const previous = settings;
    const next = { ...base, ...patch };
    setSettings(next);
    setSaveError(null);
    setSaving(true);
    void getJson<SettingsInfo>("/api/settings", {
      method: "POST",
      body: JSON.stringify(next),
    })
      .then((response) => {
        setSettings(response.settings);
        onSaved();
      })
      .catch((err: unknown) => {
        setSettings(previous ?? base);
        setSaveError(errorMessage(err));
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-page">
      <header className="page-heading">
        <h1>Settings</h1>
        <p>
          How Decant opens things on your machine. We start from what we detect and remember your
          choices.
        </p>
      </header>

      <section className="panel">
        <div className="settings-form">
          <SettingSelect
            help="The agent the Run button opens first across Insights."
            label="Preferred agent"
            options={settingsInfo?.options.agents ?? []}
            value={settings?.agent ?? "claude"}
            onChange={(agent) => save({ agent })}
          />
          <SettingSelect
            help="Where a session opens when you run an agent."
            label="Terminal"
            options={settingsInfo?.options.terminals ?? []}
            value={settings?.terminal ?? "terminal"}
            onChange={(terminal) => save({ terminal })}
          />
          <SettingSelect
            help="Which editor Open in editor uses for a session's project."
            label="Editor"
            options={settingsInfo?.options.ides ?? []}
            value={settings?.ide ?? "vscode"}
            onChange={(ide) => save({ ide })}
          />
        </div>
        {saveError != null ? <div className="notice danger inline-notice">{saveError}</div> : null}
        <p className="settings-note">
          {saving
            ? "Saving preferences..."
            : settingsInfo?.can_launch === true
              ? "Native launcher is available on this Mac."
              : "Native launcher is unavailable on this platform."}
        </p>
      </section>

      <section className="panel about-decant">
        <div className="panel-heading">
          <div>
            <h2>About Decant</h2>
            <p>
              Local-first analytics for Claude Code, Codex, and Gemini CLI sessions. Decant is an
              open source tool from Dosu.
            </p>
          </div>
          <img alt="" src={dosuDecantUrl} />
        </div>
        <div className="panel-body">
          <div className="about-links">
            <a href={dosuLink("about")} rel="noopener" target="_blank">
              Visit Dosu ↗
            </a>
            <a href="https://github.com/dosu-ai/decant" rel="noopener" target="_blank">
              View source ↗
            </a>
            <a
              href="https://github.com/dosu-ai/decant/blob/main/LICENSE"
              rel="noopener"
              target="_blank"
            >
              Apache-2.0 license ↗
            </a>
          </div>
          <p className="about-version">Version {versionLabel(config?.version)}</p>
          <p className="about-privacy">
            Decant makes no outbound network calls. Your session logs stay on this machine.
          </p>
        </div>
      </section>
    </div>
  );
}

function SettingSelect({
  help,
  label,
  options,
  value,
  onChange,
}: {
  help: string;
  label: string;
  options: [string, string][];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="setting-select">
      <span>
        <strong>{label}</strong>
        <small>{help}</small>
      </span>
      <span className="select-shell">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" />
      </span>
    </label>
  );
}

function DeleteSessionDialog({
  error,
  onClose,
  onConfirm,
  open,
  pending,
  title,
}: {
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  pending: boolean;
  title: string;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => onCloseRef.current(), []);
  useDialogFocusTrap(open, dialogRef, requestClose);
  if (!open) {
    return null;
  }
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements Escape and explicit Cancel/close controls.
    <div
      className="report-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) {
          requestClose();
        }
      }}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="report-review-sheet session-delete-dialog"
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <span className="section-eyebrow">{DELETE_SESSION_EYEBROW}</span>
            <h2 id={titleId}>Delete session?</h2>
          </div>
          <button
            aria-label="Close delete confirmation"
            className="icon-button"
            disabled={pending}
            onClick={requestClose}
            type="button"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="report-review-body">
          <p className="session-delete-title">{title}</p>
          <p className="session-delete-copy" id={descriptionId}>
            {DELETE_SESSION_EXPLANATION}
          </p>
          {error != null ? (
            <div className="notice danger" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <footer>
          <button
            className="secondary-button"
            disabled={pending}
            onClick={requestClose}
            type="button"
          >
            Cancel
          </button>
          <button className="danger-button" disabled={pending} onClick={onConfirm} type="button">
            <Icon name="trash" />
            {pending ? "Deleting…" : "Delete from Decant"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function SessionDetailView({
  id,
  onSync,
  syncing,
}: {
  id: number;
  onSync: () => void;
  syncing: boolean;
}) {
  const [detail, setDetail] = useState<SessionDetailData | null>(null);
  const [outline, setOutline] = useState<SessionOutlineItemData[] | null>(null);
  const [economics, setEconomics] = useState<TokenEconomics | null>(null);
  const [contextWindow, setContextWindow] = useState<ContextWindowTimelineData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [economicsError, setEconomicsError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // Separate from loadMoreError: the two loads fail in different places and
  // retry in opposite directions, so one shared message would report a failed
  // backward load at the foot of the transcript under the wrong wording.
  const [loadEarlierError, setLoadEarlierError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [issues, setIssues] = useState<SessionIngestIssue[] | null>(null);
  const [issuesError, setIssuesError] = useState<unknown>(null);
  const [detailRetryKey, setDetailRetryKey] = useState(0);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sessionStatePending, setSessionStatePending] = useState<SessionStateUpdate | null>(null);
  const [sessionStateError, setSessionStateError] = useState<string | null>(null);
  const [sessionStateNotice, setSessionStateNotice] = useState<string | null>(null);
  const [jumpingToSeq, setJumpingToSeq] = useState<number | null>(null);
  const [activeMessageSeq, setActiveMessageSeq] = useState<number | null>(null);
  const detailRef = useRef<SessionDetailData | null>(null);
  const activeMessageSeqRef = useRef<number | null>(null);
  const handledMessageHashRef = useRef<string | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMorePromiseRef = useRef<Promise<boolean> | null>(null);
  const sessionVersionRef = useRef(0);
  const jumpGenerationRef = useRef(0);
  const sessionStateMutationGenerationRef = useRef(0);

  useEffect(() => {
    void id;
    sessionStateMutationGenerationRef.current += 1;
    setDeleteDialogOpen(false);
    setSessionStatePending(null);
    setSessionStateError(null);
    setSessionStateNotice(null);
    return () => {
      sessionStateMutationGenerationRef.current += 1;
    };
  }, [id]);

  useEffect(() => {
    void detailRetryKey;
    const sessionVersion = sessionVersionRef.current + 1;
    sessionVersionRef.current = sessionVersion;
    let cancelled = false;
    setDetail(null);
    detailRef.current = null;
    loadMorePromiseRef.current = null;
    setOutline(null);
    setEconomics(null);
    setContextWindow(null);
    setError(null);
    setEconomicsError(null);
    setLoadingMore(false);
    setLoadMoreError(null);
    setLoadEarlierError(null);
    setShowIssues(false);
    setIssues(null);
    setIssuesError(null);
    setJumpingToSeq(null);
    jumpGenerationRef.current += 1;
    activeMessageSeqRef.current = null;
    handledMessageHashRef.current = null;
    setActiveMessageSeq(null);
    if (!Number.isFinite(id)) {
      setError("Invalid session id.");
      return;
    }
    void getJson<SessionDetailData>(
      `/api/sessions/${id}?message_limit=${SESSION_DETAIL_MESSAGE_PAGE_SIZE}`,
    )
      .then((nextDetail) => {
        if (!cancelled && sessionVersionRef.current === sessionVersion) {
          detailRef.current = nextDetail;
          setDetail(nextDetail);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err);
        }
      });
    void getJson<SessionOutlineItemData[]>(`/api/sessions/${id}/outline`)
      .then((nextOutline) => {
        if (!cancelled && sessionVersionRef.current === sessionVersion) {
          setOutline(nextOutline);
        }
      })
      .catch(() => {
        // The loaded transcript still supplies a progressive outline.
      });
    void getJson<TokenEconomics>(`/api/sessions/${id}/token-economics`)
      .then((nextEconomics) => {
        if (!cancelled) {
          setEconomics(nextEconomics);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEconomicsError(errorMessage(err));
        }
      });
    void getJson<ContextWindowTimelineData>(`/api/sessions/${id}/context-window`)
      .then((nextTimeline) => {
        if (!cancelled) {
          setContextWindow(nextTimeline);
        }
      })
      .catch(() => {
        // The context strip is progressive enhancement; the transcript stands alone.
      });
    return () => {
      cancelled = true;
    };
  }, [detailRetryKey, id]);

  // Ingest issues are fetched lazily, on first expand, rather than eagerly
  // alongside outline/economics/context-window above: most sessions have
  // none, and the raw_line the row can join against is display-local by
  // design (never logged), so there is no reason to pull it over the wire
  // before the user asks to see it.
  useEffect(() => {
    if (!showIssues || issues != null || issuesError != null) {
      return;
    }
    let cancelled = false;
    void getJson<SessionIngestIssue[]>(`/api/sessions/${id}/issues`)
      .then((nextIssues) => {
        if (!cancelled) {
          setIssues(nextIssues);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setIssuesError(err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, showIssues, issues, issuesError]);

  const loadMoreMessages = useCallback((): Promise<boolean> => {
    if (loadMorePromiseRef.current != null) {
      return loadMorePromiseRef.current;
    }
    const current = detailRef.current;
    if (current == null || current.has_more_messages !== true) {
      return Promise.resolve(false);
    }
    const sessionVersion = sessionVersionRef.current;
    const offset = (current.message_offset ?? 0) + current.messages.length;
    setLoadingMore(true);
    setLoadMoreError(null);
    const request = getJson<SessionDetailData>(
      `/api/sessions/${id}?message_limit=${SESSION_DETAIL_MESSAGE_PAGE_SIZE}&message_offset=${offset}`,
    )
      .then((page) => {
        if (sessionVersionRef.current !== sessionVersion) {
          return false;
        }
        const latest = detailRef.current;
        if (latest == null || latest.summary.id !== id) {
          return false;
        }
        const messages = appendTranscriptPage(latest.messages, page.messages);
        const nextDetail = {
          ...latest,
          messages,
          message_offset: latest.message_offset ?? 0,
          message_limit: SESSION_DETAIL_MESSAGE_PAGE_SIZE,
          has_more_messages: page.has_more_messages === true,
        };
        detailRef.current = nextDetail;
        setDetail(nextDetail);
        return page.has_more_messages === true;
      })
      .catch((err: unknown) => {
        if (sessionVersionRef.current === sessionVersion) {
          setLoadMoreError(errorMessage(err));
        }
        return false;
      })
      .finally(() => {
        if (loadMorePromiseRef.current === request) {
          loadMorePromiseRef.current = null;
        }
        if (sessionVersionRef.current === sessionVersion) {
          setLoadingMore(false);
        }
      });
    loadMorePromiseRef.current = request;
    return request;
  }, [id]);

  /** A deep link, outline click or compaction jump lands mid-session; without this ArrowUp stops at the window's top. */
  const loadPreviousMessages = useCallback((): Promise<boolean> => {
    const sessionVersion = sessionVersionRef.current;
    return runWithTranscriptRequestSlot(
      loadMorePromiseRef,
      () => sessionVersionRef.current === sessionVersion,
      false,
      async () => {
        const current = detailRef.current;
        if (current == null || current.summary.id !== id) {
          return false;
        }
        const request = previousTranscriptPageRequest(
          current.message_offset ?? 0,
          SESSION_DETAIL_MESSAGE_PAGE_SIZE,
        );
        if (request == null) {
          return false;
        }
        setLoadingMore(true);
        setLoadEarlierError(null);
        return getJson<SessionDetailData>(
          `/api/sessions/${id}?message_limit=${request.limit}&message_offset=${request.offset}`,
        )
          .then((page) => {
            if (sessionVersionRef.current !== sessionVersion) {
              return false;
            }
            const latest = detailRef.current;
            if (latest == null || latest.summary.id !== id) {
              return false;
            }
            if (page.messages.length === 0) {
              return false;
            }
            // Browser scroll anchoring does not compensate for prepended turns
            // (measured in Chromium), so the correction below is required.
            // Anchor on a surviving turn rather than scrollHeight: the
            // content-visibility placeholders only estimate their height.
            let anchorSeq: number | null = null;
            let anchorTop: number | null = null;
            for (const message of latest.messages) {
              const top = document
                .getElementById(`message-${message.seq}`)
                ?.getBoundingClientRect().top;
              if (top != null) {
                anchorSeq = message.seq;
                anchorTop = top;
                break;
              }
            }
            const nextDetail = {
              ...latest,
              messages: prependTranscriptPage(latest.messages, page.messages),
              message_offset: request.offset,
            };
            detailRef.current = nextDetail;
            // flushSync so the measurement sees the new DOM and the shifted
            // position is never painted before it is corrected.
            flushSync(() => {
              setDetail(nextDetail);
            });
            if (anchorSeq != null && anchorTop != null) {
              const after = document
                .getElementById(`message-${anchorSeq}`)
                ?.getBoundingClientRect().top;
              if (after != null && after !== anchorTop) {
                window.scrollBy({ behavior: "auto", top: after - anchorTop });
              }
            }
            return true;
          })
          .catch((err: unknown) => {
            if (sessionVersionRef.current === sessionVersion) {
              setLoadEarlierError(errorMessage(err));
            }
            return false;
          })
          .finally(() => {
            if (sessionVersionRef.current === sessionVersion) {
              setLoadingMore(false);
            }
          });
      },
    );
  }, [id]);

  const loadMessageWindow = useCallback(
    async (seq: number): Promise<boolean> => {
      const sessionVersion = sessionVersionRef.current;
      return runWithTranscriptRequestSlot(
        loadMorePromiseRef,
        () => sessionVersionRef.current === sessionVersion,
        false,
        async () => {
          const current = detailRef.current;
          if (current == null || current.summary.id !== id) {
            return false;
          }
          if (
            (current.message_offset ?? 0) === 0 &&
            current.messages.some((message) => message.seq === seq)
          ) {
            return true;
          }
          const request = transcriptPrefixRequest(
            seq,
            current.summary.message_count,
            SESSION_DETAIL_MESSAGE_PAGE_SIZE,
          );
          setLoadingMore(true);
          setLoadMoreError(null);
          return getJson<SessionDetailData>(
            `/api/sessions/${id}?message_limit=${request.limit}&message_offset=${request.offset}`,
          )
            .then((page) => {
              if (sessionVersionRef.current !== sessionVersion) {
                return false;
              }
              // Never trade a populated transcript for an empty one. The clamp
              // above keeps the offset in range against the count we hold, but
              // that count can lag the archive after a re-sync.
              if (page.messages.length === 0) {
                return false;
              }
              const latest = detailRef.current;
              if (latest == null || latest.summary.id !== id) {
                return false;
              }
              const messages =
                (latest.message_offset ?? 0) > 0
                  ? appendTranscriptPage(page.messages, latest.messages)
                  : page.messages;
              const nextDetail = {
                ...page,
                messages,
                message_offset: 0,
                message_limit: request.limit,
                has_more_messages:
                  messages.length < latest.summary.message_count ||
                  page.has_more_messages === true ||
                  latest.has_more_messages === true,
              };
              detailRef.current = nextDetail;
              flushSync(() => {
                setDetail(nextDetail);
              });
              return nextDetail.messages.some((message) => message.seq === seq);
            })
            .catch((err: unknown) => {
              if (sessionVersionRef.current === sessionVersion) {
                setLoadMoreError(errorMessage(err));
              }
              return false;
            })
            .finally(() => {
              if (sessionVersionRef.current === sessionVersion) {
                setLoadingMore(false);
              }
            });
        },
      );
    },
    [id],
  );

  const jumpToMessage = useCallback(
    async (seq: number) => {
      const sessionVersion = sessionVersionRef.current;
      const jumpGeneration = jumpGenerationRef.current + 1;
      jumpGenerationRef.current = jumpGeneration;
      const hash = `#message-${seq}`;
      handledMessageHashRef.current = `${id}:${seq}`;
      window.history.replaceState(null, "", hash);
      setJumpingToSeq(seq);
      try {
        const loaded = await loadMessageWindow(seq);
        if (
          !loaded ||
          sessionVersionRef.current !== sessionVersion ||
          jumpGenerationRef.current !== jumpGeneration
        ) {
          return;
        }
        activeMessageSeqRef.current = seq;
        setActiveMessageSeq(seq);
        requestAnimationFrame(() => {
          if (
            sessionVersionRef.current === sessionVersion &&
            jumpGenerationRef.current === jumpGeneration
          ) {
            scrollTranscriptMessage(
              seq,
              true,
              () =>
                sessionVersionRef.current === sessionVersion &&
                jumpGenerationRef.current === jumpGeneration,
            );
          }
        });
      } finally {
        if (
          sessionVersionRef.current === sessionVersion &&
          jumpGenerationRef.current === jumpGeneration
        ) {
          setJumpingToSeq((current) => (current === seq ? null : current));
        }
      }
    },
    [id, loadMessageWindow],
  );

  const loadedMessageCount = detail?.messages.length ?? 0;
  useEffect(() => {
    if (detail == null) {
      return;
    }
    const followMessageHash = () => {
      const seq = transcriptSeqFromHash(window.location.hash);
      if (seq == null) {
        return;
      }
      const key = `${id}:${seq}`;
      if (handledMessageHashRef.current === key) {
        return;
      }
      handledMessageHashRef.current = key;
      void jumpToMessage(seq);
    };
    followMessageHash();
    window.addEventListener("hashchange", followMessageHash);
    return () => window.removeEventListener("hashchange", followMessageHash);
  }, [detail, id, jumpToMessage]);

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (
      sentinel == null ||
      loadedMessageCount === 0 ||
      detail?.has_more_messages !== true ||
      loadMoreError != null ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreMessages();
        }
      },
      { rootMargin: "700px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [detail?.has_more_messages, loadedMessageCount, loadMoreError, loadMoreMessages]);

  const navigateTranscript = useCallback(
    async (direction: TranscriptNavigationDirection) => {
      const sessionVersion = sessionVersionRef.current;
      let current = detailRef.current;
      if (current == null) {
        return;
      }
      let sequences = renderableMessages(current.messages).map((message) => message.seq);
      let activeSeq = activeMessageSeqRef.current;
      if (activeSeq == null || !sequences.includes(activeSeq)) {
        activeSeq = nearestTranscriptSeq(sequences);
      }
      let targetSeq = nextTranscriptSeq(sequences, activeSeq, direction);
      const canLoadForward = direction === 1 && current.has_more_messages === true;
      const canLoadBackward = direction === -1 && (current.message_offset ?? 0) > 0;
      if (targetSeq == null && (canLoadForward || canLoadBackward)) {
        await (canLoadForward ? loadMoreMessages() : loadPreviousMessages());
        if (sessionVersionRef.current !== sessionVersion) {
          return;
        }
        current = detailRef.current;
        sequences =
          current == null
            ? sequences
            : renderableMessages(current.messages).map((message) => message.seq);
        targetSeq = nextTranscriptSeq(sequences, activeSeq, direction);
      }
      if (targetSeq == null) {
        return;
      }
      activeMessageSeqRef.current = targetSeq;
      setActiveMessageSeq(targetSeq);
      handledMessageHashRef.current = `${id}:${targetSeq}`;
      window.history.replaceState(null, "", `#message-${targetSeq}`);
      requestAnimationFrame(() => {
        if (sessionVersionRef.current === sessionVersion) {
          scrollTranscriptMessage(targetSeq);
        }
      });
    },
    [id, loadMoreMessages, loadPreviousMessages],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const direction = transcriptNavigationDirection(event);
      if (
        direction == null ||
        event.repeat ||
        isInteractiveTarget(event.target) ||
        isInteractiveTarget(document.activeElement) ||
        hasOpenModal(document)
      ) {
        return;
      }
      event.preventDefault();
      void navigateTranscript(direction);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigateTranscript]);

  const mutateSessionState = useCallback(
    (state: SessionStateUpdate) => {
      const mutationGeneration = sessionStateMutationGenerationRef.current + 1;
      sessionStateMutationGenerationRef.current = mutationGeneration;
      setSessionStatePending(state);
      setSessionStateError(null);
      setSessionStateNotice(null);
      const request = sessionStateRequest(id, state);
      void getJson<{ ok: true }>(request.path, request.init)
        .then(() => {
          if (sessionStateMutationGenerationRef.current !== mutationGeneration) {
            return;
          }
          if (state === "deleted") {
            setDeleteDialogOpen(false);
            visit("/sessions");
            return;
          }
          setDeleteDialogOpen(false);
          if (state === "visible") {
            setSessionStateNotice("Session restored to the default views.");
          }
          setDetailRetryKey((key) => key + 1);
        })
        .catch((err: unknown) => {
          if (sessionStateMutationGenerationRef.current === mutationGeneration) {
            setSessionStateError(errorMessage(err));
          }
        })
        .finally(() => {
          if (sessionStateMutationGenerationRef.current === mutationGeneration) {
            setSessionStatePending(null);
          }
        });
    },
    [id],
  );

  // Hoisted above the early returns because hooks cannot run conditionally.
  // TranscriptTurn is memoized, and a Map rebuilt every render would defeat
  // that for every turn on the screen.
  const subagents = detail?.subagents;
  const subagentsByToolUse = useMemo(() => subagentMap(subagents ?? []), [subagents]);
  const detailMessages = detail?.messages;
  const messages = useMemo(() => renderableMessages(detailMessages ?? []), [detailMessages]);
  const toc = useMemo(
    () => (outline == null ? threadToc(messages) : threadTocFromOutline(outline)),
    [messages, outline],
  );
  const compactions = contextWindow?.compactions;
  const compactionBySeq = useMemo(
    () => new Map((compactions ?? []).map((compaction) => [compaction.seq, compaction] as const)),
    [compactions],
  );
  const compactionNumberBySeq = useMemo(
    () => new Map((compactions ?? []).map((compaction, index) => [compaction.seq, index + 1])),
    [compactions],
  );

  if (error != null) {
    return (
      <ApiFailureState
        error={error}
        onRetry={() => setDetailRetryKey((key) => key + 1)}
        onSync={onSync}
      />
    );
  }

  if (detail == null) {
    return <SessionDetailSkeleton />;
  }

  const stats = threadStats(
    detail.summary,
    messages,
    toc,
    contextWindow?.turn_count,
    detail.totals,
  );
  const subagentRuns = countSubagentRuns(detail.subagents);
  const windowTokens = contextWindow?.window_tokens ?? null;
  const detailTitle = sessionDisplayTitle(detail.summary);
  const archiveAction = archiveActionFor(detail.summary);
  const sessionsHref = detail.summary.is_user_archived
    ? sessionsArchivedHref("/sessions", true)
    : "/sessions";

  return (
    <div className="session-detail">
      <header className="thread-header">
        <div className="thread-header-inner">
          <div className="thread-header-title-row">
            <h1>{detailTitle}</h1>
            <div className="thread-header-actions">
              <ReportExportButton
                excluded={SESSION_REPORT_NEVER_INCLUDES}
                href={`/api/reports/session/${detail.summary.id}.html`}
                includes={SESSION_REPORT_INCLUDES}
                previewHref={`/reports/session/${detail.summary.id}`}
                title="Review session report"
              />
              <OverflowMenu label={`More actions for ${detailTitle}`}>
                {archiveAction != null ? (
                  <button
                    disabled={sessionStatePending != null}
                    onClick={() => mutateSessionState(archiveAction)}
                    type="button"
                  >
                    <Icon name="archive" />
                    <span>
                      {archiveAction === "visible" ? "Unarchive session" : "Archive session"}
                    </span>
                  </button>
                ) : null}
                <button
                  className="is-danger"
                  disabled={sessionStatePending != null}
                  onClick={() => {
                    setSessionStateError(null);
                    setDeleteDialogOpen(true);
                  }}
                  type="button"
                >
                  <Icon name="trash" />
                  <span>Delete session</span>
                </button>
              </OverflowMenu>
            </div>
          </div>
          <div className="thread-badges">
            <ToolBadge tool={detail.summary.tool} />
            <ModelBadge model={detail.summary.model} />
            <DosuProvenanceBadge session={detail.summary} />
            <ReasoningBadge
              effort={detail.summary.reasoning_effort}
              levels={detail.summary.reasoning_effort_levels}
              totalReasoningTokens={detail.summary.total_reasoning_tokens}
              reasoningSource={detail.summary.reasoning_source}
              labeled
            />
            {detail.summary.ingest_issue_count > 0 ? (
              <button
                aria-expanded={showIssues}
                aria-label={`${showIssues ? "Hide" : "Show"} ingest diagnostics`}
                className="badge-button"
                onClick={() => setShowIssues((value) => !value)}
                type="button"
              >
                <Badge tone="warning">{formatIssueBadge(detail.summary.ingest_issue_count)}</Badge>
              </button>
            ) : null}
            {detail.summary.project_path != null ? (
              <Link
                className="project-chip"
                href={projectSessionsHref(detail.summary.project_path)}
                title={detail.summary.project_path}
              >
                <Icon name="folder" />
                {basename(detail.summary.project_path)}
              </Link>
            ) : null}
          </div>
          <div className="thread-stats">
            <span>
              <strong>{formatInt(stats.turns)}</strong> turns
            </span>
            <span>
              <strong>{formatInt(stats.replies)}</strong> replies
            </span>
            <span>
              <strong>{formatInt(stats.toolCalls)}</strong> tool calls
            </span>
            <span>
              <strong>{compact(stats.tokens)}</strong> tokens
            </span>
            <span>
              <strong>{money(detail.summary.estimated_cost_usd)}</strong>
            </span>
          </div>
        </div>
      </header>

      {detail.summary.is_user_archived ? (
        <div className="notice session-state-banner" role="status">
          <span>
            {detail.summary.user_state === "archived"
              ? "This session is archived and hidden from default lists, search, and analytics."
              : "This session is archived with a parent session."}
          </span>
          {detail.summary.user_state === "archived" ? (
            <button
              className="secondary-button"
              disabled={sessionStatePending != null}
              onClick={() => mutateSessionState("visible")}
              type="button"
            >
              Unarchive
            </button>
          ) : null}
        </div>
      ) : sessionStateNotice != null ? (
        <div className="notice session-state-banner" role="status">
          {sessionStateNotice}
        </div>
      ) : null}
      {sessionStateError != null && !deleteDialogOpen ? (
        <div className="notice danger session-state-banner" role="alert">
          <span>{sessionStateError}</span>
          {archiveAction != null ? (
            <button
              className="secondary-button"
              disabled={sessionStatePending != null}
              onClick={() => mutateSessionState(archiveAction)}
              type="button"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {showIssues ? (
        <IngestIssuesPanel
          error={issuesError}
          issues={issues}
          onResync={onSync}
          onRetry={() => setIssuesError(null)}
          syncing={syncing}
        />
      ) : null}

      <Link className="back-link" href={sessionsHref}>
        <Icon name="arrowLeft" />
        Sessions
      </Link>

      <DeleteSessionDialog
        error={deleteDialogOpen ? sessionStateError : null}
        onClose={() => {
          if (sessionStatePending == null) {
            setDeleteDialogOpen(false);
            setSessionStateError(null);
          }
        }}
        onConfirm={() => mutateSessionState("deleted")}
        open={deleteDialogOpen}
        pending={sessionStatePending === "deleted"}
        title={detailTitle}
      />

      {economics != null ? (
        <TokenEconomicsPanel
          compact
          description="Estimated agent activity inside this session, including nested subagents; capped user response time is shown separately."
          economics={economics}
          subagentRuns={subagentRuns}
          title="Activity breakdown"
        />
      ) : economicsError != null ? (
        <div className="notice inline-notice">Activity breakdown unavailable: {economicsError}</div>
      ) : (
        <SessionEconomicsSkeleton />
      )}

      <ContextWindowPanel onJump={jumpToMessage} timeline={contextWindow} />

      <div className="transcript-layout">
        <aside className="toc">
          <div className="toc-inner">
            <div className="toc-title">In this thread</div>
            <div className="toc-hotkeys">
              <span>
                <kbd>↑</kbd>
                <kbd>↓</kbd>
              </span>
              Move through messages
            </div>
            {toc.length === 0 ? <p>No prompts or Dosu calls to list</p> : null}
            {toc.map((item) => (
              <ThreadTocEntry
                current={activeMessageSeq === item.seq}
                item={item}
                jumping={jumpingToSeq === item.seq}
                key={item.key}
                onJump={jumpToMessage}
              />
            ))}
          </div>
        </aside>

        <div className="transcript-column">
          {(detail.message_offset ?? 0) > 0 ? (
            <div className="transcript-window-start">
              {/* Count of missing messages: the offset is a zero-based row
                  index and would contradict the #message-<seq> anchor as an ordinal. */}
              <span>
                {formatInt(detail.message_offset ?? 0)} earlier{" "}
                {(detail.message_offset ?? 0) === 1 ? "message" : "messages"} not loaded
              </span>
              {loadEarlierError != null ? (
                <span className="transcript-window-start-error" role="status">
                  Couldn’t load the earlier messages: {loadEarlierError}
                </span>
              ) : null}
              <span className="transcript-window-start-actions">
                <button
                  className="button small secondary"
                  disabled={loadingMore}
                  onClick={() => void loadPreviousMessages()}
                  type="button"
                >
                  {loadEarlierError != null
                    ? "Try again"
                    : loadingMore
                      ? "Loading…"
                      : "Load earlier"}
                </button>
                <button
                  className="button small secondary"
                  onClick={() => void jumpToMessage(0)}
                  type="button"
                >
                  Start at the beginning
                </button>
              </span>
            </div>
          ) : null}
          {messages.map((message) => (
            <TranscriptTurn
              active={activeMessageSeq === message.seq}
              compaction={compactionBySeq.get(message.seq) ?? null}
              compactionNumber={compactionNumberBySeq.get(message.seq) ?? null}
              key={messageKey(message)}
              message={message}
              sessionIsSubagent={detail.summary.is_subagent}
              subagentsByToolUse={subagentsByToolUse}
              tool={detail.summary.tool}
              windowTokens={windowTokens}
            />
          ))}
          {detail.has_more_messages === true ? (
            <div
              aria-live="polite"
              className="transcript-load-more"
              ref={loadMoreSentinelRef}
              role="status"
            >
              {loadMoreError != null ? (
                <>
                  <span>Couldn’t load the next messages: {loadMoreError}</span>
                  <button
                    className="button small secondary"
                    onClick={() => void loadMoreMessages()}
                    type="button"
                  >
                    Try again
                  </button>
                </>
              ) : (
                <span>
                  {loadingMore ? "Loading more messages…" : "Keep scrolling to load more"}
                  <small>
                    {formatInt(detail.messages.length)} of {formatInt(detail.summary.message_count)}
                  </small>
                </span>
              )}
            </div>
          ) : (
            <div className="transcript-end">
              {(detail.message_offset ?? 0) === 0
                ? `All ${formatInt(detail.summary.message_count)} messages loaded`
                : "Reached the end of this session"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IngestIssuesPanel({
  error,
  issues,
  onResync,
  onRetry,
  syncing,
}: {
  error: unknown;
  issues: SessionIngestIssue[] | null;
  onResync: () => void;
  onRetry: () => void;
  syncing: boolean;
}) {
  const unknownIssues = issues?.filter((issue) => issue.code === "unknown_record_type") ?? [];
  const otherIssues = issues?.filter((issue) => issue.code !== "unknown_record_type") ?? [];
  const unknownSummary = unknownRecordTypeSummary(unknownIssues.map((issue) => issue.error));
  return (
    <section className="panel ingest-issues-panel">
      <div className="panel-heading">
        <div>
          <h2>Ingest diagnostics</h2>
          <p>
            A source line could not be parsed, so this session may be incomplete. Informational
            parser notes are included here for context.
          </p>
        </div>
        <button
          aria-busy={syncing}
          aria-label="Re-sync session logs"
          className={`secondary-button sync-button${syncing ? " is-syncing" : ""}`}
          disabled={syncing}
          onClick={onResync}
          type="button"
        >
          <Icon name="refresh" />
          {syncing ? null : "Re-sync"}
        </button>
      </div>
      <div className="panel-body">
        {error != null ? (
          <ApiFailureState error={error} onRetry={onRetry} />
        ) : issues == null ? (
          <p className="faint">Loading issues…</p>
        ) : issues.length === 0 ? (
          <p className="faint">No issues recorded for this session.</p>
        ) : (
          <div className="signal-list">
            {unknownSummary.count > 0 ? (
              <div className="ingest-issue-row is-informational">
                <div className="muted">
                  Decant safely preserved or ignored {formatInt(unknownSummary.count)} unknown
                  source {unknownSummary.count === 1 ? "record type" : "record types"}
                  {unknownSummary.types.length > 0
                    ? `: ${unknownSummary.types.map((type) => `“${type}”`).join(", ")}`
                    : ""}
                  .{" "}
                  <a
                    href="https://github.com/dosu-ai/decant/releases"
                    rel="noopener"
                    target="_blank"
                  >
                    Check for a Decant update
                  </a>{" "}
                  before re-syncing.
                </div>
              </div>
            ) : null}
            {otherIssues.map((issue, index) => (
              // No stable id in the wire shape; composite of the fields shown
              // plus the map index, since byte-identical rows (e.g. repeated
              // duplicate_tool_result issues) would otherwise collide.
              <div
                className={`ingest-issue-row ${
                  issue.code === "unparsed_line" ? "is-warning" : "is-informational"
                }`}
                // biome-ignore lint/suspicious/noArrayIndexKey: fetched once and never reorders; index only disambiguates byte-identical rows.
                key={`${issue.code}-${issue.line_no}-${issue.error}-${index}`}
              >
                <div>
                  <div>
                    <code className="mono">{issue.code}</code>
                    {issue.line_no != null ? (
                      <span className="faint"> · line {issue.line_no}</span>
                    ) : null}
                  </div>
                  <div className="muted">{issue.error}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// tabIndex={-1} lets arrow-key navigation move focus (and screen readers
// announce the turn) without joining the tab order. Memoized because a
// transcript can hold unbounded turns and each keypress changes `active` on two.
const TranscriptTurn = memo(function TranscriptTurn({
  active,
  compaction,
  compactionNumber,
  message,
  sessionIsSubagent,
  subagentsByToolUse,
  tool,
  windowTokens,
}: {
  active: boolean;
  compaction: ContextWindowCompactionData | null;
  compactionNumber: number | null;
  message: SessionDetailData["messages"][number];
  sessionIsSubagent: boolean;
  subagentsByToolUse: Map<string, SubagentDetailData[]>;
  tool: string;
  windowTokens: number | null;
}) {
  if (message.is_compact_boundary) {
    return (
      <CompactionTurn
        active={active}
        anchorId={`message-${message.seq}`}
        compaction={compaction}
        compactionNumber={compactionNumber}
        message={message}
      />
    );
  }
  const contextTokens =
    message.role === "assistant" && (!message.is_sidechain || sessionIsSubagent)
      ? message.context_tokens
      : null;
  const blocks = message.blocks.map((block, blockIndex) => (
    <TranscriptBlock
      block={block}
      key={blockKey(block, blockIndex)}
      subagents={subagentsByToolUse.get(block.tool_use_id ?? "") ?? []}
      tool={tool}
    />
  ));
  const providerClass =
    message.role === "assistant" ? ` provider-${providerIdentity(tool).key}` : "";
  return (
    <article
      aria-current={active ? "true" : undefined}
      className={`turn${message.is_compact_summary ? " compact-summary-turn" : ""}${
        active ? " is-keyboard-active" : ""
      }${providerClass}`}
      id={`message-${message.seq}`}
      tabIndex={-1}
    >
      <TranscriptIdentityBadge message={message} tool={tool} />
      <div className="turn-meta">
        {message.model != null ? <ModelBadge model={message.model} /> : null}
        {message.timestamp != null ? <span>{relativeTime(message.timestamp)}</span> : null}
        {contextTokens != null ? (
          <ContextChip tokens={contextTokens} windowTokens={windowTokens} />
        ) : null}
      </div>
      <div className="turn-body">
        {message.is_compact_summary ? (
          <details className="compact-summary">
            <summary>Compaction summary carried forward into the continued session</summary>
            {blocks}
          </details>
        ) : (
          blocks
        )}
      </div>
    </article>
  );
});

function CompactionTurn({
  active = false,
  anchorId,
  compaction,
  compactionNumber = null,
  message,
}: {
  active?: boolean;
  anchorId?: string;
  compaction: ContextWindowCompactionData | null;
  compactionNumber?: number | null;
  message: SessionDetailData["messages"][number];
}) {
  const trigger = compaction?.trigger ?? message.compact_trigger;
  const pre = compaction?.pre_tokens ?? message.compact_pre_tokens;
  const post = compaction?.post_tokens ?? null;
  return (
    <article
      aria-current={active ? "true" : undefined}
      className={`turn compaction-turn${active ? " is-keyboard-active" : ""}`}
      id={anchorId}
      tabIndex={-1}
    >
      <Badge mono tone="accent">
        {compactionNumber == null ? "Compacted" : `Compaction ${compactionNumber}`}
      </Badge>
      <div className="turn-meta">
        {message.timestamp != null ? <span>{relativeTime(message.timestamp)}</span> : null}
      </div>
      <div className="turn-body">
        <div className="compaction-card">
          <div className="compaction-card-head">
            <Icon name="refresh" />
            <strong>Context compacted{trigger != null ? ` (${trigger})` : ""}</strong>
            {pre != null ? (
              <span className="compaction-card-tokens">
                {compact(pre)}
                {post != null ? ` → ${compact(post)}` : ""} tokens
              </span>
            ) : null}
          </div>
          <p>
            Earlier messages were summarized and dropped from the live context window; the full
            transcript below is unaffected.
          </p>
          {message.blocks.length > 0 ? (
            <details className="compact-summary">
              <summary>Summary carried forward into the continued session</summary>
              {message.blocks.map((block, blockIndex) => (
                <TranscriptBlock block={block} key={blockKey(block, blockIndex)} />
              ))}
            </details>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function ContextChip({ tokens, windowTokens }: { tokens: number; windowTokens: number | null }) {
  const pct = windowTokens != null && windowTokens > 0 ? tokens / windowTokens : null;
  const level = pct == null ? "" : pct >= 0.8 ? " is-hot" : pct >= 0.6 ? " is-warm" : "";
  const title =
    pct == null
      ? `Context window: ${formatInt(tokens)} tokens`
      : `Context window: ${formatInt(tokens)} of ${compact(windowTokens ?? 0)} tokens`;
  return (
    <span className={`ctx-chip${level}`} title={title}>
      {pct != null ? (
        <span aria-hidden="true" className="ctx-chip-bar">
          <i style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }} />
        </span>
      ) : null}
      {pct != null ? `${Math.round(pct * 100)}% · ` : ""}
      {compact(tokens)}
    </span>
  );
}

const STRIP_HEIGHT = 214;
const STRIP_PLOT_TOP = 44;
const STRIP_RUG_HEIGHT = 30;
const STRIP_PAD_LEFT = 46;
const STRIP_PAD_RIGHT = 16;
const STRIP_WINDOW_LABEL_Y = 13;
/** Auto-compact fires near the top of the window; the exact threshold varies
 * by version, so the zone is a directional hint, not a promise. */
const STRIP_AUTO_COMPACT_ZONE = 0.8;

function ContextWindowPanel({
  onJump,
  timeline,
}: {
  onJump: (seq: number) => void | Promise<void>;
  timeline: ContextWindowTimelineData | null;
}) {
  const mode = contextWindowDisplayMode(timeline);
  if (mode === "hidden" || timeline == null) {
    return null;
  }
  if (mode === "unavailable" || timeline.window_tokens == null) {
    return <ContextWindowUnavailable timeline={timeline} />;
  }
  return (
    <ContextWindowStrip onJump={onJump} timeline={timeline} windowTokens={timeline.window_tokens} />
  );
}

function ContextWindowUnavailable({ timeline }: { timeline: ContextWindowTimelineData }) {
  const hasUsage = timeline.points.length > 0;
  return (
    <section className="panel context-window-panel">
      <div className="panel-heading">
        <div>
          <h2>Context window</h2>
          <p>How full the model's context window was at each API call across the session.</p>
        </div>
        <div className="activity-summary">
          {timeline.window_tokens != null ? (
            <span>
              <strong>{compact(timeline.window_tokens)}</strong>
              capacity
            </span>
          ) : null}
          {hasUsage ? (
            <span>
              <strong>{compact(timeline.peak_tokens)}</strong>
              peak tokens
            </span>
          ) : null}
        </div>
      </div>
      <div className="ctx-unavailable">
        <Icon name="info" />
        <div>
          <strong>
            {hasUsage
              ? "Window capacity not recorded or inferred"
              : "Per-call usage wasn’t recorded"}
          </strong>
          <p>
            {hasUsage
              ? "The transcript includes token usage, but Decant has no explicit context-window value and no model-based capacity for this source, so a trustworthy percentage is unavailable."
              : "This source session does not include the per-call token readings needed to reconstruct context usage."}
          </p>
        </div>
      </div>
    </section>
  );
}

function ContextWindowStrip({
  onJump,
  timeline,
  windowTokens,
}: {
  onJump: (seq: number) => void | Promise<void>;
  timeline: ContextWindowTimelineData;
  windowTokens: number;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverCompactionGroup, setHoverCompactionGroup] = useState<number | null>(null);
  const [selectedCompactionGroup, setSelectedCompactionGroup] = useState<number | null>(null);
  const [tooltipSize, setTooltipSize] = useState({ height: 158, width: 208 });

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (element == null) {
      return;
    }
    const measure = () => setWidth(Math.floor(element.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  // Fallback keeps the strip drawable even when measurement is delayed (e.g. a
  // hot-reloaded page whose effects did not re-run); the observer corrects it.
  const stripWidth = width > 0 ? width : 960;

  const layout = useMemo(() => {
    const points = timeline.points;
    const compactions = [...timeline.compactions].sort((a, b) => a.seq - b.seq);
    const peakLabel =
      timeline.peak_pct == null
        ? compact(timeline.peak_tokens)
        : `${Math.round(timeline.peak_pct * 100)}%`;

    const plotLeft = STRIP_PAD_LEFT;
    const plotRight = Math.max(plotLeft + 40, stripWidth - STRIP_PAD_RIGHT);
    const baseY = STRIP_HEIGHT - STRIP_RUG_HEIGHT;
    const yAt = (tokens: number) =>
      STRIP_PLOT_TOP + (1 - Math.min(1, tokens / windowTokens)) * (baseY - STRIP_PLOT_TOP);

    const { markerXs, segments, slotWidth, turnOrder, xs } = layoutContextCurve(
      points,
      compactions,
      { plotLeft, plotRight, yAt },
    );
    const xOf = (index: number) => xs[index] ?? plotLeft;

    const compactionMarks = compactions.map((compaction, index) => ({
      compaction,
      x: markerXs[index] ?? plotLeft,
    }));
    const compactionGroups = groupContextMarkers(compactionMarks.map(({ x }) => x));

    // Regular turn axis: a boundary tick at each slot edge, labels centered in
    // their slot for every labelStep-th turn.
    const labelStep = turnLabelStep(turnOrder.length);
    const turnMarks = turnOrder.map((turn, index) => ({
      turn,
      boundaryX: plotLeft + index * slotWidth,
      centerX: plotLeft + (index + 0.5) * slotWidth,
      labeled: index === 0 || turn % labelStep === 0,
    }));

    const lastIndex = points.length - 1;
    const lastPoint = points[lastIndex];
    const peakIndex = points.reduce(
      (best, point, index) =>
        point.context_tokens > (points[best]?.context_tokens ?? 0) ? index : best,
      0,
    );
    const peakPoint = points[peakIndex];
    const endY = lastPoint == null ? baseY : yAt(lastPoint.context_tokens);
    const peakX = xOf(peakIndex);
    const peakY = peakPoint == null ? baseY : yAt(peakPoint.context_tokens);
    return {
      baseY,
      compactionGroups,
      compactionMarks,
      compactions,
      endX: xOf(lastIndex),
      endY,
      // The live readout sits inside the plot, above the line when there is
      // room and below it when the session ended near the ceiling.
      endLabelAbove: endY > STRIP_PLOT_TOP + 30,
      lastIndex,
      lastPoint,
      peakIndex,
      peakLabel,
      peakLabelOnLeft: peakX > plotLeft + 70,
      peakLabelY: Math.max(STRIP_PLOT_TOP + 10, peakY - 7),
      peakPoint,
      peakX,
      peakY,
      plotLeft,
      plotRight,
      points,
      segments,
      turnMarks,
      xOf,
      xs,
      yAt,
    };
  }, [timeline, stripWidth, windowTokens]);
  const { baseY, compactionGroups, compactions, lastPoint, peakLabel, points, xOf, xs, yAt } =
    layout;

  // The static plot depends only on the layout; keeping its elements stable
  // lets React skip them while the pointer moves and only the hover overlay
  // and tooltip change. The handlers below only call state setters and onJump.
  const plot = useMemo(() => {
    const {
      baseY,
      compactionGroups,
      compactionMarks,
      compactions,
      endLabelAbove,
      endX,
      endY,
      lastIndex,
      lastPoint,
      peakIndex,
      peakLabel,
      peakLabelOnLeft,
      peakLabelY,
      peakPoint,
      peakX,
      peakY,
      plotLeft,
      plotRight,
      segments,
      turnMarks,
      yAt,
    } = layout;
    let previousTickLabelX = Number.NEGATIVE_INFINITY;
    return (
      <>
        <rect
          className="ctx-strip-band"
          height={yAt(windowTokens * STRIP_AUTO_COMPACT_ZONE) - yAt(windowTokens)}
          width={plotRight - plotLeft}
          x={plotLeft}
          y={yAt(windowTokens)}
        />
        <text
          className="ctx-strip-band-label"
          x={plotLeft + 4}
          y={yAt(windowTokens * STRIP_AUTO_COMPACT_ZONE) - 4}
        >
          auto-compact zone
        </text>
        {[0.25, 0.5, 0.75].map((fraction) => (
          <g className="ctx-strip-grid" key={`grid-${fraction}`}>
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={yAt(windowTokens * fraction)}
              y2={yAt(windowTokens * fraction)}
            />
            <text textAnchor="end" x={plotLeft - 8} y={yAt(windowTokens * fraction) + 3.5}>
              {compact(windowTokens * fraction)}
            </text>
          </g>
        ))}
        <line
          className="ctx-strip-window"
          x1={plotLeft}
          x2={plotRight}
          y1={yAt(windowTokens)}
          y2={yAt(windowTokens)}
        />
        <text className="ctx-strip-label" x={plotLeft + 4} y={STRIP_WINDOW_LABEL_Y}>
          window · {compact(windowTokens)}
          {timeline.window_inferred ? " (inferred)" : ""}
        </text>
        {segments.map((coords) => (
          <g key={`seg-${coords[0]?.[0] ?? 0}`}>
            <path className="ctx-strip-area" d={contextCurveAreaPath(coords, baseY)} />
            <path className="ctx-strip-line" d={contextCurveLinePath(coords)} />
          </g>
        ))}
        <g className="ctx-strip-rug">
          {turnMarks.slice(1).map((mark) => (
            <line
              key={`tick-${mark.turn}`}
              x1={mark.boundaryX}
              x2={mark.boundaryX}
              y1={baseY + 3}
              y2={baseY + 8}
            />
          ))}
          {turnMarks.map((mark) => {
            if (!mark.labeled || mark.centerX - previousTickLabelX < 44) {
              return null;
            }
            previousTickLabelX = mark.centerX;
            return (
              <text
                key={`tick-label-${mark.turn}`}
                textAnchor="middle"
                x={mark.centerX}
                y={baseY + 20}
              >
                turn {mark.turn}
              </text>
            );
          })}
        </g>
        {compactionMarks.map(({ compaction, x }) => (
          <g className="ctx-strip-compaction" key={`compaction-mark-${compaction.seq}`}>
            <line x1={x} x2={x} y1={STRIP_PLOT_TOP} y2={baseY} />
            <rect
              fill="transparent"
              height={baseY - STRIP_PLOT_TOP}
              width={16}
              x={x - 8}
              y={STRIP_PLOT_TOP}
            >
              <title>{compactionLabel(compaction)}</title>
            </rect>
          </g>
        ))}
        {compactionGroups.map((group, groupIndex) => {
          const first = (group.indexes[0] ?? 0) + 1;
          const last = (group.indexes.at(-1) ?? 0) + 1;
          const firstCompaction = compactions[group.indexes[0] ?? 0];
          const label = first === last ? `${first}` : `${first}–${last}`;
          const markerWidth = first === last ? 18 : Math.max(28, label.length * 6 + 10);
          return (
            <a
              aria-label={
                first === last && firstCompaction != null
                  ? `Compaction ${first}: ${compactionTokenRange(firstCompaction)} tokens`
                  : `Compactions ${first} through ${last}`
              }
              href={`#message-${firstCompaction?.seq ?? 0}`}
              key={`compaction-group-${first}-${last}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const seq = firstCompaction?.seq;
                if (group.indexes.length > 1) {
                  setHoverIndex(null);
                  setSelectedCompactionGroup(groupIndex);
                } else if (seq != null) {
                  setSelectedCompactionGroup(null);
                  void onJump(seq);
                }
              }}
              onFocus={() => {
                setHoverIndex(null);
                setHoverCompactionGroup(groupIndex);
                if (group.indexes.length > 1) {
                  setSelectedCompactionGroup(groupIndex);
                }
              }}
              onMouseEnter={() => {
                setHoverIndex(null);
                setHoverCompactionGroup(groupIndex);
              }}
              onMouseMove={(event) => event.stopPropagation()}
            >
              <g className="ctx-strip-compaction-marker">
                <rect
                  height={18}
                  rx={9}
                  width={markerWidth}
                  x={group.x - markerWidth / 2}
                  y={STRIP_PLOT_TOP - 21}
                />
                <text textAnchor="middle" x={group.x} y={STRIP_PLOT_TOP - 8}>
                  {label}
                </text>
              </g>
            </a>
          );
        })}
        {peakPoint != null && peakIndex !== lastIndex ? (
          <g className="ctx-strip-peak">
            <circle cx={peakX} cy={peakY} r={2.5}>
              <title>
                Peak {peakLabel} · {compact(peakPoint.context_tokens)} tokens
              </title>
            </circle>
            <text
              textAnchor={peakLabelOnLeft ? "end" : "start"}
              x={peakX + (peakLabelOnLeft ? -6 : 6)}
              y={peakLabelY}
            >
              peak {peakLabel}
            </text>
          </g>
        ) : null}
        <g className="ctx-strip-end">
          <circle className="ctx-strip-end-halo" cx={endX} cy={endY} r={6.5} />
          <circle cx={endX} cy={endY} r={3}>
            <title>End · {compact(lastPoint?.context_tokens ?? 0)} tokens</title>
          </circle>
          <text textAnchor="end" x={endX - 9} y={endLabelAbove ? endY - 9 : endY + 18}>
            {Math.round(((lastPoint?.context_tokens ?? 0) / windowTokens) * 100)}% ·{" "}
            {compact(lastPoint?.context_tokens ?? 0)}
          </text>
        </g>
      </>
    );
  }, [layout, onJump, timeline.window_inferred, windowTokens]);

  const handleMove = (event: { clientX: number; currentTarget: SVGSVGElement }) => {
    setHoverCompactionGroup(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    let nearest = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, x] of xs.entries()) {
      const distance = Math.abs(x - mouseX);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = index;
      }
    }
    setHoverIndex(nearest);
  };
  const hovered = hoverIndex == null ? null : (points[hoverIndex] ?? null);
  const hoveredIsFullCacheMiss =
    hoverIndex != null && isFullCacheMiss(points, hoverIndex, compactions);
  const activeCompactionGroup = selectedCompactionGroup ?? hoverCompactionGroup;
  const hoveredCompactions =
    activeCompactionGroup == null ? null : (compactionGroups[activeCompactionGroup] ?? null);
  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (element == null || (hovered == null && activeCompactionGroup == null)) {
      return;
    }
    const next = {
      height: Math.ceil(element.getBoundingClientRect().height),
      width: Math.ceil(element.getBoundingClientRect().width),
    };
    setTooltipSize((current) =>
      current.height === next.height && current.width === next.width ? current : next,
    );
  }, [hovered, activeCompactionGroup]);
  const tooltipAnchor =
    hoveredCompactions != null
      ? { x: hoveredCompactions.x, y: STRIP_PLOT_TOP }
      : hovered != null && hoverIndex != null
        ? { x: xOf(hoverIndex), y: yAt(hovered.context_tokens) }
        : null;
  const tooltipLayout =
    tooltipAnchor != null
      ? layoutContextTooltip({
          anchorX: tooltipAnchor.x,
          anchorY: tooltipAnchor.y,
          frameHeight: STRIP_HEIGHT,
          frameWidth: stripWidth,
          tooltipHeight: tooltipSize.height,
          tooltipWidth: tooltipSize.width,
        })
      : null;
  const handleJump = () => {
    if (hovered == null) {
      return;
    }
    void onJump(hovered.seq);
  };

  return (
    <section className="panel context-window-panel">
      <div className="panel-heading">
        <div>
          <h2>Context window</h2>
          <p>How full the model's context window was at each API call across the session.</p>
        </div>
        <div className="activity-summary">
          <span>
            <strong>{peakLabel}</strong>
            peak
          </span>
          <span>
            <strong>{formatInt(timeline.turn_count)}</strong>
            {timeline.turn_count === 1 ? "turn" : "turns"}
          </span>
          <span>
            <strong>{formatInt(points.length)}</strong>
            calls
          </span>
          <span>
            <strong>{formatInt(compactions.length)}</strong>
            {compactions.length === 1 ? "compaction" : "compactions"}
          </span>
        </div>
      </div>
      <div className="ctx-strip-wrap">
        <div className="ctx-strip-frame" ref={frameRef}>
          {lastPoint != null ? (
            <>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-jump is a
                  pointer-only shortcut; keyboard users reach the same turns via the
                  thread TOC and the compaction markers, which are real anchors. */}
              <svg
                aria-label={`Context window usage across ${points.length} API calls and ${timeline.turn_count} turns; peak ${peakLabel} of ${compact(windowTokens)}`}
                className="ctx-strip"
                height={STRIP_HEIGHT}
                onClick={(event) => {
                  setSelectedCompactionGroup(null);
                  handleJump();
                  event.currentTarget.focus();
                }}
                onMouseLeave={() => {
                  setHoverIndex(null);
                  setHoverCompactionGroup(null);
                }}
                onMouseMove={handleMove}
                width={stripWidth}
              >
                {plot}
                {hovered != null && hoverIndex != null ? (
                  <g className="ctx-strip-hover">
                    <line
                      x1={xOf(hoverIndex)}
                      x2={xOf(hoverIndex)}
                      y1={STRIP_PLOT_TOP}
                      y2={baseY}
                    />
                    <circle cx={xOf(hoverIndex)} cy={yAt(hovered.context_tokens)} r={3} />
                  </g>
                ) : null}
              </svg>
              {hoveredCompactions != null ? (
                <div
                  className={`ctx-tooltip ctx-compaction-tooltip${
                    selectedCompactionGroup != null ? " is-interactive" : ""
                  }`}
                  style={{
                    left: tooltipLayout?.left ?? 2,
                    top: tooltipLayout?.top ?? 2,
                  }}
                  ref={tooltipRef}
                >
                  <div className="ctx-tooltip-when">Context boundary</div>
                  <strong>
                    {hoveredCompactions.indexes.length === 1
                      ? `Compaction ${(hoveredCompactions.indexes[0] ?? 0) + 1}`
                      : `Compactions ${(hoveredCompactions.indexes[0] ?? 0) + 1}–${
                          (hoveredCompactions.indexes.at(-1) ?? 0) + 1
                        }`}
                  </strong>
                  <div className="ctx-tooltip-rows">
                    {hoveredCompactions.indexes.map((compactionIndex) => {
                      const compaction = compactions[compactionIndex];
                      return compaction == null ? null : selectedCompactionGroup != null ? (
                        <a
                          href={`#message-${compaction.seq}`}
                          key={`compaction-link-${compaction.seq}`}
                          onClick={(event) => {
                            event.preventDefault();
                            setSelectedCompactionGroup(null);
                            setHoverCompactionGroup(null);
                            void onJump(compaction.seq);
                          }}
                        >
                          <span>Compaction {compactionIndex + 1}</span>
                          <span>{compactionTokenRange(compaction)}</span>
                        </a>
                      ) : (
                        <span
                          className="ctx-tooltip-compaction-row"
                          key={`compaction-row-${compaction.seq}`}
                        >
                          <span>Compaction {compactionIndex + 1}</span>
                          <span>{compactionTokenRange(compaction)}</span>
                        </span>
                      );
                    })}
                  </div>
                  <div className="ctx-tooltip-hint">
                    {selectedCompactionGroup != null
                      ? "Choose a compaction to jump to the thread."
                      : hoveredCompactions.indexes.length > 1
                        ? "Select the numbered group to choose an exact compaction."
                        : "Select the marker to jump to the thread."}
                  </div>
                </div>
              ) : hovered != null && hoverIndex != null ? (
                <div
                  className="ctx-tooltip"
                  style={{
                    left: tooltipLayout?.left ?? 2,
                    top: tooltipLayout?.top ?? 2,
                  }}
                  ref={tooltipRef}
                >
                  <div className="ctx-tooltip-when">
                    turn {hovered.turn} · call {hoverIndex + 1} of {points.length}
                  </div>
                  <strong>
                    {Math.round((hovered.context_tokens / windowTokens) * 100)}% ·{" "}
                    {formatInt(hovered.context_tokens)} tokens in context
                  </strong>
                  <div className="ctx-tooltip-rows">
                    <span>cache read</span>
                    <span>{compact(hovered.cache_read_tokens)}</span>
                    <span>cache write</span>
                    <span>{compact(hovered.cache_creation_tokens)}</span>
                    {/* Claude Code sometimes reports raw input_tokens as a
                        small streaming placeholder; keeping it separate is
                        still more honest than folding it into cache writes. */}
                    <span>uncached input</span>
                    <span>{compact(hovered.input_tokens)}</span>
                  </div>
                  <div className="ctx-tooltip-output">
                    <span>output · this call</span>
                    <span>{compact(hovered.output_tokens)} tokens</span>
                  </div>
                  {hoveredIsFullCacheMiss ? (
                    <div className="ctx-tooltip-warning">
                      full cache miss — entire prompt re-sent
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function turnLabelStep(turnCount: number): number {
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]) {
    if (turnCount / step <= 8) {
      return step;
    }
  }
  return 1000;
}

function compactionTokenRange(compaction: ContextWindowCompactionData): string {
  if (compaction.pre_tokens == null) {
    return "Token count unavailable";
  }
  const post = compaction.post_tokens != null ? ` → ${compact(compaction.post_tokens)}` : "";
  return `${compact(compaction.pre_tokens)}${post}`;
}

function compactionLabel(compaction: ContextWindowCompactionData): string {
  const trigger = compaction.trigger != null ? `${compaction.trigger} compaction` : "compaction";
  if (compaction.pre_tokens == null) {
    return trigger;
  }
  const post = compaction.post_tokens != null ? ` → ${compact(compaction.post_tokens)}` : "";
  return `${trigger} · ${compact(compaction.pre_tokens)}${post} tokens`;
}

function TranscriptBlock({
  block,
  subagents = [],
  tool = "",
}: {
  block: TranscriptBlockData;
  subagents?: SubagentDetailData[];
  tool?: string;
}) {
  if (block.block_type === "tool_use") {
    const isDosu = isDosuToolName(block.tool_name);
    const presentation = presentationForTool(block.tool_name, block.tool_input);
    return (
      <div className={`tool-call${isDosu ? " is-dosu" : ""}`}>
        <div className="tool-call-header">
          {isDosu ? (
            <span className="dosu-tool-mark">
              <img alt="" src={dosuOfficialUrl} />
            </span>
          ) : (
            <Icon name="bolt" />
          )}
          <span className="tool-call-name">{block.tool_name ?? "tool_use"}</span>
          {isDosu ? <span className="dosu-tool-badge">Optimized</span> : <small>tool call</small>}
        </div>
        {isPresent(block.tool_input) ? (
          <ToolCallPresentation forceOpen={isDosu} presentation={presentation} />
        ) : null}
        {subagents.map((subagent) => (
          <SubagentCard key={subagent.summary.id} subagent={subagent} />
        ))}
      </div>
    );
  }
  if (block.block_type === "tool_result") {
    if (!isPresent(block.tool_result)) {
      return null;
    }
    return <ToolResultBlock block={block} forceOpen={isDosuToolName(block.tool_name)} />;
  }
  if (block.block_type === "thinking") {
    if (!isPresent(block.text)) {
      return null;
    }
    return (
      <details className="thinking-block">
        <summary>Thinking</summary>
        <p>{block.text}</p>
      </details>
    );
  }
  if (!isPresent(block.text)) {
    return null;
  }
  const attachment = embeddedAttachmentSummary(block.block_type, block.text);
  if (attachment != null) {
    return (
      <div className="transcript-attachment">
        <span className="transcript-attachment-icon">
          <Icon name="file" />
        </span>
        <div>
          <strong>Embedded image</strong>
          <span>
            {attachment.mediaType.split("/", 2)[1]?.toUpperCase() ?? "Image"} ·{" "}
            {formatBytes(attachment.byteLength)}
          </span>
          <small>Payload preserved in the local session log</small>
        </div>
      </div>
    );
  }
  const special = specialTranscriptBlock(block.text);
  if (special != null) {
    return <SpecialTranscriptBlock block={special} tool={tool} />;
  }
  return <TranscriptMarkdown>{block.text}</TranscriptMarkdown>;
}

function ToolCallPresentation({
  forceOpen = false,
  presentation,
}: {
  forceOpen?: boolean;
  presentation: TranscriptToolPresentation;
}) {
  switch (presentation.kind) {
    case "shell":
      return (
        <div className="tool-presentation tool-shell">
          {presentation.caption != null ? <p>{presentation.caption}</p> : null}
          <TranscriptCodeBlock code={`$ ${presentation.command}`} language="bash" />
        </div>
      );
    case "file":
      return (
        <div className="tool-presentation tool-file">
          <ToolPathHeader operation={presentation.operation} path={presentation.path} />
          {presentation.content != null ? (
            <TranscriptCodeBlock code={presentation.content} language={presentation.language} />
          ) : (
            <CollapsedToolArguments argumentsText={presentation.arguments} forceOpen={forceOpen} />
          )}
        </div>
      );
    case "edit":
      return (
        <div className="tool-presentation tool-edit">
          <ToolPathHeader operation="edit" path={presentation.path} />
          {presentation.diff.length > 0 ? (
            <div className="tool-diff">
              {presentation.diff.map((line) => {
                let partOffset = 0;
                return (
                  <div
                    className={`tool-diff-line is-${line.kind}`}
                    key={`${line.kind}-${line.oldLine ?? "x"}-${line.newLine ?? "x"}-${line.text}`}
                  >
                    <span>{line.oldLine ?? ""}</span>
                    <span>{line.newLine ?? ""}</span>
                    <code>
                      {line.parts.map((part) => {
                        const key = `${part.kind}-${partOffset}`;
                        partOffset += part.value.length;
                        return (
                          <span className={`is-${part.kind}`} key={key}>
                            {part.value}
                          </span>
                        );
                      })}
                    </code>
                  </div>
                );
              })}
            </div>
          ) : (
            <CollapsedToolArguments argumentsText={presentation.arguments} forceOpen={forceOpen} />
          )}
        </div>
      );
    case "search":
      return (
        <div className="tool-presentation tool-search">
          <div className="tool-presentation-chips">
            <Badge tone="info">{presentation.searchKind}</Badge>
            {presentation.pattern != null ? <code>{presentation.pattern}</code> : null}
            {presentation.path != null ? <code>{presentation.path}</code> : null}
          </div>
          <CollapsedToolArguments argumentsText={presentation.arguments} forceOpen={forceOpen} />
        </div>
      );
    case "json":
      return (
        <CollapsedToolArguments argumentsText={presentation.arguments} forceOpen={forceOpen} />
      );
  }
}

function ToolPathHeader({
  operation,
  path,
}: {
  operation: "edit" | "read" | "write";
  path: string | null;
}) {
  return (
    <div className="tool-path-header">
      <Badge tone={operation === "read" ? "info" : operation === "edit" ? "warning" : "success"}>
        {operation}
      </Badge>
      <code title={path ?? ""}>{path ?? "Unknown path"}</code>
    </div>
  );
}

function CollapsedToolArguments({
  argumentsText,
  forceOpen = false,
}: {
  argumentsText: string;
  forceOpen?: boolean;
}) {
  return (
    <details className="tool-arguments" open={forceOpen || argumentsText.length <= 240}>
      <summary>arguments</summary>
      <TranscriptCodeBlock code={argumentsText} language="json" />
    </details>
  );
}

function ToolResultBlock({
  block,
  forceOpen = false,
}: {
  block: TranscriptBlockData;
  forceOpen?: boolean;
}) {
  const result = block.tool_result ?? "";
  const collapsed = collapseTranscriptText(result);
  const [expanded, setExpanded] = useState(forceOpen || !collapsed.shouldCollapse);
  const summary = summarizeToolResult(block.tool_name, result);
  return (
    <details
      className="tool-result"
      onToggle={(event) => setExpanded(forceOpen || event.currentTarget.open)}
      open={forceOpen || expanded}
    >
      <summary>
        result{summary == null ? "" : ` · ${summary}`}
        {!expanded && collapsed.shouldCollapse ? ` · ${transcriptCollapseLabel(collapsed)}` : ""}
      </summary>
      <TranscriptCodeBlock
        code={expanded ? result : collapsed.preview}
        language={languageForTool(block.tool_name, block.tool_input)}
      />
    </details>
  );
}

function SessionDetailSkeleton() {
  return (
    <div
      className="session-detail session-detail-skeleton"
      aria-label="Loading session"
      role="status"
    >
      <header className="thread-header">
        <div className="thread-header-inner">
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-badges" />
          <span className="skeleton-line skeleton-stats" />
        </div>
      </header>
      <span className="skeleton-line skeleton-back" />
      <SessionEconomicsSkeleton />
      <div className="transcript-layout">
        <aside className="toc">
          <div className="toc-inner">
            <span className="skeleton-line skeleton-toc-title" />
            {["one", "two", "three", "four", "five", "six", "seven"].map((key) => (
              <span className="skeleton-line skeleton-toc-row" key={key} />
            ))}
          </div>
        </aside>
        <div className="transcript-column">
          {["prompt", "reply", "tool", "followup", "summary"].map((key) => (
            <article className="turn skeleton-turn" key={key}>
              <span className="skeleton-line skeleton-meta" />
              <span className="skeleton-line skeleton-copy" />
              <span className="skeleton-line skeleton-copy short" />
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionEconomicsSkeleton() {
  return (
    <section
      aria-label="Loading activity breakdown"
      className="panel token-economics-panel is-compact skeleton-panel"
      role="status"
    >
      <div className="panel-heading">
        <div>
          <span className="skeleton-line skeleton-heading" />
          <span className="skeleton-line skeleton-subheading" />
        </div>
        <span className="skeleton-line skeleton-summary" />
      </div>
      <div className="activity-table-wrap">
        <div className="skeleton-table">
          {["context", "planning", "code", "communicating"].map((key) => (
            <span className="skeleton-line" key={key} />
          ))}
        </div>
      </div>
    </section>
  );
}

type SpecialTranscriptBlockData = {
  title: string;
  description: string;
  tooltip: string;
  icon: IconName;
  chips: string[];
  kind?: StructuredTranscriptKind;
  dialogue?: StructuredTranscriptLine[];
};

function specialTranscriptBlock(text: string): SpecialTranscriptBlockData | null {
  const trimmed = text.trimStart();
  const structured = structuredTranscriptBlock(text);
  if (structured != null) {
    return {
      ...structured,
      icon: structuredTranscriptIcon(structured.kind),
      tooltip: structuredTranscriptTooltip(structured.kind),
    };
  }
  if (isPermissionsText(text)) {
    const sandbox = matchText(text, /`sandbox_mode`\s+is\s+`([^`]+)`/);
    const approval = matchText(text, /Approval policy is currently ([^.]+)\./);
    const network = matchText(text, /Network access is ([^.]+)\./);
    return {
      title: "Execution permissions",
      description: "Agent runtime limits for filesystem, network, and approval behavior.",
      tooltip:
        "Defines what the coding agent can read or write, whether it may request elevated commands, and whether network access is available.",
      icon: "shield",
      chips: [
        sandbox == null ? null : `sandbox ${sandbox}`,
        approval == null ? null : `approvals ${approval}`,
        network == null ? null : `network ${network}`,
      ].filter((value): value is string => value != null),
    };
  }
  if (/^<local-command-caveat>/i.test(trimmed)) {
    return {
      title: "Command context",
      description: "Runtime notice for local command output in this session.",
      tooltip:
        "Explains how local command output should be interpreted by the coding agent without exposing the raw system tag in the transcript.",
      icon: "shield",
      chips: ["agent runtime"],
    };
  }
  if (/^<command-name>/i.test(trimmed)) {
    const command = matchText(trimmed, /<command-name>([^<]+)<\/command-name>/);
    return {
      title: "Command context",
      description:
        command == null ? "Local slash command context." : `Local slash command: ${command}.`,
      tooltip:
        "Represents local slash-command metadata. The raw command wrapper is hidden so the transcript stays readable.",
      icon: "tools",
      chips: [command ?? "slash command"],
    };
  }
  if (/^The following is the Codex agent history/i.test(trimmed)) {
    return {
      title: "Agent history",
      description: "Prior agent transcript supplied as context.",
      tooltip: "Shows prior Codex activity that was included for review or continuation context.",
      icon: "file",
      chips: ["history"],
    };
  }
  if (/^Use prior reviews as context/i.test(trimmed)) {
    return {
      title: "Review context",
      description: "Instruction to treat previous reviews as context, not binding precedent.",
      tooltip: "Marks review-guidance context included before the current task request.",
      icon: "file",
      chips: ["review"],
    };
  }
  if (/^<teammate-message\b/i.test(trimmed)) {
    const summary = tagAttribute(trimmed, "summary");
    const teammate = tagAttribute(trimmed, "teammate_id");
    return {
      title: "Subagent request",
      description: summary ?? "Delegated work request supplied to a subagent.",
      tooltip:
        "Represents a structured subagent handoff. The raw message tag is hidden so the transcript stays readable.",
      icon: "cpu",
      chips: [teammate == null ? null : teammate].filter((value): value is string => value != null),
    };
  }
  if (text.includes("<environment_context>")) {
    const cwd = matchText(text, /<cwd>([^<]+)<\/cwd>/);
    const mode = matchText(text, /<shell>([^<]+)<\/shell>/);
    return {
      title: "Environment context",
      description: "Local workspace and shell context supplied to the agent.",
      tooltip:
        "Shows where the agent is running and which local environment details were provided for the session.",
      icon: "desktop",
      chips: [cwd == null ? null : shortPath(cwd), mode == null ? null : mode].filter(
        (value): value is string => value != null,
      ),
    };
  }
  if (trimmed.startsWith("# AGENTS.md instructions") || text.includes("<INSTRUCTIONS>")) {
    return {
      title: "Repository instructions",
      description: "Repo-specific agent guidance, invariants, and definition of done.",
      tooltip:
        "Summarizes the local AGENTS.md instructions that shape how the agent should edit, test, and verify work in this repository.",
      icon: "file",
      chips: ["AGENTS.md", `${formatInt(text.split(/\r?\n/).length)} lines`],
    };
  }
  return null;
}

function SpecialTranscriptBlock({
  block,
  tool,
}: {
  block: SpecialTranscriptBlockData;
  tool: string;
}) {
  return (
    <Tooltip content={block.tooltip}>
      {(tooltipProps) => (
        <div
          className={`special-block${block.kind != null ? ` is-${block.kind}` : ""}`}
          {...tooltipProps}
        >
          <span className="special-icon">
            <Icon name={block.icon} />
          </span>
          <div>
            <div className="special-heading">
              <strong>{block.title}</strong>
              <span aria-hidden="true" className="info-tooltip">
                <Icon name="info" />
              </span>
            </div>
            <p>{block.description}</p>
            {block.chips.length > 0 ? (
              <div className="special-chips">
                {block.chips.map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </div>
            ) : null}
            {block.dialogue != null && block.dialogue.length > 0 ? (
              <div className="realtime-dialogue">
                {keyedTranscriptLines(block.dialogue).map(({ key, line }) => (
                  <div className={`realtime-line is-${line.speaker}`} key={key}>
                    <TranscriptSpeakerBadge speaker={line.speaker} tool={tool} />
                    <p>{line.text}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Tooltip>
  );
}

function structuredTranscriptIcon(kind: StructuredTranscriptKind): IconName {
  if (kind === "realtime-ended") {
    return "clock";
  }
  if (kind === "realtime-handoff") {
    return "messages";
  }
  return "cpu";
}

function keyedTranscriptLines(
  lines: readonly StructuredTranscriptLine[],
): { key: string; line: StructuredTranscriptLine }[] {
  const occurrences = new Map<string, number>();
  return lines.map((line) => {
    const base = `${line.speaker}:${line.text}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return { key: `${base}:${occurrence}`, line };
  });
}

function structuredTranscriptTooltip(kind: StructuredTranscriptKind): string {
  if (kind === "realtime-ended") {
    return "Marks the point where a realtime voice conversation returned to normal typed chat.";
  }
  if (kind === "realtime-handoff") {
    return "A structured voice-mode envelope rendered as readable dialogue instead of raw runtime markup.";
  }
  return "Agent coordination instructions supplied by the runtime, summarized without the raw internal boilerplate.";
}

function SubagentCard({ subagent }: { subagent: SubagentDetailData }) {
  const messages = renderableMessages(subagent.messages);
  const nested = subagentMap(subagent.subagents);
  const compactionNumberBySeq = new Map(
    messages
      .filter((message) => message.is_compact_boundary)
      .map((message, index) => [message.seq, index + 1]),
  );
  return (
    <details className="subagent-card">
      <summary>
        <span>
          <Icon name="cpu" />
          subagent
        </span>
        <span>
          {subagent.agent_type ??
            cleanSessionTitle(subagent.summary.title) ??
            subagent.agent_id ??
            "agent"}
        </span>
        <small>
          {formatInt(subagent.summary.message_count)} msgs ·{" "}
          {money(subagent.summary.estimated_cost_usd)}
        </small>
      </summary>
      {messages.length === 0 ? (
        <div className="subagent-summary">
          <span>{formatInt(subagent.summary.message_count)} messages</span>
          <span>{formatInt(subagent.summary.subagent_count)} nested</span>
          <Link href={`/sessions/${subagent.summary.id}`}>Open session</Link>
        </div>
      ) : (
        <div className="subagent-transcript">
          {messages.map((message) =>
            message.is_compact_boundary ? (
              <CompactionTurn
                compaction={null}
                compactionNumber={compactionNumberBySeq.get(message.seq) ?? null}
                key={messageKey(message)}
                message={message}
              />
            ) : (
              <article
                className={`turn is-subagent${
                  message.role === "assistant"
                    ? ` provider-${providerIdentity(subagent.summary.tool).key}`
                    : ""
                }`}
                key={messageKey(message)}
              >
                <TranscriptIdentityBadge message={message} tool={subagent.summary.tool} />
                <div className="turn-body">
                  {message.blocks.map((block, blockIndex) => (
                    <TranscriptBlock
                      block={block}
                      key={blockKey(block, blockIndex)}
                      subagents={nested.get(block.tool_use_id ?? "") ?? []}
                      tool={subagent.summary.tool}
                    />
                  ))}
                </div>
              </article>
            ),
          )}
        </div>
      )}
    </details>
  );
}

function subagentMap(subagents: SubagentDetailData[]): Map<string, SubagentDetailData[]> {
  const map = new Map<string, SubagentDetailData[]>();
  for (const subagent of subagents) {
    if (subagent.spawn_tool_use_id == null) {
      continue;
    }
    const bucket = map.get(subagent.spawn_tool_use_id);
    if (bucket == null) {
      map.set(subagent.spawn_tool_use_id, [subagent]);
    } else {
      bucket.push(subagent);
    }
  }
  return map;
}

function countSubagentRuns(subagents: SubagentDetailData[]): number {
  return subagents.reduce(
    (total, subagent) => total + 1 + countSubagentRuns(subagent.subagents),
    0,
  );
}

function renderableMessages(
  messages: SessionDetailData["messages"],
): SessionDetailData["messages"] {
  return messages.filter(
    (message) =>
      // Compaction boundaries carry no blocks but render as inline cards.
      message.is_compact_boundary ||
      message.blocks.some((block) => {
        if (block.block_type === "text" || block.block_type === "thinking") {
          return isPresent(block.text);
        }
        return block.block_type === "tool_use" || block.block_type === "tool_result";
      }),
  );
}

function threadToc(messages: SessionDetailData["messages"]): ThreadTocItem[] {
  return messages.flatMap((message) => {
    const items: ThreadTocItem[] = [];
    // Compact summaries are machine-generated continuations, not prompts.
    if (message.role === "user" && !message.is_compact_summary) {
      const label =
        message.blocks.find((block) => block.block_type === "text" && isPresent(block.text))
          ?.text ?? "";
      if (label.trim() !== "") {
        items.push({
          key: `prompt:${message.seq}`,
          seq: message.seq,
          kind: "prompt",
          ...tocPresentation(label),
        });
      }
    }
    for (const block of message.blocks) {
      if (block.block_type !== "tool_use" || !isDosuToolName(block.tool_name)) {
        continue;
      }
      items.push({
        key: `dosu:${message.seq}:${block.ordinal}`,
        seq: message.seq,
        label: dosuToolDisplayName(block.tool_name),
        icon: "bolt",
        kind: "dosu",
      });
    }
    return items;
  });
}

function threadTocFromOutline(outline: SessionOutlineItemData[]): ThreadTocItem[] {
  return outline.map((item) =>
    item.kind === "dosu"
      ? {
          key: `dosu:${item.seq}:${item.ordinal}`,
          seq: item.seq,
          label: item.text || "Dosu tool",
          icon: "bolt",
          kind: "dosu",
        }
      : {
          key: `prompt:${item.seq}`,
          seq: item.seq,
          kind: "prompt",
          ...tocPresentation(item.text),
        },
  );
}

const ThreadTocEntry = memo(function ThreadTocEntry({
  current,
  item,
  jumping,
  onJump,
}: {
  current: boolean;
  item: ThreadTocItem;
  jumping: boolean;
  onJump: (seq: number) => Promise<unknown>;
}) {
  return (
    <a
      aria-label={item.kind === "dosu" ? `Dosu tool call: ${item.label}` : undefined}
      className={[
        item.kind === "dosu" ? "is-dosu" : null,
        jumping ? "is-loading" : null,
        current ? "is-current" : null,
      ]
        .filter(isPresent)
        .join(" ")}
      href={`#message-${item.seq}`}
      onClick={(event) => {
        event.preventDefault();
        void onJump(item.seq);
      }}
    >
      <span className={`toc-icon${item.kind === "dosu" ? " is-dosu" : ""}`}>
        {item.kind === "dosu" ? <img alt="" src={dosuOfficialUrl} /> : <Icon name={item.icon} />}
      </span>
      <span>{item.label}</span>
      {item.kind === "dosu" ? <em>Dosu</em> : null}
      {jumping ? <b>loading</b> : null}
    </a>
  );
});

type ThreadTocItem = {
  key: string;
  seq: number;
  label: string;
  icon: IconName;
  kind: "prompt" | "dosu";
};

function tocPresentation(text: string): { label: string; icon: IconName } {
  const special = specialTranscriptBlock(text);
  if (special != null) {
    return { label: firstLine(special.title, 70), icon: special.icon };
  }
  return { label: firstLine(cleanSessionTitle(text) ?? text, 70), icon: "messages" };
}

/**
 * Header stats are whole-session figures, so `totals` (server-aggregated) is
 * used; counting the loaded window would shrink as a transcript paginates. The
 * window fallback only covers payloads that predate `totals`.
 */
function threadStats(
  summary: SessionSummary,
  messages: SessionDetailData["messages"],
  toc: ThreadTocItem[],
  fullTurnCount?: number | null,
  totals?: SessionDetailData["totals"],
) {
  return {
    turns:
      fullTurnCount != null && fullTurnCount > 0
        ? fullTurnCount
        : toc.filter((item) => item.kind === "prompt").length,
    replies:
      totals?.reply_count ?? messages.filter((message) => message.role === "assistant").length,
    toolCalls:
      totals?.tool_call_count ??
      messages.reduce(
        (sum, message) =>
          sum + message.blocks.filter((block) => block.block_type === "tool_use").length,
        0,
      ),
    tokens: summary.total_input_tokens + summary.total_output_tokens,
  };
}

function messageKey(message: SessionDetailData["messages"][number]): string {
  return `${message.seq}:${message.role}`;
}

function blockKey(block: TranscriptBlockData, index: number): string {
  return [
    index,
    block.ordinal,
    block.block_type,
    block.tool_use_id ?? "no-tool",
    block.tool_name ?? "no-name",
  ].join("|");
}

function TranscriptIdentityBadge({
  message,
  tool,
}: {
  message: SessionDetailData["messages"][number];
  tool: string;
}) {
  if (message.is_compact_summary) {
    return (
      <Badge mono tone="accent">
        <Icon name="refresh" />
        Summary
      </Badge>
    );
  }
  const specialKind = messageSpecialKind(message);
  if (specialKind != null) {
    const realtime = specialKind === "realtime-ended" || specialKind === "realtime-handoff";
    return (
      <Badge tone={realtime ? "info" : "neutral"}>
        <Icon name={realtime ? "messages" : "shield"} />
        {realtime ? "Realtime" : "Runtime"}
      </Badge>
    );
  }
  if (message.role === "assistant") {
    const provider = providerIdentity(tool);
    return (
      <Badge tone={provider.tone}>
        {provider.icon == null ? <Icon name="cpu" /> : <BrandMark name={provider.icon} />}
        {provider.label}
      </Badge>
    );
  }
  if (message.role === "tool") {
    return (
      <Badge tone="info">
        <Icon name="tools" />
        Tool
      </Badge>
    );
  }
  if (message.role === "system") {
    return (
      <Badge>
        <Icon name="shield" />
        System
      </Badge>
    );
  }
  return <Badge>You</Badge>;
}

function TranscriptSpeakerBadge({
  speaker,
  tool,
}: {
  speaker: StructuredTranscriptLine["speaker"];
  tool: string;
}) {
  if (speaker === "user") {
    return <span className="realtime-speaker">You</span>;
  }
  const provider = providerIdentity(tool);
  return (
    <span className={`realtime-speaker tone-${provider.tone}`}>
      {provider.icon == null ? <Icon name="cpu" /> : <BrandMark name={provider.icon} />}
      {provider.label}
    </span>
  );
}

function messageSpecialKind(
  message: SessionDetailData["messages"][number],
): StructuredTranscriptKind | "runtime" | null {
  const blocks = message.blocks.filter(
    (block) => block.block_type === "text" && isPresent(block.text),
  );
  if (blocks.length === 0 || blocks.length !== message.blocks.length) {
    return null;
  }
  let kind: StructuredTranscriptKind | "runtime" | null = null;
  for (const block of blocks) {
    const special = specialTranscriptBlock(block.text ?? "");
    if (special == null) {
      return null;
    }
    kind ??= special.kind ?? "runtime";
  }
  return kind;
}

function nearestTranscriptSeq(sequences: readonly number[]): number | null {
  let nearest: { distance: number; seq: number } | null = null;
  const readingLine = 184;
  for (const seq of sequences) {
    const element = document.getElementById(`message-${seq}`);
    if (element == null) {
      continue;
    }
    const bounds = element.getBoundingClientRect();
    if (bounds.bottom < readingLine) {
      continue;
    }
    const distance = Math.abs(bounds.top - readingLine);
    if (nearest == null || distance < nearest.distance) {
      nearest = { distance, seq };
    }
  }
  return nearest?.seq ?? sequences[0] ?? null;
}

function scrollTranscriptMessage(seq: number, stabilize = false, isCurrent = () => true) {
  const target = document.getElementById(`message-${seq}`);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!revealTranscriptMessage(target, reducedMotion || stabilize) || !stabilize) {
    return;
  }

  // content-visibility keeps thousand-message transcripts fast by estimating
  // off-screen turn heights. A deep jump reveals and measures those turns over
  // the next few frames, so the first scroll can drift as estimates become real
  // heights. Re-align without animation until the layout settles; focus stays
  // on the target from the first reveal and stale rapid jumps cancel the loop.
  let remaining = 7;
  const realign = () => {
    if (!isCurrent() || target == null) {
      return;
    }
    target.scrollIntoView({ behavior: "auto", block: "start" });
    remaining -= 1;
    if (remaining > 0) {
      requestAnimationFrame(() => requestAnimationFrame(realign));
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(realign));
}

function implementedTimestamp(row: Recommendation): number {
  const time = Date.parse(row.implemented_at ?? "");
  return Number.isFinite(time) ? time : 0;
}

/** Rendered instead of the app when decant is loaded inside a frame, so that no
 * part of the UI - including the Insights "Run" button, which launches a coding
 * agent on this machine - exists to be clicked through a hidden overlay. */
function FramedNotice() {
  return (
    <EmptyState
      icon="shield"
      message="Open Decant directly in its own browser tab or window to use it."
      title="Decant cannot be displayed in a frame"
    />
  );
}

const root = document.getElementById("root");
if (root == null) {
  throw new Error("missing #root");
}
createRoot(root).render(
  isFramed(window) ? (
    <FramedNotice />
  ) : (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  ),
);
