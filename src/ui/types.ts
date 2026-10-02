export type Summary = {
  sessions: number;
  messages: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
};

export type SessionSummary = {
  id: number;
  tool: string;
  source_session_id: string;
  title: string | null;
  project_path: string | null;
  model: string | null;
  reasoning_effort: string | null;
  reasoning_effort_levels: string[];
  total_reasoning_tokens: number;
  reasoning_source: string | null;
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

export type SearchHit = {
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

export type SearchResponse = {
  elapsed_ms: number;
  results: SearchHit[];
  total: number | null;
  total_is_capped: boolean;
};

export type SyncProgress = {
  failed: number;
  ingested: number;
  scanned: number;
  skipped: number;
  total: number;
};

export type ServerEventPayload = {
  reason?: string;
};

export type Activity = {
  by_hour: number[];
  by_weekday: number[];
  timezone: string;
  peak_hour: number | null;
  peak_weekday: number | null;
};

export type ModelSparklines = {
  models: Record<string, number[]>;
  days: string[];
};

export type DateBounds = {
  min: string | null;
  max: string | null;
};

export type ActivityBucket = "context" | "planning" | "code" | "communicating";

export type TokenEconomics = {
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

export type DimensionRow = {
  key: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  est_reasoning_tokens: number;
  estimated_cost_usd: number;
};

export type ProjectSummary = {
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

export type ToolRow = {
  tool_name: string;
  tool_kind: string;
  mcp_server: string | null;
  calls: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
  last_used_at: string | null;
};

export type McpRow = {
  mcp_server: string;
  tools: number;
  calls: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
  last_used_at: string | null;
};

export type ToolCallRow = {
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

export type ToolCallPage = {
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

export type FileRow = {
  key: string;
  project: string | null;
  reads: number;
  edits: number;
  writes: number;
  deletes: number;
  sessions: number;
  last_touched_at: string | null;
};

export type Recommendation = {
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

export type ConfigView = {
  dbPath: string;
  claudeDir: string;
  codexDir: string;
  version: string;
};

export type UserSettings = {
  agent: string;
  terminal: string;
  ide: string;
};

export type SettingsInfo = {
  settings: UserSettings;
  path: string;
  can_launch: boolean;
  options: {
    agents: [string, string][];
    terminals: [string, string][];
    ides: [string, string][];
  };
};

export type DashboardData = {
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

export type DataSlice = keyof DashboardData;

export type NavItem = {
  key: string;
  href: string;
  label: string;
  icon: IconName;
};

export type ThemeChoice = "system" | "light" | "dark";

export type RangePreset = "7d" | "30d" | "90d" | "all" | "custom";

export type DateRangeSelection = {
  preset: RangePreset;
  from: string | null;
  to: string | null;
};

export type LoadedSessionPage = {
  exhausted: boolean;
  page: number;
  requestKey: string;
  scopeKey: string;
  sessions: SessionSummary[];
};

export type SessionPageState = {
  error: unknown;
  exhausted: boolean;
  loadedPage: number | null;
  loading: boolean;
  sessions: SessionSummary[];
};

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "claude"
  | "openai"
  | "gemini";

export type BrandIconName = "anthropic" | "claude" | "openai" | "gemini";

export type IconName =
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

export type SessionDetailData = {
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

export type SessionOutlineItemData = {
  seq: number;
  text: string;
  kind: "prompt" | "dosu";
  ordinal: number;
};

/** Mirrors the server's SessionIngestIssue, minus raw_line and created_at:
 * this panel never renders the raw transcript line (see docs/logging.md and
 * the sessionIngestIssues docstring in src/query.ts). */
export type SessionIngestIssue = {
  code: string;
  line_no: number | null;
  error: string;
};

export type ContextWindowPointData = {
  seq: number;
  timestamp: string | null;
  turn: number;
  context_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
};

export type ContextWindowCompactionData = {
  seq: number;
  timestamp: string | null;
  trigger: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
};

export type ContextWindowTimelineData = {
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

export type SubagentDetailData = SessionDetailData & {
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
};

export type TranscriptBlockData = {
  ordinal: number;
  block_type: string;
  text: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input: string | null;
  tool_result: string | null;
};
