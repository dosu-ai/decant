import type { Json } from "./model.ts";

export const ACTIVITY_BUCKETS = ["context", "planning", "code", "communicating"] as const;
export type ActivityBucket = (typeof ACTIVITY_BUCKETS)[number];

const SHELL_TOOLS = new Set(["bash", "exec_command", "local_shell", "run_shell_command", "shell"]);
const CONTEXT_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "notebookread",
  "webfetch",
  "websearch",
  "task",
  "toolsearch",
  "bashoutput",
  "listmcpresourcestool",
  "readmcpresourcetool",
]);
const CODE_TOOLS = new Set([
  "apply_patch",
  "edit",
  "write",
  "notebookedit",
  "multiedit",
  "write_file",
  "replace",
]);
const PLANNING_TOOLS = new Set([
  "enterplanmode",
  "exitplanmode",
  "todowrite",
  "update_plan",
  "write_todos",
]);
const READONLY_BASH = new Set([
  "ls",
  "cat",
  "grep",
  "rg",
  "find",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "tree",
  "stat",
  "file",
  "which",
  "type",
  "env",
  "printenv",
  "diff",
]);
const READONLY_GIT = new Set(["status", "diff", "log", "show", "branch", "remote", "blame"]);

const SEARCH_COMMANDS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ripgrep",
  "ack",
  "ag",
  "find",
  "fd",
]);
const SEARCH_TOOLS = new Set(["grep", "glob"]);

// Statements, not pipelines: `ps aux | grep node` filters output rather than
// searching a repo, so counting it would make the code-map suggestion useless.
const STATEMENT_SEPARATORS = /\n|;|&&|\|\|/;

/** Counts how many search operations a tool call represents: 1 for a
 * structured Grep/Glob call, or one per shell statement whose leading
 * command is a search binary (rg, grep, find, ...). Compound commands are
 * split on `;`, `&&`, `||`, and newlines -- never on `|`, since a pipeline's
 * tail filters output rather than searching the repo. */
export function countSearches(toolName: string, input: string | null): number {
  // Raw name, before localToolName: an MCP server may be named `exec`, and a
  // dotted `mcp__x__y.shell` would otherwise flatten to `shell`.
  if (toolName.startsWith("mcp__")) {
    return 0;
  }
  const normalized = localToolName(toolName).toLowerCase();
  if (SEARCH_TOOLS.has(normalized)) {
    return 1;
  }
  if (!SHELL_TOOLS.has(normalized)) {
    return 0;
  }
  const command = commandFromInput(input ?? undefined);
  if (command == null) {
    return 0;
  }
  return command.split(STATEMENT_SEPARATORS).filter((statement) => {
    const [head, subcommand] = commandHead(statement);
    if (head == null) {
      return false;
    }
    return SEARCH_COMMANDS.has(head) || (head === "git" && subcommand === "grep");
  }).length;
}

export function toolBucket(
  toolName: string | null | undefined,
  input?: string | Json,
): ActivityBucket {
  const name = toolName ?? "";
  const baseName = localToolName(name);
  const normalized = baseName.toLowerCase();
  if (SHELL_TOOLS.has(normalized)) {
    return bashBucket(commandFromInput(input));
  }
  if (PLANNING_TOOLS.has(normalized)) {
    return "planning";
  }
  if (CODE_TOOLS.has(normalized)) {
    return "code";
  }
  if (CONTEXT_TOOLS.has(normalized) || name.startsWith("mcp__")) {
    return "context";
  }
  return "context";
}

// High-precision markers that a shell command mutates a source file. Kept
// deliberately narrow: a false positive moves the phase boundary earlier and
// mislabels orientation as implementation, which is worse than missing one. So
// no bare `>` redirect (too often /dev/null, /tmp, logs) -- only unambiguous
// in-place edits, patch application, and explicit file writes.
const SHELL_EDIT_PATTERNS: RegExp[] = [
  /\bgit\s+apply\b(?![^\n]*--(?:check|stat|summary|numstat))/, // apply a patch for real
  /\bsed\b[^\n|]*\s-i\b/, // in-place edit
  /\bpatch\b[^\n|]*-p\d/, // patch -p1 < ...
  /\bwriteFileSync\b|\bfs\.write\b|\.writeFile\b/, // node fs writes (node -e ...)
  /\bopen\([^)]*['"][wa]\+?['"]/, // python open(..., "w"/"a")
  /\bapplypatch\b/,
];

/** True for tools that mutate a file on disk (the phase boundary marker): the
 * first such tool_use flips a session from orientation to implementation. Covers
 * the structured edit tools (edit/write/patch) AND shell commands that clearly
 * write a file (git apply, sed -i, fs.writeFileSync, ...), since agents sometimes
 * implement through the shell rather than the edit tool. */
export function isCodeEditTool(
  toolName: string | null | undefined,
  input?: string | Json,
): boolean {
  const normalized = localToolName(toolName ?? "").toLowerCase();
  if (CODE_TOOLS.has(normalized)) {
    return true;
  }
  if (SHELL_TOOLS.has(normalized)) {
    const command = commandFromInput(input);
    return command != null && SHELL_EDIT_PATTERNS.some((re) => re.test(command));
  }
  return false;
}

export function blockBucket(
  blockType: string | null,
  toolName?: string | null,
  input?: string | Json,
): ActivityBucket {
  if (blockType === "thinking") {
    return "planning";
  }
  if (blockType === "tool_use" || blockType === "tool_result" || blockType === "web_search") {
    return toolBucket(toolName, input);
  }
  return "communicating";
}

export function bashBucket(command: string | null): ActivityBucket {
  const [head, subcommand] = commandHead(command);
  if (head == null) {
    return "code";
  }
  if (head === "git") {
    return subcommand != null && READONLY_GIT.has(subcommand) ? "context" : "code";
  }
  return READONLY_BASH.has(head) ? "context" : "code";
}

function commandFromInput(input: string | Json | undefined): string | null {
  if (input == null) {
    return null;
  }
  let value = typeof input === "string" ? parseJson(input) : input;
  if (typeof value === "string") {
    const nested = parseJson(value);
    if (nested !== value) {
      value = nested;
    }
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const command = value.command ?? value.cmd;
    if (typeof command === "string") {
      return command;
    }
    if (Array.isArray(command)) {
      return command.filter((part): part is string => typeof part === "string").join(" ");
    }
  }
  return null;
}

function parseJson(value: string): Json | string {
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
  }
}

function commandHead(command: string | null): [string | null, string | null] {
  const tokens = splitCommand(command);
  if (tokens.length === 0) {
    return [null, null];
  }
  const head = basename(tokens[0] ?? "");
  const subcommand = tokens[1] ?? null;
  return [head, subcommand];
}

function splitCommand(command: string | null): string[] {
  if (command == null) {
    return [];
  }
  const trimmed = command.trim();
  if (trimmed === "") {
    return [];
  }
  return trimmed.split(/\s+/).filter((token) => token !== "");
}

function basename(value: string): string {
  const clean = value.replace(/^['"]|['"]$/g, "");
  return clean.split("/").filter(Boolean).at(-1) ?? clean;
}

function localToolName(name: string): string {
  return name.split(".").filter(Boolean).at(-1) ?? name;
}
