import type { Json } from "./model.ts";

export const ACTIVITY_BUCKETS = ["context", "planning", "code", "communicating"] as const;
export type ActivityBucket = (typeof ACTIVITY_BUCKETS)[number];

const SHELL_TOOLS = new Set(["bash", "exec_command", "local_shell", "run_shell_command", "shell"]);
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
  "nl",
  "sort",
  "uniq",
  "cut",
  "tr",
  "jq",
  "du",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "less",
  "more",
  "column",
]);
const READONLY_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "remote",
  "blame",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "grep",
  "describe",
  "shortlog",
]);
// Commands that only change the shell's own state. A statement made of these
// neither reads nor writes the repo, so it never decides a compound command.
const NAVIGATION = new Set(["cd", "pushd", "popd", "true", ":"]);
// `bash -lc "<script>"` and friends: classify the script, not the shell.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]*?)\s*$/;
// An output redirect writes a file unless it targets a descriptor or /dev/null.
const WRITE_REDIRECT = /(?<![0-9&<>])>>?(?!&|\s*\/dev\/null)|&>>?(?!\s*\/dev\/null)/;

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
  const inner = codexExecCalls(toolName, input ?? undefined);
  if (inner.length > 0) {
    return inner.reduce(
      (total, call) =>
        total +
        countSearches(
          call.name,
          call.command == null ? null : JSON.stringify({ cmd: call.command }),
        ),
      0,
    );
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
  const inner = codexExecCalls(name, input);
  if (inner.length > 0) {
    const buckets = new Set(inner.map((call) => toolBucket(call.name, innerInput(call))));
    return EXEC_BUCKET_PRECEDENCE.find((bucket) => buckets.has(bucket)) ?? "context";
  }
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
  const inner = codexExecCalls(toolName, input);
  if (inner.length > 0) {
    return inner.some((call) => isCodeEditTool(call.name, innerInput(call)));
  }
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

/** A shell command is context only when every statement and pipeline stage
 * in it is read-only; one mutating or unrecognized part makes it code. Agents
 * routinely chain reads (`cd repo; grep -n x src; sed -n 1,40p f`), so judging
 * the whole command by its first word filed that reading under code. */
export function bashBucket(command: string | null): ActivityBucket {
  const script = unwrapShell(command);
  if (script == null || script.trim() === "") {
    return "code";
  }
  for (const statement of splitUnquoted(script, STATEMENT_BREAK)) {
    if (statement.trim() === "") {
      continue;
    }
    if (WRITE_REDIRECT.test(stripQuoted(statement))) {
      return "code";
    }
    if (splitUnquoted(statement, PIPE).some((stage) => stageVerdict(stage) === "code")) {
      return "code";
    }
  }
  return "context";
}

const STATEMENT_BREAK = /^(?:\n|;|&&|\|\|)/;
const PIPE = /^\|(?!\|)/;

/** Splits on `separator` outside single and double quotes, so a grep pattern
 * like "a\\|b" or a sed script like 's/a;b/c/' stays one piece. */
function splitUnquoted(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote != null) {
      if (char === "\\" && quote === '"') {
        current += char + (text[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const match = separator.exec(text.slice(i));
    if (match != null) {
      parts.push(current);
      current = "";
      i += match[0].length - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function stripQuoted(text: string): string {
  return text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

function unwrapShell(command: string | null): string | null {
  let current = command;
  for (let depth = 0; current != null && depth < 3; depth += 1) {
    const match = SHELL_WRAPPER.exec(current);
    if (match == null) {
      return current;
    }
    const body = match[1] ?? "";
    const quoted = /^(['"])([\s\S]*)\1$/.exec(body);
    current = quoted != null ? (quoted[2] ?? "") : body;
  }
  return current;
}

function stageVerdict(stage: string): ActivityBucket | "neutral" {
  const tokens = splitCommand(stage);
  if (tokens.length === 0) {
    return "neutral";
  }
  const head = basename(tokens[0] ?? "");
  const subcommand = tokens[1] ?? null;
  if (NAVIGATION.has(head)) {
    return "neutral";
  }
  if (head === "git") {
    if (subcommand === "config") {
      return tokens.some((t) => t === "--list" || t === "-l" || t.startsWith("--get"))
        ? "context"
        : "code";
    }
    return subcommand != null && READONLY_GIT.has(subcommand) ? "context" : "code";
  }
  if (head === "sed") {
    return tokens.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith("--in-place"))
      ? "code"
      : "context";
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

/** One `tools.<name>(...)` call inside a Codex `exec` program. */
export interface CodexExecCall {
  name: string;
  /** The literal `cmd` of an `exec_command` call; null when it is built at runtime. */
  command: string | null;
}

const EXEC_INNER_CALL = /\btools\.([A-Za-z_]\w*)\s*\(/g;
const EXEC_CMD_LITERAL =
  /^\s*\{[^{}]*?["']?\bcmd["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/;

// Recent Codex versions run every action through one `exec` tool whose input is a
// JavaScript program calling `tools.exec_command(...)`, `tools.apply_patch(...)`, and so
// on. Classifying that wrapper by its own name would file every edit and shell command
// as context, so each inner call is classified on its own terms.
function isCodexExec(toolName: string | null | undefined): boolean {
  const name = toolName ?? "";
  // Raw name check: an MCP server's tool may also be called `exec`.
  return !name.startsWith("mcp__") && name.toLowerCase() === "exec";
}

function execProgram(input: string | Json | undefined): string | null {
  if (input == null) {
    return null;
  }
  if (typeof input !== "string") {
    return typeof input === "object" && !Array.isArray(input) && typeof input.input === "string"
      ? input.input
      : null;
  }
  const parsed = parseJson(input);
  return typeof parsed === "string" ? parsed : input;
}

function decodeJsString(literal: string): string {
  if (literal.startsWith('"')) {
    const parsed = parseJson(literal);
    if (typeof parsed === "string") {
      return parsed;
    }
  }
  return literal.slice(1, -1).replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
}

/** The inner tool calls of a Codex `exec` program, in source order. Empty for any
 * other tool, or for a program that calls no tools. */
export function codexExecCalls(
  toolName: string | null | undefined,
  input?: string | Json,
): CodexExecCall[] {
  if (!isCodexExec(toolName)) {
    return [];
  }
  const program = execProgram(input);
  if (program == null) {
    return [];
  }
  const calls: CodexExecCall[] = [];
  for (const match of program.matchAll(EXEC_INNER_CALL)) {
    const name = match[1] ?? "";
    if (name.toLowerCase() === "exec") {
      continue;
    }
    let command: string | null = null;
    if (name === "exec_command") {
      const rest = program.slice((match.index ?? 0) + match[0].length);
      const literal = rest.match(EXEC_CMD_LITERAL)?.[1];
      command = literal == null ? null : decodeJsString(literal);
    }
    calls.push({ name, command });
  }
  return calls;
}

// A program that reads and then patches is an implementation step, so the strongest
// inner bucket labels the whole call.
const EXEC_BUCKET_PRECEDENCE: ActivityBucket[] = ["code", "planning", "context"];

function innerInput(call: CodexExecCall): Json | undefined {
  return call.command == null ? undefined : { cmd: call.command };
}
