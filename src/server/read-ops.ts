import type { Database } from "bun:sqlite";
import { contextWindowForSession } from "../context-window.ts";
import type { DateFilter } from "../date-filter.ts";
import type { Operation } from "../enrich.ts";
import {
  getSession,
  getSessionOutline,
  type ListFilter,
  listProjects,
  listSessions,
  listToolCalls,
  type SearchFilter,
  searchPage,
  sessionIngestIssues,
  sessionSearchIndex,
  type ToolCallFilter,
} from "../query.ts";
import {
  activity,
  byDimension,
  type Dimension,
  type FileGroup,
  fileHotspots,
  mcpUsage,
  modelSparklines,
  type StatsFilter,
  toolUsage,
  totals,
} from "../stats.ts";
import {
  type TokenEconomicsFilter,
  tokenEconomics,
  tokenEconomicsForSession,
} from "../token-economics.ts";

/**
 * The archive reads heavy enough to hold up other requests. Each one is a
 * named, read-only function of a database and plain-data arguments, so the
 * server can run it on a worker thread's own connection (see read-pool.ts)
 * and tests or a pool-less caller can run the same code inline.
 *
 * A `json` operation returns the value to serialize, or null for a missing
 * session. Serializing where the value is computed keeps that work off the
 * request thread and hands back a single string instead of a cloned object
 * graph.
 */
interface JsonReadOp<A> {
  kind: "json";
  run: (db: Database, args: A) => unknown;
}

/** Reports render HTML. They import the report renderer lazily so the charting
 * library loads only when someone exports a report. */
interface HtmlReadOp<A> {
  kind: "html";
  run: (db: Database, args: A) => Promise<{ html: string; filename: string } | null>;
}

type ReadOp<A> = JsonReadOp<A> | HtmlReadOp<A>;

export type ReadOpOutput =
  | { type: "json"; body: string }
  | { type: "html"; body: string; filename: string };

const json = <A>(run: (db: Database, args: A) => unknown): JsonReadOp<A> => ({ kind: "json", run });

export const READ_OPS = {
  sessions: json((db, args: ListFilter) => listSessions(db, args)),
  sessionSearchIndex: json((db, args: { limit: number; offset: number }) =>
    sessionSearchIndex(db, args),
  ),
  projects: json((db, _args: Record<string, never>) => listProjects(db)),
  session: json((db, args: { id: number; messageLimit: number | null; messageOffset: number }) =>
    getSession(db, args.id, {
      messageLimit: args.messageLimit,
      messageOffset: args.messageOffset,
    }),
  ),
  sessionTokenEconomics: json((db, args: { id: number }) => tokenEconomicsForSession(db, args.id)),
  sessionContextWindow: json((db, args: { id: number }) => contextWindowForSession(db, args.id)),
  sessionOutline: json((db, args: { id: number }) => getSessionOutline(db, args.id)),
  sessionIssues: json((db, args: { id: number }) => sessionIngestIssues(db, args.id)),
  search: json((db, args: { query: string; filter: SearchFilter }) =>
    searchPage(db, args.query, args.filter),
  ),
  statsSummary: json((db, args: StatsFilter) => totals(db, args)),
  statsByDimension: json((db, args: { dimension: Dimension; filter: StatsFilter }) =>
    byDimension(db, args.dimension, args.filter),
  ),
  activity: json((db, args: StatsFilter) => activity(db, args)),
  modelSparklines: json((db, args: StatsFilter) => modelSparklines(db, args)),
  tokenEconomics: json((db, args: TokenEconomicsFilter) => tokenEconomics(db, args)),
  files: json(
    (db, args: { group: FileGroup; op: Operation | null; limit: number; filter: DateFilter }) =>
      fileHotspots(db, args.group, args.op, args.limit, args.filter),
  ),
  toolCalls: json((db, args: ToolCallFilter) => listToolCalls(db, args)),
  toolUsage: json((db, args: { errorsOnly: boolean; limit: number; filter: DateFilter }) =>
    toolUsage(db, args.errorsOnly, args.limit, args.filter),
  ),
  mcpUsage: json((db, args: { limit: number; filter: DateFilter }) =>
    mcpUsage(db, args.limit, args.filter),
  ),
  analyticsReport: {
    kind: "html",
    run: async (db, args: { filter: StatsFilter }) => {
      const { assembleAnalyticsReport, renderAnalyticsReport } = await import("../report/index.ts");
      return {
        html: renderAnalyticsReport(assembleAnalyticsReport(db, { filter: args.filter })),
        filename: "decant-analytics-report.html",
      };
    },
  },
  sessionReport: {
    kind: "html",
    run: async (db, args: { id: number }) => {
      const { assembleSessionReport, renderSessionReport } = await import("../report/index.ts");
      const report = assembleSessionReport(db, args.id);
      if (report == null) {
        return null;
      }
      return {
        html: renderSessionReport(report),
        filename: `decant-session-${report.summary.id}-${reportFilenamePart(report.summary.title)}.html`,
      };
    },
  },
} satisfies Record<string, ReadOp<never>>;

export type ReadOpName = keyof typeof READ_OPS;

export type ReadOpArgs<N extends ReadOpName> =
  (typeof READ_OPS)[N] extends ReadOp<infer A> ? A : never;

export function isReadOpName(value: unknown): value is ReadOpName {
  return typeof value === "string" && Object.hasOwn(READ_OPS, value);
}

/** Run one operation against `db`. Null means the session it names is gone. */
export async function executeReadOp<N extends ReadOpName>(
  db: Database,
  name: N,
  args: ReadOpArgs<N>,
): Promise<ReadOpOutput | null> {
  const op = READ_OPS[name] as ReadOp<ReadOpArgs<N>>;
  if (op.kind === "html") {
    const report = await op.run(db, args);
    return report == null ? null : { type: "html", body: report.html, filename: report.filename };
  }
  const value = op.run(db, args);
  return value == null ? null : { type: "json", body: JSON.stringify(value) };
}

function reportFilenamePart(value: string | null): string {
  const normalized = (value ?? "report")
    .normalize("NFKD")
    .replaceAll(/[^a-zA-Z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 64);
  return normalized === "" ? "report" : normalized;
}
