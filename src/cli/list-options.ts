import { homedir } from "node:os";
import { InvalidArgumentError } from "commander";
import { dateFilterFromSearch } from "../date-filter.ts";
import { resolveProjectPath, resolveRepoRoots, type ScopeEnv } from "../project-scope.ts";
import type { ProjectSummary, SessionSummary } from "../query.ts";
import type { Archive, CliContext } from "./context.ts";
import { parseInteger } from "./parse.ts";

// Flags shared by the listing commands: scope, dates, paging, and fields.

// A Record makes the compiler reject a field the row type lacks and report
// one this list forgot. `subagents` is absent because no listing nests them.
const SESSION_FIELD_MAP: Record<Exclude<keyof SessionSummary, "subagents">, true> = {
  id: true,
  tool: true,
  source_session_id: true,
  title: true,
  project_path: true,
  model: true,
  reasoning_effort: true,
  reasoning_effort_levels: true,
  total_reasoning_tokens: true,
  reasoning_source: true,
  started_at: true,
  ended_at: true,
  message_count: true,
  total_input_tokens: true,
  total_output_tokens: true,
  usage_available: true,
  estimated_cost_usd: true,
  cost_source: true,
  model_provider: true,
  user_state: true,
  is_user_archived: true,
  is_archived: true,
  is_subagent: true,
  parent_session_id: true,
  spawn_tool_use_id: true,
  agent_id: true,
  agent_type: true,
  spawn_depth: true,
  context_window_tokens: true,
  peak_context_tokens: true,
  compaction_count: true,
  subagent_count: true,
  subagent_estimated_cost_usd: true,
  ingest_issue_count: true,
  informational_ingest_issue_count: true,
  dosu_mcp_direct_calls: true,
  dosu_mcp_tree_calls: true,
};

const PROJECT_FIELD_MAP: Record<keyof ProjectSummary, true> = {
  id: true,
  path: true,
  name: true,
  sessions: true,
  usage_sessions: true,
  estimated_cost_usd: true,
  last_seen_at: true,
  is_worktree: true,
  root_path: true,
  worktree_label: true,
  worktree_tool: true,
  root_source: true,
  worktree_count: true,
  session_tools: true,
};

export const SESSION_FIELDS: readonly string[] = Object.keys(SESSION_FIELD_MAP);
export const PROJECT_FIELDS: readonly string[] = Object.keys(PROJECT_FIELD_MAP);

/** A `--fields` parser that rejects names outside `valid` and lists them. */
export function fieldsParser(valid: readonly string[]): (value: string) => string[] {
  return (value) => {
    const fields = [...new Set(value.split(",").map((field) => field.trim()))];
    const unknown = fields.filter((field) => !valid.includes(field));
    if (unknown.length > 0) {
      const named = unknown.map((field) => JSON.stringify(field)).join(", ");
      throw new InvalidArgumentError(`unknown field ${named}. Valid fields: ${valid.join(", ")}`);
    }
    return fields;
  };
}

/** A day as the API's `from` and `to` take it, so both read dates one way. */
export function parseDay(value: string): string {
  const day = dateFilterFromSearch(new URLSearchParams({ from: value })).from;
  if (day == null) {
    throw new InvalidArgumentError("expected a date as YYYY-MM-DD");
  }
  return day;
}

export function parseLimit(value: string): number {
  const limit = parseInteger(value);
  if (limit < 1) {
    throw new InvalidArgumentError("expected an integer of 1 or more");
  }
  return limit;
}

export function parseOffset(value: string): number {
  const offset = parseInteger(value);
  if (offset < 0) {
    throw new InvalidArgumentError("expected zero or a positive integer");
  }
  return offset;
}

export interface ScopeOptions {
  project?: string;
  repo?: string;
  since?: string;
  until?: string;
}

export interface ListScope {
  project?: string;
  repo?: string[];
  from?: string;
  to?: string;
  utcDays: true;
}

/** The query filter for the scope flags, or the exit code once an error is on
 * stderr. An unknown scope is an error so an empty list keeps one meaning. */
export function resolveListScope(
  ctx: CliContext,
  archive: Archive,
  options: ScopeOptions,
): ListScope | number {
  const fail = (code: number, message: string): number => {
    ctx.io.writeErr(`error: ${message}\n`);
    return code;
  };
  // The help promises UTC days, and some sources keep their local offset.
  const scope: ListScope = { from: options.since, to: options.until, utcDays: true };
  if (options.since != null && options.until != null && options.since > options.until) {
    return fail(2, `--since ${options.since} is after --until ${options.until}`);
  }
  const env: ScopeEnv = {
    cwd: process.cwd(),
    homeDir: ctx.homeDir === undefined ? homedir() : ctx.homeDir,
  };
  if (options.project != null) {
    if (options.project === "") {
      return fail(2, "--project needs a path");
    }
    const match = resolveProjectPath(archive.db, options.project, env);
    if (match.path == null) {
      return fail(
        1,
        `no project matches --project ${JSON.stringify(options.project)} ` +
          `(looked for ${match.tried.join(", ")})\n` +
          "run `decant project ls` to see the stored paths, or use --repo " +
          "to match a repository and its worktrees",
      );
    }
    scope.project = match.path;
  }
  if (options.repo != null) {
    if (options.repo === "") {
      return fail(2, "--repo needs a path, a remote, or a repository name");
    }
    const match = resolveRepoRoots(archive.db, options.repo, env);
    if (match.kind === "ambiguous") {
      return fail(
        2,
        `--repo ${JSON.stringify(options.repo)} names several repositories: ` +
          `${match.candidates.join(", ")}\npass one of these paths instead`,
      );
    }
    if (match.kind === "none") {
      return fail(
        1,
        `no repository matches --repo ${JSON.stringify(options.repo)} ` +
          `(looked for ${match.tried.join(", ")})\n` +
          "run `decant project ls --fields path,root_path` to see the stored " +
          "paths and their repository roots",
      );
    }
    scope.repo = match.roots;
  }
  return scope;
}

/** Print `rows` whole, or only `fields` of each when the flag was given. */
export function outputRows<T extends object>(
  ctx: CliContext,
  rows: T[],
  fields: string[] | undefined,
  renderDefault: () => string,
): void {
  if (fields == null) {
    ctx.output(rows, renderDefault);
    return;
  }
  const cells = rows.map((row) => fields.map((field) => (row as Record<string, unknown>)[field]));
  ctx.output(
    cells.map((values) => Object.fromEntries(values.map((value, index) => [fields[index], value]))),
    () => cells.map((values) => values.map(textCell).join("\t")).join("\n"),
  );
}

export function textCell(value: unknown): string {
  if (value == null) {
    return "";
  }
  // One row per line and one cell per tab, whatever a title or a list holds.
  return (Array.isArray(value) ? value.join(",") : String(value)).replace(/[\t\r\n]+/g, " ");
}
