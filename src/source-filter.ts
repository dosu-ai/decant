import type { Database } from "bun:sqlite";
import { cachedRead, statementKey } from "./read-cache.ts";
import { sessionUserStatePredicateForDatabase } from "./session-user-state.ts";
import { visibleSessionPredicate } from "./session-visibility.ts";

export const SESSION_SOURCES = [
  "claude_code",
  "codex_app",
  "codex_cli",
  "codex_other",
  "gemini_cli",
  "opencode",
  "cursor_cli",
  "copilot_cli",
  "vscode_copilot",
  "atif",
  "hermes",
] as const;

export type SessionSource = (typeof SESSION_SOURCES)[number];

export interface AvailableSessionSource {
  key: SessionSource;
  label: string;
}

export function parseSessionSource(value: string | null): SessionSource | null {
  return SESSION_SOURCES.includes(value as SessionSource) ? (value as SessionSource) : null;
}

export function sessionSourceLabel(source: SessionSource): string {
  switch (source) {
    case "claude_code":
      return "Claude Code";
    case "codex_app":
      return "Codex App";
    case "codex_cli":
      return "Codex CLI";
    case "codex_other":
      return "Codex (other clients)";
    case "gemini_cli":
      return "Gemini CLI";
    case "opencode":
      return "OpenCode";
    case "cursor_cli":
      return "Cursor CLI";
    case "copilot_cli":
      return "Copilot CLI";
    case "vscode_copilot":
      return "VS Code Copilot Chat";
    case "atif":
      return "ATIF trajectories";
    case "hermes":
      return "Hermes Agent";
  }
}

const CODEX_DESKTOP_ORIGINATORS = "('Codex Desktop', 'codex_work_desktop')";

function rawMetaField(alias: string, field: string): string {
  return `CASE WHEN json_valid(${alias}.raw_meta)
    THEN json_extract(${alias}.raw_meta, '$.${field}')
  END`;
}

function codexAppSql(alias: string): string {
  return `COALESCE(${rawMetaField(alias, "originator")}, '') IN ${CODEX_DESKTOP_ORIGINATORS}`;
}

function codexCliSql(alias: string): string {
  return `NOT (${codexAppSql(alias)})
    AND (
      COALESCE(${rawMetaField(alias, "originator")}, '') = 'codex-tui'
      OR COALESCE(${rawMetaField(alias, "source")}, '') = 'cli'
    )`;
}

export function sessionSourcePredicate(
  alias: string,
  source: SessionSource | null | undefined,
): { sql: string; params: string[] } {
  switch (source) {
    case "claude_code":
      return { sql: `${alias}.tool = ?`, params: ["claude_code"] };
    case "codex_app":
      return { sql: `${alias}.tool = 'codex' AND ${codexAppSql(alias)}`, params: [] };
    case "codex_cli":
      return { sql: `${alias}.tool = 'codex' AND ${codexCliSql(alias)}`, params: [] };
    case "codex_other":
      // Everything Codex that is neither the desktop app nor the CLI, such as
      // SDK, exec, and third-party clients, so the Codex buckets add up to the
      // Codex total.
      return {
        sql: `${alias}.tool = 'codex'
          AND NOT (${codexAppSql(alias)})
          AND NOT (${codexCliSql(alias)})`,
        params: [],
      };
    case "gemini_cli":
      return { sql: `${alias}.tool = ?`, params: ["gemini"] };
    case "opencode":
      return { sql: `${alias}.tool = ?`, params: ["opencode"] };
    case "cursor_cli":
      return { sql: `${alias}.tool = ?`, params: ["cursor"] };
    case "copilot_cli":
      return { sql: `${alias}.tool = ?`, params: ["copilot"] };
    case "vscode_copilot":
      return { sql: `${alias}.tool = ?`, params: ["vscode_copilot"] };
    case "atif":
      return { sql: `${alias}.tool = ?`, params: ["atif"] };
    case "hermes":
      return { sql: `${alias}.tool = ?`, params: ["hermes"] };
    default:
      return { sql: "", params: [] };
  }
}

export function availableSessionSources(db: Database): AvailableSessionSource[] {
  const userVisible = sessionUserStatePredicateForDatabase(db, "s");
  // One scan with a conditional count per source, instead of a scan per source.
  const predicates = SESSION_SOURCES.map((key) => sessionSourcePredicate("s", key));
  const sql = `SELECT ${predicates
    .map(
      (source, index) => `COALESCE(SUM(CASE WHEN ${source.sql} THEN 1 ELSE 0 END), 0) AS s${index}`,
    )
    .join(", ")}
       FROM session s
       WHERE ${visibleSessionPredicate("s")}
         AND ${userVisible}`;
  const params = predicates.flatMap((source) => source.params);
  const counts = cachedRead(
    db,
    statementKey(sql, params),
    () => (db.query(sql).values(...params)[0] as number[] | undefined) ?? [],
  );
  return SESSION_SOURCES.flatMap((key, index) =>
    Number(counts[index] ?? 0) > 0 ? [{ key, label: sessionSourceLabel(key) }] : [],
  );
}
