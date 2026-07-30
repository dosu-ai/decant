import type { Database } from "bun:sqlite";
import { compareCodePoints } from "./order.ts";
import { sessionUserStatePredicateForDatabase } from "./session-user-state.ts";
import { DECANT_VERSION } from "./version.ts";

export { DECANT_VERSION };

export const OP_KINDS = ["command", "file_write", "file_edit", "file_delete", "patch"] as const;
export type OpKind = (typeof OP_KINDS)[number];

export const PHASES = ["setup", "build", "test", "lint", "run", "deploy", "vcs", "other"] as const;
export type Phase = (typeof PHASES)[number];

export interface Op {
  session_id: number;
  ordinal: number;
  kind: OpKind;
  raw: string;
  normalized: string;
  payload: string | null;
  phase: Phase;
  is_error: boolean;
  redacted: boolean;
  sessions_seen: number;
  success_rate: number;
}

export interface Scope {
  project?: string | null;
  workType?: string | null;
  fromSession?: number | null;
}

export interface Distillation {
  scope_label: string;
  ops: Op[];
  session_count: number;
  date_from: string | null;
  date_to: string | null;
  generated_with: string;
}

export type ScriptFormat = "sh" | "just" | "make";

export interface ScriptOpts {
  format: ScriptFormat;
  minFrequency: number;
  exemplar: boolean;
}

export interface HotFile {
  rel_path: string;
  reads: number;
  edits: number;
  sessions: number;
}

export type SkillKind = "skill" | "agents" | "command";

const phaseOrder = new Map<Phase, number>(PHASES.map((phase, index) => [phase, index]));
const redactors: [RegExp, string][] = (() => {
  const val = String.raw`(?:'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|\S+)`;
  return [
    [
      new RegExp(`(--?(?:token|api[-_]?key|secret|password|passwd|pwd)[ =])${val}`, "gi"),
      "$1<REDACTED>",
    ],
    [new RegExp(String.raw`(authorization:\s*bearer\s+)${val}`, "gi"), "$1<REDACTED>"],
    [new RegExp(String.raw`((?:x-api-key|x-auth-token|api-key):\s*)${val}`, "gi"), "$1<REDACTED>"],
    [/([a-z][a-z0-9+.-]*:\/\/[^/:@\s]+:)[^/@\s]+@/gi, "$1<REDACTED>@"],
    [
      new RegExp(String.raw`\b([A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*=)${val}`, "g"),
      "$1<REDACTED>",
    ],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<REDACTED>"],
    [/\bsk-[A-Za-z0-9]{20,}\b/g, "<REDACTED>"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "<REDACTED>"],
  ];
})();

export function phaseLabel(phase: Phase): string {
  return phase;
}

export function phaseSortOrder(phase: Phase): number {
  return phaseOrder.get(phase) ?? 99;
}

export function parseScriptFormat(value: string): ScriptFormat | null {
  if (value === "sh" || value === "bash") {
    return "sh";
  }
  return value === "just" || value === "make" ? value : null;
}

export function parseSkillKind(value: string): SkillKind | null {
  return value === "skill" || value === "agents" || value === "command" ? value : null;
}

export function defaultScriptOpts(): ScriptOpts {
  return { format: "sh", minFrequency: 0.25, exemplar: false };
}

export function decodeCommand(toolName: string, input: string | null | undefined): string | null {
  if (input == null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
    if (typeof value === "string") {
      value = JSON.parse(value);
    }
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  const key =
    toolName === "Bash"
      ? "command"
      : toolName === "exec_command" || toolName === "shell" || toolName === "local_shell"
        ? "cmd"
        : null;
  if (key == null) {
    return null;
  }
  const command = object[key] ?? object.command;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command)) {
    const parts = command
      .filter((part): part is string => typeof part === "string")
      .map(shellQuote);
    return parts.length > 0 ? parts.join(" ") : null;
  }
  return null;
}

export function normalize(raw: string, cwd?: string | null): string {
  const replaced =
    cwd == null ? raw : replacePathPrefix(raw, cwd.replace(/\/+$/, ""), "$PROJECT_ROOT");
  return replaced.split(/\s+/).filter(Boolean).join(" ");
}

function replacePathPrefix(value: string, from: string, to: string): string {
  if (from === "") {
    return value;
  }
  let out = "";
  let index = 0;
  for (;;) {
    const pos = value.indexOf(from, index);
    if (pos < 0) {
      out += value.slice(index);
      return out;
    }
    const after = pos + from.length;
    const beforeChar = pos === 0 ? null : value[pos - 1];
    const afterChar = value[after] ?? null;
    const prefixOk = beforeChar == null || !/[A-Za-z0-9/_\-.]/.test(beforeChar);
    const suffixOk = afterChar == null || /[/ \t"'):]/.test(afterChar);
    out += value.slice(index, pos);
    out += prefixOk && suffixOk ? to : from;
    index = after;
  }
}

export function redact(value: string): [string, boolean] {
  let out = value;
  let hit = false;
  for (const [pattern, replacement] of redactors) {
    if (pattern.test(out)) {
      hit = true;
      out = out.replace(pattern, replacement);
    }
    pattern.lastIndex = 0;
  }
  return [out, hit];
}

export function classifyPhase(command: string): Phase {
  const lower = command.toLowerCase();
  const has = (needles: string[]): boolean => needles.some((needle) => lower.includes(needle));
  if (has(["install", "deps.get", "setup", "bootstrap", "npm ci", "mix setup"])) {
    return "setup";
  }
  if (has(["clippy", "fmt", "lint", "format", "rustfmt", "eslint", "prettier"])) {
    return "lint";
  }
  if (
    has(["test", "spec", "nextest"]) ||
    (lower.includes(" check") && !lower.includes("checkout"))
  ) {
    return "test";
  }
  if (has(["build", "compile"])) {
    return "build";
  }
  if (has(["deploy", "release", "publish"])) {
    return "deploy";
  }
  if (has(["git "])) {
    return "vcs";
  }
  if (has(["run", "serve", "start", "phx.server"])) {
    return "run";
  }
  return "other";
}

export function isDestructive(command: string): string | null {
  const lower = command.toLowerCase();
  const rules: [string, string][] = [
    ["rm -rf", "rm -rf"],
    ["rm -fr", "rm -rf"],
    ["git push --force", "force push"],
    ["git push -f", "force push"],
    ["git reset --hard", "hard reset"],
    ["git clean", "git clean"],
    ["git checkout -- ", "discard changes"],
    ["git checkout .", "discard changes"],
    ["git restore", "discard changes"],
    ["kubectl delete", "kubectl delete"],
    ["docker rm", "docker rm"],
    ["docker rmi", "docker rmi"],
    ["docker volume rm", "docker volume rm"],
    ["dropdb", "dropdb"],
    ["drop table", "drop table"],
    ["drop database", "drop database"],
    ["dd if=", "dd"],
    ["mkfs", "mkfs"],
    ["truncate -s 0", "truncate"],
    ["shred ", "shred"],
    [" -delete", "find -delete"],
    ["chmod -r 777", "chmod 777"],
    ["| sh", "pipe-to-shell"],
    ["| bash", "pipe-to-shell"],
  ];
  return rules.find(([pattern]) => lower.includes(pattern))?.[1] ?? null;
}

export function timeline(db: Database, scope: Scope = {}): Distillation {
  const scoped = scopeClause(scope);
  const visibleSession = sessionUserStatePredicateForDatabase(db, "s");
  const count = db
    .query(
      `SELECT COUNT(*) AS session_count, MIN(s.started_at) AS date_from, MAX(s.started_at) AS date_to
       FROM session s
       LEFT JOIN project p ON p.id = s.project_id
       WHERE ${visibleSession}${scoped.sql}`,
    )
    .get(...scoped.values) as {
    session_count: number;
    date_from: string | null;
    date_to: string | null;
  };
  const rows = db
    .query(
      `SELECT tc.session_id, tc.ordinal, tc.tool_name, tc.input, tc.is_error, s.cwd
       FROM tool_call tc
       JOIN session s ON s.id = tc.session_id
       LEFT JOIN project p ON p.id = s.project_id
       WHERE ${visibleSession}${scoped.sql}
       ORDER BY tc.session_id, tc.ordinal`,
    )
    .all(...scoped.values) as ToolCallRow[];

  const raws = rows.flatMap((row) => {
    if (row.tool_name == null) {
      return [];
    }
    const command = decodeCommand(row.tool_name, row.input);
    if (command == null) {
      return [];
    }
    const [redactedCommand, redacted] = redact(command);
    const normalized = normalize(redactedCommand, row.cwd);
    return [
      {
        session_id: row.session_id,
        ordinal: row.ordinal,
        raw: redactedCommand,
        normalized,
        redacted,
        phase: classifyPhase(normalized),
        is_error: row.is_error === 1,
      },
    ];
  });

  const agg = new Map<string, { sessions: Set<number>; total: number; ok: number }>();
  for (const row of raws) {
    const entry = agg.get(row.normalized) ?? { sessions: new Set<number>(), total: 0, ok: 0 };
    entry.sessions.add(row.session_id);
    entry.total += 1;
    if (!row.is_error) {
      entry.ok += 1;
    }
    agg.set(row.normalized, entry);
  }

  const ops = raws.map((row): Op => {
    const entry = agg.get(row.normalized);
    return {
      session_id: row.session_id,
      ordinal: row.ordinal,
      kind: "command",
      raw: row.raw,
      normalized: row.normalized,
      payload: null,
      phase: row.phase,
      is_error: row.is_error,
      redacted: row.redacted,
      sessions_seen: entry?.sessions.size ?? 0,
      success_rate: entry == null || entry.total === 0 ? 0 : entry.ok / entry.total,
    };
  });

  return {
    scope_label: scopeLabel(scope),
    ops,
    session_count: count.session_count,
    date_from: count.date_from,
    date_to: count.date_to,
    generated_with: DECANT_VERSION,
  };
}

export function renderScript(
  distillation: Distillation,
  options: ScriptOpts = defaultScriptOpts(),
): string {
  const lines = selectLines(distillation, options);
  switch (options.format) {
    case "sh":
      return emitSh(distillation, options, lines);
    case "just":
      return emitJust(distillation, options, lines);
    case "make":
      return emitMake(distillation, options, lines);
  }
}

export function replayOps(db: Database, sessionId: number): Op[] {
  const cwd =
    (
      db.query("SELECT cwd FROM session WHERE id = ?1").get(sessionId) as {
        cwd: string | null;
      } | null
    )?.cwd ?? null;
  const rows = db
    .query(
      `SELECT ordinal, tool_name, input, is_error
       FROM tool_call WHERE session_id = ?1 ORDER BY ordinal`,
    )
    .all(sessionId) as ReplayToolCallRow[];
  const ops: Op[] = [];
  for (const row of rows) {
    if (row.tool_name == null) {
      continue;
    }
    const isError = row.is_error === 1;
    const command = decodeCommand(row.tool_name, row.input);
    if (command != null) {
      const [redactedCommand, redacted] = redact(command);
      const normalized = normalize(redactedCommand, cwd);
      ops.push({
        session_id: sessionId,
        ordinal: row.ordinal,
        kind: "command",
        raw: redactedCommand,
        normalized,
        payload: null,
        phase: classifyPhase(normalized),
        is_error: isError,
        redacted,
        sessions_seen: 1,
        success_rate: isError ? 0 : 1,
      });
      continue;
    }
    const file = fileOp(row.tool_name, row.input, cwd, sessionId, row.ordinal, isError);
    if (file != null) {
      ops.push(file);
    }
  }
  return ops;
}

export function renderReplay(
  db: Database,
  sessionId: number,
  includeErrors: boolean,
): string | null {
  const meta = db.query("SELECT title, tool FROM session WHERE id = ?1").get(sessionId) as {
    title: string | null;
    tool: string;
  } | null;
  if (meta == null) {
    return null;
  }
  const ops = replayOps(db, sessionId);
  let out = "#!/usr/bin/env bash\n";
  out += `# Replay of ${commentSafe(meta.tool)} session ${sessionId}: ${commentSafe(meta.title ?? "(untitled)")}\n`;
  out += `# Distilled by Decant ${DECANT_VERSION}. Best-effort, REVIEW before running.\n`;
  out += "# Assumes the same starting file state; secrets are best-effort redacted.\n";
  out += "set -euo pipefail\n";
  out += `PROJECT_ROOT="\${PROJECT_ROOT:-$(git rev-parse --show-toplevel)}"\ncd "$PROJECT_ROOT"\n\n`;
  for (const op of ops) {
    switch (op.kind) {
      case "command": {
        if (op.is_error && !includeErrors) {
          break;
        }
        const destructive = isDestructive(op.normalized);
        if (op.is_error) {
          out += `# (errored in original run)\n# ${commentSafe(op.normalized)}\n`;
        } else if (destructive != null) {
          out += `# REVIEW: destructive (${destructive})\n# ${commentSafe(op.normalized)}\n`;
        } else {
          out += `${op.normalized}\n`;
        }
        break;
      }
      case "file_write":
        out += writeBlock(op.raw, op.payload ?? "");
        break;
      case "file_edit":
        out += `# EDIT ${commentSafe(op.raw)}: ${commentSafe(op.payload ?? "")} (apply manually — v1 does not auto-apply edits)\n`;
        break;
      case "file_delete":
        out += `# DELETE ${commentSafe(op.raw)} (review)\n# rm ${commentSafe(shellQuote(op.raw))}\n`;
        break;
      case "patch":
        out += patchBlock(op.payload ?? "");
        break;
    }
  }
  return out;
}

export function hotContext(db: Database, scope: Scope = {}, limitValue = 15): HotFile[] {
  const scoped = scopeClause(scope);
  const visibleSession = sessionUserStatePredicateForDatabase(db, "s");
  return db
    .query(
      `SELECT fr.rel_path,
              SUM(CASE WHEN fr.operation = 'read' THEN 1 ELSE 0 END) AS reads,
              SUM(CASE WHEN fr.operation IN ('edit', 'write') THEN 1 ELSE 0 END) AS edits,
              COUNT(DISTINCT fr.session_id) AS sessions
       FROM file_ref fr
       JOIN session s ON s.id = fr.session_id
       LEFT JOIN project p ON p.id = s.project_id
       WHERE fr.rel_path IS NOT NULL
         AND ${visibleSession}${scoped.sql}
       GROUP BY fr.rel_path
       HAVING reads > 0
       ORDER BY sessions DESC, reads DESC, fr.rel_path
       LIMIT ?`,
    )
    .all(...scoped.values, normalizeLimit(limitValue, 15)) as HotFile[];
}

export function renderSkill(
  distillation: Distillation,
  hot: HotFile[],
  kind: SkillKind,
  project: string,
): string {
  const commands = commandsBlock(distillation);
  const files = keyFilesBlock(hot);
  const slug = Array.from(project)
    .map((char) => (/[A-Za-z0-9]/.test(char) ? char.toLowerCase() : "-"))
    .join("");
  switch (kind) {
    case "skill":
      return `---
name: ${slug}-workflow
description: Distilled workflow for ${project} — proven commands and the files agents re-read most. Use when working in ${project}.
---

# ${project} workflow

_Distilled by Decant ${distillation.generated_with} from ${distillation.session_count} session(s). Review and edit before use._

## When to use

Working in the ${project} project — building, testing, or getting oriented.

## Key files

${files}
## Commands

${commands}`;
    case "agents":
      return `## ${project} — distilled workflow

_Decant ${distillation.generated_with}, from ${distillation.session_count} session(s). Review before committing._

### Commands

${commands}
### Where things live

${files}`;
    case "command":
      return `---
description: Run the distilled ${project} workflow
---

Proven commands for ${project} (Decant, ${distillation.session_count} session(s)):

${commands}`;
  }
}

interface ToolCallRow {
  session_id: number;
  ordinal: number;
  tool_name: string | null;
  input: string | null;
  is_error: number | null;
  cwd: string | null;
}

interface ReplayToolCallRow {
  ordinal: number;
  tool_name: string | null;
  input: string | null;
  is_error: number | null;
}

interface SelectedLine {
  phase: Phase;
  cmd: string;
  sessionsSeen: number;
  successRate: number;
  destructive: string | null;
  orderKey: [number, number];
}

function scopeClause(scope: Scope): { sql: string; values: (string | number)[] } {
  let sql = "";
  const values: (string | number)[] = [];
  if (scope.project != null) {
    sql += " AND (p.name = ? OR p.path = ? OR COALESCE(p.root_path, p.path) = ?)";
    values.push(scope.project, scope.project, scope.project);
  }
  if (scope.workType != null) {
    sql += " AND s.work_type = ?";
    values.push(scope.workType);
  }
  if (scope.fromSession != null) {
    sql += " AND s.id = ?";
    values.push(scope.fromSession);
  }
  return { sql, values };
}

function scopeLabel(scope: Scope): string {
  if (scope.fromSession != null) {
    return `session ${scope.fromSession}`;
  }
  if (scope.project != null) {
    return `project ${JSON.stringify(scope.project)}`;
  }
  if (scope.workType != null) {
    return `work_type ${JSON.stringify(scope.workType)}`;
  }
  return "all sessions";
}

function selectLines(distillation: Distillation, options: ScriptOpts): SelectedLine[] {
  const exemplar = options.exemplar || distillation.session_count <= 1;
  const lines: SelectedLine[] = [];
  if (exemplar) {
    let last: string | null = null;
    for (const op of distillation.ops.filter((op) => op.kind === "command")) {
      if (op.is_error || last === op.normalized) {
        continue;
      }
      last = op.normalized;
      lines.push({
        phase: op.phase,
        cmd: op.normalized,
        sessionsSeen: op.sessions_seen,
        successRate: op.success_rate,
        destructive: isDestructive(op.normalized),
        orderKey: [op.session_id, op.ordinal],
      });
    }
    lines.sort(compareOrderKey);
    return lines;
  }

  const seen = new Set<string>();
  for (const op of distillation.ops.filter((op) => op.kind === "command")) {
    if (seen.has(op.normalized)) {
      continue;
    }
    seen.add(op.normalized);
    const freq = op.sessions_seen / Math.max(distillation.session_count, 1);
    if (op.success_rate <= 0 || op.sessions_seen < 2 || freq < options.minFrequency) {
      continue;
    }
    lines.push({
      phase: op.phase,
      cmd: op.normalized,
      sessionsSeen: op.sessions_seen,
      successRate: op.success_rate,
      destructive: isDestructive(op.normalized),
      orderKey: [0, 0],
    });
  }
  lines.sort(
    (left, right) =>
      phaseSortOrder(left.phase) - phaseSortOrder(right.phase) ||
      right.sessionsSeen - left.sessionsSeen ||
      right.successRate - left.successRate ||
      compareCodePoints(left.cmd, right.cmd),
  );
  return lines;
}

function headerLines(distillation: Distillation, options: ScriptOpts): string[] {
  const day = (value: string | null): string => value?.slice(0, 10) ?? "?";
  const mode =
    options.exemplar || distillation.session_count <= 1
      ? "faithful single-session order"
      : "ranked by frequency × success";
  return [
    `Distilled by Decant ${distillation.generated_with} from ${distillation.scope_label}`,
    `${distillation.session_count} session(s) (${day(distillation.date_from)}..${day(
      distillation.date_to,
    )}). Commands you actually ran, ${mode}.`,
    "REVIEW before running. Secrets are best-effort redacted.",
  ];
}

function emitSh(distillation: Distillation, options: ScriptOpts, lines: SelectedLine[]): string {
  let out = "#!/usr/bin/env bash\n";
  for (const header of headerLines(distillation, options)) {
    out += `# ${header}\n`;
  }
  out += "set -euo pipefail\n";
  out += `PROJECT_ROOT="\${PROJECT_ROOT:-$(git rev-parse --show-toplevel)}"\n`;
  if (lines.length === 0) {
    return `${out}\n# (no recurring commands met the frequency threshold)\n`;
  }
  const grouped = !options.exemplar && distillation.session_count > 1;
  if (grouped) {
    for (const phase of PHASES) {
      const group = lines.filter((line) => line.phase === phase);
      if (group.length === 0) {
        continue;
      }
      out += `\n# ${phaseLabel(phase)}\n`;
      for (const line of group) {
        out += shLine(line, distillation.session_count);
      }
    }
  } else {
    out += "\n";
    for (const line of lines) {
      out += shLine(line, distillation.session_count);
    }
  }
  return out;
}

function shLine(line: SelectedLine, sessionCount: number): string {
  if (line.destructive != null) {
    return `# REVIEW: destructive (${line.destructive}), seen in ${line.sessionsSeen} session(s) — left commented\n# ${line.cmd}\n`;
  }
  const prefix =
    sessionCount > 1
      ? `# seen ${line.sessionsSeen}/${sessionCount}, ${Math.round(line.successRate * 100)}% ok\n`
      : "";
  return `${prefix}${line.cmd}\n`;
}

function emitJust(distillation: Distillation, options: ScriptOpts, lines: SelectedLine[]): string {
  let out = "";
  for (const header of headerLines(distillation, options)) {
    out += `# ${header}\n`;
  }
  out += "\nexport PROJECT_ROOT := `git rev-parse --show-toplevel`\n";
  for (const phase of PHASES) {
    const group = lines.filter((line) => line.phase === phase);
    if (group.length === 0) {
      continue;
    }
    out += `\n${phase}:\n`;
    for (const line of group) {
      out +=
        line.destructive == null
          ? `    ${line.cmd}\n`
          : `    # REVIEW destructive (${line.destructive}): ${line.cmd}\n`;
    }
  }
  return out;
}

function emitMake(distillation: Distillation, options: ScriptOpts, lines: SelectedLine[]): string {
  let out = "";
  for (const header of headerLines(distillation, options)) {
    out += `# ${header}\n`;
  }
  const phases = PHASES.filter((phase) => lines.some((line) => line.phase === phase));
  out += `\n.PHONY: ${phases.join(" ")}\n`;
  for (const phase of phases) {
    out += `\n${phase}:\n`;
    for (const line of lines.filter((line) => line.phase === phase)) {
      out +=
        line.destructive == null
          ? `\t${line.cmd}\n`
          : `\t# REVIEW destructive (${line.destructive}): ${line.cmd}\n`;
    }
  }
  return out;
}

function fileOp(
  toolName: string,
  input: string | null,
  cwd: string | null,
  sessionId: number,
  ordinal: number,
  isError: boolean,
): Op | null {
  if (input == null) {
    return null;
  }
  const make = (kind: OpKind, raw: string, payload: string | null, redacted: boolean): Op => ({
    session_id: sessionId,
    ordinal,
    kind,
    raw,
    normalized: "",
    payload,
    phase: "other",
    is_error: isError,
    redacted,
    sessions_seen: 1,
    success_rate: isError ? 0 : 1,
  });
  if (toolName === "apply_patch") {
    let value: unknown;
    try {
      value = JSON.parse(input);
    } catch {
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    const [patch, redacted] = redact(value);
    return make("patch", "apply_patch", patch, redacted);
  }
  const value = parseToolInputObject(input);
  if (value == null) {
    return null;
  }
  const get = (key: string): string | null => {
    const got = value[key];
    return typeof got === "string" ? got : null;
  };
  switch (toolName) {
    case "Write": {
      const path = get("file_path");
      if (path == null) {
        return null;
      }
      const [content, redacted] = redact(get("content") ?? "");
      return make("file_write", relToRoot(path, cwd), content, redacted);
    }
    case "Edit": {
      const path = get("file_path");
      if (path == null) {
        return null;
      }
      const oldText = oneLine(get("old_string") ?? "", 60);
      const newText = oneLine(get("new_string") ?? "", 60);
      const [payload, redacted] = redact(`replace \`${oldText}\` -> \`${newText}\``);
      return make("file_edit", relToRoot(path, cwd), payload, redacted);
    }
    case "NotebookEdit": {
      const path = get("notebook_path") ?? get("file_path");
      return path == null
        ? null
        : make("file_edit", relToRoot(path, cwd), "notebook cell edit", false);
    }
    default:
      return null;
  }
}

function parseToolInputObject(input: string): Record<string, unknown> | null {
  try {
    let value: unknown = JSON.parse(input);
    if (typeof value === "string") {
      value = JSON.parse(value);
    }
    return value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function relToRoot(path: string, cwd: string | null): string {
  if (cwd != null) {
    const root = cwd.replace(/\/+$/, "");
    const prefix = `${root}/`;
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length);
    }
  }
  return path;
}

const REPLAY_EOF = "DECANT_EOF";
const COMMENT_UNSAFE = /[\p{Cc}\u2028\u2029]/gu;

/**
 * Escapes anything that could end a `#` comment line — transcript-supplied text
 * (paths, titles, commands) is interpolated into comments of a generated bash
 * script, so a raw newline there would emit an executable line.
 */
export function commentSafe(value: string): string {
  return value.replace(
    COMMENT_UNSAFE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function writeBlock(path: string, content: string): string {
  const trimmed = content.replace(/\n+$/, "");
  if (trimmed.includes(REPLAY_EOF) || path.includes("\n") || path.includes(REPLAY_EOF)) {
    return `# SKIPPED write to ${commentSafe(JSON.stringify(path))}: content or path unsafe for a heredoc — recreate it manually.\n`;
  }
  const quoted = shellQuote(path);
  return `mkdir -p "$(dirname ${quoted})"\ncat > ${quoted} <<'${REPLAY_EOF}'\n${trimmed}\n${REPLAY_EOF}\n`;
}

export function patchBlock(patch: string): string {
  const trimmed = patch.replace(/\n+$/, "");
  return trimmed.includes(REPLAY_EOF)
    ? "# SKIPPED patch: contains the heredoc delimiter — apply it manually.\n"
    : `git apply <<'${REPLAY_EOF}'\n${trimmed}\n${REPLAY_EOF}\n`;
}

function oneLine(value: string, max: number): string {
  const flat = value.split(/\s+/).filter(Boolean).join(" ");
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat;
}

function commandsBlock(distillation: Distillation): string {
  const lines = selectLines(distillation, defaultScriptOpts()).filter(
    (line) => line.destructive == null,
  );
  if (lines.length === 0) {
    return "_(no recurring commands found)_\n";
  }
  return `\`\`\`bash\n${lines.map((line) => line.cmd).join("\n")}\n\`\`\`\n`;
}

function keyFilesBlock(hot: HotFile[]): string {
  if (hot.length === 0) {
    return "_(no hot-context files found)_\n";
  }
  return hot
    .map(
      (file) =>
        `- \`${file.rel_path}\` — read in ${file.sessions} session(s)${
          file.edits === 0 ? ", rarely edited" : ""
        }\n`,
    )
    .join("");
}

function normalizeLimit(value: number | null | undefined, fallback: number): number {
  return value != null && value > 0 ? Math.trunc(value) : fallback;
}

function compareOrderKey(left: SelectedLine, right: SelectedLine): number {
  return left.orderKey[0] - right.orderKey[0] || left.orderKey[1] - right.orderKey[1];
}
