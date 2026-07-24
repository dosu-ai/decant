import * as echarts from "echarts";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Clock3,
  Cpu,
  Download,
  FileText,
  FlaskConical,
  Folder,
  Inbox,
  Info,
  Lightbulb,
  Menu,
  MessageSquare,
  Minus,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Upload,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
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
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  type AnalyticsChartMetric,
  type AnalyticsChartState,
  type AnalyticsChartVariant,
  prepareAnalyticsChartState,
} from "./chart-state.ts";
import { layoutContextAnnotations } from "./context-window-layout.ts";
import { contextWindowDisplayMode } from "./context-window-state.ts";
import { compactDateTime, fullDateTime } from "./date-time.ts";
import { effortTooltip } from "./effort.ts";
import { isFramed } from "./frame-guard.ts";
import { planSessionLoad, shouldShowSessionSkeleton } from "./loading-state.ts";
import {
  isInteractiveTarget,
  nextTranscriptSeq,
  type TranscriptNavigationDirection,
  transcriptNavigationDirection,
  transcriptSeqFromHash,
} from "./transcript-navigation.ts";
import {
  appendTranscriptPage,
  clampTranscriptWindowOffset,
  runWithTranscriptRequestSlot,
  transcriptWindowOffset,
} from "./transcript-pagination.ts";
import {
  type StructuredTranscriptKind,
  type StructuredTranscriptLine,
  structuredTranscriptBlock,
} from "./transcript-presentation.ts";
import "./styles.css";

type Summary = {
  sessions: number;
  messages: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
};

type SessionSummary = {
  id: number;
  tool: string;
  source_session_id: string;
  title: string | null;
  project_path: string | null;
  model: string | null;
  reasoning_effort: string | null;
  reasoning_effort_levels: string[];
  started_at: string | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  estimated_cost_usd: number;
  is_subagent: boolean;
  parent_session_id: number | null;
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
  context_window_tokens: number | null;
  peak_context_tokens: number | null;
  compaction_count: number;
  subagent_count: number;
  subagent_estimated_cost_usd: number;
  subagents?: SessionSummary[];
};

type SearchHit = {
  session_id: number;
  session_title: string | null;
  tool: string;
  snippet: string;
};

type Activity = {
  by_hour: number[];
  by_weekday: number[];
  timezone: string;
  peak_hour: number | null;
  peak_weekday: number | null;
};

type ModelSparklines = {
  models: Record<string, number[]>;
  days: string[];
};

type DateBounds = {
  min: string | null;
  max: string | null;
};

type NowView = {
  today: Summary;
  active_sessions: unknown[];
  last_sync_at: string | null;
  sync_in_progress: boolean;
};

type ActivityBucket = "context" | "planning" | "code" | "communicating";

type TokenEconomics = {
  buckets: {
    bucket: ActivityBucket;
    generation_tokens: number;
    context_window_tokens: number;
    estimated_cost_usd: number;
    tool_calls: number;
    sessions: number;
    cost_share: number;
    active_ms: number;
  }[];
  totals: {
    generation_tokens: number;
    context_window_tokens: number;
    estimated_cost_usd: number;
    input_cost_usd: number;
    output_cost_usd: number;
    active_ms: number;
    waiting_on_user_ms: number;
    attributed_ms: number;
  };
};

type DimensionRow = {
  key: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  est_reasoning_tokens: number;
  estimated_cost_usd: number;
};

type ProjectSummary = {
  id: number;
  path: string;
  name: string | null;
  sessions: number;
  estimated_cost_usd: number;
  last_seen_at: string | null;
  is_worktree: boolean;
  root_path: string | null;
  worktree_label: string | null;
  worktree_tool: string | null;
  root_source: string | null;
  worktree_count: number;
  session_tools: string[];
};

type ToolRow = {
  tool_name: string;
  tool_kind: string;
  mcp_server: string | null;
  calls: number;
  errors: number;
};

type McpRow = {
  mcp_server: string;
  tools: number;
  calls: number;
  errors: number;
};

type FileRow = {
  key: string;
  project: string | null;
  reads: number;
  edits: number;
  writes: number;
  deletes: number;
  sessions: number;
  last_touched_at: string | null;
};

type Recommendation = {
  key: string;
  kind: "signal" | "catalog";
  status: string;
  category: string | null;
  title: string;
  detail: string | null;
  suggestion: string | null;
  prompt: string | null;
  url: string | null;
  link_label: string | null;
  icon: string | null;
  tone: string | null;
  score: number;
  action: string | null;
  memory_layer: string | null;
  promotion_target: string | null;
  trigger: string | null;
  evidence: string | null;
  success_metric: string | null;
  note: string | null;
  implemented_at: string | null;
};

type ConfigView = {
  dbPath: string;
  claudeDir: string;
  codexDir: string;
};

type UserSettings = {
  agent: string;
  terminal: string;
  ide: string;
};

type SettingsInfo = {
  settings: UserSettings;
  path: string;
  can_launch: boolean;
  options: {
    agents: [string, string][];
    terminals: [string, string][];
    ides: [string, string][];
  };
};

type DashboardData = {
  summary: Summary | null;
  sessions: SessionSummary[];
  byModel: DimensionRow[];
  byProject: DimensionRow[];
  byDay: DimensionRow[];
  projects: ProjectSummary[];
  tools: ToolRow[];
  mcp: McpRow[];
  files: FileRow[];
  recommendations: Recommendation[];
  config: ConfigView | null;
  settings: SettingsInfo | null;
  activity: Activity | null;
  modelSparklines: ModelSparklines | null;
  tokenEconomics: TokenEconomics | null;
  now: NowView | null;
  dateBounds: DateBounds | null;
};

const emptyData: DashboardData = {
  summary: null,
  sessions: [],
  byModel: [],
  byProject: [],
  byDay: [],
  projects: [],
  tools: [],
  mcp: [],
  files: [],
  recommendations: [],
  config: null,
  settings: null,
  activity: null,
  modelSparklines: null,
  tokenEconomics: null,
  now: null,
  dateBounds: null,
};

type DataSlice = Exclude<keyof DashboardData, "sessions">;

// Each page fetches only the slices it renders; fetching everything for every
// page made first paint wait on the slowest analytics endpoint. Slices are
// cached per (date filter, reload generation), so navigating back is free and
// SSE-triggered refreshes only refetch what the active page shows.
const SLICE_LOADERS: Record<
  DataSlice,
  { dateScoped: boolean; load: (dateQuery: string) => Promise<Partial<DashboardData>> }
> = {
  summary: {
    dateScoped: true,
    load: async (q) => ({
      summary: await getJson<Summary>(withDateQuery("/api/stats/summary", q)),
    }),
  },
  byModel: {
    dateScoped: true,
    load: async (q) => ({
      byModel: await getJson<DimensionRow[]>(withDateQuery("/api/stats/by-dimension?dim=model", q)),
    }),
  },
  byProject: {
    dateScoped: true,
    load: async (q) => ({
      byProject: await getJson<DimensionRow[]>(
        withDateQuery("/api/stats/by-dimension?dim=project", q),
      ),
    }),
  },
  byDay: {
    dateScoped: true,
    load: async (q) => ({
      byDay: await getJson<DimensionRow[]>(withDateQuery("/api/stats/by-dimension?dim=day", q)),
    }),
  },
  projects: {
    dateScoped: false,
    load: async () => ({ projects: await getJson<ProjectSummary[]>("/api/projects") }),
  },
  tools: {
    dateScoped: true,
    load: async (q) => ({
      tools: await getJson<ToolRow[]>(withDateQuery("/api/tools/usage?limit=100", q)),
    }),
  },
  mcp: {
    dateScoped: true,
    load: async (q) => ({
      mcp: await getJson<McpRow[]>(withDateQuery("/api/tools/mcp-usage?limit=100", q)),
    }),
  },
  files: {
    dateScoped: true,
    load: async (q) => ({
      files: await getJson<FileRow[]>(withDateQuery("/api/files?group=path&limit=100", q)),
    }),
  },
  recommendations: {
    dateScoped: false,
    load: async () => ({
      recommendations: await getJson<Recommendation[]>("/api/recommendations?status=all"),
    }),
  },
  config: {
    dateScoped: false,
    load: async () => ({ config: await getJson<ConfigView>("/api/config") }),
  },
  settings: {
    dateScoped: false,
    load: async () => ({ settings: await getJson<SettingsInfo>("/api/settings") }),
  },
  activity: {
    dateScoped: true,
    load: async (q) => ({
      activity: await getJson<Activity>(withDateQuery("/api/analytics/activity", q)),
    }),
  },
  modelSparklines: {
    dateScoped: true,
    load: async (q) => ({
      modelSparklines: await getJson<ModelSparklines>(
        withDateQuery("/api/analytics/model-sparklines", q),
      ),
    }),
  },
  tokenEconomics: {
    dateScoped: true,
    load: async (q) => ({
      tokenEconomics: await getJson<TokenEconomics>(
        withDateQuery("/api/analytics/token-economics", q),
      ),
    }),
  },
  now: {
    dateScoped: false,
    load: async () => ({ now: await getJson<NowView>("/api/analytics/now") }),
  },
  dateBounds: {
    dateScoped: false,
    load: async () => ({ dateBounds: await getJson<DateBounds>("/api/date-bounds") }),
  },
};

// Slices the app shell itself renders (sidebar stats, sync button, pickers).
const SHELL_SLICES: DataSlice[] = ["summary", "now", "dateBounds"];

const ROUTE_SLICES: Record<string, DataSlice[]> = {
  Sessions: [],
  Projects: ["projects"],
  Search: [],
  Analytics: ["byDay", "byModel", "byProject", "activity", "modelSparklines", "tokenEconomics"],
  Insights: ["recommendations", "settings"],
  "Tools & MCP": ["tools", "mcp"],
  Files: ["files"],
  Settings: ["config", "settings"],
};

type NavItem = {
  key: string;
  href: string;
  label: string;
  icon: IconName;
};

const navItems: NavItem[] = [
  { key: "sessions", href: "/sessions", label: "Sessions", icon: "sessions" },
  { key: "projects", href: "/projects", label: "Projects", icon: "folder" },
  { key: "search", href: "/search", label: "Search", icon: "search" },
  { key: "analytics", href: "/analytics", label: "Analytics", icon: "chart" },
  { key: "insights", href: "/insights", label: "Insights", icon: "lightbulb" },
  { key: "tools", href: "/tools", label: "Tools & MCP", icon: "tools" },
  { key: "files", href: "/files", label: "Files", icon: "file" },
];

const CLAUDE_ICON_PATH =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
const OPENAI_ICON_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const ANTHROPIC_ICON_PATH =
  "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";

const SESSION_PAGE_SIZE = 50;
const SESSION_DETAIL_MESSAGE_PAGE_SIZE = 160;
const SESSION_TABLE_SKELETON_KEYS = Array.from(
  { length: 10 },
  (_, index) => `session-row-skeleton-${index}`,
);
type ThemeChoice = "system" | "light" | "dark";
type RangePreset = "7d" | "30d" | "90d" | "all" | "custom";
type DateRangeSelection = {
  preset: RangePreset;
  from: string | null;
  to: string | null;
};

const RANGE_PRESETS = [
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
] as const;
const ALL_DATE_RANGE: DateRangeSelection = { preset: "all", from: null, to: null };

function App() {
  const [path, setPath] = useState(locationPath);
  const [data, setData] = useState<DashboardData>(emptyData);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadedSessionKey, setLoadedSessionKey] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(SESSION_PAGE_SIZE);
  const [dateRangeSelection, setDateRangeSelection] = useState<DateRangeSelection>(ALL_DATE_RANGE);
  const [menuOpen, setMenuOpen] = useState(false);
  const dateQuery = dateRangeQuery(dateRangeSelection);
  const sessionLoadKey = `${dateQuery}:${reloadKey}`;
  const refreshTimerRef = useRef<number | null>(null);
  const loadedSlicesRef = useRef(new Map<DataSlice, string>());
  const activeView = activeRoute(path);
  const showsSessions = activeView === "Sessions";
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    const stored = localStorage.getItem("decant-theme");
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
      localStorage.removeItem("decant-theme");
    } else {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem("decant-theme", theme);
    }
    window.dispatchEvent(new CustomEvent("decant:set-theme"));
  }, [theme]);

  useEffect(() => {
    void dateQuery;
    setData((current) => ({ ...current, sessions: [] }));
    setLoadedSessionKey(null);
    setSessionLimit(SESSION_PAGE_SIZE);
  }, [dateQuery]);

  useEffect(() => {
    const sliceKey = (slice: DataSlice): string =>
      SLICE_LOADERS[slice].dateScoped ? `${dateQuery}|${reloadKey}` : `${reloadKey}`;
    const needed = [...new Set([...SHELL_SLICES, ...(ROUTE_SLICES[activeView] ?? [])])];
    const missing = needed.filter(
      (slice) => loadedSlicesRef.current.get(slice) !== sliceKey(slice),
    );
    if (missing.length === 0) {
      return;
    }
    let cancelled = false;
    Promise.all(missing.map((slice) => SLICE_LOADERS[slice].load(dateQuery)))
      .then((parts) => {
        if (cancelled) {
          return;
        }
        const merged = Object.assign({}, ...parts) as Partial<DashboardData>;
        setData((current) => ({ ...current, ...merged }));
        for (const slice of missing) {
          loadedSlicesRef.current.set(slice, sliceKey(slice));
        }
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeView, dateQuery, reloadKey]);

  useEffect(() => {
    if (!showsSessions) {
      return;
    }
    let cancelled = false;
    const plan = planSessionLoad({
      loadedRequestKey: loadedSessionKey,
      loadedRows: data.sessions.length,
      pageSize: SESSION_PAGE_SIZE,
      requestKey: sessionLoadKey,
      sessionLimit,
    });
    if (plan == null) {
      return;
    }
    setSessionsLoading(true);
    void getJson<SessionSummary[]>(
      withDateQuery(
        `/api/sessions?limit=${plan.limit}&offset=${plan.offset}&with_subagents=true`,
        dateQuery,
      ),
    )
      .then((sessions) => {
        if (cancelled) {
          return;
        }
        setData((current) => ({
          ...current,
          sessions: plan.replace ? sessions : [...current.sessions, ...sessions],
        }));
        setLoadedSessionKey(sessionLoadKey);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(errorMessage(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSessionsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    data.sessions.length,
    dateQuery,
    loadedSessionKey,
    sessionLimit,
    sessionLoadKey,
    showsSessions,
  ]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("sync", requestRefresh);
    events.addEventListener("archive_updated", requestRefresh);
    return () => {
      events.removeEventListener("sync", requestRefresh);
      events.removeEventListener("archive_updated", requestRefresh);
      events.close();
    };
  }, [requestRefresh]);

  const active = activeView;
  const activeKey = activeRouteKey(path);
  const metrics = data.summary;
  // Prefer the loaded (date-filtered) session list, matching the sidebar's
  // other stats; dateBounds is archive-wide and only a fallback for routes
  // that never load session rows, so it must never win over an in-range value.
  const lastActivity = latestSessionDay(data.sessions) ?? formatDay(data.dateBounds?.max ?? null);
  const syncInProgress = data.now?.sync_in_progress === true;
  const runSync = () => {
    if (syncInProgress) {
      return;
    }
    setError(null);
    void getJson<unknown>("/api/sync", { method: "POST", body: "{}" })
      .then(requestRefresh)
      .catch((err: unknown) => setError(errorMessage(err)));
  };

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
          <a className="brand" href="/" onClick={(event) => navigate(event, "/", setPath)}>
            <span className="brand-icon">
              <Icon name="beaker" />
            </span>
            <span>decant</span>
          </a>
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
          {navItems.map((item) => (
            <a
              aria-current={activeKey === item.key ? "page" : undefined}
              href={item.href}
              key={item.href}
              onClick={(event) => {
                setMenuOpen(false);
                navigate(event, item.href, setPath);
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-stat" title="Live and auto-syncing">
            <span className="live-dot" />
            <span>
              <strong>{formatInt(metrics?.sessions ?? 0)}</strong> sessions
            </span>
          </div>
          <div className="sidebar-stat">
            <Icon name="money" />
            <span>
              <strong>{money(metrics?.estimated_cost_usd ?? 0)}</strong> tracked
            </span>
          </div>
          {lastActivity != null ? (
            <div className="sidebar-stat">
              <Icon name="clock" />
              <span>latest {lastActivity}</span>
            </div>
          ) : null}
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
          <h1>{titleFor(active)}</h1>
          <div className="topbar-spacer" />
          <a
            className="search-shortcut"
            href="/search"
            onClick={(event) => navigate(event, "/search", setPath)}
          >
            <Icon name="search" />
            <span>Search...</span>
            <kbd>/</kbd>
          </a>
          <button
            aria-busy={syncInProgress}
            className={`secondary-button sync-button${syncInProgress ? " is-syncing" : ""}`}
            disabled={syncInProgress}
            onClick={runSync}
            type="button"
          >
            <Icon name="refresh" />
            {syncInProgress ? "Syncing" : "Sync"}
          </button>
          <a
            aria-label="Settings"
            className="icon-button"
            href="/settings"
            onClick={(event) => navigate(event, "/settings", setPath)}
            title="Settings"
          >
            <Icon name="settings" />
          </a>
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
            {error != null ? <div className="notice danger">{error}</div> : null}
            {renderView(active, path, data, {
              dateRange: dateRangeSelection,
              onDateRangeChange: (next) => {
                setSessionLimit(SESSION_PAGE_SIZE);
                setDateRangeSelection(next);
              },
              refresh: requestRefresh,
              sessionLimit,
              sessionsLoading,
              setSessionLimit,
            })}
          </div>
        </main>
      </div>
    </div>
  );
}

function renderView(
  active: string,
  path: string,
  data: DashboardData,
  actions: {
    dateRange: DateRangeSelection;
    onDateRangeChange: (range: DateRangeSelection) => void;
    refresh: () => void;
    sessionLimit: number;
    sessionsLoading: boolean;
    setSessionLimit: (limit: number) => void;
  },
) {
  const pathname = pathOnly(path);
  if (pathname.startsWith("/sessions/")) {
    return <SessionDetailView id={Number(pathname.split("/").at(-1))} />;
  }
  switch (active) {
    case "Sessions":
      return (
        <SessionsView
          data={data}
          dateRange={actions.dateRange}
          limit={actions.sessionLimit}
          loading={actions.sessionsLoading}
          onDateRangeChange={actions.onDateRangeChange}
          onLimitChange={actions.setSessionLimit}
        />
      );
    case "Projects":
      return <ProjectsView projects={data.projects} />;
    case "Search":
      return <SearchView path={path} />;
    case "Analytics":
      return (
        <AnalyticsView
          data={data}
          dateRange={actions.dateRange}
          onDateRangeChange={actions.onDateRangeChange}
        />
      );
    case "Insights":
      return (
        <InsightsView
          rows={data.recommendations}
          settingsInfo={data.settings}
          onMarked={actions.refresh}
        />
      );
    case "Tools & MCP":
      return (
        <ToolsView
          data={data}
          dateRange={actions.dateRange}
          onDateRangeChange={actions.onDateRangeChange}
        />
      );
    case "Files":
      return (
        <FilesView
          dateBounds={data.dateBounds}
          dateRange={actions.dateRange}
          onDateRangeChange={actions.onDateRangeChange}
          rows={data.files}
        />
      );
    case "Settings":
      return <SettingsView config={data.config} settingsInfo={data.settings} />;
    default:
      return (
        <SessionsView
          data={data}
          dateRange={actions.dateRange}
          limit={actions.sessionLimit}
          loading={actions.sessionsLoading}
          onDateRangeChange={actions.onDateRangeChange}
          onLimitChange={actions.setSessionLimit}
        />
      );
  }
}

function SessionsView({
  data,
  dateRange,
  limit,
  loading,
  onDateRangeChange,
  onLimitChange,
}: {
  data: DashboardData;
  dateRange: DateRangeSelection;
  limit: number;
  loading: boolean;
  onDateRangeChange: (range: DateRangeSelection) => void;
  onLimitChange: (limit: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(() => new Set());
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const total = data.summary?.sessions ?? data.sessions.length;
  const filtered = filterSessions(data.sessions, query);
  const hasMore = !loading && data.sessions.length < total;
  const waitingForSessions = shouldShowSessionSkeleton({
    isLoading: loading,
    loadedRows: data.sessions.length,
    query,
  });

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel == null || !hasMore) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting === true) {
          onLimitChange(Math.min(total, limit + SESSION_PAGE_SIZE));
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, limit, onLimitChange, total]);

  const toggleSession = (id: number) => {
    setExpandedSessions((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

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
          <p>Every Claude Code and Codex session in your local archive.</p>
        </div>
        <DateRangeControl bounds={data.dateBounds} range={dateRange} onChange={onDateRangeChange} />
      </header>

      <div className="stat-grid sessions-stat-grid">
        <StatCard
          icon="sessions"
          label="Sessions"
          tone="accent"
          value={formatInt(data.summary?.sessions ?? 0)}
        />
        <StatCard
          icon="messages"
          label="Messages"
          tone="info"
          value={formatInt(data.summary?.messages ?? 0)}
        />
        <StatCard
          icon="money"
          label="Est. cost"
          tone="success"
          value={money(data.summary?.estimated_cost_usd ?? 0)}
        />
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Sessions</h2>
          </div>
          <input
            aria-label="Filter sessions"
            className="session-filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by title, model, or tool..."
            value={query}
          />
        </div>
        <div className="table-scroll">
          <table className="data-table sessions-table">
            <colgroup>
              <col className="col-session-tool" />
              <col className="col-session-title" />
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
                <th>Model</th>
                <th>Effort</th>
                <th className="numeric">Peak ctx</th>
                <th className="numeric">Compactions</th>
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
                  <td colSpan={10}>
                    {query.trim() === ""
                      ? "No sessions ingested yet."
                      : "No sessions match that filter."}
                  </td>
                </tr>
              ) : null}
              {!waitingForSessions ? filtered.flatMap((session) => renderRows(session)) : null}
            </tbody>
          </table>
        </div>
        <div className="panel-footer">
          <span>
            {sessionsCaption(query, filtered.length, data.sessions.length, total, loading)}
          </span>
          <div aria-hidden="true" className="infinite-sentinel" ref={sentinelRef} />
        </div>
      </section>
    </div>
  );
}

function SessionTableSkeletonRows() {
  return SESSION_TABLE_SKELETON_KEYS.map((key) => (
    <tr className="session-row-skeleton" key={key}>
      <td>
        <span className="skeleton-line table-skeleton-line tool" />
      </td>
      <td>
        <span className="skeleton-line table-skeleton-line title" />
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

function ProjectsView({ projects }: { projects: ProjectSummary[] }) {
  const sorted = projects
    .slice()
    .sort(
      (left, right) =>
        Number(left.is_worktree) - Number(right.is_worktree) ||
        right.sessions - left.sessions ||
        right.estimated_cost_usd - left.estimated_cost_usd ||
        left.path.localeCompare(right.path),
    );
  const worktrees = projects.filter((project) => project.is_worktree);
  const activitySources = new Set(projects.flatMap((project) => project.session_tools));

  return (
    <div className="view-stack">
      <header className="page-heading">
        <h1>Projects</h1>
        <p>Project roots, worktrees, source tools, and local session activity.</p>
      </header>

      <div className="stat-grid projects-stat-grid">
        <StatCard
          icon="folder"
          label="Projects"
          tone="accent"
          value={formatInt(projects.filter((project) => !project.is_worktree).length)}
        />
        <StatCard icon="folder" label="Worktrees" tone="info" value={formatInt(worktrees.length)} />
        <StatCard
          icon="tools"
          label="Activity sources"
          tone="success"
          value={formatInt(activitySources.size)}
        />
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Projects and worktrees</h2>
            <p>Worktree source comes from Git pointers, known layouts, or root name matching.</p>
          </div>
        </div>
        {sorted.length === 0 ? (
          <EmptyState
            icon="folder"
            message="Projects appear after sessions are synced."
            title="No projects"
          />
        ) : (
          <div className="table-scroll">
            <table className="data-table projects-table">
              <colgroup>
                <col className="col-project-path" />
                <col className="col-project-kind" />
                <col className="col-project-source" />
                <col className="col-project-root" />
                <col className="col-number" />
                <col className="col-number" />
                <col className="col-project-date" />
              </colgroup>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Root</th>
                  <th className="numeric">Sessions</th>
                  <th className="numeric">Cost</th>
                  <th className="numeric">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((project) => (
                  <tr key={project.id}>
                    <td className="truncate-cell" title={project.path}>
                      <span className="path-stack">
                        <strong>{projectName(project)}</strong>
                        <small>{project.path}</small>
                      </span>
                    </td>
                    <td>
                      <ProjectKind project={project} />
                    </td>
                    <td>
                      <ProjectSource project={project} />
                    </td>
                    <td className="truncate-cell" title={project.root_path ?? project.path}>
                      {project.is_worktree ? (
                        <span className="path-stack is-compact">
                          <strong>{basename(project.root_path)}</strong>
                          <small>{project.root_path ?? "-"}</small>
                        </span>
                      ) : project.worktree_count > 0 ? (
                        <span className="worktree-count">
                          {formatInt(project.worktree_count)}{" "}
                          {project.worktree_count === 1 ? "worktree" : "worktrees"}
                        </span>
                      ) : (
                        <span className="faint">-</span>
                      )}
                    </td>
                    <td className="numeric muted">{formatInt(project.sessions)}</td>
                    <td className="numeric">{money(project.estimated_cost_usd)}</td>
                    <td className="numeric muted">{relativeTime(project.last_seen_at)}</td>
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

function ProjectKind({ project }: { project: ProjectSummary }) {
  if (project.is_worktree) {
    return <Badge tone="info">worktree</Badge>;
  }
  return <Badge tone="neutral">project</Badge>;
}

function ProjectSource({ project }: { project: ProjectSummary }) {
  if (project.is_worktree) {
    return (
      <span className="source-stack">
        <Badge tone="accent">{worktreeToolLabel(project.worktree_tool)}</Badge>
        <small>{rootSourceLabel(project.root_source)}</small>
      </span>
    );
  }
  if (project.session_tools.length === 0) {
    return <span className="faint">-</span>;
  }
  return (
    <span className="source-badges">
      {project.session_tools.map((tool) => (
        <ToolBadge key={tool} tool={tool} />
      ))}
    </span>
  );
}

function projectName(project: ProjectSummary): string {
  if (!project.is_worktree) {
    return project.name ?? basename(project.path);
  }
  const label = project.worktree_label ?? basename(project.path);
  return label === "wt" ? "worktree" : label;
}

function worktreeToolLabel(value: string | null): string {
  switch (value) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "conductor":
      return "Conductor";
    case "git":
      return "Git";
    case "t3":
      return "T3";
    case "warp":
      return "Warp";
    case null:
      return "Worktree";
    default:
      return capitalize(value);
  }
}

function rootSourceLabel(value: string | null): string {
  switch (value) {
    case "git":
      return "Git worktree pointer";
    case "intree":
      return "In-project worktrees folder";
    case "namematch":
      return "Matched to project root";
    case "self":
      return "Project root";
    case "synthetic":
      return "Inferred root";
    case null:
      return "Unknown source";
    default:
      return capitalize(value);
  }
}

function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return sessions;
  }
  return sessions.filter((session) => sessionMatchesQuery(session, needle));
}

function sessionMatchesQuery(session: SessionSummary, needle: string): boolean {
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

function sessionsCaption(
  query: string,
  visible: number,
  loaded: number,
  total: number,
  loading: boolean,
): string {
  if (loading && query.trim() === "") {
    if (loaded === 0) {
      return total > 0 ? `Loading ${formatInt(total)} sessions...` : "Loading sessions...";
    }
    return loaded < total
      ? `Refreshing ${formatInt(loaded)} of ${formatInt(total)} sessions`
      : `Refreshing ${formatInt(loaded)} sessions`;
  }
  if (query.trim() !== "") {
    return `Showing ${formatInt(visible)} matching ${visible === 1 ? "row" : "rows"} from ${formatInt(loaded)} available sessions`;
  }
  return `Showing ${formatInt(loaded)} of ${formatInt(total)} sessions`;
}

function SessionTableRow({
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
          <a href={`/sessions/${session.id}`}>{title}</a>
          {isSubagent ? <small>{subagentDescriptor(session)}</small> : null}
        </span>
      </td>
      <td>
        <ModelBadge model={session.model} />
      </td>
      <td>
        <EffortBadge effort={session.reasoning_effort} levels={session.reasoning_effort_levels} />
      </td>
      <td className="numeric">
        <SessionContextPeak session={session} />
      </td>
      <td className="numeric muted">{formatInt(session.compaction_count)}</td>
      <td className="numeric">
        <SubagentRollup session={session} />
      </td>
      <td className="numeric muted">{formatInt(session.message_count)}</td>
      <td className="numeric">{money(threadCost(session))}</td>
      <td className="numeric muted">
        <SessionStartedAt value={session.started_at} />
      </td>
    </tr>
  );
}

function SessionStartedAt({ value }: { value: string | null }) {
  const compact = compactDateTime(value);
  if (compact == null || value == null) {
    return <span>-</span>;
  }
  return (
    <time dateTime={value} title={fullDateTime(value) ?? compact}>
      {compact}
    </time>
  );
}

function SessionContextPeak({ session }: { session: SessionSummary }) {
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

function SubagentRollup({ session }: { session: SessionSummary }) {
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

function sessionDisplayTitle(session: SessionSummary): string {
  return cleanSessionTitle(session.title) ?? session.source_session_id ?? "(untitled)";
}

function cleanSessionTitle(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  const text = stripAnsi(value).trim();
  if (isPermissionsText(text)) {
    return "Execution permissions";
  }
  if (/^<local-command-caveat>/i.test(text)) {
    return "Command context";
  }
  if (/^<local-command-std(?:out|err)>/i.test(text) || /^<local-command-output>/i.test(text)) {
    return "Command output";
  }
  if (/^<command-name>/i.test(text)) {
    return "Command context";
  }
  if (/^<teammate-message\b/i.test(text)) {
    return tagAttribute(text, "summary") ?? "Subagent request";
  }
  if (/^<environment_context>/i.test(text)) {
    return "Environment context";
  }
  const withoutMarkup = stripMarkupTags(text);
  if (withoutMarkup !== text && withoutMarkup !== "") {
    return firstLine(withoutMarkup.replace(/^Caveat:\s*/i, ""), 96);
  }
  const tag = text.match(/^<([a-z][a-z0-9_-]*)\b[^>]*>/i);
  if (tag == null) {
    return text;
  }
  const remainder = text.slice(tag[0].length).trim();
  if (remainder !== "" && !remainder.startsWith("<")) {
    return firstLine(remainder.replace(/^Caveat:\s*/i, ""), 96);
  }
  return readableTagLabel(tag[1] ?? "");
}

function stripMarkupTags(value: string): string {
  return value
    .replace(/<\/?[a-z][a-z0-9_-]*\b[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAnsi(value: string): string {
  const pattern = `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`;
  return value.replace(new RegExp(pattern, "g"), "");
}

function isPermissionsText(value: string): boolean {
  return (
    /^<permissions instructions>/i.test(value) || value.includes("Filesystem sandboxing defines")
  );
}

function tagAttribute(value: string, name: string): string | null {
  const pattern = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = value.match(pattern);
  return match == null ? null : (match[1] ?? match[2] ?? match[3] ?? null);
}

function readableTagLabel(tag: string): string {
  switch (tag.toLowerCase()) {
    case "environment_context":
      return "Environment context";
    case "permissions":
    case "permissions-instructions":
    case "permissions_instructions":
      return "Execution permissions";
    default:
      return "Agent context";
  }
}

function subagentDescriptor(session: SessionSummary): string {
  const kind = session.agent_type ?? "subagent";
  return session.agent_id != null ? `${kind} · ${session.agent_id}` : kind;
}

function SearchView({ path }: { path: string }) {
  const initialQuery = new URLSearchParams(path.split("?")[1] ?? "").get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = () => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setHits([]);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    void getJson<SearchHit[]>("/api/search", {
      method: "POST",
      body: JSON.stringify({ query: trimmed, limit: 25 }),
    })
      .then(setHits)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSearching(false));
  };

  useEffect(() => {
    setQuery(initialQuery);
    if (initialQuery.trim() === "") {
      setHits([]);
      return;
    }
    setSearching(true);
    setError(null);
    void getJson<SearchHit[]>("/api/search", {
      method: "POST",
      body: JSON.stringify({ query: initialQuery, limit: 25 }),
    })
      .then(setHits)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSearching(false));
  }, [initialQuery]);

  return (
    <div className="search-page">
      <header className="page-heading">
        <h1>Search</h1>
        <p>Full-text search across every message and tool call in your archive.</p>
      </header>

      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <Icon name="search" />
        <input
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search across all sessions and tool calls..."
          value={query}
        />
      </form>

      {query.trim() !== "" ? (
        <p className="result-caption">
          {formatInt(hits.length)} {hits.length === 1 ? "result" : "results"}
        </p>
      ) : null}
      {error != null ? <div className="notice danger">{error}</div> : null}

      <div className="search-results">
        {searching ? <div className="empty-state">Searching...</div> : null}
        {!searching && query.trim() === "" ? (
          <EmptyState
            icon="search"
            message="Find any message or tool call across every session by keyword."
            title="Search your archive"
          />
        ) : null}
        {!searching && query.trim() !== "" && hits.length === 0 ? (
          <EmptyState
            icon="inbox"
            message="Nothing matched your search. Try a different term."
            title="No matches"
          />
        ) : null}
        {hits.map((hit) => (
          <a
            className="result-card"
            href={`/sessions/${hit.session_id}`}
            key={`${hit.session_id}-${hit.snippet}`}
          >
            <div className="result-card-heading">
              <span>{hit.session_title ?? `Session ${hit.session_id}`}</span>
            </div>
            <p>
              <HighlightedSnippet snippet={hit.snippet} />
            </p>
          </a>
        ))}
      </div>
    </div>
  );
}

function HighlightedSnippet({ snippet }: { snippet: string }) {
  return (
    <>
      {snippetParts(snippet).map((part) =>
        part.match ? (
          <mark key={part.key}>{part.text}</mark>
        ) : (
          <span key={part.key}>{part.text}</span>
        ),
      )}
    </>
  );
}

type SortDirection = "asc" | "desc";
type SortValue = number | string | null | undefined;
type SortState<Key extends string> = { direction: SortDirection; key: Key };
type ModelSortKey =
  | "cost"
  | "input_tokens"
  | "key"
  | "output_tokens"
  | "reasoning_tokens"
  | "sessions";
type ProjectSortKey = "cost" | "key" | "sessions";
type McpSortKey = "calls" | "errors" | "server" | "tools";
type ToolSortKey = "calls" | "errors" | "kind" | "server" | "tool";
type FileSortKey =
  | "deletes"
  | "edits"
  | "key"
  | "last_touched_at"
  | "project"
  | "reads"
  | "sessions"
  | "total"
  | "writes";

function nextSort<Key extends string>(sort: SortState<Key>, key: Key): SortState<Key> {
  return {
    key,
    direction: sort.key === key && sort.direction === "desc" ? "asc" : "desc",
  };
}

function sortRows<Row, Key extends string>(
  rows: Row[],
  sort: SortState<Key>,
  valueFor: (row: Row, key: Key) => SortValue,
): Row[] {
  return rows
    .slice()
    .sort((left, right) =>
      compareSortValue(valueFor(left, sort.key), valueFor(right, sort.key), sort.direction),
    );
}

function compareSortValue(left: SortValue, right: SortValue, direction: SortDirection): number {
  const multiplier = direction === "asc" ? 1 : -1;
  if (typeof left === "number" || typeof right === "number") {
    return multiplier * ((Number(left) || 0) - (Number(right) || 0));
  }
  return (
    multiplier * String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true })
  );
}

function modelSortValue(row: DimensionRow, key: ModelSortKey): SortValue {
  switch (key) {
    case "cost":
      return row.estimated_cost_usd;
    case "input_tokens":
      return row.input_tokens;
    case "key":
      return row.key;
    case "output_tokens":
      return row.output_tokens;
    case "reasoning_tokens":
      return row.reasoning_tokens || row.est_reasoning_tokens;
    case "sessions":
      return row.sessions;
  }
}

function projectSortValue(row: DimensionRow, key: ProjectSortKey): SortValue {
  switch (key) {
    case "cost":
      return row.estimated_cost_usd;
    case "key":
      return row.key;
    case "sessions":
      return row.sessions;
  }
}

function mcpSortValue(row: McpRow, key: McpSortKey): SortValue {
  switch (key) {
    case "calls":
      return row.calls;
    case "errors":
      return row.errors;
    case "server":
      return row.mcp_server;
    case "tools":
      return row.tools;
  }
}

function toolSortValue(row: ToolRow, key: ToolSortKey): SortValue {
  switch (key) {
    case "calls":
      return row.calls;
    case "errors":
      return row.errors;
    case "kind":
      return row.tool_kind;
    case "server":
      return row.mcp_server;
    case "tool":
      return row.tool_name;
  }
}

function fileSortValue(row: FileRow, key: FileSortKey): SortValue {
  switch (key) {
    case "deletes":
      return row.deletes;
    case "edits":
      return row.edits;
    case "key":
      return row.key;
    case "last_touched_at":
      return row.last_touched_at == null ? 0 : Date.parse(row.last_touched_at);
    case "project":
      return row.project;
    case "reads":
      return row.reads;
    case "sessions":
      return row.sessions;
    case "total":
      return fileTotal(row);
    case "writes":
      return row.writes;
  }
}

function AnalyticsView({
  data,
  dateRange,
  onDateRangeChange,
}: {
  data: DashboardData;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
}) {
  const [modelSort, setModelSort] = useState<SortState<ModelSortKey>>({
    key: "cost",
    direction: "desc",
  });
  const [projectSort, setProjectSort] = useState<SortState<ProjectSortKey>>({
    key: "cost",
    direction: "desc",
  });
  const byDay = data.byDay
    .filter((row) => row.key !== "")
    .slice()
    .sort((left, right) => left.key.localeCompare(right.key));
  const modelRows = useMemo(
    () => sortRows(data.byModel, modelSort, modelSortValue),
    [data.byModel, modelSort],
  );
  const projectRows = useMemo(
    () => sortRows(data.byProject, projectSort, projectSortValue).slice(0, 12),
    [data.byProject, projectSort],
  );
  const maxModelCost = Math.max(1.0e-9, ...modelRows.map((row) => row.estimated_cost_usd));
  return (
    <div className="view-stack">
      <header className="page-heading inline-heading">
        <div>
          <h1>Analytics</h1>
          <p>Usage and cost across your sessions.</p>
        </div>
        <DateRangeControl bounds={data.dateBounds} range={dateRange} onChange={onDateRangeChange} />
      </header>

      <div className="stat-grid analytics-stat-grid">
        <StatCard
          icon="sessions"
          label="Sessions"
          tone="accent"
          value={formatInt(data.summary?.sessions ?? 0)}
        />
        <StatCard
          icon="messages"
          label="Messages"
          tone="info"
          value={formatInt(data.summary?.messages ?? 0)}
        />
        <StatCard
          icon="bolt"
          label="Tool calls"
          tone="warning"
          value={formatInt(data.summary?.tool_calls ?? 0)}
        />
        <StatCard
          icon="download"
          label="Input tokens"
          tone="neutral"
          value={compact(data.summary?.input_tokens ?? 0)}
        />
        <StatCard
          icon="upload"
          label="Output tokens"
          tone="neutral"
          value={compact(data.summary?.output_tokens ?? 0)}
        />
        <StatCard
          icon="money"
          label="Est. cost"
          tone="success"
          value={money(data.summary?.estimated_cost_usd ?? 0)}
        />
      </div>

      <TokenEconomicsPanel economics={data.tokenEconomics} />

      <div className="split">
        <DailyPanel rows={byDay} metric="sessions" title="Sessions per day" />
        <DailyPanel rows={byDay} metric="cost" title="Cost per day" />
      </div>

      <div className="split">
        <ActivityPanel activity={data.activity} />
        <WeekdayPanel activity={data.activity} />
      </div>

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
                      {basename(row.key)}
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

function ActivityPanel({ activity }: { activity: Activity | null }) {
  const labels = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));
  const peak = activity?.peak_hour ?? peakIndex(activity?.by_hour ?? []);
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
      </div>
      <div className="panel-body chart-panel-body">
        <AnalyticsChart
          labels={labels}
          metric="int"
          values={activity?.by_hour ?? []}
          variant="bar"
        />
      </div>
    </section>
  );
}

function TokenEconomicsPanel({
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

type TooltipTriggerProps = {
  ref: (node: HTMLElement | null) => void;
  onBlur: () => void;
  onFocus: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  tabIndex: number;
  "aria-describedby"?: string;
};

function Tooltip({
  children,
  content,
}: {
  children: (props: TooltipTriggerProps) => ReactNode;
  content: ReactNode;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openTooltip = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const closeTooltip = () => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => setOpen(false), 80);
  };

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (trigger == null) {
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    const width = tooltipRect?.width ?? 320;
    const height = tooltipRect?.height ?? 44;
    const padding = 12;
    const maxLeft = Math.max(padding, window.innerWidth - width - padding);
    const left = clampNumber(
      triggerRect.left + triggerRect.width / 2 - width / 2,
      padding,
      maxLeft,
    );
    let top = triggerRect.top - height - 8;
    if (top < padding) {
      top = triggerRect.bottom + 8;
    }
    top = clampNumber(top, padding, Math.max(padding, window.innerHeight - height - padding));
    setPosition((current) =>
      current != null && current.left === left && current.top === top ? current : { left, top },
    );
  }, []);

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
    }
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const onScrollOrResize = () => updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (triggerRef.current?.contains(target) === true || tooltipRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, updatePosition]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    [clearCloseTimer],
  );

  const triggerProps: TooltipTriggerProps = {
    ref: (node) => {
      triggerRef.current = node;
    },
    onBlur: closeTooltip,
    onFocus: openTooltip,
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    },
    onMouseEnter: openTooltip,
    onMouseLeave: closeTooltip,
    tabIndex: 0,
    "aria-describedby": open ? id : undefined,
  };

  return (
    <>
      {children(triggerProps)}
      {open
        ? createPortal(
            <div
              className="floating-tooltip"
              id={id}
              onMouseEnter={openTooltip}
              onMouseLeave={closeTooltip}
              ref={tooltipRef}
              role="tooltip"
              style={
                position == null
                  ? { left: 0, top: 0, visibility: "hidden" }
                  : { left: position.left, top: position.top }
              }
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function WeekdayPanel({ activity }: { activity: Activity | null }) {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const peak = activity?.peak_weekday ?? peakIndex(activity?.by_weekday ?? []);
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Busiest days</h2>
          <p>{peak == null ? "Sessions by weekday" : `You ship most on ${weekdayLabel(peak)}`}</p>
        </div>
      </div>
      <div className="panel-body chart-panel-body">
        <AnalyticsChart
          labels={labels}
          metric="int"
          values={activity?.by_weekday ?? []}
          variant="bar"
        />
      </div>
    </section>
  );
}

function DailyPanel({
  rows,
  metric,
  title,
}: {
  rows: DimensionRow[];
  metric: "sessions" | "cost";
  title: string;
}) {
  const values = rows.map((row) => (metric === "sessions" ? row.sessions : row.estimated_cost_usd));
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
        </div>
      </div>
      <div className="panel-body">
        {rows.length === 0 ? (
          <EmptyState icon="chart" message="Widen the date range." title="No data in range" />
        ) : (
          <AnalyticsChart
            labels={rows.map((row) => row.key)}
            metric={metric === "cost" ? "money" : "int"}
            values={values}
            variant={metric === "cost" ? "line" : "bar"}
          />
        )}
      </div>
    </section>
  );
}

function AnalyticsChart({
  labels,
  metric,
  values,
  variant,
}: {
  labels: string[];
  metric: AnalyticsChartMetric;
  values: number[];
  variant: AnalyticsChartVariant;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);
  const lastDrawnKeyRef = useRef<string | null>(null);
  const chartState = prepareAnalyticsChartState({ labels, metric, values, variant });
  const chartStateRef = useRef<AnalyticsChartState>(chartState);
  chartStateRef.current = chartState;

  useEffect(() => {
    const element = chartRef.current;
    if (element == null) {
      return;
    }
    const chart = echarts.init(element, null, { renderer: "canvas" });
    chartInstanceRef.current = chart;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const draw = (force = false) => {
      const current = chartStateRef.current;
      if (!force && lastDrawnKeyRef.current === current.key) {
        return;
      }
      chart.setOption(buildChartOption(current), true);
      lastDrawnKeyRef.current = current.key;
      chart.resize();
    };
    const resize = () => chart.resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener("resize", resize);
    const redrawForTheme = () => draw(true);
    window.addEventListener("decant:set-theme", redrawForTheme);
    media.addEventListener("change", redrawForTheme);
    draw();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("decant:set-theme", redrawForTheme);
      media.removeEventListener("change", redrawForTheme);
      chart.dispose();
      chartInstanceRef.current = null;
      lastDrawnKeyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartInstanceRef.current;
    const current = chartStateRef.current;
    if (chart == null || lastDrawnKeyRef.current === chartState.key) {
      return;
    }
    chart.setOption(buildChartOption(current), true);
    lastDrawnKeyRef.current = chartState.key;
    chart.resize();
  }, [chartState.key]);

  return <div aria-label="Analytics chart" className="analytics-chart" ref={chartRef} role="img" />;
}

function buildChartOption({
  labels,
  metric,
  values,
  variant,
}: {
  labels: string[];
  metric: AnalyticsChartMetric;
  values: number[];
  variant: AnalyticsChartVariant;
}): echarts.EChartsOption {
  const colors = chartColors();
  const moneyMetric = metric === "money";
  const seriesType = variant;
  return {
    color: [colors.accent, colors.info, colors.success, colors.warning],
    textStyle: { fontFamily: "inherit", color: colors.muted },
    animationDuration: 180,
    grid: { left: 6, right: 16, top: 18, bottom: 6, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: colors.surface,
      borderColor: colors.line,
      borderWidth: 1,
      padding: [8, 12],
      textStyle: { color: colors.fg, fontSize: 12 },
      axisPointer: {
        type: seriesType === "bar" ? "shadow" : "line",
        lineStyle: { color: colors.faint, width: 1 },
        shadowStyle: { color: `${colors.fg}0d` },
      },
      valueFormatter: (value) =>
        moneyMetric ? money(Number(value ?? 0)) : formatInt(Number(value ?? 0)),
    },
    xAxis: {
      type: "category",
      data: labels,
      boundaryGap: seriesType !== "line",
      axisLine: { lineStyle: { color: colors.line } },
      axisTick: { show: false },
      axisLabel: {
        color: colors.faint,
        fontSize: 11,
        hideOverlap: true,
        formatter: (value: string) => chartLabel(value),
      },
    },
    yAxis: {
      type: "value",
      axisLabel: {
        color: colors.faint,
        fontSize: 11,
        formatter: (value: number) => chartValue(value, metric),
      },
      splitLine: { lineStyle: { color: colors.line, type: "dashed" } },
    },
    series: [
      {
        name: moneyMetric ? "cost" : "sessions",
        type: seriesType,
        data: values,
        smooth: seriesType === "line",
        showSymbol: false,
        barMaxWidth: 26,
        itemStyle: { borderRadius: seriesType === "bar" ? [3, 3, 0, 0] : 0 },
        lineStyle: { width: 2 },
        areaStyle: seriesType === "line" ? { opacity: 0.1 } : undefined,
      },
    ],
  };
}

function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string) => styles.getPropertyValue(name).trim();
  return {
    fg: value("--fg"),
    muted: value("--muted"),
    faint: value("--faint"),
    line: value("--line"),
    surface: value("--surface"),
    accent: value("--accent"),
    info: value("--info"),
    success: value("--success"),
    warning: value("--warning"),
  };
}

function Sparkline({ tone = "accent", values }: { tone?: BadgeTone; values: number[] }) {
  const points = sparkPoints(values);
  if (points == null) {
    return <span className="spark-empty">-</span>;
  }
  return (
    <svg
      aria-hidden="true"
      className={`sparkline tone-${tone}`}
      preserveAspectRatio="none"
      viewBox="0 0 100 24"
    >
      <polyline points={points} />
    </svg>
  );
}

function sparkPoints(values: number[]): string | null {
  const cleanValues = values.map((value) => Math.max(0, value));
  if (cleanValues.length < 2) {
    return null;
  }
  const max = Math.max(1, ...cleanValues);
  return cleanValues
    .map((value, index) => {
      const x = (index / (cleanValues.length - 1)) * 100;
      const y = 23 - (value / max) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function hourLabel(hour: number): string {
  if (hour === 0) {
    return "12a";
  }
  if (hour === 12) {
    return "12p";
  }
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

function weekdayLabel(day: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day] ?? String(day);
}

function peakIndex(values: number[]): number | null {
  const max = Math.max(0, ...values);
  return max > 0 ? values.indexOf(max) : null;
}

function chartLabel(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(5, 10) : value;
}

function chartValue(value: number, metric: AnalyticsChartMetric): string {
  const formatted = compactAxis(value);
  return metric === "money" ? `$${formatted}` : formatted;
}

function activityLabel(bucket: ActivityBucket): string {
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

function activityDescription(bucket: ActivityBucket): string {
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

function activityTone(bucket: ActivityBucket): BadgeTone {
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

function compactAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${trimNumber(value / 1_000_000)}M`;
  }
  if (abs >= 1_000) {
    return `${trimNumber(value / 1_000)}K`;
  }
  return trimNumber(value);
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? formatInt(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "claude"
  | "openai";

type BrandIconName = "anthropic" | "claude" | "openai";

type IconName =
  | "arrowLeft"
  | "beaker"
  | "bolt"
  | "chart"
  | "check"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "chevronUp"
  | "clock"
  | "cpu"
  | "desktop"
  | "download"
  | "file"
  | "folder"
  | "info"
  | "inbox"
  | "lightbulb"
  | "menu"
  | "messages"
  | "minus"
  | "money"
  | "moon"
  | "plus"
  | "refresh"
  | "search"
  | "sessions"
  | "settings"
  | "shield"
  | "sun"
  | "tools"
  | "upload"
  | "x";

function StatCard({
  icon,
  label,
  tone,
  value,
}: {
  icon: IconName;
  label: string;
  tone: BadgeTone;
  value: string;
}) {
  return (
    <div className="stat-card">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <span className={`stat-icon tone-${tone}`}>
        <Icon name={icon} />
      </span>
    </div>
  );
}

function Badge({
  children,
  className,
  mono = false,
  title,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  mono?: boolean;
  title?: string;
  tone?: BadgeTone;
}) {
  return (
    <span
      className={`badge tone-${tone}${mono ? " is-mono" : ""}${className ? ` ${className}` : ""}`}
      title={title}
    >
      {children}
    </span>
  );
}

function ToolBadge({ tool }: { tool: string | null | undefined }) {
  if (tool === "claude_code") {
    return (
      <Badge tone="claude">
        <BrandMark name="claude" />
        Claude
      </Badge>
    );
  }
  if (tool === "codex") {
    return (
      <Badge tone="openai">
        <BrandMark name="openai" />
        Codex
      </Badge>
    );
  }
  return <Badge>{tool ?? "-"}</Badge>;
}

function ModelBadge({ model }: { model: string | null | undefined }) {
  const label = displayModelLabel(model);
  if (label == null) {
    return <span className="faint">-</span>;
  }
  const tone = brandTone(label);
  const icon = modelBrandIcon(label, tone);
  return (
    <Badge mono tone={tone}>
      {icon == null ? null : <BrandMark name={icon} />}
      {label}
    </Badge>
  );
}

function EffortBadge({
  effort,
  labeled = false,
  levels = [],
}: {
  effort: string | null | undefined;
  labeled?: boolean;
  levels?: string[];
}) {
  const label = effort?.trim().toLowerCase();
  if (label == null || label === "") {
    return <span className="faint">-</span>;
  }
  return (
    <Badge mono title={effortTooltip(label, levels)} tone={label === "mixed" ? "warning" : "info"}>
      {labeled ? `effort ${label}` : label}
    </Badge>
  );
}

function displayModelLabel(model: string | null | undefined): string | null {
  if (model == null) {
    return null;
  }
  const trimmed = model.trim();
  if (trimmed === "") {
    return null;
  }
  const tagOnly = trimmed.match(/^<([a-z][a-z0-9_-]*)>$/i);
  if (tagOnly != null) {
    return capitalize((tagOnly[1] ?? "").replace(/[-_]+/g, " "));
  }
  const stripped = stripMarkupTags(trimmed);
  return stripped === "" ? null : stripped;
}

function EmptyState({ icon, message, title }: { icon: IconName; message: string; title: string }) {
  return (
    <div className="empty-state">
      <span>
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{message}</p>
    </div>
  );
}

function Bar({ fraction, tone }: { fraction: number; tone: BadgeTone }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)) * 100;
  return (
    <div className="bar">
      <span className={`tone-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function DateRangeControl({
  bounds,
  range,
  onChange,
}: {
  bounds: DateBounds | null;
  range: DateRangeSelection;
  onChange: (range: DateRangeSelection) => void;
}) {
  return (
    <div className="date-range-control">
      <div className="date-range-buttons">
        {range.from != null && range.to != null ? (
          <button
            aria-label="Previous period"
            className="icon-period-button"
            onClick={() => onChange(shiftDateRange(range, -1))}
            type="button"
          >
            <Icon name="chevronLeft" />
          </button>
        ) : null}
        {RANGE_PRESETS.map((preset) => (
          <button
            aria-pressed={range.preset === preset.key}
            key={preset.key}
            onClick={() => onChange(applyDatePreset(preset.key, bounds))}
            type="button"
          >
            {preset.label}
          </button>
        ))}
        <button
          aria-pressed={range.preset === "all"}
          onClick={() => onChange(ALL_DATE_RANGE)}
          type="button"
        >
          All
        </button>
        {range.from != null && range.to != null ? (
          <button
            aria-label="Next period"
            className="icon-period-button"
            onClick={() => onChange(shiftDateRange(range, 1))}
            type="button"
          >
            <Icon name="chevronRight" />
          </button>
        ) : null}
      </div>
      <span>{dateRangeLabel(range)}</span>
    </div>
  );
}

function SortableHeader<Key extends string>({
  align = "left",
  label,
  onSort,
  sort,
  sortKey,
}: {
  align?: "left" | "right";
  label: string;
  onSort: (key: Key) => void;
  sort: SortState<Key>;
  sortKey: Key;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={align === "right" ? "numeric" : undefined}
    >
      <button
        className={`sort-header${align === "right" ? " is-right" : ""}${active ? " is-active" : ""}`}
        onClick={() => onSort(sortKey)}
        type="button"
      >
        <span>{label}</span>
        <Icon name={active && sort.direction === "asc" ? "chevronUp" : "chevronDown"} />
      </button>
    </th>
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
        <h3>{row.title}</h3>
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
  return (
    <div className="signal-row">
      <span className={`signal-rail tone-${toneName(row.tone)}`} />
      <span className={`signal-icon tone-${toneName(row.tone)}`}>
        <Icon name={recommendationIcon(row)} />
      </span>
      <div>
        <p>{row.title}</p>
        {row.detail != null ? <small>{row.detail}</small> : null}
        <PromotionMeta row={row} />
      </div>
      <RecommendationActions
        canLaunch={canLaunch}
        compact
        onComplete={onComplete}
        pending={pending}
        row={row}
      />
    </div>
  );
}

function RecommendationCard({
  canLaunch,
  featured,
  onComplete,
  pending,
  row,
}: {
  canLaunch: boolean;
  featured: boolean;
  onComplete: (row: Recommendation) => void;
  pending: string | null;
  row: Recommendation;
}) {
  return (
    <article className={`catalog-card${featured ? " is-featured" : ""}`}>
      <div>
        <span className={`signal-icon tone-${toneName(row.tone)}`}>
          <Icon name={recommendationIcon(row)} />
        </span>
        <h4>{row.title}</h4>
      </div>
      {row.detail != null ? <p>{row.detail}</p> : null}
      <PromotionPanel compact row={row} />
      <RecommendationActions
        canLaunch={canLaunch}
        onComplete={onComplete}
        pending={pending}
        row={row}
      />
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
          <Icon name={canLaunch ? "bolt" : "check"} />
          {pending === row.key
            ? "Saving"
            : compact
              ? "Run"
              : canLaunch
                ? "Run"
                : "Copy setup prompt"}
        </button>
      ) : null}
      {row.url != null ? (
        <a href={row.url} rel="noreferrer" target="_blank">
          {row.link_label ?? "Docs"}
        </a>
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

function PromotionMeta({ row }: { row: Recommendation }) {
  if (!hasPromotion(row)) {
    return null;
  }
  return (
    <div className="promotion-meta">
      {row.memory_layer != null ? <span>{row.memory_layer}</span> : null}
      {row.promotion_target != null ? <span>{row.promotion_target}</span> : null}
    </div>
  );
}

function Icon({ name }: { name: IconName }) {
  const Component = iconComponent(name);
  return <Component aria-hidden="true" focusable="false" strokeWidth={2} />;
}

function BrandMark({ name }: { name: BrandIconName }) {
  return (
    <svg aria-hidden="true" className="brand-mark" focusable="false" viewBox="0 0 24 24">
      <path d={brandIconPath(name)} />
    </svg>
  );
}

function iconComponent(name: IconName): LucideIcon {
  switch (name) {
    case "arrowLeft":
      return ArrowLeft;
    case "beaker":
      return FlaskConical;
    case "bolt":
      return Zap;
    case "chart":
      return BarChart3;
    case "check":
      return Check;
    case "chevronDown":
      return ChevronDown;
    case "chevronLeft":
      return ChevronLeft;
    case "chevronRight":
      return ChevronRight;
    case "chevronUp":
      return ChevronUp;
    case "clock":
      return Clock3;
    case "cpu":
      return Cpu;
    case "desktop":
      return Monitor;
    case "download":
      return Download;
    case "file":
      return FileText;
    case "folder":
      return Folder;
    case "info":
      return Info;
    case "inbox":
      return Inbox;
    case "lightbulb":
      return Lightbulb;
    case "menu":
      return Menu;
    case "messages":
      return MessageSquare;
    case "minus":
      return Minus;
    case "money":
      return CircleDollarSign;
    case "moon":
      return Moon;
    case "plus":
      return Plus;
    case "refresh":
      return RefreshCw;
    case "search":
      return Search;
    case "sessions":
      return Rows3;
    case "settings":
      return Settings;
    case "shield":
      return ShieldCheck;
    case "sun":
      return Sun;
    case "tools":
      return Wrench;
    case "upload":
      return Upload;
    case "x":
      return X;
  }
}

function brandIconPath(name: BrandIconName): string {
  switch (name) {
    case "anthropic":
      return ANTHROPIC_ICON_PATH;
    case "claude":
      return CLAUDE_ICON_PATH;
    case "openai":
      return OPENAI_ICON_PATH;
  }
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

function field(label: string, value: string | null): string | null {
  return isPresent(value) ? `${label}: ${value}` : null;
}

function modelBrandIcon(model: string, tone: BadgeTone): BrandIconName | null {
  if (tone === "openai") {
    return "openai";
  }
  if (tone === "claude") {
    return model.toLowerCase().includes("anthropic") && !model.toLowerCase().includes("claude")
      ? "anthropic"
      : "claude";
  }
  return null;
}

function brandTone(model: string | null | undefined): BadgeTone {
  const normalized = (model ?? "").toLowerCase();
  if (
    normalized.includes("claude") ||
    normalized.includes("anthropic") ||
    normalized.includes("opus") ||
    normalized.includes("sonnet") ||
    normalized.includes("haiku")
  ) {
    return "claude";
  }
  if (
    normalized.includes("gpt") ||
    normalized.includes("openai") ||
    normalized.includes("codex") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3")
  ) {
    return "openai";
  }
  return "neutral";
}

function toneName(tone: string | null | undefined): BadgeTone {
  return tone === "success" ||
    tone === "warning" ||
    tone === "danger" ||
    tone === "info" ||
    tone === "accent"
    ? tone
    : "neutral";
}

function fileTotal(row: FileRow): number {
  return row.reads + row.edits + row.writes + row.deletes;
}

function threadCost(session: SessionSummary): number {
  if ((session.subagents?.length ?? 0) > 0) {
    return (
      session.estimated_cost_usd +
      (session.subagents ?? []).reduce((sum, subagent) => sum + threadCost(subagent), 0)
    );
  }
  return session.estimated_cost_usd + session.subagent_estimated_cost_usd;
}

function isPresent(value: string | null | undefined): value is string {
  return value != null && value.trim() !== "";
}

function firstLine(value: string, maxLength: number): string {
  const line = value.trim().split("\n", 1)[0] ?? "";
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}...` : line;
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString();
}

function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return formatInt(value);
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function duration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${totalSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function relativeTime(value: string | null | undefined): string {
  if (value == null || value === "") {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  const deltaSeconds = Math.round((Date.now() - timestamp) / 1000);
  const abs = Math.abs(deltaSeconds);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (abs >= seconds) {
      return formatter.format(Math.round(-deltaSeconds / seconds), unit);
    }
  }
  return "just now";
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function latestSessionDay(sessions: SessionSummary[]): string | null {
  const latest = sessions.find((session) => session.started_at != null)?.started_at;
  return latest == null ? null : formatDay(latest);
}

function formatDay(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

function InsightsView({
  rows,
  settingsInfo,
  onMarked,
}: {
  rows: Recommendation[];
  settingsInfo: SettingsInfo | null;
  onMarked: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        .catch((err: unknown) => setError(errorMessage(err)))
        .finally(() => setPending(null));
      return;
    }
    if (isPresent(row.prompt)) {
      void navigator.clipboard?.writeText(handoffPrompt(row));
      return;
    }
    setPending(row.key);
    void getJson<{ ok: boolean }>("/api/recommendations/mark", {
      method: "POST",
      body: JSON.stringify({ key: row.key, source: "ui" }),
    })
      .then(onMarked)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setPending(null));
  };

  return (
    <div className="view-stack insights-stack">
      <header className="page-heading">
        <h1>Insights</h1>
        <p>What could make your coding agents better, drawn from your archive.</p>
      </header>

      {error != null ? <div className="notice danger inline-notice">{error}</div> : null}

      <section className="view-stack">
        <div className="section-title-row">
          <div>
            <h2>Promotion candidates</h2>
            <p>Data-backed lessons ranked by impact</p>
          </div>
          {signals.length > 0 ? <span>{formatInt(signals.length)} active</span> : null}
        </div>

        {signals.length === 0 ? (
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

      {catalogGroups.length > 0 ? (
        <section className="view-stack">
          <div className="section-title-row">
            <div>
              <h2>Recommended for coding agents</h2>
              <p>Set these up to make your agents faster and more consistent</p>
            </div>
          </div>
          {catalogGroups.map(([category, items], groupIndex) => (
            <div className="catalog-group" key={category}>
              <h3>{category}</h3>
              <div className="catalog-grid">
                {items.map((row, index) => (
                  <RecommendationCard
                    featured={groupIndex === 0 && index === 0}
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
        </section>
      ) : null}

      {implementedRows.length > 0 ? (
        <section className="view-stack insights-history-heading">
          <div className="section-title-row">
            <div>
              <h2>Implemented</h2>
              <p>Recommendations already marked complete</p>
            </div>
            <span>{formatInt(implementedRows.length)} saved</span>
          </div>
          <div className="catalog-grid">
            {implementedRows.map((row) => (
              <ImplementedRecommendationCard key={row.key} row={row} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
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

function ToolsView({
  data,
  dateRange,
  onDateRangeChange,
}: {
  data: DashboardData;
  dateRange: DateRangeSelection;
  onDateRangeChange: (range: DateRangeSelection) => void;
}) {
  const [mcpSort, setMcpSort] = useState<SortState<McpSortKey>>({
    key: "calls",
    direction: "desc",
  });
  const [toolSort, setToolSort] = useState<SortState<ToolSortKey>>({
    key: "calls",
    direction: "desc",
  });
  const mcpRows = useMemo(() => sortRows(data.mcp, mcpSort, mcpSortValue), [data.mcp, mcpSort]);
  const toolRows = useMemo(
    () => sortRows(data.tools, toolSort, toolSortValue),
    [data.tools, toolSort],
  );

  return (
    <div className="view-stack">
      <header className="page-heading inline-heading">
        <div>
          <h1>Tools &amp; MCP</h1>
          <p>Tool and MCP-server call volume, scoped to your archive.</p>
        </div>
        <DateRangeControl bounds={data.dateBounds} range={dateRange} onChange={onDateRangeChange} />
      </header>

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
                <col className="col-wide" />
                <col className="col-number" />
                <col className="col-number" />
                <col className="col-number" />
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
                </tr>
              </thead>
              <tbody>
                {mcpRows.map((row) => (
                  <tr key={row.mcp_server}>
                    <td className="mono">
                      <span className="icon-cell">
                        <Icon name="cpu" />
                        <span>{row.mcp_server}</span>
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
                  </tr>
                ))}
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
              <col className="col-tool" />
              <col className="col-kind" />
              <col className="col-server" />
              <col className="col-number" />
              <col className="col-number" />
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
              </tr>
            </thead>
            <tbody>
              {toolRows.length === 0 ? (
                <tr>
                  <td colSpan={5}>No tool calls.</td>
                </tr>
              ) : null}
              {toolRows.map((row) => (
                <tr key={`${row.tool_name}-${row.tool_kind}-${row.mcp_server ?? ""}`}>
                  <td className="mono">{row.tool_name}</td>
                  <td>
                    <Badge tone={row.tool_kind === "mcp" ? "accent" : "neutral"}>
                      {row.tool_kind === "mcp" ? "MCP" : "built-in"}
                    </Badge>
                  </td>
                  <td className="mono muted">
                    {row.mcp_server != null && row.mcp_server !== "" ? (
                      <span className="icon-cell">
                        <Icon name="cpu" />
                        {row.mcp_server}
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
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
    let cancelled = false;
    const opParam = op == null ? "" : `&op=${op}`;
    void getJson<FileRow[]>(
      withDateQuery(`/api/files?group=${group}&limit=100${opParam}`, dateRangeQuery(dateRange)),
    ).then((nextRows) => {
      if (!cancelled) {
        setFileRows(nextRows);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dateRange, group, op]);

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
        {fileRows.length === 0 ? (
          <EmptyState
            icon="file"
            message="Hotspots appear once the archive has file activity."
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
                      <a href={`/search?q=${encodeURIComponent(`"${row.key}"`)}`}>{row.key}</a>
                    </td>
                    {group === "path" ? (
                      <td className="muted" title={row.project ?? ""}>
                        {basename(row.project)}
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
  settingsInfo,
}: {
  config: ConfigView | null;
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
      .then((response) => setSettings(response.settings))
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
          How decant opens things on your machine. We start from what we detect and remember your
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

function SessionDetailView({ id }: { id: number }) {
  const [detail, setDetail] = useState<SessionDetailData | null>(null);
  const [outline, setOutline] = useState<SessionOutlineItemData[] | null>(null);
  const [economics, setEconomics] = useState<TokenEconomics | null>(null);
  const [contextWindow, setContextWindow] = useState<ContextWindowTimelineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [economicsError, setEconomicsError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [jumpingToSeq, setJumpingToSeq] = useState<number | null>(null);
  const [activeMessageSeq, setActiveMessageSeq] = useState<number | null>(null);
  const detailRef = useRef<SessionDetailData | null>(null);
  const activeMessageSeqRef = useRef<number | null>(null);
  const handledMessageHashRef = useRef<string | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMorePromiseRef = useRef<Promise<boolean> | null>(null);
  const sessionVersionRef = useRef(0);

  useEffect(() => {
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
    setJumpingToSeq(null);
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
          setError(errorMessage(err));
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
  }, [id]);

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
          if (current.messages.some((message) => message.seq === seq)) {
            return true;
          }
          const offset = clampTranscriptWindowOffset(
            transcriptWindowOffset(seq),
            current.summary.message_count,
            SESSION_DETAIL_MESSAGE_PAGE_SIZE,
          );
          setLoadingMore(true);
          setLoadMoreError(null);
          return getJson<SessionDetailData>(
            `/api/sessions/${id}?message_limit=${SESSION_DETAIL_MESSAGE_PAGE_SIZE}&message_offset=${offset}`,
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
              const nextDetail = {
                ...page,
                message_offset: page.message_offset ?? offset,
                message_limit: SESSION_DETAIL_MESSAGE_PAGE_SIZE,
              };
              detailRef.current = nextDetail;
              setDetail(nextDetail);
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
      const hash = `#message-${seq}`;
      handledMessageHashRef.current = `${id}:${seq}`;
      window.history.replaceState(null, "", hash);
      setJumpingToSeq(seq);
      try {
        const loaded = await loadMessageWindow(seq);
        if (!loaded || sessionVersionRef.current !== sessionVersion) {
          return;
        }
        activeMessageSeqRef.current = seq;
        setActiveMessageSeq(seq);
        requestAnimationFrame(() => {
          if (sessionVersionRef.current === sessionVersion) {
            scrollTranscriptMessage(seq);
          }
        });
      } finally {
        if (sessionVersionRef.current === sessionVersion) {
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
      if (targetSeq == null && direction === 1 && current.has_more_messages === true) {
        await loadMoreMessages();
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
    [id, loadMoreMessages],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const direction = transcriptNavigationDirection(event);
      if (
        direction == null ||
        event.repeat ||
        isInteractiveTarget(event.target) ||
        isInteractiveTarget(document.activeElement) ||
        document.querySelector("[role='dialog']") != null
      ) {
        return;
      }
      event.preventDefault();
      void navigateTranscript(direction);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigateTranscript]);

  if (error != null) {
    return <div className="notice danger">Unable to load session: {error}</div>;
  }

  if (detail == null) {
    return <SessionDetailSkeleton />;
  }

  const messages = renderableMessages(detail.messages);
  const toc = outline == null ? threadToc(messages) : threadTocFromOutline(outline);
  const stats = threadStats(detail.summary, messages, toc, contextWindow?.turn_count);
  const subagentsByToolUse = subagentMap(detail.subagents);
  const subagentRuns = countSubagentRuns(detail.subagents);
  const compactionBySeq = new Map(
    (contextWindow?.compactions ?? []).map((compaction) => [compaction.seq, compaction] as const),
  );
  const windowTokens = contextWindow?.window_tokens ?? null;

  return (
    <div className="session-detail">
      <header className="thread-header">
        <div className="thread-header-inner">
          <h1>{sessionDisplayTitle(detail.summary)}</h1>
          <div className="thread-badges">
            <ToolBadge tool={detail.summary.tool} />
            <ModelBadge model={detail.summary.model} />
            <EffortBadge
              effort={detail.summary.reasoning_effort}
              labeled
              levels={detail.summary.reasoning_effort_levels}
            />
            {detail.summary.project_path != null ? (
              <span className="project-chip" title={detail.summary.project_path}>
                <Icon name="folder" />
                {detail.summary.project_path}
              </span>
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

      <a className="back-link" href="/sessions" onClick={(event) => navigate(event, "/sessions")}>
        <Icon name="arrowLeft" />
        Sessions
      </a>

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
            {toc.length === 0 ? <p>No prompts to list</p> : null}
            {toc.map((item) => (
              <a
                className={[
                  jumpingToSeq === item.seq ? "is-loading" : null,
                  activeMessageSeq === item.seq ? "is-current" : null,
                ]
                  .filter(isPresent)
                  .join(" ")}
                href={`#message-${item.seq}`}
                key={item.seq}
                onClick={(event) => {
                  event.preventDefault();
                  void jumpToMessage(item.seq);
                }}
              >
                <span className="toc-icon">
                  <Icon name={item.icon} />
                </span>
                <span>{item.label}</span>
                {jumpingToSeq === item.seq ? <b>loading</b> : null}
                {item.tools > 0 ? <b>{item.tools}</b> : null}
              </a>
            ))}
          </div>
        </aside>

        <div className="transcript-column">
          {(detail.message_offset ?? 0) > 0 ? (
            <div className="transcript-window-start">
              <span>
                Viewing from message {formatInt((detail.message_offset ?? 0) + 1)} of{" "}
                {formatInt(detail.summary.message_count)}
              </span>
              <button
                className="button small secondary"
                onClick={() => void jumpToMessage(0)}
                type="button"
              >
                Start at the beginning
              </button>
            </div>
          ) : null}
          {messages.map((message) => (
            <TranscriptTurn
              active={activeMessageSeq === message.seq}
              compaction={compactionBySeq.get(message.seq) ?? null}
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

type SessionDetailData = {
  summary: SessionSummary;
  messages: {
    seq: number;
    role: string;
    timestamp: string | null;
    model: string | null;
    context_tokens: number | null;
    output_tokens: number | null;
    is_sidechain: boolean;
    is_compact_boundary: boolean;
    compact_trigger: string | null;
    compact_pre_tokens: number | null;
    is_compact_summary: boolean;
    blocks: TranscriptBlockData[];
  }[];
  subagents: SubagentDetailData[];
  message_offset?: number;
  message_limit?: number | null;
  has_more_messages?: boolean;
};

type SessionOutlineItemData = {
  seq: number;
  text: string;
};

type ContextWindowPointData = {
  seq: number;
  timestamp: string | null;
  turn: number;
  context_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
};

type ContextWindowCompactionData = {
  seq: number;
  timestamp: string | null;
  trigger: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
};

type ContextWindowTimelineData = {
  session_id: number;
  tool: string;
  window_tokens: number | null;
  window_inferred: boolean;
  peak_tokens: number;
  peak_pct: number | null;
  turn_count: number;
  points: ContextWindowPointData[];
  compactions: ContextWindowCompactionData[];
};

type SubagentDetailData = SessionDetailData & {
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
};

type TranscriptBlockData = {
  ordinal: number;
  block_type: string;
  text: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input: string | null;
  tool_result: string | null;
};

function TranscriptTurn({
  active,
  compaction,
  message,
  sessionIsSubagent,
  subagentsByToolUse,
  tool,
  windowTokens,
}: {
  active: boolean;
  compaction: ContextWindowCompactionData | null;
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
}

function CompactionTurn({
  active = false,
  anchorId,
  compaction,
  message,
}: {
  active?: boolean;
  anchorId?: string;
  compaction: ContextWindowCompactionData | null;
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
    >
      <Badge mono tone="accent">
        Compacted
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

const STRIP_HEIGHT = 198;
const STRIP_PLOT_TOP = 48;
const STRIP_RUG_HEIGHT = 30;
const STRIP_PAD_LEFT = 46;
const STRIP_PAD_RIGHT = 16;
const STRIP_WINDOW_LABEL_Y = 13;
const STRIP_ANNOTATION_LABEL_YS = [28, 41] as const;
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
            {hasUsage ? "Window capacity wasn’t recorded" : "Per-call usage wasn’t recorded"}
          </strong>
          <p>
            {hasUsage
              ? "The transcript includes token usage, but this source did not record the model’s total context capacity, so a trustworthy percentage is unavailable."
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
  const [width, setWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

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

  const points = timeline.points;
  const compactions = [...timeline.compactions].sort((a, b) => a.seq - b.seq);
  const peakLabel =
    timeline.peak_pct == null
      ? compact(timeline.peak_tokens)
      : `${Math.round(timeline.peak_pct * 100)}%`;

  const plotLeft = STRIP_PAD_LEFT;
  const plotRight = Math.max(plotLeft + 40, stripWidth - STRIP_PAD_RIGHT);
  const plotWidth = plotRight - plotLeft;
  const baseY = STRIP_HEIGHT - STRIP_RUG_HEIGHT;
  const yAt = (tokens: number) =>
    STRIP_PLOT_TOP + (1 - Math.min(1, tokens / windowTokens)) * (baseY - STRIP_PLOT_TOP);

  // Equal-width turn slots: every turn spans the same share of the axis and a
  // turn's calls subdivide its slot, so the x-axis reads as a regular scale.
  const turnOrder: number[] = [];
  const callsPerTurn = new Map<number, number>();
  for (const point of points) {
    if (!callsPerTurn.has(point.turn)) {
      turnOrder.push(point.turn);
    }
    callsPerTurn.set(point.turn, (callsPerTurn.get(point.turn) ?? 0) + 1);
  }
  const slotByTurn = new Map(turnOrder.map((turn, index) => [turn, index] as const));
  const slotWidth = plotWidth / turnOrder.length;
  const seenInTurn = new Map<number, number>();
  const xs = points.map((point) => {
    const position = seenInTurn.get(point.turn) ?? 0;
    seenInTurn.set(point.turn, position + 1);
    const slot = slotByTurn.get(point.turn) ?? 0;
    const calls = callsPerTurn.get(point.turn) ?? 1;
    return plotLeft + (slot + (position + 0.5) / calls) * slotWidth;
  });
  const xOf = (index: number) => xs[index] ?? plotLeft;

  // Split the curve at compaction boundaries so each drop renders as a cliff.
  const segments: [number, number][][] = [];
  {
    let current: [number, number][] = [];
    let nextCompaction = 0;
    points.forEach((point, index) => {
      let cut = false;
      while (
        nextCompaction < compactions.length &&
        (compactions[nextCompaction]?.seq ?? 0) < point.seq
      ) {
        nextCompaction += 1;
        cut = true;
      }
      if (cut && current.length > 0) {
        segments.push(current);
        current = [];
      }
      current.push([xOf(index), yAt(point.context_tokens)]);
    });
    if (current.length > 0) {
      segments.push(current);
    }
  }

  const linePath = (coords: [number, number][]) =>
    coords
      .map(([px, py], index) => `${index === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`)
      .join(" ");
  const areaPath = (coords: [number, number][]) => {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first == null || last == null) {
      return "";
    }
    return `${linePath(coords)} L${last[0].toFixed(1)} ${baseY} L${first[0].toFixed(1)} ${baseY} Z`;
  };
  const markerX = (compaction: ContextWindowCompactionData) => {
    const after = points.findIndex((point) => point.seq > compaction.seq);
    if (after < 0) {
      return xOf(points.length - 1);
    }
    if (after === 0) {
      return xOf(0);
    }
    return (xOf(after - 1) + xOf(after)) / 2;
  };
  const compactionMarks = compactions.map((compaction) => ({
    compaction,
    text: compactionMarkText(compaction),
    x: markerX(compaction),
  }));
  const compactionLabels = layoutContextAnnotations(compactionMarks, {
    labelYs: STRIP_ANNOTATION_LABEL_YS,
    plotLeft,
    plotRight,
  });

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
  const endX = xOf(lastIndex);
  const endY = lastPoint == null ? baseY : yAt(lastPoint.context_tokens);
  const peakX = xOf(peakIndex);
  const peakY = peakPoint == null ? baseY : yAt(peakPoint.context_tokens);
  const peakLabelOnLeft = peakX > plotLeft + 70;
  const peakLabelY = Math.max(STRIP_PLOT_TOP + 10, peakY - 7);
  // The live readout sits inside the plot, above the line when there is room
  // and below it when the session ended near the ceiling.
  const endLabelAbove = endY > STRIP_PLOT_TOP + 30;

  const handleMove = (event: { clientX: number; currentTarget: SVGSVGElement }) => {
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
  const tooltipFlips = hovered != null && hoverIndex != null && xOf(hoverIndex) > stripWidth - 210;
  const handleJump = () => {
    if (hovered == null) {
      return;
    }
    void onJump(hovered.seq);
  };

  let previousTickLabelX = Number.NEGATIVE_INFINITY;

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
                onClick={handleJump}
                onMouseLeave={() => setHoverIndex(null)}
                onMouseMove={handleMove}
                role="img"
                width={stripWidth}
              >
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
                    <path className="ctx-strip-area" d={areaPath(coords)} />
                    <path className="ctx-strip-line" d={linePath(coords)} />
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
                {compactionMarks.map(({ compaction, x }, compactionIndex) => {
                  const label = compactionLabels[compactionIndex];
                  const marker = (
                    <g className="ctx-strip-compaction" key={`marker-${compaction.seq}`}>
                      <line x1={x} x2={x} y1={STRIP_PLOT_TOP} y2={baseY} />
                      <text
                        textAnchor={label?.anchor ?? "start"}
                        x={label?.textX ?? x + 6}
                        y={label?.textY ?? STRIP_ANNOTATION_LABEL_YS[0]}
                      >
                        {compactionMarkText(compaction)}
                      </text>
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
                  );
                  return (
                    <a
                      href={`#message-${compaction.seq}`}
                      key={`compaction-${compaction.seq}`}
                      onClick={(event) => {
                        event.preventDefault();
                        void onJump(compaction.seq);
                      }}
                    >
                      {marker}
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
                  <circle cx={endX} cy={endY} r={3} />
                  <text textAnchor="end" x={endX - 9} y={endLabelAbove ? endY - 9 : endY + 18}>
                    {Math.round(((lastPoint?.context_tokens ?? 0) / windowTokens) * 100)}% ·{" "}
                    {compact(lastPoint?.context_tokens ?? 0)}
                  </text>
                </g>
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
              {hovered != null && hoverIndex != null ? (
                <div
                  className="ctx-tooltip"
                  style={{
                    left: tooltipFlips ? xOf(hoverIndex) - 196 : xOf(hoverIndex) + 12,
                    top: Math.max(
                      2,
                      Math.min(yAt(hovered.context_tokens) - 24, STRIP_HEIGHT - 118),
                    ),
                  }}
                >
                  <div className="ctx-tooltip-when">
                    turn {hovered.turn} · call {hoverIndex + 1} of {points.length}
                  </div>
                  <strong>
                    {Math.round((hovered.context_tokens / windowTokens) * 100)}% ·{" "}
                    {formatInt(hovered.context_tokens)} tokens
                  </strong>
                  {/* The log's raw input_tokens is a streaming placeholder
                      (usually 0-5, upstream anthropics/claude-code#25941);
                      the accurate fresh-context number is cache_creation, so
                      the two fold into one row and the rows sum to the
                      headline total. */}
                  <div className="ctx-tooltip-rows">
                    <span>cache read</span>
                    <span>{compact(hovered.cache_read_tokens)}</span>
                    <span>fresh input</span>
                    <span>{compact(hovered.cache_creation_tokens + hovered.input_tokens)}</span>
                    <span>output</span>
                    <span>{compact(hovered.output_tokens)}</span>
                  </div>
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

function compactionMarkText(compaction: ContextWindowCompactionData): string {
  const trigger = compaction.trigger != null ? `${compaction.trigger}-compact` : "compacted";
  if (compaction.pre_tokens == null) {
    return `⇣ ${trigger}`;
  }
  const post = compaction.post_tokens != null ? ` → ${compact(compaction.post_tokens)}` : "";
  return `⇣ ${trigger} · ${compact(compaction.pre_tokens)}${post}`;
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
    return (
      <div className="tool-call">
        <div>
          <Icon name="bolt" />
          <span>{block.tool_name ?? "tool_use"}</span>
          <small>tool call</small>
        </div>
        {isPresent(block.tool_input) ? (
          <details open={block.tool_input.length <= 240}>
            <summary>arguments</summary>
            <pre>{prettyJson(block.tool_input)}</pre>
          </details>
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
    return (
      <details className="tool-result">
        <summary>result</summary>
        <pre>{block.tool_result}</pre>
      </details>
    );
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
  const special = specialTranscriptBlock(block.text);
  if (special != null) {
    return <SpecialTranscriptBlock block={special} tool={tool} />;
  }
  return <p className="text-block">{block.text}</p>;
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

function matchText(value: string, pattern: RegExp): string | null {
  return value.match(pattern)?.[1]?.trim() ?? null;
}

function shortPath(value: string): string {
  const parts = value.split("/").filter((part) => part !== "");
  return parts.length <= 2 ? value : `.../${parts.slice(-2).join("/")}`;
}

function SubagentCard({ subagent }: { subagent: SubagentDetailData }) {
  const messages = renderableMessages(subagent.messages);
  const nested = subagentMap(subagent.subagents);
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
          <a href={`/sessions/${subagent.summary.id}`}>Open session</a>
        </div>
      ) : (
        <div className="subagent-transcript">
          {messages.map((message) =>
            message.is_compact_boundary ? (
              <CompactionTurn compaction={null} key={messageKey(message)} message={message} />
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
    // Compact summaries are machine-generated continuations, not prompts.
    if (message.role !== "user" || message.is_compact_summary) {
      return [];
    }
    const label =
      message.blocks.find((block) => block.block_type === "text" && isPresent(block.text))?.text ??
      "";
    if (label.trim() === "") {
      return [];
    }
    return [
      {
        seq: message.seq,
        ...tocPresentation(label),
        tools: message.blocks.filter((block) => block.block_type === "tool_use").length,
      },
    ];
  });
}

function threadTocFromOutline(outline: SessionOutlineItemData[]): ThreadTocItem[] {
  return outline.map((item) => ({
    seq: item.seq,
    ...tocPresentation(item.text),
    tools: 0,
  }));
}

type ThreadTocItem = {
  seq: number;
  label: string;
  tools: number;
  icon: IconName;
};

function tocPresentation(text: string): { label: string; icon: IconName } {
  const special = specialTranscriptBlock(text);
  if (special != null) {
    return { label: firstLine(special.title, 70), icon: special.icon };
  }
  return { label: firstLine(cleanSessionTitle(text) ?? text, 70), icon: "messages" };
}

function threadStats(
  summary: SessionSummary,
  messages: SessionDetailData["messages"],
  toc: ThreadTocItem[],
  fullTurnCount?: number | null,
) {
  return {
    turns: fullTurnCount != null && fullTurnCount > 0 ? fullTurnCount : toc.length,
    replies: messages.filter((message) => message.role === "assistant").length,
    toolCalls: messages.reduce(
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

function providerIdentity(tool: string): {
  key: "assistant" | "claude" | "openai";
  label: string;
  tone: BadgeTone;
  icon: BrandIconName | null;
} {
  if (tool === "claude_code") {
    return { key: "claude", label: "Claude", tone: "claude", icon: "claude" };
  }
  if (tool === "codex") {
    return { key: "openai", label: "Codex", tone: "openai", icon: "openai" };
  }
  return { key: "assistant", label: "Assistant", tone: "accent", icon: null };
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

function scrollTranscriptMessage(seq: number) {
  document.getElementById(`message-${seq}`)?.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function applyDatePreset(
  key: (typeof RANGE_PRESETS)[number]["key"],
  bounds: DateBounds | null,
): DateRangeSelection {
  const preset = RANGE_PRESETS.find((item) => item.key === key);
  const to = validIsoDate(bounds?.max) ?? todayIsoDate();
  if (preset == null) {
    return ALL_DATE_RANGE;
  }
  return {
    preset: key,
    from: addDays(to, -(preset.days - 1)),
    to,
  };
}

function shiftDateRange(range: DateRangeSelection, direction: -1 | 1): DateRangeSelection {
  if (range.from == null || range.to == null) {
    return range;
  }
  const span = Math.max(1, daysBetween(range.from, range.to) + 1);
  return {
    preset: "custom",
    from: addDays(range.from, span * direction),
    to: addDays(range.to, span * direction),
  };
}

function dateRangeQuery(range: DateRangeSelection): string {
  const params = new URLSearchParams();
  if (range.from != null) {
    params.set("from", range.from);
  }
  if (range.to != null) {
    params.set("to", range.to);
  }
  return params.toString();
}

function withDateQuery(path: string, dateQuery: string): string {
  if (dateQuery === "") {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}${dateQuery}`;
}

function dateRangeLabel(range: DateRangeSelection): string {
  if (range.from == null || range.to == null) {
    return "All time";
  }
  return range.from === range.to
    ? formatDateLabel(range.from)
    : `${formatDateLabel(range.from)} to ${formatDateLabel(range.to)}`;
}

function addDays(isoDate: string, days: number): string {
  const date = parseIsoDate(isoDate) ?? new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const start = parseIsoDate(from)?.getTime() ?? 0;
  const end = parseIsoDate(to)?.getTime() ?? start;
  return Math.round((end - start) / 86_400_000);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function validIsoDate(value: string | null | undefined): string | null {
  if (value == null || parseIsoDate(value) == null) {
    return null;
  }
  return value;
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function formatDateLabel(value: string): string {
  const date = parseIsoDate(value);
  if (date == null) {
    return value;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeRoute(path: string): string {
  const pathname = pathOnly(path);
  if (pathname === "/" || pathname === "/sessions" || pathname.startsWith("/sessions/")) {
    return "Sessions";
  }
  if (pathname === "/settings") {
    return "Settings";
  }
  const match = navItems.find((item) => item.href === pathname);
  return match?.label ?? "Sessions";
}

function activeRouteKey(path: string): string {
  const pathname = pathOnly(path);
  if (pathname === "/" || pathname === "/sessions" || pathname.startsWith("/sessions/")) {
    return "sessions";
  }
  if (pathname === "/settings") {
    return "settings";
  }
  return navItems.find((item) => item.href === pathname)?.key ?? "sessions";
}

function titleFor(active: string): string {
  return active === "Sessions" ? "Session Archive" : active;
}

function shortDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return value;
  }
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function implementedTimestamp(row: Recommendation): number {
  const time = Date.parse(row.implemented_at ?? "");
  return Number.isFinite(time) ? time : 0;
}

function prettyJson(value: string | null): string {
  if (value == null || value === "") {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function snippetParts(snippet: string): { key: string; text: string; match: boolean }[] {
  const parts: { key: string; text: string; match: boolean }[] = [];
  let remaining = snippet;
  let offset = 0;
  while (remaining !== "") {
    const start = remaining.indexOf("[");
    if (start < 0) {
      parts.push({ key: `text-${offset}`, text: remaining, match: false });
      break;
    }
    if (start > 0) {
      parts.push({ key: `text-${offset}`, text: remaining.slice(0, start), match: false });
    }
    const close = remaining.indexOf("]", start + 1);
    if (close < 0) {
      parts.push({ key: `text-${offset + start}`, text: remaining.slice(start), match: false });
      break;
    }
    parts.push({
      key: `match-${offset + start}`,
      text: remaining.slice(start + 1, close),
      match: true,
    });
    const consumed = close + 1;
    offset += consumed;
    remaining = remaining.slice(consumed);
  }
  return parts;
}

function basename(path: string | null | undefined): string {
  if (path == null || path === "") {
    return "-";
  }
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function locationPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function pathOnly(path: string): string {
  return path.split("?", 1)[0] ?? "/";
}

function navigate(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  setPath?: (path: string) => void,
) {
  event.preventDefault();
  window.history.pushState(null, "", href);
  const next = locationPath();
  if (setPath != null) {
    setPath(next);
  } else {
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

/** Rendered instead of the app when decant is loaded inside a frame, so that no
 * part of the UI - including the Insights "Run" button, which launches a coding
 * agent on this machine - exists to be clicked through a hidden overlay. */
function FramedNotice() {
  return (
    <EmptyState
      icon="shield"
      message="Open decant directly in its own browser tab or window to use it."
      title="decant cannot be displayed in a frame"
    />
  );
}

const root = document.getElementById("root");
if (root == null) {
  throw new Error("missing #root");
}
createRoot(root).render(isFramed(window) ? <FramedNotice /> : <App />);
