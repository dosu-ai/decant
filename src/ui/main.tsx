import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, getJson } from "./api.ts";
import { ApiFailureState } from "./api-failure.tsx";
import dosuDecantUrl from "./assets/dosu-decant.png";
import dosuOfficialUrl from "./assets/dosu-official.svg";
import { paletteShortcutLabel, shouldOpenCommandPalette } from "./command-palette.ts";
import { CommandPalette } from "./command-palette-view.tsx";
import { EmptyState, ErrorState } from "./common.tsx";
import { emptyData, SLICE_LOADERS, slicesForView } from "./data-slices.ts";
import { ALL_DATE_RANGE, dateRangeQuery, withDateQuery } from "./date-range.ts";
import { dosuLink } from "./dosu-links.ts";
import { ErrorBoundary } from "./error-boundary.tsx";
import { useDisabledFocusRescue } from "./focus.ts";
import { formatDay, formatInt, latestSessionDay, money, versionLabel } from "./format.ts";
import { isFramed } from "./frame-guard.ts";
import { Icon } from "./icons.tsx";
import { createLatestThrottle, type LatestThrottle } from "./latest-throttle.ts";
import { Link, locationPath, visit } from "./link.tsx";
import { navGroups, navItems } from "./nav-items.ts";
import {
  documentTitleFor,
  isKnownRoute,
  isSessionDetailPath,
  pathOnly,
  activeRoute as resolveActiveRoute,
  activeRouteKey as resolveActiveRouteKey,
  sessionIncludesArchived,
  sessionPageFromPath,
  sessionProjectFilter,
  sessionsPageHref,
  titleFor,
} from "./navigation.ts";
import {
  ANALYTICS_REPORT_INCLUDES,
  ANALYTICS_REPORT_NEVER_INCLUDES,
  ReportRouteView,
  SESSION_REPORT_INCLUDES,
  SESSION_REPORT_NEVER_INCLUDES,
} from "./report-export.tsx";
import { readStorage, removeStorage, writeStorage } from "./safe-storage.ts";
import { sessionPageFailure, useSessionPage } from "./session-page.ts";
import { collectSliceResults } from "./slice-loading.ts";
import {
  isForegroundSync,
  LIVE_SESSIONS_REFRESH_MS,
  LIVE_SESSIONS_TOP_PX,
  type LiveSessionsViewer,
  liveSessionsAction,
  parseSyncFailure,
  planArchiveUpdate,
  sessionsAutoRefresh,
} from "./sync-events.ts";
import { hasOpenModal, isInteractiveTarget } from "./transcript-navigation.ts";
import type {
  DashboardData,
  DataSlice,
  DateRangeSelection,
  ServerEventPayload,
  SessionPageState,
  SyncProgress,
  ThemeChoice,
} from "./types.ts";
import { AnalyticsView } from "./views/analytics.tsx";
import { FilesView } from "./views/files.tsx";
import { InsightsView } from "./views/insights.tsx";
import { ProjectsView } from "./views/projects.tsx";
import { SearchView } from "./views/search.tsx";
import { SessionDetailView } from "./views/session-detail.tsx";
import { SessionsView } from "./views/sessions.tsx";
import { SettingsView } from "./views/settings.tsx";
import { ToolsView } from "./views/tools.tsx";
import "./styles.css";

const LIVE_DISCONNECT_GRACE_MS = 15_000;
// Every other view renders its own <h1>; the topbar title is then a plain label.
const VIEWS_WITHOUT_HEADING = new Set(["not-found"]);
const SYNC_PROGRESS_RENDER_MS = 150;

function liveSessionsViewer(): LiveSessionsViewer {
  return {
    nearTop: window.scrollY <= LIVE_SESSIONS_TOP_PX,
    visible: document.visibilityState !== "hidden",
  };
}

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
  const [sessionTextFilterActive, setSessionTextFilterActive] = useState(false);
  const syncCompleteTimerRef = useRef<number | null>(null);
  const syncProgressThrottleRef = useRef<LatestThrottle<SyncProgress> | null>(null);
  const liveSessionsThrottleRef = useRef<LatestThrottle<null> | null>(null);
  const liveSessionsRef = useRef(false);
  const liveDisconnectTimerRef = useRef<number | null>(null);
  const liveDroppedRef = useRef(false);
  const manualSyncPendingRef = useRef(false);
  const awaitingStatsRef = useRef(false);
  const localSyncingRef = useRef(false);
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
    // The SSE handlers live in a long-lived effect, so they read this ref
    // rather than a stale closure over localSyncing.
    localSyncingRef.current = localSyncing;
  }, [localSyncing]);

  const sessionFailure = sessionPageFailure(sessionPageState, sessionPage);
  const liveSessions = sessionsAutoRefresh({
    path,
    textFilterActive: sessionTextFilterActive,
    paletteOpen: commandPaletteOpen,
  });

  useEffect(() => {
    const throttle = createLatestThrottle<null>(() => {
      const action = liveSessionsAction(
        liveSessionsRef.current,
        localSyncingRef.current,
        liveSessionsViewer(),
      );
      if (action === "refresh") {
        setArchiveUpdateAvailable(false);
        requestRefresh();
      } else if (action === "offer_update") {
        setArchiveUpdateAvailable(true);
      }
    }, LIVE_SESSIONS_REFRESH_MS);
    liveSessionsThrottleRef.current = throttle;
    return () => {
      throttle.cancel();
      liveSessionsThrottleRef.current = null;
    };
  }, [requestRefresh]);

  useEffect(() => {
    liveSessionsRef.current = liveSessions;
    // Activity that lit Update while the list was filtered, paged, or covered
    // loads once the unfiltered first page is back in view.
    if (liveSessions && archiveUpdateAvailable) {
      liveSessionsThrottleRef.current?.push(null);
    }
  }, [archiveUpdateAvailable, liveSessions]);

  useEffect(() => {
    if (!liveSessions || !archiveUpdateAvailable) {
      return;
    }
    // Activity held back while the reader was scrolled down or the tab was
    // hidden loads once they are back at the top of a visible list.
    const resume = () => {
      const viewer = liveSessionsViewer();
      if (viewer.nearTop && viewer.visible) {
        liveSessionsThrottleRef.current?.push(null);
      }
    };
    window.addEventListener("scroll", resume, { passive: true });
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("scroll", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [archiveUpdateAvailable, liveSessions]);

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
        // A sync seen only over this stream may have finished, failed, or died
        // with the server while disconnected, so its terminal event is lost.
        // A later progress event restores the indicator if it is still running.
        if (!manualSyncPendingRef.current) {
          progressThrottle.cancel();
          setLocalSyncing(false);
          setSyncProgress(null);
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
        if (!isForegroundSync(payload.reason)) {
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
      if (!isForegroundSync(payload.reason)) {
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
      const plan = planArchiveUpdate(
        payload.reason,
        awaitingStatsRef.current,
        localSyncingRef.current,
      );
      awaitingStatsRef.current = plan.awaitingStats;
      if (plan.refresh) {
        setArchiveUpdateAvailable(false);
        requestRefresh();
        return;
      }
      if (plan.offerUpdate) {
        const liveRefresh = liveSessionsThrottleRef.current;
        if (liveSessionsRef.current && liveRefresh != null) {
          liveRefresh.push(null);
        } else {
          setArchiveUpdateAvailable(true);
        }
      }
    };
    const handleOpen = () => markConnected();
    const handleError = (event: Event) => {
      const failure = parseSyncFailure(event);
      if (failure != null) {
        markConnected();
        if (isForegroundSync(failure.reason)) {
          progressThrottle.cancel();
          setLocalSyncing(false);
          setSyncProgress(null);
          // Matches what a failed POST /api/sync shows, so Retry runs a sync.
          setSyncError(new ApiError(500, "internal_error", failure.error));
        }
        return;
      }
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
    manualSyncPendingRef.current = true;
    void getJson<unknown>("/api/sync", { method: "POST", body: "{}" })
      .finally(() => {
        manualSyncPendingRef.current = false;
      })
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
            {activeView === "sessions" && sessionFailure === "notice" ? (
              <div className="notice danger slice-load-notice" role="alert">
                <span>
                  The session list could not be refreshed. The sessions shown may be out of date.
                </span>
                <button className="secondary-button" onClick={requestRefresh} type="button">
                  Retry
                </button>
              </div>
            ) : null}
            {activeView === "sessions" && sessionFailure === "replace" ? (
              <ApiFailureState
                error={sessionPageState.error}
                onRetry={requestRefresh}
                onSync={runSync}
              />
            ) : (
              renderView(activeView, path, data, {
                dateRange: dateRangeSelection,
                onDateRangeChange: handleDateRangeChange,
                onSessionTextFilterChange: setSessionTextFilterActive,
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
    onSessionTextFilterChange: (active: boolean) => void;
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
          onTextFilterChange={actions.onSessionTextFilterChange}
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
