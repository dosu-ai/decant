import type { Database } from "bun:sqlite";
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
    default:
      return { sql: "", params: [] };
  }
}

export function availableSessionSources(db: Database): AvailableSessionSource[] {
  const userVisible = sessionUserStatePredicateForDatabase(db, "s");
  return SESSION_SOURCES.flatMap((key) => {
    const source = sessionSourcePredicate("s", key);
    const statement = db.prepare(
      `SELECT COUNT(*) AS sessions
       FROM session s
       WHERE ${visibleSessionPredicate("s")}
         AND ${userVisible}
         AND ${source.sql}`,
    );
    let sessions: number;
    try {
      sessions = Number((statement.get(...source.params) as { sessions: number }).sessions);
    } finally {
      statement.finalize();
    }
    return sessions > 0 ? [{ key, label: sessionSourceLabel(key) }] : [];
  });
}
