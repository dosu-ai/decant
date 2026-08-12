// Type-only, so this erases at build time. ECharts is ~1.1MB minified and is
// reachable from exactly two call sites, both of which import() it on demand:
// eagerly importing it here put the whole library on every route, including
// /settings and /search, which never draw a chart.
import type { ECharts as EChartsInstance, EChartsOption } from "echarts";
import type { LucideIcon } from "lucide-react";
import {
  Archive,
  ArrowLeft,
  BarChart3,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDollarSign,
  Clock3,
  Copy,
  Cpu,
  Download,
  Ellipsis,
  Eye,
  FileCode2,
  FileText,
  FileType2,
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
  Share2,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
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
import { ApiError, getJson } from "./api.ts";
import dosuDecantUrl from "./assets/dosu-decant.png";
import dosuOfficialUrl from "./assets/dosu-official.svg";
import {
  type AnalyticsChartMetric,
  type AnalyticsChartState,
  type AnalyticsChartVariant,
  prepareAnalyticsChartState,
} from "./chart-state.ts";
import {
  buildCommandPaletteGroups,
  type CommandPaletteItem,
  flattenCommandPaletteItems,
  normalizeRecentSearches,
  paletteShortcutLabel,
  pointerMovementChangesSelection,
  reconcileCommandPaletteActiveIndex,
  reduceCommandPaletteKey,
  shouldOpenCommandPalette,
} from "./command-palette.ts";
import {
  contextCurveAreaPath,
  contextCurveLinePath,
  groupContextMarkers,
  layoutContextCurve,
  layoutContextTooltip,
} from "./context-window-layout.ts";
import { contextWindowDisplayMode, isFullCacheMiss } from "./context-window-state.ts";
import { fullDateTime, relativeTime, sessionListDate } from "./date-time.ts";
import { dosuBadgeAriaLabel, dosuBadgeVisualLabel, dosuEvidenceSummary } from "./dosu-badge.ts";
import { DOSU_ANALYTICS_DISMISSAL_KEY, shouldShowDosuCta } from "./dosu-cta.ts";
import { dosuLink } from "./dosu-links.ts";
import { dosuToolDisplayName, isDosuToolName } from "./dosu-tool.ts";
import { effortDisplayLabel, effortTooltip } from "./effort.ts";
import { isFramed } from "./frame-guard.ts";
import {
  createSessionSearchIndex,
  type SessionHighlightRange,
  type SessionHighlights,
  type SessionSearchIndex,
  type SessionSearchIndexRow,
} from "./fuzzy.ts";
import { formatIssueBadge, unknownRecordTypeSummary } from "./ingest-issues.ts";
import {
  planSessionPageLoad,
  sessionPageExhausted,
  shouldShowSessionSkeleton,
} from "./loading-state.ts";
import { formatMcpServer, mcpServerLabel, mcpServerLabels } from "./mcp-server.ts";
import {
  documentTitleFor,
  isKnownRoute,
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
import { exactSearchRemaining, searchPageMayHaveMore } from "./search-pagination.ts";
import { searchRequestScope, searchRouteHref } from "./search-request.ts";
import { searchSnippetParts, visuallyOrderedSearchHits } from "./search-results.ts";
import {
  archiveActionFor,
  DELETE_SESSION_EXPLANATION,
  type SessionStateUpdate,
  sessionStateRequest,
} from "./session-state.ts";
import {
  scopedSessionSummaryKey,
  sessionCardMetrics,
  sessionSummaryPath,
  sessionThreadCost,
} from "./session-summary.ts";
import {
  hasShareCardValues,
  SHARE_CARD_HEIGHT,
  SHARE_CARD_SCALE,
  SHARE_CARD_WIDTH,
  SHARE_EXCLUDED_FIELDS,
  SHARE_INCLUDED_FIELDS,
  type ShareCardCopyInput,
  shareCardAltText,
  shareCardButtonLabel,
  shareCardCaption,
  shareCardFilename,
  shareCardQualifier,
  shareCardTakeaway,
  shareCardTitle,
} from "./share-card.ts";
import { collectSliceResults } from "./slice-loading.ts";
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
  user_state: "archived" | null;
  is_user_archived: boolean;
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
  /** Ingest diagnostics recorded against this session's source file. */
  ingest_issue_count: number;
  informational_ingest_issue_count: number;
  dosu_mcp_direct_calls: number;
  dosu_mcp_tree_calls: number;
  subagents?: SessionSummary[];
};

type SearchHit = {
  block_id: number;
  block_type: string;
  href: string;
  message_seq: number;
  project: string | null;
  role: string;
  session_id: number;
  session_title: string | null;
  snippet: string;
  timestamp: string | null;
  tool: string;
};

type SearchResponse = {
  elapsed_ms: number;
  results: SearchHit[];
  total: number | null;
  total_is_capped: boolean;
};

type SyncProgress = {
  failed: number;
  ingested: number;
  scanned: number;
  skipped: number;
  total: number;
};

type ServerEventPayload = {
  reason?: string;
};

const LIVE_DISCONNECT_GRACE_MS = 15_000;

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
  p50_ms: number | null;
  p95_ms: number | null;
  last_used_at: string | null;
};

type McpRow = {
  mcp_server: string;
  tools: number;
  calls: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
  last_used_at: string | null;
};

type ToolCallRow = {
  id: number;
  session_id: number;
  session_title: string | null;
  project: string | null;
  tool_name: string | null;
  tool_kind: string | null;
  mcp_server: string | null;
  input_preview: string | null;
  input_bytes: number | null;
  output_preview: string | null;
  output_bytes: number | null;
  is_error: boolean | null;
  has_result: boolean | null;
  duration_ms: number | null;
  timestamp: string | null;
  seq: number | null;
};

type ToolCallPage = {
  calls: ToolCallRow[];
  total: number;
  limit: number;
  offset: number;
  summary: {
    calls: number;
    errors: number;
    p50_ms: number | null;
    p95_ms: number | null;
  } | null;
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
  impact_label?: string | null;
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
  version: string;
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
  dateBounds: DateBounds | null;
};

const emptyData: DashboardData = {
  summary: null,
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
  dateBounds: null,
};

type DataSlice = keyof DashboardData;

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
    // Recommendations are archive-wide. If they become date-scoped, the
    // recommendations loading key and layout effect must include dateQuery too.
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
  dateBounds: {
    dateScoped: false,
    load: async () => ({ dateBounds: await getJson<DateBounds>("/api/date-bounds") }),
  },
};

// Slices the app shell itself renders (sidebar stats, sync button, pickers).
const SHELL_SLICES: DataSlice[] = ["summary", "dateBounds", "config"];

const ROUTE_SLICES: Record<string, DataSlice[]> = {
  Sessions: [],
  Projects: ["projects"],
  Search: [],
  Analytics: [
    "byDay",
    "byModel",
    "byProject",
    "activity",
    "modelSparklines",
    "tokenEconomics",
    "settings",
  ],
  Insights: ["recommendations", "settings"],
  "Tools & MCP": ["tools", "mcp"],
  Files: ["files"],
  Settings: ["config", "settings"],
};

function slicesForView(activeView: string): DataSlice[] {
  return [...new Set([...SHELL_SLICES, ...(ROUTE_SLICES[activeView] ?? [])])];
}

type NavItem = {
  key: string;
  href: string;
  label: string;
  icon: IconName;
};

/**
 * Two sections: what the archive adds up to, then the archive itself. Analytics
 * leads because it answers the question the tool exists for -- what the sessions
 * cost and where the context went -- and it is what `/` serves.
 */
const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      { key: "analytics", href: "/", label: "Analytics", icon: "chart" },
      { key: "insights", href: "/insights", label: "Insights", icon: "lightbulb" },
    ],
  },
  {
    label: "Browse",
    items: [
      { key: "sessions", href: "/sessions", label: "Sessions", icon: "sessions" },
      { key: "search", href: "/search", label: "Search", icon: "search" },
      { key: "projects", href: "/projects", label: "Projects", icon: "folder" },
      { key: "files", href: "/files", label: "Files", icon: "file" },
      { key: "tools", href: "/tools", label: "Tools & MCP", icon: "tools" },
    ],
  },
];

const navItems: NavItem[] = navGroups.flatMap((group) => group.items);

const CLAUDE_ICON_PATH =
  "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
const OPENAI_ICON_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
const ANTHROPIC_ICON_PATH =
  "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z";

const SESSION_PAGE_SIZE = 50;
const SESSION_DETAIL_MESSAGE_PAGE_SIZE = 160;
const SESSION_TABLE_SKELETON_KEYS = Array.from(
  { length: SESSION_PAGE_SIZE },
  (_, index) => `session-row-skeleton-${index}`,
);
const EMPTY_SESSION_IDS = new Set<number>();
type ThemeChoice = "system" | "light" | "dark";
type RangePreset = "7d" | "30d" | "90d" | "all" | "custom";
type DateRangeSelection = {
  preset: RangePreset;
  from: string | null;
  to: string | null;
};

function versionLabel(version: string | null | undefined): string {
  if (version == null || version === "") {
    return "local checkout";
  }
  return version === "dev" || version.startsWith("v") ? version : `v${version}`;
}

const RANGE_PRESETS = [
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
] as const;
const ALL_DATE_RANGE: DateRangeSelection = { preset: "all", from: null, to: null };

type LoadedSessionPage = {
  exhausted: boolean;
  page: number;
  requestKey: string;
  scopeKey: string;
  sessions: SessionSummary[];
};

type SessionPageState = {
  error: unknown;
  exhausted: boolean;
  loadedPage: number | null;
  loading: boolean;
  sessions: SessionSummary[];
};

const SESSION_PAGE_CACHE_LIMIT = 12;

function rememberSessionPage(cache: Map<string, LoadedSessionPage>, page: LoadedSessionPage): void {
  cache.delete(page.requestKey);
  cache.set(page.requestKey, page);
  while (cache.size > SESSION_PAGE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest == null) {
      return;
    }
    cache.delete(oldest);
  }
}

function useSessionPage({
  dateQuery,
  enabled,
  includeArchived,
  page,
  project,
  reloadKey,
}: {
  dateQuery: string;
  enabled: boolean;
  includeArchived: boolean;
  page: number;
  project: string | null;
  reloadKey: number;
}): SessionPageState {
  const cacheRef = useRef(new Map<string, LoadedSessionPage>());
  const [settled, setSettled] = useState<{
    failed: { error: unknown; requestKey: string } | null;
    loaded: LoadedSessionPage | null;
  }>({ failed: null, loaded: null });
  const scopeKey = JSON.stringify([dateQuery, project, includeArchived, reloadKey]);
  const requestKey = `${scopeKey}:${page}`;
  const cached = cacheRef.current.get(requestKey) ?? null;
  const visible = cached ?? (settled.loaded?.scopeKey === scopeKey ? settled.loaded : null);
  const currentError = settled.failed?.requestKey === requestKey ? settled.failed.error : null;
  const loading = enabled && cached == null && currentError == null;

  useEffect(() => {
    if (!enabled || cacheRef.current.has(requestKey)) {
      return;
    }
    const controller = new AbortController();
    const plan = planSessionPageLoad({ page, pageSize: SESSION_PAGE_SIZE });
    const projectParam = project == null ? "" : `&project=${encodeURIComponent(project)}`;
    const archivedParam = includeArchived ? "&include_archived=true" : "";
    void getJson<SessionSummary[]>(
      withDateQuery(
        `/api/sessions?limit=${plan.limit}&offset=${plan.offset}` +
          `&with_subagents=true${projectParam}${archivedParam}`,
        dateQuery,
      ),
      { signal: controller.signal },
    )
      .then((sessions) => {
        const loaded: LoadedSessionPage = {
          exhausted: sessionPageExhausted({
            receivedRows: sessions.length,
            requestedRows: plan.limit,
          }),
          page: plan.page,
          requestKey,
          scopeKey,
          sessions: sessions.slice(0, SESSION_PAGE_SIZE),
        };
        rememberSessionPage(cacheRef.current, loaded);
        setSettled({ failed: null, loaded });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setSettled((current) => ({ ...current, failed: { error, requestKey } }));
      });
    return () => controller.abort();
  }, [dateQuery, enabled, includeArchived, page, project, requestKey, scopeKey]);

  return {
    error: currentError,
    exhausted: visible?.exhausted ?? false,
    loadedPage: visible?.page ?? null,
    loading,
    sessions: visible?.sessions ?? [],
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
  const syncCompleteTimerRef = useRef<number | null>(null);
  const liveDisconnectTimerRef = useRef<number | null>(null);
  const liveDroppedRef = useRef(false);
  const dateQuery = dateRangeQuery(dateRangeSelection);
  const sessionProject = sessionProjectFilter(path);
  const includeArchivedSessions = sessionIncludesArchived(path);
  const sessionPage = sessionPageFromPath(path);
  const refreshTimerRef = useRef<number | null>(null);
  const loadedSlicesRef = useRef(new Map<DataSlice, string>());
  const activeView = resolveActiveRoute(path, navItems);
  const showsSessions = activeView === "Sessions";
  const sessionPageState = useSessionPage({
    dateQuery,
    enabled: showsSessions,
    includeArchived: includeArchivedSessions,
    page: sessionPage,
    project: sessionProject,
    reloadKey,
  });
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
      localStorage.removeItem("decant-theme");
    } else {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem("decant-theme", theme);
    }
    window.dispatchEvent(new CustomEvent("decant:set-theme"));
  }, [theme]);

  useLayoutEffect(() => {
    setRecommendationsLoading(
      activeView === "Insights" &&
        loadedSlicesRef.current.get("recommendations") !== `${reloadKey}`,
    );
  }, [activeView, reloadKey]);

  useEffect(() => {
    const sliceKey = (slice: DataSlice): string =>
      SLICE_LOADERS[slice].dateScoped ? `${dateQuery}|${reloadKey}` : `${reloadKey}`;
    const needed = slicesForView(activeView);
    setFailedSlices((current) => current.filter((slice) => needed.includes(slice)));
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
        setFailedSlices(settled.failures.map((failure) => failure.slice));
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
    const markConnected = () => {
      if (liveDroppedRef.current) {
        liveDroppedRef.current = false;
        setArchiveUpdateAvailable(true);
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
          setSyncProgress(payload.progress);
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

  const active = activeView;
  const activeKey = resolveActiveRouteKey(path, navItems);
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
    setSyncProgress(null);
    setArchiveUpdateAvailable(false);
    setLocalSyncing(true);
    void getJson<unknown>("/api/sync", { method: "POST", body: "{}" })
      .then(() => {
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
        setLocalSyncing(false);
        setSyncProgress(null);
        setSyncError(err);
      });
  };
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
          <a className="brand" href="/" onClick={(event) => navigate(event, "/", setPath)}>
            <span className="brand-icon">
              <img alt="" src={dosuDecantUrl} />
            </span>
            <span>Decant</span>
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
                    <a
                      aria-current={activeKey === item.key ? "page" : undefined}
                      href={item.href}
                      onClick={(event) => {
                        setMenuOpen(false);
                        navigate(event, item.href, setPath);
                      }}
                    >
                      <Icon name={item.icon} />
                      <span>{item.label}</span>
                    </a>
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
          <h1>{titleFor(active)}</h1>
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
            {active === "Sessions" && sessionPageState.error != null ? (
              <ApiFailureState
                error={sessionPageState.error}
                onRetry={requestRefresh}
                onSync={runSync}
              />
            ) : (
              renderView(active, path, data, {
                dateRange: dateRangeSelection,
                onDateRangeChange: (next) => {
                  if (sessionPageFromPath(path) > 1) {
                    visit(sessionsPageHref(path, 1), setPath);
                  }
                  setDateRangeSelection(next);
                },
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
  active: string,
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
  if (/^\/sessions\/\d+$/.test(pathname)) {
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
  switch (active) {
    case "Sessions":
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
    case "Projects":
      return (
        <ProjectsView onSync={actions.runSync} projects={data.projects} syncing={actions.syncing} />
      );
    case "Search":
      return <SearchView dateRange={actions.dateRange} path={path} />;
    case "Analytics":
      return (
        <AnalyticsView
          data={data}
          dateRange={actions.dateRange}
          onDateRangeChange={actions.onDateRangeChange}
          onSync={actions.runSync}
          syncing={actions.syncing}
        />
      );
    case "Insights":
      return (
        <InsightsView
          loading={actions.recommendationsLoading}
          loadFailed={actions.failedSlices.includes("recommendations")}
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
        <a className="primary-button" href="/">
          Back to Analytics
        </a>
      }
      detail={`There is no page at ${pathname}.`}
      icon="inbox"
      title="Page not found"
    />
  );
}

function SessionsView({
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
          <p>Every Claude Code and Codex session log on this device.</p>
        </div>
        <DateRangeControl bounds={data.dateBounds} range={dateRange} onChange={onDateRangeChange} />
      </header>

      <div className="stat-grid sessions-stat-grid">
        <StatCard
          icon="sessions"
          label="Sessions"
          tone="accent"
          value={formatInt(cardSummary.sessions)}
        />
        <StatCard
          icon="messages"
          label="Messages"
          tone="info"
          value={formatInt(cardSummary.messages)}
        />
        <StatCard
          icon="money"
          label="Est. cost"
          tone="success"
          value={money(cardSummary.estimated_cost_usd)}
        />
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
              <a
                aria-label="Clear project filter"
                href={sessionsArchivedHref("/sessions", includeArchived)}
              >
                <Icon name="x" />
              </a>
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

function ProjectsView({
  onSync,
  projects,
  syncing,
}: {
  onSync: () => void;
  projects: ProjectSummary[];
  syncing: boolean;
}) {
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
            action={
              <button
                aria-busy={syncing}
                aria-label="Sync session logs"
                className={`primary-button sync-button${syncing ? " is-syncing" : ""}`}
                disabled={syncing}
                onClick={onSync}
                type="button"
              >
                <Icon name="refresh" />
                {syncing ? null : "Sync now"}
              </button>
            }
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
                      <a className="path-stack" href={projectSessionsHref(project.path)}>
                        <strong>{projectName(project)}</strong>
                        <small>{project.path}</small>
                      </a>
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

const SessionTableRow = memo(function SessionTableRow({
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
            <a href={`/sessions/${session.id}`}>{title}</a>
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
          <a href={projectSessionsHref(session.project_path)}>{basename(session.project_path)}</a>
        )}
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
      <td className="numeric">{money(sessionThreadCost(session))}</td>
      <td className="numeric muted">
        <SessionStartedAt value={session.started_at} />
      </td>
    </tr>
  );
});

function DosuProvenanceBadge({ session }: { session: SessionSummary }) {
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

function SessionStartedAt({ value }: { value: string | null }) {
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

type PaletteItemKind = "recent" | "session" | "page" | "action" | "content-search";

interface PaletteItem extends CommandPaletteItem {
  activate: () => void;
  detail?: string;
  highlights?: SessionHighlights;
  icon: IconName;
  kind: PaletteItemKind;
  row?: SessionSearchIndexRow;
}

function CommandPalette({
  analyticsReportHref,
  onClose,
  onNavigate,
  onRunSync,
  onToggleTheme,
  open,
  refreshKey,
  syncing,
}: {
  analyticsReportHref: string;
  onClose: () => void;
  onNavigate: (href: string) => void;
  onRunSync: () => void;
  onToggleTheme: () => void;
  open: boolean;
  refreshKey: number;
  syncing: boolean;
}) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SessionSearchIndexRow[]>([]);
  const [loadedRefreshKey, setLoadedRefreshKey] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [indexError, setIndexError] = useState<unknown>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const activeItemIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const listboxId = useId();
  closeRef.current = onClose;
  const requestClose = useCallback(() => closeRef.current(), []);
  useDialogFocusTrap(open, dialogRef, requestClose);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery("");
    setRecentSearches(readRecentSearches());
    activeItemIdRef.current = null;
    setActiveIndex(null);
  }, [open]);

  useEffect(() => {
    if (!open || loadedRefreshKey === refreshKey) {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setIndexError(null);
    void getJson<SessionSearchIndexRow[]>("/api/sessions/search-index", {
      signal: controller.signal,
    })
      .then((nextRows) => {
        if (controller.signal.aborted) {
          return;
        }
        setRows(nextRows);
        setLoadedRefreshKey(refreshKey);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setIndexError(error);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [loadedRefreshKey, open, refreshKey]);

  const fuzzyIndex: SessionSearchIndex = useMemo(() => createSessionSearchIndex(rows), [rows]);
  const normalizedQuery = query.trim();
  const matches = useMemo(
    () => (normalizedQuery === "" ? [] : fuzzyIndex.search(normalizedQuery, 10)),
    [fuzzyIndex, normalizedQuery],
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  const recentItems: PaletteItem[] = recentSearches.map((recent) => ({
    id: `recent:${recent}`,
    label: recent,
    detail: "Search transcript content",
    icon: "clock",
    kind: "recent",
    activate: () => {
      rememberSearch(recent);
      onNavigate(searchRouteHref(recent, locationPath()));
    },
  }));
  const sessionMatches =
    normalizedQuery === ""
      ? rows.slice(0, 6).map((row) => ({ id: row.id, highlights: {} }))
      : matches;
  const sessionItems: PaletteItem[] = sessionMatches.flatMap((match) => {
    const row = rowById.get(match.id);
    if (row == null) {
      return [];
    }
    return [
      {
        id: `session:${row.id}`,
        label: row.title?.trim() || `Session ${row.id}`,
        detail: paletteSessionDetail(row),
        highlights: match.highlights,
        icon: "sessions",
        kind: "session",
        row,
        activate: () => onNavigate(`/sessions/${row.id}`),
      },
    ];
  });
  const pageItems: PaletteItem[] = navItems
    .filter((item) => commandPaletteTextMatches(normalizedQuery, item.label))
    .map((item) => ({
      id: `page:${item.key}`,
      label: item.label,
      detail: item.href,
      icon: item.icon,
      kind: "page",
      activate: () => onNavigate(item.href),
    }));
  const availableActions: PaletteItem[] = [
    ...(syncing
      ? []
      : [
          {
            id: "action:sync",
            label: "Run sync",
            detail: "Ingest changed local session logs",
            icon: "refresh" as const,
            kind: "action" as const,
            activate: onRunSync,
          },
        ]),
    {
      id: "action:theme",
      label: "Toggle theme",
      detail: "Cycle system, light, and dark",
      icon: "sun",
      kind: "action",
      activate: () => {
        onToggleTheme();
        requestClose();
      },
    },
    {
      id: "action:report",
      label: "Analytics report",
      detail: "Review and export the active date range",
      icon: "chart",
      kind: "action",
      activate: () => onNavigate(analyticsReportHref),
    },
    {
      id: "action:settings",
      label: "Settings",
      detail: "Agent, terminal, and editor preferences",
      icon: "settings",
      kind: "action",
      activate: () => onNavigate("/settings"),
    },
  ];
  const actionItems = availableActions.filter((item) =>
    commandPaletteTextMatches(normalizedQuery, `${item.label} ${item.detail ?? ""}`),
  );
  const contentSearch: PaletteItem | null =
    normalizedQuery === ""
      ? null
      : {
          id: "content-search",
          label: `Search transcript content for “${normalizedQuery}”`,
          detail: "Messages, tool calls, and results",
          icon: "search",
          kind: "content-search",
          activate: () => {
            const remembered = rememberSearch(normalizedQuery);
            setRecentSearches(remembered);
            onNavigate(searchRouteHref(normalizedQuery, locationPath()));
          },
        };
  const groups = buildCommandPaletteGroups({
    query,
    recent: recentItems,
    sessions: sessionItems,
    pages: pageItems,
    actions: actionItems,
    contentSearch,
  });
  const items = flattenCommandPaletteItems(groups);
  const renderedItemKey = items.map((item) => item.id).join("\u0000");

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    void renderedItemKey;
    const nextIndex = reconcileCommandPaletteActiveIndex(activeItemIdRef.current, items);
    activeItemIdRef.current = nextIndex == null ? null : (items[nextIndex]?.id ?? null);
    setActiveIndex(nextIndex);
  }, [items, open, renderedItemKey]);

  const selectPaletteIndex = (index: number | null) => {
    const nextIndex = index != null && items[index] != null ? index : null;
    activeItemIdRef.current = nextIndex == null ? null : (items[nextIndex]?.id ?? null);
    setActiveIndex(nextIndex);
  };

  useEffect(() => {
    if (activeIndex == null) {
      return;
    }
    dialogRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) {
    return null;
  }

  const renderedActiveIndex =
    activeIndex != null && items[activeIndex] != null ? activeIndex : null;
  const activeItem = renderedActiveIndex == null ? null : (items[renderedActiveIndex] ?? null);
  const activeDescendant =
    renderedActiveIndex == null ? undefined : `command-palette-item-${renderedActiveIndex}`;
  const quickMatchCount = sessionItems.length + pageItems.length + actionItems.length;
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements Escape and the explicit close button.
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="command-palette"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="sr-only" id={titleId}>
          Search and commands
        </h2>
        <div className="command-palette-input-row">
          <Icon name="search" />
          <input
            aria-activedescendant={activeDescendant}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={true}
            aria-label="Search sessions and commands"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const result = reduceCommandPaletteKey(
                { activeIndex },
                {
                  key: event.key,
                  itemCount: items.length,
                  isComposing: event.nativeEvent.isComposing,
                },
              );
              if (!result.handled) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              if (result.effect === "close") {
                requestClose();
                return;
              }
              if (result.effect === "activate") {
                activeItem?.activate();
                return;
              }
              selectPaletteIndex(result.activeIndex);
            }}
            placeholder="Search sessions or run a command…"
            role="combobox"
            value={query}
          />
          <button
            aria-label="Close command palette"
            className="icon-button command-palette-close"
            onClick={requestClose}
            type="button"
          >
            <Icon name="x" />
          </button>
        </div>
        <div aria-live="polite" className="command-palette-state-region">
          {loading && rows.length === 0 ? (
            <p className="command-palette-state" role="status">
              Loading session index…
            </p>
          ) : null}
          {indexError != null && rows.length === 0 ? (
            <p className="command-palette-state is-error" role="status">
              Session shortcuts are unavailable. Pages and actions still work.
            </p>
          ) : null}
          {normalizedQuery !== "" && quickMatchCount === 0 && !loading && indexError == null ? (
            <p className="command-palette-state">No quick matches. Try transcript search below.</p>
          ) : null}
        </div>
        <div className="command-palette-results" id={listboxId} role="listbox">
          {groups.map((group) => {
            const labelId = `${listboxId}-${group.id}-label`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: fieldset is not a valid listbox child; this div is an explicit ARIA group.
              <div
                aria-labelledby={labelId}
                className={`command-palette-group is-${group.id}`}
                key={group.id}
                role="group"
              >
                <div
                  className={group.label == null ? "sr-only" : "command-palette-group-label"}
                  id={labelId}
                >
                  {group.label ?? "Transcript search"}
                </div>
                {group.items.map((item) => {
                  const index = items.indexOf(item);
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation is owned by the combobox through aria-activedescendant.
                    <div
                      aria-selected={index === activeIndex}
                      className={`command-palette-item is-${item.kind}${
                        index === activeIndex ? " is-active" : ""
                      }`}
                      data-palette-index={index}
                      id={`command-palette-item-${index}`}
                      key={item.id}
                      onClick={() => item.activate()}
                      onMouseDown={(event) => event.preventDefault()}
                      onPointerMove={(event) => {
                        if (pointerMovementChangesSelection(event)) {
                          selectPaletteIndex(index);
                        }
                      }}
                      role="option"
                      tabIndex={-1}
                    >
                      <span className="command-palette-item-icon">
                        <Icon name={item.icon} />
                      </span>
                      <span className="command-palette-item-copy">
                        <strong>
                          <PaletteHighlightedText
                            ranges={item.highlights?.title}
                            text={item.label}
                          />
                        </strong>
                        {item.kind === "session" && item.row != null ? (
                          <PaletteSessionMeta highlights={item.highlights} row={item.row} />
                        ) : item.detail == null ? null : (
                          <span>{item.detail}</span>
                        )}
                      </span>
                      {item.kind === "session" && item.row?.started_at != null ? (
                        <time
                          className="command-palette-item-date"
                          dateTime={item.row.started_at}
                          title={fullDateTime(item.row.started_at) ?? item.row.started_at}
                        >
                          <PaletteHighlightedText
                            ranges={item.highlights?.started_at}
                            text={item.row.started_at.slice(0, 10)}
                          />
                        </time>
                      ) : item.kind === "content-search" ? (
                        <kbd>↵</kbd>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <footer className="command-palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function commandPaletteTextMatches(query: string, text: string): boolean {
  if (query === "") {
    return true;
  }
  const lower = text.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((term) => lower.includes(term));
}

function paletteSessionDetail(row: SessionSearchIndexRow): string {
  return [row.project, row.tool, row.model]
    .filter((value) => value != null && value !== "")
    .join(" · ");
}

function PaletteSessionMeta({
  highlights,
  row,
}: {
  highlights: SessionHighlights | undefined;
  row: SessionSearchIndexRow;
}) {
  const values = [
    { field: "project" as const, value: row.project },
    { field: "tool" as const, value: row.tool },
    { field: "model" as const, value: row.model },
  ].filter(
    (entry): entry is { field: "project" | "tool" | "model"; value: string } =>
      entry.value != null && entry.value !== "",
  );
  return (
    <span>
      {values.map((entry, index) => (
        <span key={entry.field}>
          {index > 0 ? " · " : null}
          <PaletteHighlightedText ranges={highlights?.[entry.field]} text={entry.value} />
        </span>
      ))}
    </span>
  );
}

function PaletteHighlightedText({
  ranges,
  text,
}: {
  ranges: readonly SessionHighlightRange[] | undefined;
  text: string;
}) {
  if (ranges == null || ranges.length === 0) {
    return text;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    const [start, end] = range;
    if (start > cursor) {
      parts.push(<span key={`text-${index}`}>{text.slice(cursor, start)}</span>);
    }
    parts.push(<mark key={`match-${index}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push(<span key="text-tail">{text.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

function SearchView({ dateRange, path }: { dateRange: DateRangeSelection; path: string }) {
  const pageSize = 25;
  const initialQuery = new URLSearchParams(path.split("?")[1] ?? "").get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [totalIsCapped, setTotalIsCapped] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [retryKey, setRetryKey] = useState(0);
  const [recentSearches, setRecentSearches] = useState(readRecentSearches);
  const searchEpochRef = useRef(0);
  const resultsQueryRef = useRef<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const hitsLengthRef = useRef(0);
  const totalRef = useRef<number | null>(null);
  const totalIsCappedRef = useRef(false);
  hitsLengthRef.current = hits.length;
  totalRef.current = total;
  totalIsCappedRef.current = totalIsCapped;
  const rangeFrom = dateRange.from;
  const rangeTo = dateRange.to;
  const requestScope = useMemo(
    () => searchRequestScope(path, { from: rangeFrom, to: rangeTo }),
    [path, rangeFrom, rangeTo],
  );
  const requestScopeKey = JSON.stringify(requestScope);

  useLayoutEffect(() => {
    void requestScopeKey;
    searchEpochRef.current += 1;
    resultsQueryRef.current = null;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    setHits([]);
    setTotal(null);
    totalRef.current = null;
    setTotalIsCapped(false);
    totalIsCappedRef.current = false;
    setHasMore(false);
    setElapsedMs(0);
    setActiveIndex(-1);
    setQuery(initialQuery);
    return () => {
      loadMoreControllerRef.current?.abort();
    };
  }, [initialQuery, requestScopeKey]);

  useEffect(() => {
    const epoch = searchEpochRef.current + 1;
    searchEpochRef.current = epoch;
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    const trimmed = query.trim();
    void retryKey;
    if (trimmed.length < 2) {
      resultsQueryRef.current = null;
      setHits([]);
      setTotal(null);
      totalRef.current = null;
      setTotalIsCapped(false);
      totalIsCappedRef.current = false;
      setHasMore(false);
      setElapsedMs(0);
      setSearching(false);
      setError(null);
      return;
    }
    setSearching(true);
    setError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getJson<SearchResponse>("/api/search", {
        method: "POST",
        body: JSON.stringify({
          query: trimmed,
          include_subagents: true,
          include_total: false,
          limit: pageSize,
          offset: 0,
          ...requestScope,
        }),
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted || searchEpochRef.current !== epoch) {
            return;
          }
          setHits(response.results);
          setHasMore(
            searchPageMayHaveMore({
              lastPageSize: response.results.length,
              loaded: response.results.length,
              pageSize,
              total: totalRef.current,
              totalIsCapped: totalIsCappedRef.current,
            }),
          );
          setElapsedMs(response.elapsed_ms);
          setActiveIndex(response.results.length > 0 ? 0 : -1);
          resultsQueryRef.current = trimmed;
          setRecentSearches(rememberSearch(trimmed));
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted && searchEpochRef.current === epoch) {
            setError(err);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && searchEpochRef.current === epoch) {
            setSearching(false);
          }
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, requestScope, retryKey]);

  useEffect(() => {
    const trimmed = query.trim();
    void retryKey;
    if (trimmed.length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const epoch = searchEpochRef.current;
      void getJson<SearchResponse>("/api/search", {
        method: "POST",
        body: JSON.stringify({
          query: trimmed,
          include_subagents: true,
          include_total: true,
          limit: 1,
          offset: 0,
          ...requestScope,
        }),
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted || searchEpochRef.current !== epoch) {
            return;
          }
          totalRef.current = response.total;
          totalIsCappedRef.current = response.total_is_capped;
          setTotal(response.total);
          setTotalIsCapped(response.total_is_capped);
          setHasMore(
            searchPageMayHaveMore({
              lastPageSize: 0,
              loaded: hitsLengthRef.current,
              pageSize,
              total: response.total,
              totalIsCapped: response.total_is_capped,
            }),
          );
        })
        .catch(() => {
          // A count is supplementary; keep the fast ranked results usable when
          // the slower total request is interrupted or unavailable.
        });
    }, 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, requestScope, retryKey]);

  const orderedHits = visuallyOrderedSearchHits(hits);
  const groups = groupSearchHits(orderedHits);
  const exactRemaining = exactSearchRemaining(total, hits.length, totalIsCapped);
  const activeHit = activeIndex < 0 ? null : (orderedHits[activeIndex] ?? null);
  const activeHitId = activeHit == null ? undefined : `search-hit-${activeHit.block_id}`;
  useEffect(() => {
    if (activeIndex < 0) {
      return;
    }
    document
      .querySelector<HTMLElement>(`[data-search-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  const loadMore = () => {
    const trimmed = query.trim();
    if (searching || !hasMore || trimmed.length < 2) {
      return;
    }
    setSearching(true);
    setError(null);
    const epoch = searchEpochRef.current;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    void getJson<SearchResponse>("/api/search", {
      method: "POST",
      body: JSON.stringify({
        query: trimmed,
        include_subagents: true,
        include_total: false,
        limit: pageSize,
        offset: hits.length,
        ...requestScope,
      }),
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted || searchEpochRef.current !== epoch) {
          return;
        }
        const loaded = hits.length + response.results.length;
        setHits((current) => [...current, ...response.results]);
        setHasMore(
          searchPageMayHaveMore({
            lastPageSize: response.results.length,
            loaded,
            pageSize,
            total: totalRef.current,
            totalIsCapped: totalIsCappedRef.current,
          }),
        );
        setElapsedMs(response.elapsed_ms);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted && searchEpochRef.current === epoch) {
          setError(err);
        }
      })
      .finally(() => {
        if (loadMoreControllerRef.current === controller) {
          loadMoreControllerRef.current = null;
        }
        if (!controller.signal.aborted && searchEpochRef.current === epoch) {
          setSearching(false);
        }
      });
  };

  return (
    <div className="search-page">
      <header className="page-heading">
        <h1>Search</h1>
        <p>Full-text search across every message and tool call in your session logs.</p>
      </header>

      <form className="search-form" onSubmit={(event) => event.preventDefault()}>
        <Icon name="search" />
        <input
          aria-activedescendant={activeHitId}
          aria-autocomplete="list"
          aria-busy={searching}
          aria-controls="search-results-listbox"
          aria-expanded={orderedHits.length > 0}
          autoComplete="off"
          onChange={(event) => {
            searchEpochRef.current += 1;
            resultsQueryRef.current = null;
            loadMoreControllerRef.current?.abort();
            loadMoreControllerRef.current = null;
            setHits([]);
            setTotal(null);
            totalRef.current = null;
            setTotalIsCapped(false);
            totalIsCappedRef.current = false;
            setHasMore(false);
            setElapsedMs(0);
            setActiveIndex(-1);
            setSearching(event.target.value.trim().length >= 2);
            updateSearchRoute(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && orderedHits.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index + 1 + orderedHits.length) % orderedHits.length);
            } else if (event.key === "ArrowUp" && orderedHits.length > 0) {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + orderedHits.length) % orderedHits.length);
            } else if (
              event.key === "Enter" &&
              !searching &&
              activeHit != null &&
              resultsQueryRef.current === query.trim()
            ) {
              event.preventDefault();
              visit(activeHit.href);
            } else if (event.key === "Escape") {
              event.preventDefault();
              updateSearchRoute("");
            }
          }}
          placeholder="Search across all sessions and tool calls..."
          role="combobox"
          value={query}
        />
      </form>

      {query.trim().length >= 2 && (searching || hits.length > 0 || total != null) ? (
        <p className="result-caption">
          {total == null
            ? hits.length === 0
              ? "Finding matches"
              : `Showing ${formatInt(hits.length)} matches`
            : `${formatInt(total)}${totalIsCapped ? "+" : ""} ${
                total === 1 ? "result" : "results"
              }`}{" "}
          · {formatSearchTime(elapsedMs)}
        </p>
      ) : null}
      {error != null ? (
        <ApiFailureState error={error} onRetry={() => setRetryKey((key) => key + 1)} />
      ) : null}

      <div className="search-results">
        {searching && hits.length === 0 ? <div className="searching-state">Searching…</div> : null}
        {!searching && query.trim().length < 2 ? (
          <EmptyState
            action={
              recentSearches.length > 0 ? (
                <div className="recent-searches">
                  {recentSearches.map((recent) => (
                    <button
                      className="secondary-button"
                      key={recent}
                      onClick={() => updateSearchRoute(recent)}
                      type="button"
                    >
                      {recent}
                    </button>
                  ))}
                </div>
              ) : undefined
            }
            icon="search"
            message="Type at least two characters to search messages, tools, and sessions."
            title="Search your session logs"
          />
        ) : null}
        {!searching && query.trim().length >= 2 && hits.length === 0 ? (
          <EmptyState
            action={
              <button
                className="secondary-button"
                onClick={() => updateSearchRoute("")}
                type="button"
              >
                Clear search
              </button>
            }
            icon="inbox"
            message="Nothing matched your search. Try a different term."
            title="No matches"
          />
        ) : null}
        <div aria-label="Search results" id="search-results-listbox" role="listbox">
          {groups.map((group) => (
            <section className="search-result-group" key={group.sessionId} role="presentation">
              <header className="search-group-heading">
                <div className="search-group-title">
                  <strong>{group.title}</strong>
                  <span>{basename(group.project)}</span>
                </div>
                <span>{shortDate(group.timestamp ?? "")}</span>
              </header>
              <div role="presentation">
                {group.hits.map((hit) => {
                  const index = orderedHits.indexOf(hit);
                  return (
                    <a
                      aria-current={index === activeIndex ? "true" : undefined}
                      aria-selected={index === activeIndex}
                      className="result-card search-hit-row"
                      data-search-index={index}
                      href={hit.href}
                      id={`search-hit-${hit.block_id}`}
                      key={hit.block_id}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={(event) => navigate(event, hit.href)}
                      role="option"
                    >
                      <div className="result-card-heading">
                        <Badge tone="neutral">{searchHitLabel(hit)}</Badge>
                        <span>message {hit.message_seq}</span>
                      </div>
                      <p>
                        <HighlightedSnippet snippet={hit.snippet} />
                      </p>
                    </a>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        {hasMore ? (
          <button
            className="secondary-button search-load-more"
            disabled={searching}
            onClick={loadMore}
            type="button"
          >
            {searching
              ? "Loading…"
              : exactRemaining == null
                ? "Load more"
                : `Load more · ${formatInt(exactRemaining)} remaining`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function groupSearchHits(hits: SearchHit[]) {
  const groups = new Map<
    number,
    {
      hits: SearchHit[];
      project: string | null;
      sessionId: number;
      timestamp: string | null;
      title: string;
    }
  >();
  for (const hit of hits) {
    const group = groups.get(hit.session_id);
    if (group == null) {
      groups.set(hit.session_id, {
        hits: [hit],
        project: hit.project,
        sessionId: hit.session_id,
        timestamp: hit.timestamp,
        title: hit.session_title ?? `Session ${hit.session_id}`,
      });
    } else {
      group.hits.push(hit);
    }
  }
  return [...groups.values()];
}

function searchHitLabel(hit: SearchHit): string {
  if (hit.block_type === "tool_use") {
    return hit.tool === "" ? "tool call" : hit.tool;
  }
  return hit.role === "" ? hit.block_type : hit.role;
}

function formatSearchTime(elapsedMs: number): string {
  return elapsedMs < 1 ? "<1 ms" : `${Math.round(elapsedMs)} ms`;
}

function readRecentSearches(): string[] {
  try {
    const key = "decant-recent-searches";
    const current = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return normalizeRecentSearches(current);
  } catch {
    return [];
  }
}

function rememberSearch(query: string): string[] {
  const values = normalizeRecentSearches(readRecentSearches(), query);
  try {
    localStorage.setItem("decant-recent-searches", JSON.stringify(values));
  } catch {
    // Search still works when storage is unavailable.
  }
  return values;
}

function HighlightedSnippet({ snippet }: { snippet: string }) {
  return (
    <>
      {searchSnippetParts(snippet).map((part) =>
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
type McpSortKey = "calls" | "errors" | "last_used" | "p50" | "server" | "tools";
type ToolSortKey = "calls" | "errors" | "kind" | "last_used" | "p50" | "server" | "tool";
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
    case "last_used":
      return row.last_used_at == null ? 0 : Date.parse(row.last_used_at);
    case "p50":
      return row.p50_ms;
    case "server":
      // The short name on purpose, not the disambiguated label: two
      // registrations of one server sort adjacently, which is where a reader
      // expects to find them.
      return formatMcpServer(row.mcp_server);
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
    case "last_used":
      return row.last_used_at == null ? 0 : Date.parse(row.last_used_at);
    case "p50":
      return row.p50_ms;
    case "server":
      // The short name on purpose, not the disambiguated label: two
      // registrations of one server sort adjacently, which is where a reader
      // expects to find them.
      return formatMcpServer(row.mcp_server);
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

/**
 * Shown when the archive holds nothing at all, which is what a first run looks
 * like now that Analytics is the landing route. Distinct from the per-panel
 * "No data in range" state: telling someone with no sessions to widen a date
 * range sends them to a control that cannot help.
 */
function FirstRunPanel({ onSync, syncing }: { onSync: () => void; syncing: boolean }) {
  return (
    <section className="panel first-run">
      <div className="panel-body">
        <span className="first-run-icon">
          <Icon name="beaker" />
        </span>
        <h2>No sessions yet</h2>
        <p>
          Decant reads the JSONL logs Claude Code and Codex already write and turns them into a
          searchable session-log index with token, cost, and context-window analytics. Nothing
          leaves this machine.
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

const ANALYTICS_REPORT_INCLUDES = [
  "Selected date range, local timezone, session totals, tokens, and estimated costs",
  "Model names and full project paths, activity charts, and token economics",
  "For all-time reports, up to five open insight titles, details, impact labels, and suggestions",
] as const;

const SESSION_REPORT_INCLUDES = [
  "Session title and first user-prompt preview (up to 180 characters)",
  "Full project path, model, effort, dates, and estimated cost",
  "Context-window and token-economics summaries",
  "Tool-call aggregates and up to 25 referenced file paths",
] as const;

const ANALYTICS_REPORT_NEVER_INCLUDES = [
  "Transcript messages, tool inputs, or tool-result bodies",
  "Credentials, source-file contents, or the session-log database",
  "Remote scripts, fonts, or tracking pixels",
] as const;

const SESSION_REPORT_NEVER_INCLUDES = [
  "Transcript messages beyond the disclosed prompt preview, tool inputs, or tool-result bodies",
  "Credentials, source-file contents, or the session-log database",
  "Remote scripts, fonts, or tracking pixels",
] as const;

function dialogFocusTargets(dialog: HTMLElement | null): HTMLElement[] {
  if (dialog == null) {
    return [];
  }
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getClientRects().length > 0);
}

function useDialogFocusTrap(
  open: boolean,
  dialogRef: { current: HTMLElement | null },
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      (dialogFocusTargets(dialog)[0] ?? dialog)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const dialog = dialogRef.current;
      const focusTargets = dialogFocusTargets(dialog);
      const first = focusTargets[0];
      const last = focusTargets.at(-1);
      if (dialog == null) {
        return;
      }
      if (first == null || last == null) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      if (returnFocus?.isConnected === true) {
        returnFocus.focus();
      }
    };
  }, [dialogRef, onClose, open]);
}

function PrivacyReviewLists({
  className,
  excluded,
  excludedLabel,
  included,
  includedLabel,
}: {
  className: string;
  excluded: readonly string[];
  excludedLabel: string;
  included: readonly string[];
  includedLabel: string;
}) {
  return (
    <div className={className}>
      <div>
        <h3>{includedLabel}</h3>
        <ul>
          {included.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <div>
        <h3>{excludedLabel}</h3>
        <ul>
          {excluded.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ExportReviewSheet({
  actions,
  excluded,
  includes,
  notice,
  onClose,
  open,
  title,
}: {
  actions: ReactNode;
  excluded: readonly string[];
  includes: readonly string[];
  notice?: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useDialogFocusTrap(open, dialogRef, onClose);
  if (!open) {
    return null;
  }
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements Escape and the explicit close button.
    <div
      className="report-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="report-review-sheet"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <span className="section-eyebrow">Privacy review</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button
            aria-label="Close report review"
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="report-review-body">
          <PrivacyReviewLists
            className="report-privacy-review"
            excluded={excluded}
            excludedLabel="It never includes"
            included={includes}
            includedLabel="This report includes"
          />
          {notice}
        </div>
        <footer>{actions}</footer>
      </section>
    </div>,
    document.body,
  );
}

function ReportExportButton({
  excluded,
  href,
  includes,
  previewHref,
  title,
}: {
  excluded: readonly string[];
  href: string;
  includes: readonly string[];
  previewHref: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeReview = useCallback(() => setOpen(false), []);

  const printReport = () => {
    const preview = window.open("", "_blank", "noopener=false");
    if (preview == null) {
      setError("Allow pop-ups for this local page, then try again.");
      return;
    }
    preview.document.write("<p style='font-family:system-ui;padding:2rem'>Preparing report…</p>");
    setPrinting(true);
    setError(null);
    void fetch(href)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Report request failed (${response.status})`);
        }
        const documentHtml = await response.text();
        preview.document.open();
        preview.document.write(documentHtml);
        preview.document.close();
        await waitForReportFonts(preview.document);
        preview.focus();
        preview.print();
        closeReview();
      })
      .catch((reason: unknown) => {
        preview.close();
        setError(errorMessage(reason));
      })
      .finally(() => setPrinting(false));
  };

  return (
    <>
      <button
        className="primary-button report-action-button"
        onClick={() => setOpen(true)}
        type="button"
      >
        <Icon name="eye" />
        View report
      </button>
      <ExportReviewSheet
        actions={
          <>
            <button
              className="secondary-button"
              disabled={printing}
              onClick={printReport}
              type="button"
            >
              <Icon name="filePdf" />
              Save as PDF
            </button>
            <a className="secondary-button" download href={href} onClick={closeReview}>
              <Icon name="fileCode" />
              Download HTML
            </a>
            <a
              className="primary-button"
              href={previewHref}
              onClick={(event) => {
                closeReview();
                navigate(event, previewHref);
              }}
            >
              <Icon name="eye" />
              View report
            </a>
          </>
        }
        excluded={excluded}
        includes={includes}
        notice={error != null ? <div className="notice danger">{error}</div> : null}
        onClose={closeReview}
        open={open}
        title={title}
      />
    </>
  );
}

function ReportRouteExportActions({
  downloadHref,
  excluded,
  includes,
  onPrint,
  printDisabled,
  title,
}: {
  downloadHref: string;
  excluded: readonly string[];
  includes: readonly string[];
  onPrint: () => void;
  printDisabled: boolean;
  title: string;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const closeReview = useCallback(() => setReviewOpen(false), []);
  return (
    <>
      <button className="secondary-button" onClick={() => setReviewOpen(true)} type="button">
        <Icon name="fileCode" />
        Download HTML
      </button>
      <button
        className="primary-button"
        disabled={printDisabled}
        onClick={() => setReviewOpen(true)}
        type="button"
      >
        <Icon name="filePdf" />
        Save as PDF
      </button>
      <ExportReviewSheet
        actions={
          <>
            <button
              className="secondary-button"
              disabled={printDisabled}
              onClick={() => {
                closeReview();
                onPrint();
              }}
              type="button"
            >
              <Icon name="filePdf" />
              Save as PDF
            </button>
            <a className="secondary-button" download href={downloadHref} onClick={closeReview}>
              <Icon name="fileCode" />
              Download HTML
            </a>
          </>
        }
        excluded={excluded}
        includes={includes}
        onClose={closeReview}
        open={reviewOpen}
        title={`Review ${title.toLowerCase()}`}
      />
    </>
  );
}

function ReportRouteView({
  backHref,
  downloadHref,
  excluded,
  includes,
  onSync,
  sourceHref,
  title,
}: {
  backHref: string;
  downloadHref: string;
  excluded: readonly string[];
  includes: readonly string[];
  onSync: () => void;
  sourceHref: string;
  title: string;
}) {
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retryKey, setRetryKey] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    void retryKey;
    const controller = new AbortController();
    setDocumentHtml(null);
    setError(null);
    void fetchReportHtml(sourceHref, controller.signal)
      .then(setDocumentHtml)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason);
        }
      });
    return () => controller.abort();
  }, [retryKey, sourceHref]);

  return (
    <div
      className="report-route-theme"
      style={{
        background: "#eef0ec",
        color: "#24302a",
        minHeight: "100vh",
      }}
    >
      <style>{`
        @media print {
          .report-route-toolbar { display: none !important; }
          .report-route-frame { height: 100vh !important; }
        }
      `}</style>
      <header
        className="report-route-toolbar"
        style={{
          alignItems: "center",
          background: "#fff",
          borderBottom: "1px solid #dce1da",
          display: "flex",
          gap: "10px",
          minHeight: "58px",
          padding: "10px 18px",
          position: "sticky",
          top: 0,
          zIndex: 2,
        }}
      >
        <a
          className="secondary-button"
          href={backHref}
          onClick={(event) => navigate(event, backHref)}
        >
          <Icon name="arrowLeft" />
          Back
        </a>
        <strong style={{ marginRight: "auto" }}>{title}</strong>
        <ReportRouteExportActions
          downloadHref={downloadHref}
          excluded={excluded}
          includes={includes}
          onPrint={() => {
            const frameWindow = frameRef.current?.contentWindow;
            if (frameWindow != null) {
              void waitForReportFonts(frameWindow.document).then(() => frameWindow.print());
            }
          }}
          printDisabled={documentHtml == null}
          title={title}
        />
      </header>
      {error != null ? (
        <div style={{ margin: "32px auto", maxWidth: "760px", padding: "0 20px" }}>
          <ApiFailureState
            error={error}
            onRetry={() => setRetryKey((key) => key + 1)}
            onSync={onSync}
          />
        </div>
      ) : documentHtml == null ? (
        <div style={{ margin: "32px auto", maxWidth: "760px", padding: "0 20px" }}>
          <EmptyState
            icon="file"
            message="Preparing the local report preview."
            title="Loading report"
          />
        </div>
      ) : (
        <iframe
          className="report-route-frame"
          ref={frameRef}
          sandbox="allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox"
          srcDoc={documentHtml}
          style={{
            background: "#fff",
            border: 0,
            display: "block",
            height: "calc(100vh - 58px)",
            width: "100%",
          }}
          title={`${title} preview`}
        />
      )}
    </div>
  );
}

async function waitForReportFonts(document: Document): Promise<void> {
  if (document.fonts == null) {
    return;
  }
  await document.fonts.ready;
}

async function fetchReportHtml(path: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(path, {
    headers: { accept: "text/html, application/json" },
    signal,
  });
  if (response.ok) {
    return response.text();
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    // The recovery component has a status-based fallback for non-JSON errors.
  }
  const code =
    typeof payload.code === "string" && payload.code !== "" ? payload.code : "request_failed";
  const message =
    typeof payload.error === "string" && payload.error !== ""
      ? payload.error
      : `Report request failed (${response.status})`;
  const { code: _code, error: _error, ...extras } = payload;
  throw new ApiError(response.status, code, message, extras);
}

function AnalyticsView({
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
    () => localStorage.getItem(DOSU_ANALYTICS_DISMISSAL_KEY) === "1",
  );
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
        <ActivityPanel activity={data.activity} rangeLabels={byDay.map((row) => row.key)} />
        <WeekdayPanel activity={data.activity} rangeLabels={byDay.map((row) => row.key)} />
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
              localStorage.setItem(DOSU_ANALYTICS_DISMISSAL_KEY, "1");
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
                      <a href={projectSessionsHref(row.key)}>{basename(row.key)}</a>
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

function ActivityPanel({
  activity,
  rangeLabels,
}: {
  activity: Activity | null;
  rangeLabels: string[];
}) {
  const labels = Array.from({ length: 24 }, (_, hour) => hourLabel(hour));
  const peak = activity?.peak_hour ?? peakIndex(activity?.by_hour ?? []);
  const range = shareRange(rangeLabels);
  const shareInput: ShareCardCopyInput = {
    kind: "busiest_hours",
    labels,
    values: activity?.by_hour ?? [],
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

function WeekdayPanel({
  activity,
  rangeLabels,
}: {
  activity: Activity | null;
  rangeLabels: string[];
}) {
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const peak = activity?.peak_weekday ?? peakIndex(activity?.by_weekday ?? []);
  const range = shareRange(rangeLabels);
  const shareInput: ShareCardCopyInput = {
    kind: "busiest_days",
    labels,
    values: activity?.by_weekday ?? [],
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
  const labels = rows.map((row) => row.key);
  const values = rows.map((row) => (metric === "sessions" ? row.sessions : row.estimated_cost_usd));
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

function ShareChartButton({
  disabled = false,
  input,
  metric,
  variant,
}: {
  disabled?: boolean;
  input: ShareCardCopyInput;
  metric: AnalyticsChartMetric;
  variant: AnalyticsChartVariant;
}) {
  const [open, setOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [png, setPng] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const renderVersionRef = useRef(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeShareReview = useCallback(() => setOpen(false), []);
  const title = shareCardTitle(input.kind);
  const caption = shareCardCaption(input);
  const altText = shareCardAltText(input);
  const filename = shareCardFilename(input.kind, input.start, input.end);

  const setPreview = useCallback((blob: Blob | null) => {
    if (previewUrlRef.current != null) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    const nextUrl = blob == null ? null : URL.createObjectURL(blob);
    previewUrlRef.current = nextUrl;
    setPreviewUrl(nextUrl);
    setPng(blob);
  }, []);

  const renderPreview = useCallback(async () => {
    const version = renderVersionRef.current + 1;
    renderVersionRef.current = version;
    setBusy(true);
    setStatus(null);
    try {
      const blob = await renderShareCardPng(input, metric, variant);
      if (renderVersionRef.current === version) {
        setPreview(blob);
      }
    } catch (error) {
      if (renderVersionRef.current === version) {
        setStatus(`Unable to render image: ${errorMessage(error)}`);
        setPreview(null);
      }
    } finally {
      if (renderVersionRef.current === version) {
        setBusy(false);
      }
    }
  }, [input, metric, setPreview, variant]);

  useEffect(
    () => () => {
      renderVersionRef.current += 1;
      if (previewUrlRef.current != null) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    [],
  );

  useDialogFocusTrap(open, dialogRef, closeShareReview);

  const copyText = async (value: string, success: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(success);
    } catch (error) {
      setStatus(`Clipboard unavailable: ${errorMessage(error)}`);
    }
  };

  const copyImage = async () => {
    if (png == null || typeof ClipboardItem === "undefined" || navigator.clipboard?.write == null) {
      setStatus("Image copying is unavailable in this browser. Download the PNG instead.");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setStatus("Image copied.");
    } catch (error) {
      setStatus(`Image copy failed: ${errorMessage(error)}`);
    }
  };

  const download = () => {
    if (previewUrl == null) {
      return;
    }
    const anchor = document.createElement("a");
    anchor.download = filename;
    anchor.href = previewUrl;
    anchor.click();
    setStatus(`Downloaded ${filename}.`);
  };

  const nativeShare = async () => {
    if (png == null || navigator.share == null) {
      setStatus("The native share sheet is unavailable in this browser.");
      return;
    }
    const file = new File([png], filename, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] }) === false) {
      setStatus("This browser cannot share PNG files. Download the image instead.");
      return;
    }
    try {
      await navigator.share({ files: [file], title, text: caption });
      setStatus("Shared from your device.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus("Share canceled.");
      } else {
        setStatus(`Share failed: ${errorMessage(error)}`);
      }
    }
  };

  return (
    <>
      <button
        aria-label={shareCardButtonLabel(input.kind)}
        className="chart-share-button"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          void renderPreview();
        }}
        type="button"
      >
        <Icon name="share" />
        Share
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements Escape and the explicit close button.
            <div
              className="share-review-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  closeShareReview();
                }
              }}
            >
              <section
                aria-labelledby={`share-title-${input.kind}`}
                aria-modal="true"
                className="share-review-sheet"
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
              >
                <header>
                  <div>
                    <span>Local, aggregate-only export</span>
                    <h2 id={`share-title-${input.kind}`}>Review {title}</h2>
                  </div>
                  <button
                    aria-label="Close share review"
                    className="icon-button"
                    onClick={closeShareReview}
                    type="button"
                  >
                    <Icon name="x" />
                  </button>
                </header>
                <div className="share-review-body">
                  <div className="share-preview">
                    {busy ? (
                      <div className="share-preview-loading">Rendering locally…</div>
                    ) : previewUrl == null ? (
                      <div className="share-preview-loading">Preview unavailable</div>
                    ) : (
                      <img alt={altText} src={previewUrl} />
                    )}
                    <p className="share-export-size">2× high-density PNG · 2400 × 1260</p>
                  </div>
                  <PrivacyReviewLists
                    className="share-privacy-review"
                    excluded={SHARE_EXCLUDED_FIELDS}
                    excludedLabel="Always excluded"
                    included={SHARE_INCLUDED_FIELDS}
                    includedLabel="Included"
                  />
                  <div className="share-copy-review">
                    <div>
                      <strong>Caption</strong>
                      <p>{caption}</p>
                    </div>
                    <div>
                      <strong>Alt text</strong>
                      <p>{altText}</p>
                    </div>
                  </div>
                </div>
                <footer>
                  <div className="share-actions">
                    <button
                      className="secondary-button"
                      disabled={png == null || busy}
                      onClick={() => void copyImage()}
                      type="button"
                    >
                      <Icon name="copy" />
                      Copy image
                    </button>
                    <button
                      className="secondary-button"
                      disabled={png == null || busy}
                      onClick={download}
                      type="button"
                    >
                      <Icon name="download" />
                      Download PNG
                    </button>
                    <button
                      className="secondary-button"
                      disabled={png == null || busy}
                      onClick={() => void nativeShare()}
                      type="button"
                    >
                      <Icon name="share" />
                      Share…
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void copyText(caption, "Caption copied.")}
                      type="button"
                    >
                      Copy caption
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void copyText(altText, "Alt text copied.")}
                      type="button"
                    >
                      Copy alt text
                    </button>
                  </div>
                  <p aria-live="polite">{status ?? "Nothing leaves this machine until you act."}</p>
                </footer>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

async function renderShareCardPng(
  input: ShareCardCopyInput,
  metric: AnalyticsChartMetric,
  variant: AnalyticsChartVariant,
): Promise<Blob> {
  const scale = SHARE_CARD_SCALE;
  const chartNode = document.createElement("div");
  chartNode.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1080px;height:310px;pointer-events:none";
  document.body.append(chartNode);
  const echarts = await import("echarts");
  const chart = echarts.init(chartNode, null, {
    renderer: "canvas",
    width: 1080,
    height: 310,
  });
  let chartUrl: string;
  try {
    const state = prepareAnalyticsChartState({
      labels: input.labels,
      metric,
      values: input.values,
      variant,
    });
    chart.setOption(
      {
        ...buildChartOption(state),
        animation: false,
        backgroundColor: "#11151f",
      },
      true,
    );
    chartUrl = chart.getDataURL({
      backgroundColor: "#11151f",
      pixelRatio: Math.max(1, scale),
      type: "png",
    });
  } finally {
    chart.dispose();
    chartNode.remove();
  }

  const [chartImage, decantImage, dosuImage] = await Promise.all([
    loadCanvasImage(chartUrl),
    loadCanvasImage(dosuDecantUrl),
    loadCanvasImage(dosuOfficialUrl),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = SHARE_CARD_WIDTH * scale;
  canvas.height = SHARE_CARD_HEIGHT * scale;
  const context = canvas.getContext("2d");
  if (context == null) {
    throw new Error("2D canvas is unavailable");
  }
  context.scale(scale, scale);
  context.fillStyle = "#0b0e14";
  context.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  context.fillStyle = "#11151f";
  context.fillRect(42, 34, SHARE_CARD_WIDTH - 84, SHARE_CARD_HEIGHT - 68);

  context.drawImage(decantImage, 68, 58, 34, 34);
  context.fillStyle = "#e7eaf0";
  context.font = "650 22px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText("Decant", 114, 83);
  context.fillStyle = "#9aa6b8";
  context.font = "500 17px Inter, ui-sans-serif, system-ui, sans-serif";
  context.textAlign = "right";
  context.fillText(shareCardRange(input), SHARE_CARD_WIDTH - 68, 81);
  context.textAlign = "left";

  context.fillStyle = "#e7eaf0";
  context.font = "650 36px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText(shareCardTitle(input.kind), 68, 142);
  context.fillStyle = "#9aa6b8";
  context.font = "500 22px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText(shareCardTakeaway(input), 68, 178);
  context.drawImage(chartImage, 68, 204, SHARE_CARD_WIDTH - 136, 304);

  context.fillStyle = "#6b7689";
  context.font = "500 16px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText(shareCardQualifier(input.kind), 68, 557);
  context.drawImage(dosuImage, SHARE_CARD_WIDTH - 244, 537, 24, 25);
  context.fillStyle = "#9aa6b8";
  context.font = "600 16px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText("Decant · by Dosu", SHARE_CARD_WIDTH - 210, 557);

  return await canvasPngBlob(canvas);
}

function loadCanvasImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load local image asset: ${src}`));
    image.src = src;
  });
}

function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob == null) {
        reject(new Error("PNG encoding failed"));
      } else {
        resolve(blob);
      }
    }, "image/png");
  });
}

function shareRange(labels: string[]): { start: string; end: string } {
  return {
    start: labels[0] ?? "All time",
    end: labels.at(-1) ?? "All time",
  };
}

function shareCardRange(input: ShareCardCopyInput): string {
  const range = input.start === input.end ? input.start : `${input.start}–${input.end}`;
  return `${range} · ${input.timezone}`;
}

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
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
  const chartInstanceRef = useRef<EChartsInstance | null>(null);
  const lastDrawnKeyRef = useRef<string | null>(null);
  const chartState = prepareAnalyticsChartState({ labels, metric, values, variant });
  const chartStateRef = useRef<AnalyticsChartState>(chartState);
  chartStateRef.current = chartState;

  useEffect(() => {
    const element = chartRef.current;
    if (element == null) {
      return;
    }
    let cancelled = false;
    let disposeChart: (() => void) | null = null;
    void (async () => {
      const echarts = await import("echarts");
      if (cancelled) {
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
      // Draws whatever chartStateRef holds now, so a state change that arrived
      // while the import was in flight is not lost.
      draw();
      disposeChart = () => {
        observer.disconnect();
        window.removeEventListener("resize", resize);
        window.removeEventListener("decant:set-theme", redrawForTheme);
        media.removeEventListener("change", redrawForTheme);
        chart.dispose();
        chartInstanceRef.current = null;
        lastDrawnKeyRef.current = null;
      };
    })();
    return () => {
      cancelled = true;
      disposeChart?.();
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
}): EChartsOption {
  const colors = chartColors();
  const moneyMetric = metric === "money";
  const seriesType = variant;
  return {
    color:
      seriesType === "bar"
        ? [colors.success, colors.info, colors.warning, colors.accent]
        : [colors.accent, colors.info, colors.success, colors.warning],
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
        shadowStyle: { color: colors.hover },
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
    hover: styles.colorScheme === "dark" ? "rgba(255, 255, 255, 0.05)" : "rgba(20, 20, 20, 0.05)",
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
  | "archive"
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
  | "copy"
  | "cpu"
  | "desktop"
  | "download"
  | "ellipsis"
  | "eye"
  | "file"
  | "fileCode"
  | "filePdf"
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
  | "share"
  | "sessions"
  | "settings"
  | "shield"
  | "sun"
  | "trend"
  | "trash"
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
  const displayLabel = effortDisplayLabel(effort, labeled);
  if (label == null || label === "") {
    return (
      <span className="faint" title={effortTooltip(effort, levels)}>
        {displayLabel}
      </span>
    );
  }
  return (
    <Badge mono title={effortTooltip(effort, levels)} tone={label === "mixed" ? "warning" : "info"}>
      {displayLabel}
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

function EmptyState({
  action,
  icon,
  message,
  title,
}: {
  action?: ReactNode;
  icon: IconName;
  message: string;
  title: string;
}) {
  return (
    <div className="empty-state">
      <span>
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      <p>{message}</p>
      {action != null ? <div className="state-actions">{action}</div> : null}
    </div>
  );
}

function ErrorState({
  action,
  detail,
  icon = "info",
  secondaryAction,
  title,
}: {
  action?: ReactNode;
  detail: string;
  icon?: IconName;
  secondaryAction?: ReactNode;
  title: string;
}) {
  return (
    <div className="error-state" role="alert">
      <span>
        <Icon name={icon} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
        {action != null || secondaryAction != null ? (
          <div className="state-actions">
            {action}
            {secondaryAction}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type RecoveryPresentation = {
  actionHref?: string;
  actionLabel?: string;
  command?: string;
  detail: string;
  icon: IconName;
  retry: boolean;
  title: string;
  useSync?: boolean;
};

function recoveryPresentation(error: unknown): RecoveryPresentation {
  if (!(error instanceof ApiError)) {
    return {
      detail:
        "Decant could not reach the local server. Restart `decant serve` if needed, then retry.",
      icon: "info",
      retry: true,
      title: "Request failed",
    };
  }
  switch (error.code) {
    case "session_not_found":
      return error.extras.archive_empty === true
        ? {
            actionHref: "/sessions",
            actionLabel: "Back to sessions",
            detail: "There are no session logs on this device yet. Sync to import them.",
            icon: "sessions",
            retry: false,
            title: "No session logs yet",
            useSync: true,
          }
        : {
            actionHref: "/sessions",
            actionLabel: "Back to sessions",
            detail: "This session log is no longer available. It may have moved after a rebuild.",
            icon: "inbox",
            retry: false,
            title: "Session not found",
            useSync: true,
          };
    case "schema_too_new":
      return {
        actionHref: "https://github.com/dosu-ai/decant/releases",
        actionLabel: "Update Decant",
        detail:
          "These session logs were indexed by a newer Decant build. Update Decant, then retry.",
        icon: "info",
        retry: true,
        title: "Decant is out of date",
      };
    case "schema_too_old":
      return {
        actionHref: "https://github.com/dosu-ai/decant#configuration",
        actionLabel: "View rebuild guide",
        detail:
          "The session log index predates the supported schema baseline. Back it up, rebuild it, and sync the source logs again.",
        icon: "info",
        retry: false,
        title: "Session log index rebuild required",
      };
    case "launch_unsupported_platform":
      return {
        command: typeof error.extras.command === "string" ? error.extras.command : undefined,
        detail:
          "Native agent and editor launching is available on macOS. Copy the prompt or command and run it manually here.",
        icon: "info",
        retry: false,
        title: "Native launch is unavailable",
      };
    case "launch_failed":
      return {
        command: typeof error.extras.command === "string" ? error.extras.command : undefined,
        actionHref: "/settings",
        actionLabel: "Check launcher settings",
        detail:
          "Decant could not open the selected app. Check the launcher setting, then try again.",
        icon: "info",
        retry: true,
        title: "Launch failed",
      };
    case "archive_locked":
      return {
        detail:
          "Another Decant operation is using the session log index. Wait a moment, then retry.",
        icon: "clock",
        retry: true,
        title: "Session logs are busy",
      };
    case "service_starting":
      return {
        detail: "Decant is finishing local startup. Try again in a moment.",
        icon: "clock",
        retry: true,
        title: "Decant is starting",
      };
    case "internal_error":
      return {
        detail:
          "Decant hit an unexpected local error. Restart `decant serve`, then retry. If it continues, check the server log for the private diagnostic.",
        icon: "info",
        retry: true,
        title: "Decant could not complete the request",
      };
    default:
      if (error.status >= 500) {
        return {
          detail:
            "Decant hit an unexpected local error. Restart `decant serve`, then retry. If it continues, check the server log.",
          icon: "info",
          retry: true,
          title: "Decant could not complete the request",
        };
      }
      return {
        detail: "Decant could not complete this request. Check the input and try again.",
        icon: "info",
        retry: true,
        title: "Request failed",
      };
  }
}

function ApiFailureState({
  error,
  onRetry,
  onSync,
}: {
  error: unknown;
  onRetry?: () => void;
  onSync?: () => void;
}) {
  const [commandCopied, setCommandCopied] = useState(false);
  const recovery = recoveryPresentation(error);
  const retryIsPrimary =
    !recovery.useSync && recovery.actionHref == null && recovery.retry && onRetry != null;
  const action =
    recovery.actionHref != null && recovery.actionLabel != null ? (
      <a
        className="primary-button"
        href={recovery.actionHref}
        rel={recovery.actionHref.startsWith("http") ? "noopener" : undefined}
        target={recovery.actionHref.startsWith("http") ? "_blank" : undefined}
      >
        {recovery.actionLabel}
      </a>
    ) : recovery.useSync && onSync != null ? (
      <button className="primary-button" onClick={onSync} type="button">
        Sync now
      </button>
    ) : retryIsPrimary ? (
      <button className="primary-button" onClick={onRetry} type="button">
        Retry
      </button>
    ) : null;
  const secondaryAction =
    recovery.useSync && onSync != null && action != null ? (
      <button className="secondary-button" onClick={onSync} type="button">
        Sync now
      </button>
    ) : recovery.retry && onRetry != null && action != null && !retryIsPrimary ? (
      <button className="secondary-button" onClick={onRetry} type="button">
        Retry
      </button>
    ) : null;
  return (
    <div className="api-failure">
      <ErrorState
        action={action}
        detail={recovery.detail}
        icon={recovery.icon}
        secondaryAction={secondaryAction}
        title={recovery.title}
      />
      {recovery.command != null ? (
        <div className="recovery-command">
          <code>{recovery.command}</code>
          <button
            className="secondary-button"
            onClick={() => {
              void copyTextToClipboard(recovery.command ?? "")
                .then(() => setCommandCopied(true))
                .catch(() => setCommandCopied(false));
            }}
            type="button"
          >
            <Icon name={commandCopied ? "check" : "copy"} />
            {commandCopied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
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
        <button
          aria-pressed={range.preset === "all"}
          onClick={() => onChange(ALL_DATE_RANGE)}
          type="button"
        >
          All time
        </button>
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
      {/* The label spells out a custom range ("Jun 3 to Jun 17"). For "all" it
       * returns "All time", which is now exactly what the selected button reads,
       * so showing it twice just looks like a bug. */}
      {range.preset === "all" ? null : <span>{dateRangeLabel(range)}</span>}
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

function OverflowMenu({ children, label }: { children: ReactNode; label: string }) {
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  return (
    <details
      className="overflow-menu"
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          event.currentTarget.open = false;
        }
      }}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(".overflow-menu-popover :is(a, button)") != null &&
          menuRef.current != null
        ) {
          menuRef.current.open = false;
          menuRef.current.querySelector("summary")?.focus();
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        if (menuRef.current != null) {
          menuRef.current.open = false;
          menuRef.current.querySelector("summary")?.focus();
        }
      }}
      ref={menuRef}
    >
      <summary aria-label={label} title="More actions">
        <Icon name="ellipsis" />
      </summary>
      <div className="overflow-menu-popover">{children}</div>
    </details>
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
    case "archive":
      return Archive;
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
    case "copy":
      return Copy;
    case "cpu":
      return Cpu;
    case "desktop":
      return Monitor;
    case "download":
      return Download;
    case "ellipsis":
      return Ellipsis;
    case "eye":
      return Eye;
    case "file":
      return FileText;
    case "fileCode":
      return FileCode2;
    case "filePdf":
      return FileType2;
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
    case "share":
      return Share2;
    case "sessions":
      return Rows3;
    case "settings":
      return Settings;
    case "shield":
      return ShieldCheck;
    case "sun":
      return Sun;
    case "trend":
      return ChartNoAxesCombined;
    case "trash":
      return Trash2;
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

function durationPrecise(value: number | null): string {
  if (value == null) {
    return "—";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  }
  return duration(value);
}

function formatBytes(value: number | null): string {
  if (value == null) {
    return "—";
  }
  if (value < 1024) {
    return `${formatInt(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
          <a className="secondary-button tool-detail-transcript-link" href={transcriptHref}>
            <Icon name="messages" />
            View in transcript
            <Icon name="chevronRight" />
          </a>
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
        <StatCard
          icon="tools"
          label="Total calls"
          tone="accent"
          value={formatInt(aggregate.totalCalls)}
        />
        <StatCard
          icon="info"
          label="Error rate"
          tone={aggregate.errorRate > 0 ? "danger" : "success"}
          value={aggregate.totalCalls === 0 ? "—" : `${aggregate.errorRate.toFixed(1)}%`}
        />
        <StatCard
          icon="clock"
          label="Median / p95 elapsed"
          tone="info"
          value={
            aggregate.p50 == null || aggregate.p95 == null
              ? "—"
              : `${durationPrecise(aggregate.p50)} / ${durationPrecise(aggregate.p95)}`
          }
        />
        <StatCard icon="bolt" label="Top tool" tone="warning" value={aggregate.topTool ?? "—"} />
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
            <a
              className="secondary-button"
              href={clearedFiltersHref}
              onClick={(event) => navigate(event, clearedFiltersHref)}
            >
              Clear filters
            </a>
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
                        <a
                          href={`/sessions/${call.session_id}`}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {call.session_title ?? `Session ${call.session_id}`} →
                        </a>
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
      withDateQuery(`/api/files?group=${group}&limit=100${opParam}`, dateRangeQuery(dateRange)),
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
                      <a href={`/search?q=${encodeURIComponent(`"${row.key}"`)}`}>{row.key}</a>
                    </td>
                    {group === "path" ? (
                      <td className="muted" title={row.project ?? ""}>
                        {row.project == null ? (
                          <span className="faint">-</span>
                        ) : (
                          <a href={projectSessionsHref(row.project)}>{basename(row.project)}</a>
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
              Local-first analytics for Claude Code and Codex sessions. Decant is an open source
              tool from Dosu.
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
            <span className="section-eyebrow">Permanent action</span>
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

  /**
   * Fill in the gap in front of the loaded window.
   *
   * A window only starts partway into a session when the reader arrived by deep
   * link, outline click, or compaction jump. Without this, everything before
   * that landing point is unreachable by keyboard: ArrowUp hits the top of the
   * window and stops, even though earlier messages exist.
   */
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
            // Inserting above the viewport shifts everything below it down by
            // the height of the new content. Browser scroll anchoring does not
            // rescue this: measured in Chromium, a page's worth of prepended
            // turns moved the anchor by its full height, so the correction below
            // is doing the work rather than duplicating the browser's.
            //
            // Anchor on how far a surviving turn moved rather than on
            // scrollHeight, which would misread the content-visibility
            // placeholders: their height stays an estimate until they render.
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
            // flushSync commits the prepend before it returns, so the
            // measurement below is guaranteed to see the new DOM. Deferring to
            // requestAnimationFrame would be both less certain -- React commits
            // on its own schedule -- and a frame late, long enough for the
            // browser to paint the shifted position before it was corrected.
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

  const messages = renderableMessages(detail.messages);
  const toc = outline == null ? threadToc(messages) : threadTocFromOutline(outline);
  const stats = threadStats(
    detail.summary,
    messages,
    toc,
    contextWindow?.turn_count,
    detail.totals,
  );
  const subagentRuns = countSubagentRuns(detail.subagents);
  const compactionBySeq = new Map(
    (contextWindow?.compactions ?? []).map((compaction) => [compaction.seq, compaction] as const),
  );
  const compactionNumberBySeq = new Map(
    (contextWindow?.compactions ?? []).map((compaction, index) => [compaction.seq, index + 1]),
  );
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
            <EffortBadge
              effort={detail.summary.reasoning_effort}
              labeled
              levels={detail.summary.reasoning_effort_levels}
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
              <a
                className="project-chip"
                href={projectSessionsHref(detail.summary.project_path)}
                title={detail.summary.project_path}
              >
                <Icon name="folder" />
                {basename(detail.summary.project_path)}
              </a>
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

      <a
        className="back-link"
        href={sessionsHref}
        onClick={(event) => navigate(event, sessionsHref)}
      >
        <Icon name="arrowLeft" />
        Sessions
      </a>

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
              <a
                aria-label={item.kind === "dosu" ? `Dosu tool call: ${item.label}` : undefined}
                className={[
                  item.kind === "dosu" ? "is-dosu" : null,
                  jumpingToSeq === item.seq ? "is-loading" : null,
                  activeMessageSeq === item.seq ? "is-current" : null,
                ]
                  .filter(isPresent)
                  .join(" ")}
                href={`#message-${item.seq}`}
                key={item.key}
                onClick={(event) => {
                  event.preventDefault();
                  void jumpToMessage(item.seq);
                }}
              >
                <span className={`toc-icon${item.kind === "dosu" ? " is-dosu" : ""}`}>
                  {item.kind === "dosu" ? (
                    <img alt="" src={dosuOfficialUrl} />
                  ) : (
                    <Icon name={item.icon} />
                  )}
                </span>
                <span>{item.label}</span>
                {item.kind === "dosu" ? <em>Dosu</em> : null}
                {jumpingToSeq === item.seq ? <b>loading</b> : null}
              </a>
            ))}
          </div>
        </aside>

        <div className="transcript-column">
          {(detail.message_offset ?? 0) > 0 ? (
            <div className="transcript-window-start">
              {/* Counts what is missing rather than naming the first loaded
                  message. The offset is a zero-based row index, so printing it
                  as a 1-based ordinal contradicted the #message-<seq> anchor
                  for that very message. */}
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
  totals?: { reply_count: number; tool_call_count: number };
  message_offset?: number;
  message_limit?: number | null;
  has_more_messages?: boolean;
};

type SessionOutlineItemData = {
  seq: number;
  text: string;
  kind: "prompt" | "dosu";
  ordinal: number;
};

/** Mirrors the server's SessionIngestIssue, minus raw_line and created_at:
 * this panel never renders the raw transcript line (see docs/logging.md and
 * the sessionIngestIssues docstring in src/query.ts). */
type SessionIngestIssue = {
  code: string;
  line_no: number | null;
  error: string;
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

// tabIndex={-1} makes each turn programmatically focusable without adding it to
// the tab order, so arrow-key navigation can move focus and a screen reader
// announces the turn it scrolled to. Without it the highlight is visual only.
//
// Memoized: a transcript loads an unbounded number of turns, and every arrow
// keypress changes `active` on exactly two of them. Without this, each keypress
// re-renders every loaded turn.
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

  const curveLayout = layoutContextCurve(points, compactions, {
    plotLeft,
    plotRight,
    yAt,
  });
  const { markerXs, segments, slotWidth, turnOrder, xs } = curveLayout;
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
          <TranscriptCodeBlock
            code={`$ ${presentation.command}`}
            deferUntilVisible={false}
            language="bash"
          />
        </div>
      );
    case "file":
      return (
        <div className="tool-presentation tool-file">
          <ToolPathHeader operation={presentation.operation} path={presentation.path} />
          {presentation.content != null ? (
            <TranscriptCodeBlock
              code={presentation.content}
              deferUntilVisible={false}
              language={presentation.language}
            />
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
      <TranscriptCodeBlock code={argumentsText} deferUntilVisible={false} language="json" />
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
          <a href={`/sessions/${subagent.summary.id}`}>Open session</a>
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
 * Header stats are all whole-session figures. Counting `messages` here would
 * mix scopes: turns and tokens cover the session, so replies and tool calls
 * counted from the loaded window would silently shrink the moment a transcript
 * paginates. `totals` comes from the server aggregated over the session; the
 * window fallback only applies to a payload that predates it.
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
  if (range.from == null && range.to == null) {
    return "All time";
  }
  if (range.from == null) {
    return `Through ${formatDateLabel(range.to ?? "")}`;
  }
  if (range.to == null) {
    return `From ${formatDateLabel(range.from)}`;
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

async function copyTextToClipboard(value: string): Promise<void> {
  let clipboardError: unknown = null;
  if (navigator.clipboard?.writeText != null) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("aria-hidden", "true");
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw clipboardError instanceof Error
        ? clipboardError
        : new Error("Clipboard access is unavailable.");
    }
  } finally {
    textarea.remove();
    if (returnFocus?.isConnected === true) {
      returnFocus.focus({ preventScroll: true });
    }
  }
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

function basename(path: string | null | undefined): string {
  if (path == null || path === "") {
    return "-";
  }
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function locationPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function updateSearchRoute(query: string, setPath?: (path: string) => void) {
  const href = searchRouteHref(query, locationPath());
  if (pathOnly(locationPath()) === "/search") {
    window.history.replaceState(null, "", href);
  } else {
    window.history.pushState(null, "", href);
  }
  const next = locationPath();
  if (setPath != null) {
    setPath(next);
  } else {
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

function navigate(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  setPath?: (path: string) => void,
) {
  event.preventDefault();
  visit(href, setPath);
}

function visit(href: string, setPath?: (path: string) => void) {
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
      message="Open Decant directly in its own browser tab or window to use it."
      title="Decant cannot be displayed in a frame"
    />
  );
}

const root = document.getElementById("root");
if (root == null) {
  throw new Error("missing #root");
}
createRoot(root).render(isFramed(window) ? <FramedNotice /> : <App />);
