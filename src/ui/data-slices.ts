import { getJson } from "./api.ts";
import { TABLE_ROW_LIMIT } from "./constants.ts";
import { withDateQuery } from "./date-range.ts";
import type {
  Activity,
  ConfigView,
  DashboardData,
  DataSlice,
  DateBounds,
  DimensionRow,
  FileRow,
  McpRow,
  ModelSparklines,
  ProjectSummary,
  Recommendation,
  SettingsInfo,
  Summary,
  TokenEconomics,
  ToolRow,
} from "./types.ts";

export const emptyData: DashboardData = {
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

// Each page fetches only the slices it renders; fetching everything for every
// page made first paint wait on the slowest analytics endpoint. Slices are
// cached per (date filter, reload generation), so navigating back is free and
// SSE-triggered refreshes only refetch what the active page shows.
export const SLICE_LOADERS: Record<
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
      tools: await getJson<ToolRow[]>(
        withDateQuery(`/api/tools/usage?limit=${TABLE_ROW_LIMIT}`, q),
      ),
    }),
  },
  mcp: {
    dateScoped: true,
    load: async (q) => ({
      mcp: await getJson<McpRow[]>(
        withDateQuery(`/api/tools/mcp-usage?limit=${TABLE_ROW_LIMIT}`, q),
      ),
    }),
  },
  files: {
    dateScoped: true,
    load: async (q) => ({
      files: await getJson<FileRow[]>(
        withDateQuery(`/api/files?group=path&limit=${TABLE_ROW_LIMIT}`, q),
      ),
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
export const SHELL_SLICES: DataSlice[] = ["summary", "dateBounds", "config"];

export const ROUTE_SLICES: Record<string, DataSlice[]> = {
  sessions: [],
  projects: ["projects"],
  search: [],
  analytics: [
    "byDay",
    "byModel",
    "byProject",
    "activity",
    "modelSparklines",
    "tokenEconomics",
    "settings",
  ],
  insights: ["recommendations", "settings"],
  tools: ["tools", "mcp"],
  files: ["files"],
  settings: ["config", "settings"],
};

export function slicesForView(routeKey: string): DataSlice[] {
  return [...new Set([...SHELL_SLICES, ...(ROUTE_SLICES[routeKey] ?? [])])];
}
