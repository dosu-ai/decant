import { type CallExpression, parse } from "acorn";
import { simple } from "acorn-walk";
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
// Codex polls a long-running `exec_command` (almost always a build or test run)
// through `write_stdin`; the poll carries that command's output and wait. It is
// not an edit, so it stays out of CODE_TOOLS and never moves the phase boundary.
const EXEC_POLL_TOOLS = new Set(["write_stdin"]);
const PLANNING_TOOLS = new Set([
  "enterplanmode",
  "exitplanmode",
  "todowrite",
  "update_plan",
  "write_todos",
  // Claude Code's task list, which replaced TodoWrite.
  "taskcreate",
  "taskupdate",
  "tasklist",
  "taskget",
]);
const READONLY_BASH = new Set([
  "ls",
  "cat",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "ack",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "printf",
  "stat",
  "file",
  "which",
  "type",
  "env",
  "printenv",
  "diff",
  "cmp",
  "comm",
  "paste",
  "tac",
  "rev",
  "nl",
  "cut",
  "tr",
  "jq",
  "du",
  "df",
  "realpath",
  "readlink",
  "basename",
  "dirname",
  "less",
  "more",
  "column",
  "od",
  "hexdump",
  "strings",
  "shasum",
  "sha256sum",
  "md5",
  "md5sum",
  "cksum",
  "test",
  "[",
  "[[",
  "date",
  "ps",
  "pgrep",
  "lsof",
  "uname",
  "whoami",
  "id",
  "sw_vers",
  "uptime",
  "jobs",
  "bc",
  "expr",
  "seq",
]);
const READONLY_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "rev-parse",
  "rev-list",
  "show-ref",
  "for-each-ref",
  "merge-base",
  "cat-file",
  "name-rev",
  "check-ignore",
  "verify-commit",
  "grep",
  "describe",
  "shortlog",
  "version",
]);
// Commands that only change the shell's own state. A statement made of these
// neither reads nor writes the repo, so it never decides a compound command.
// `sleep` and `wait` are not here: an agent sleeps to wait on a build, a test
// run, or CI, and that time belongs to the work it waits on.
const NAVIGATION = new Set([
  "cd",
  "pushd",
  "popd",
  "true",
  "false",
  ":",
  "export",
  "unset",
  "set",
  "shopt",
  "local",
  "declare",
  "readonly",
  "for",
  "done",
  "fi",
  "}",
]);
// Keywords and wrappers that run the words after them: classify those words.
const COMMAND_PREFIXES = new Set(["if", "elif", "then", "else", "while", "until", "do", "!", "{"]);
const COMMAND_WRAPPERS = new Set(["time", "nohup", "timeout", "xargs"]);
// Wrapper options whose value is the next word, so it is not mistaken for the command.
const WRAPPER_VALUE_OPTIONS = new Set(["-k", "-s", "-I", "-n", "-P", "-L", "-d", "-E", "-u", "-C"]);
// A bare `version` word is not here: `yarn version` and `changeset version` bump versions.
const VERSION_ARGS = new Set(["--version", "-v", "-V", "--help", "-h", "help"]);
// `bash -lc "<script>"` and friends: classify the script, not the shell.
const SHELL_WRAPPER = /^\s*(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]*?)\s*$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
// An output redirect (`>`, `>>`, `>|`, `2>`, `&>`, `>&`, `<>`) writes a file
// unless it targets a descriptor or a device like /dev/null.
const WRITE_REDIRECT =
  /(?:&>>?|\d*(?:>>|>\||<>|>))(?!&\d|&-|\s*\/dev\/(?:null|stdout|stderr|tty)\b)/;
// Command substitutions and `sh -c` scripts nest; past this depth a command is
// treated as unrecognized (code) rather than parsed further.
const MAX_NESTING = 8;

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

/** Counts how many search operations a tool call represents: 1 for a
 * structured Grep/Glob call, or one per shell statement whose command is a
 * search binary (rg, grep, find, ...) or `git grep`. Statements are split the
 * way bashBucket splits them, and the command is found the same way, past
 * assignments, wrappers, and `git -C dir`. Only a pipeline's first stage
 * counts: `ps aux | grep node` filters output rather than searching a repo, so
 * counting it would make the code-map suggestion useless. */
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
  const script = unwrapShell(commandFromInput(input ?? undefined));
  return script == null ? 0 : scriptSearches(stripHeredocBodies(script), 0);
}

function scriptSearches(script: string, depth: number): number {
  if (depth >= MAX_NESTING) {
    return 0;
  }
  let count = 0;
  for (const statement of splitUnquoted(script, STATEMENT_BREAK)) {
    const [stage = ""] = splitUnquoted(statement, PIPE);
    const words = commandWords(stage);
    const head = basename(words[0] ?? "");
    const args = words.slice(1);
    if (SEARCH_COMMANDS.has(head)) {
      count += 1;
    } else if (head === "git" && skipOptions(args, GIT_VALUE_OPTIONS)[0] === "grep") {
      count += 1;
    } else if (SHELLS.has(head)) {
      // `cd repo && bash -lc "rg x"`: count the searches in the script it runs.
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      const body = flag === -1 ? undefined : args[flag + 1];
      if (body != null) {
        count += scriptSearches(stripHeredocBodies(quotedWord(body) ?? body), depth + 1);
      }
    }
  }
  return count;
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
  if (name.startsWith("mcp__")) {
    return mcpToolBucket(name, input);
  }
  const baseName = localToolName(name);
  const normalized = baseName.toLowerCase();
  if (SHELL_TOOLS.has(normalized)) {
    return bashBucket(commandFromInput(input));
  }
  if (PLANNING_TOOLS.has(normalized)) {
    return "planning";
  }
  if (USER_QUESTION_TOOLS.has(normalized)) {
    return "communicating";
  }
  if (
    CODE_TOOLS.has(normalized) ||
    EXEC_POLL_TOOLS.has(normalized) ||
    NOTE_WRITE_TOOLS.has(normalized)
  ) {
    return "code";
  }
  return "context";
}

/** An MCP tool, named `mcp__<server>__<tool>`: browser, desktop, and REPL
 * servers split into reads and actions; other tools keep the context default. */
function mcpToolBucket(name: string, input: string | Json | undefined): ActivityBucket {
  const match = /^mcp__(.+?)__+(.+)$/.exec(name);
  if (match == null) {
    return "context";
  }
  const server = (match[1] ?? "").toLowerCase();
  const tool = (match[2] ?? "").toLowerCase();
  if (USER_QUESTION_TOOLS.has(tool)) {
    return "communicating";
  }
  if (NOTE_WRITE_TOOLS.has(tool)) {
    return "code";
  }
  return uiToolActs(server, tool, parseToolInput(input)) ? "code" : "context";
}

// Tools that ask the user a question and wait for the answer: the model is
// talking to the user, as it does in visible text.
const USER_QUESTION_TOOLS = new Set([
  "askuserquestion",
  "request_user_input",
  "request_user_input_async",
]);

/** True for a tool that asks the user a question, in any spelling, including
 * an MCP copy such as `mcp__<server>__AskUserQuestion`. Its result arrives
 * when the user answers, so the time before it is the user's. */
export function isUserQuestionTool(
  toolName: string | null | undefined,
  input?: string | Json,
): boolean {
  const inner = codexExecCalls(toolName, input);
  if (inner.length > 0) {
    // A Codex `exec` program that only asks the user something.
    return inner.every((call) => isUserQuestionTool(call.name));
  }
  const name = toolName ?? "";
  const tool = name.startsWith("mcp__")
    ? (/^mcp__.+?__+(.+)$/.exec(name)?.[1] ?? "")
    : localToolName(name);
  return USER_QUESTION_TOOLS.has(tool.toLowerCase());
}
// Tools that write a note or checkpoint outside the workspace: Codex notes, an
// Obsidian vault, a Dosu knowledge entry. Writing is code, but a note is the
// agent's memory rather than the work product, so it never marks the first edit.
const NOTE_WRITE_TOOLS = new Set([
  "notes__write_file",
  "notes__append_to_file",
  "obsidian_append_content",
  "write_knowledge",
]);

// Browser and desktop automation reads when it looks (snapshot, screenshot, page
// text, console, tabs) or goes somewhere (navigate, wait), and acts when it sends
// input or runs code in the page. Hover and mouse moves count as input: they fire
// page handlers and open menus, the same as the click or scroll they lead into.
const PLAYWRIGHT_ACTIONS = new Set([
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_drag",
  "browser_drop",
  "browser_hover",
  "browser_file_upload",
  "browser_evaluate",
  "browser_run_code",
  "browser_run_code_unsafe",
  "browser_resize",
  "browser_emulate_media",
  "browser_handle_dialog",
  "browser_install",
  "browser_mouse_click_xy",
  "browser_mouse_drag_xy",
  "browser_mouse_move_xy",
]);
const CHROME_ACTIONS = new Set([
  "form_input",
  "file_upload",
  "upload_image",
  "javascript_tool",
  "resize_window",
  "shortcuts_execute",
]);
// Desktop control is all input except these looks and permission checks.
const COMPUTER_READS = new Set([
  "screenshot",
  "zoom",
  "wait",
  "cursor_position",
  "get_app_state",
  "request_access",
  "list_granted_applications",
]);

/** True when a browser, desktop-control, or REPL tool changes state. */
function uiToolActs(server: string, tool: string, input: Json | undefined): boolean {
  if (server.includes("repl")) {
    // A REPL call runs code.
    return true;
  }
  if (tool === "computer") {
    return computerActionActs(get(input, "action"));
  }
  if (tool === "computer_batch" || tool === "browser_batch") {
    const actions = get(input, "actions");
    return (
      Array.isArray(actions) &&
      actions.some((action) =>
        tool === "computer_batch"
          ? computerActionActs(get(action, "action"))
          : uiToolActs(
              server,
              String(get(action, "name") ?? "").toLowerCase(),
              get(action, "input"),
            ),
      )
    );
  }
  if (server.includes("playwright")) {
    return PLAYWRIGHT_ACTIONS.has(tool);
  }
  if (server.includes("chrome")) {
    return CHROME_ACTIONS.has(tool);
  }
  if (/computer[-_]?use/.test(server)) {
    return !COMPUTER_READS.has(tool);
  }
  return false;
}

function computerActionActs(action: Json | undefined): boolean {
  return typeof action === "string" && !COMPUTER_READS.has(action.toLowerCase());
}

function parseToolInput(input: string | Json | undefined): Json | undefined {
  let value = typeof input === "string" ? parseJson(input) : input;
  if (typeof value === "string") {
    value = parseJson(value);
  }
  return value;
}

function get(value: Json | undefined, key: string): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;
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
  /\.write_(?:text|bytes)\(/, // python pathlib Path.write_text / write_bytes
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
    // The patterns match anywhere in the text, so `rg writeFileSync src` or
    // `sed -n 1p f; grep -i x` would look like edits; an edit is never a read.
    return (
      command != null &&
      SHELL_EDIT_PATTERNS.some((re) => re.test(command)) &&
      bashBucket(command) === "code"
    );
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
  return scriptBucket(stripHeredocBodies(script));
}

let nesting = 0;

function scriptBucket(script: string): ActivityBucket {
  if (nesting >= MAX_NESTING) {
    return "code";
  }
  nesting += 1;
  try {
    return statementsBucket(script);
  } finally {
    nesting -= 1;
  }
}

function statementsBucket(script: string): ActivityBucket {
  for (const statement of splitUnquoted(script, STATEMENT_BREAK)) {
    if (statement.trim() === "") {
      continue;
    }
    if (WRITE_REDIRECT.test(stripQuoted(statement))) {
      return "code";
    }
    // `$(...)` runs too: `X=$(git merge-base a b)` reads, `X=$(rm f)` does not.
    if (substitutions(statement).some((body) => scriptBucket(body) === "code")) {
      return "code";
    }
    if (splitUnquoted(statement, PIPE).some((stage) => stageVerdict(stage) === "code")) {
      return "code";
    }
  }
  return "context";
}

// A lone `&` backgrounds a job and starts the next statement; `&>`, `>&`, and
// `|&` are redirects or pipes, which the preceding character rules out. The
// separators are sticky so splitting matches in place instead of re-slicing the
// rest of the text at every character.
const STATEMENT_BREAK = /\n|;|&&|\|\||&(?!>)/y;
const PIPE = /\|&?(?!\|)/y;
const WORD_BREAK = /\s+/y;

/** Splits on `separator` (a sticky regex) outside quotes, escapes, and
 * `$(...)`, so a grep pattern like "a\\|b", a sed script like 's/a;b/c/',
 * `find -exec cat {} \;`, or `$(git log | head -1)` stays one piece. */
function splitUnquoted(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;
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
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if ("$<>".includes(char) && text[i + 1] === "(") {
      depth += 1;
      current += `${char}(`;
      i += 1;
      continue;
    }
    if (depth > 0) {
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      }
      current += char;
      continue;
    }
    // `>&2` and `|&` are not a backgrounding `&`.
    const redirect = char === "&" && "<>|".includes(text[i - 1] ?? "");
    separator.lastIndex = i;
    const match = redirect ? null : separator.exec(text);
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

/** The bodies of `$(...)` substitutions outside single quotes, and of `<(...)`
 * and backtick substitutions outside any quotes. Arithmetic `$((...))` runs
 * nothing and is skipped. */
function substitutions(statement: string): string[] {
  const bodies: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < statement.length; i += 1) {
    const char = statement[i] ?? "";
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "'" && quote == null) {
      quote = "'";
    } else if (char === '"') {
      quote = quote == null ? '"' : null;
    } else if (char === "$" && statement.startsWith("((", i + 1)) {
      // Arithmetic runs nothing itself, but a `$(...)` inside it still runs.
      i += 2;
    } else if ((char === "$" || (char === "<" && quote == null)) && statement[i + 1] === "(") {
      let depth = 1;
      let end = i + 2;
      for (; end < statement.length && depth > 0; end += 1) {
        if (statement[end] === "(") {
          depth += 1;
        } else if (statement[end] === ")") {
          depth -= 1;
        }
      }
      bodies.push(statement.slice(i + 2, depth === 0 ? end - 1 : end));
      i = end - 1;
    } else if (char === "`" && quote == null) {
      // Inside double quotes a backtick pair is almost always a Markdown code
      // span in a grep pattern or label, not a command the agent meant to run.
      const end = statement.indexOf("`", i + 1);
      if (end === -1) {
        break;
      }
      bodies.push(statement.slice(i + 1, end));
      i = end;
    }
  }
  return bodies;
}

const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][\w.-]*)\1/g;

/** Drops heredoc bodies so their lines are not read as statements. The line
 * that opens the heredoc still decides: `cat > f <<EOF` writes, `python3 - <<EOF`
 * runs code, and a bare `cat <<EOF` only prints. An unterminated heredoc keeps
 * the script intact rather than hiding what follows it. */
function stripHeredocBodies(script: string): string {
  if (!script.includes("<<")) {
    return script;
  }
  const kept: string[] = [];
  const pending: string[] = [];
  for (const line of script.split("\n")) {
    if (pending.length > 0) {
      if (line.replace(/^\t+/, "").trimEnd() === pending[0]) {
        pending.shift();
      }
      continue;
    }
    kept.push(line);
    for (const match of line.matchAll(HEREDOC)) {
      if (outsideQuotes(line, match.index ?? 0)) {
        pending.push(match[2] ?? "");
      }
    }
  }
  return pending.length > 0 ? script : kept.join("\n");
}

function outsideQuotes(text: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i += 1) {
    const char = text[i] ?? "";
    if (quote == null && char === "\\") {
      i += 1;
    } else if (quote == null && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    }
  }
  return quote == null;
}

// Escapes go first so `\"` does not open a quote, and an unterminated quote
// runs to the end, as it does in splitUnquoted (a closing quote is optional so
// an unbalanced string cannot make this quadratic). Arithmetic goes too, since
// `$((a > b))` compares rather than redirects.
function stripQuoted(text: string): string {
  return text.replace(
    /\\[\s\S]|'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|\$\(\((?:[^()]|\([^()]*\))*\)\)/g,
    "''",
  );
}

function unwrapShell(command: string | null): string | null {
  let current = command;
  for (let depth = 0; current != null && depth < 3; depth += 1) {
    const match = SHELL_WRAPPER.exec(current);
    if (match == null) {
      return current;
    }
    const body = match[1] ?? "";
    if (/^['"]/.test(body)) {
      const script = quotedWord(body);
      // `bash -c 'a' _ b` or `bash -c "a"; rm b`: the stage check reads each wrapper.
      if (script == null) {
        return current;
      }
      current = script;
    } else {
      current = body;
    }
  }
  return current;
}

/** The contents of one single- or double-quoted word, or null when `word` is
 * anything more than that. */
function quotedWord(word: string): string | null {
  const single = /^'([^']*)'$/.exec(word);
  if (single != null) {
    return single[1] ?? "";
  }
  const double = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(word);
  return double == null ? null : (double[1] ?? "").replace(/\\(["\\$`])/g, "$1");
}

/** `sh -c '<script>' [name args...]` runs the script; any other shell call runs a file or stdin. */
function shellVerdict(args: string[]): ActivityBucket {
  const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
  const script = flag === -1 ? undefined : args[flag + 1];
  if (script == null) {
    return "code";
  }
  return scriptBucket(stripHeredocBodies(quotedWord(script) ?? script));
}

function stageVerdict(stage: string): ActivityBucket | "neutral" {
  const words = commandWords(stage);
  if (words.length === 0) {
    return "neutral";
  }
  const head = basename(words[0] ?? "");
  const args = words.slice(1);
  if (NAVIGATION.has(head) || head === ")") {
    return "neutral";
  }
  if (READONLY_BASH.has(head)) {
    return "context";
  }
  if (SHELLS.has(head) && args.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg))) {
    return shellVerdict(args);
  }
  if ((args.length === 1 && VERSION_ARGS.has(args[0] ?? "")) || args.includes("--help")) {
    return "context";
  }
  return READONLY_WHEN[head]?.(args) ? "context" : "code";
}

/** The words of the command a stage actually runs: without leading variable
 * assignments, subshell parens, control keywords (`do`, `then`, `if`), or
 * wrappers (`env`, `timeout 30`, `xargs -n1`, `time`). */
function commandWords(stage: string): string[] {
  let words = shellWords(stage);
  for (let guard = 0; guard < 16 && words.length > 0; guard += 1) {
    const first = words[0] ?? "";
    if (first.startsWith("(")) {
      const rest = first.replace(/^\(+/, "");
      words = rest === "" ? words.slice(1) : [rest, ...words.slice(1)];
    } else if (/^[A-Za-z_]\w*=\(/.test(first)) {
      // An array assignment, `dirs=(src tests)`, ends at the word closing it.
      const end = words.findIndex((word) => word.endsWith(")"));
      words = words.slice(end === -1 ? words.length : end + 1);
    } else if (/^[A-Za-z_]\w*=/.test(first) || COMMAND_PREFIXES.has(first)) {
      words = words.slice(1);
    } else if (first === "command") {
      const rest = words.slice(1);
      // `command -v bun` is `which bun`; `command bun test` runs bun.
      if (rest[0] === "-v" || rest[0] === "-V") {
        return ["which", ...rest.slice(1)];
      }
      words = rest;
    } else if ((first === "env" && words.length > 1) || COMMAND_WRAPPERS.has(first)) {
      words = skipOptions(words.slice(1), WRAPPER_VALUE_OPTIONS);
      if (first === "timeout") {
        words = words.slice(1);
      }
      if (first === "xargs" && words.length === 0) {
        return ["echo"];
      }
    } else {
      return words;
    }
  }
  return words;
}

/** Whitespace-split words, keeping quoted strings, escapes, and `$(...)` whole
 * and dropping redirections, which the statement-level check already judged. */
function shellWords(stage: string): string[] {
  const words = splitUnquoted(stage, WORD_BREAK).filter((word) => word !== "");
  const kept: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (/^\d*[<>]&\d*-?$/.test(word) || /^(?:\d*|&)(?:>>?|<<?-?|<<<)\S/.test(word)) {
      continue;
    }
    if (/^(?:\d*|&)(?:>>?|<<?-?|<<<)$/.test(word)) {
      i += 1;
      continue;
    }
    kept.push(word);
  }
  return kept;
}

function skipOptions(words: string[], valueOptions: Set<string>): string[] {
  let index = 0;
  while ((words[index] ?? "").startsWith("-")) {
    index += valueOptions.has(words[index] ?? "") ? 2 : 1;
  }
  return words.slice(index);
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

// Commands that are read-only only with some arguments.
const READONLY_WHEN: Record<string, (args: string[]) => boolean> = {
  git: gitReadOnly,
  gh: ghReadOnly,
  kubectl: kubectlReadOnly,
  docker: dockerReadOnly,
  "docker-compose": composeReadOnly,
  curl: curlReadOnly,
  find: findReadOnly,
  // `fd -x cmd` runs cmd per match, like `find -exec`.
  fd: (args) => {
    const exec = args.findIndex((arg) => /^(?:-x|-X|--exec|--exec-batch)$/.test(arg));
    return exec === -1 || stageVerdict(args.slice(exec + 1).join(" ")) === "context";
  },
  // `rg --pre cmd` runs cmd on every file it searches.
  rg: (args) => !args.some((arg) => /^--pre(?:=|$)/.test(arg)),
  tree: (args) => !args.some((arg) => arg.startsWith("-o")),
  // `uniq in out` writes out.
  uniq: (args) => positionals(args, new Set(["-f", "-s", "-w"])).length <= 1,
  awk: awkReadOnly,
  gawk: awkReadOnly,
  sed: sedReadOnly,
  sort: (args) => !args.some((arg) => /^-[a-zA-Z]*o/.test(arg) || arg.startsWith("--output")),
  base64: (args) => !args.some((arg) => arg === "-o" || arg.startsWith("--output")),
  sqlite3: sqliteReadOnly,
  npm: (args) =>
    ["view", "info", "show", "ls", "list", "outdated", "why", "explain"].includes(args[0] ?? ""),
  "ssh-add": (args) => args.length > 0 && args.every((arg) => arg === "-l" || arg === "-L"),
  // macOS unified log: `log show` and `log stream` only read.
  log: (args) => args[0] === "show" || args[0] === "stream",
  sysctl: (args) => !args.some((arg) => arg === "-w" || /^[\w.]+=/.test(arg)),
  aws: (args) => {
    const [, operation = ""] = skipOptions(args, AWS_VALUE_OPTIONS);
    return (
      (/^(?:get|describe|list|head)-/.test(operation) && !AWS_DOWNLOADS.has(operation)) ||
      operation === "ls"
    );
  },
  xcrun: (args) =>
    args.some(
      (arg) => arg === "--show-sdk-path" || arg === "--show-sdk-version" || arg === "--find",
    ) ||
    (args[0] === "simctl" && args[1] === "list"),
};

const AWS_VALUE_OPTIONS = new Set(["--region", "--profile", "--output", "--endpoint-url"]);
// Reads that save the response to an outfile argument.
const AWS_DOWNLOADS = new Set(["get-object", "get-object-torrent", "get-media", "get-job-output"]);

/** The non-option words of `args`, skipping the value of each option in `valueOptions`. */
function positionals(args: string[], valueOptions: Set<string>): string[] {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (valueOptions.has(arg)) {
      i += 1;
    } else if (!arg.startsWith("-")) {
      words.push(arg);
    }
  }
  return words;
}

/** True when `args` use one of `flags`, including `--flag=value` and short-flag
 * clusters such as `-rd` or `-uorigin/main`. */
function usesFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) =>
    arg.startsWith("--")
      ? flags.has(arg.split("=")[0] ?? arg)
      : /^-[a-zA-Z]/.test(arg) && [...arg.slice(1)].some((char) => flags.has(`-${char}`)),
  );
}

// `w file`, `e cmd`, and the `w`/`e` flags of `s`, each in command position:
// at the start, after `;`, `{`, `}`, a newline, or an address (`12`, `$`, `/re/`, `!`).
const SED_SCRIPT_WRITES =
  /(?:^|[;{}\n\d$/!])\s*(?:[wWe](?:\s|$)|s([^\w\s\\])(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImM\d]*[we])/;

/** sed reads unless it edits in place, runs a script file it does not show, or
 * its script writes a file (`w`, `s///w`) or runs a command (`e`, `s///e`). */
function sedReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  let explicit = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (/^-[a-zA-Z]*i/.test(arg) || /^--(?:in-place|file)/.test(arg) || /^-[a-zA-Z]*f$/.test(arg)) {
      return false;
    }
    if (/^-[a-zA-Z]*e$/.test(arg) || arg === "--expression") {
      scripts.push(args[i + 1] ?? "");
      explicit = true;
      i += 1;
    } else if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      explicit = true;
    } else if (!arg.startsWith("-") && !explicit && scripts.length === 0) {
      scripts.push(arg);
    }
  }
  return !scripts.some((script) => SED_SCRIPT_WRITES.test(unquote(script)));
}

const SQLITE_VALUE_OPTIONS = new Set(["-separator", "-newline", "-nullvalue", "-vfs", "-mmap"]);
// Dot-commands that write or run something, and `VACUUM INTO`, which writes a
// copy even from a read-only connection.
const SQLITE_WRITES =
  /(?:^|[\s;])\.(?:output|once|save|backup|clone|open|shell|system|import|log|trace|excel)\b|\bvacuum\s+into\b/i;

/** `sqlite3 -readonly db 'sql'` reads. SQL from stdin, `-init`, or a heredoc is
 * not visible here, so it counts as code. */
function sqliteReadOnly(args: string[]): boolean {
  const sql: string[] = [];
  let positional = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = (args[i] ?? "").replace(/^--/, "-");
    if (arg === "-init") {
      return false;
    }
    if (arg === "-cmd" || SQLITE_VALUE_OPTIONS.has(arg)) {
      if (arg === "-cmd") {
        sql.push(args[i + 1] ?? "");
      }
      i += 1;
    } else if (!arg.startsWith("-")) {
      positional += 1;
      if (positional > 1) {
        sql.push(arg);
      }
    }
  }
  return (
    args.some((arg) => arg.replace(/^--/, "-") === "-readonly") &&
    positional > 1 &&
    !sql.some((text) => SQLITE_WRITES.test(unquote(text)))
  );
}

// Global options whose value is the next word (`git -C dir log`).
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GIT_BRANCH_WRITES = new Set([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-f",
  "-u",
  "-t",
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--track",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
]);
const GIT_CONFIG_WRITES = new Set([
  "--unset",
  "--unset-all",
  "--add",
  "--replace-all",
  "--remove-section",
  "--rename-section",
  "-e",
  "--edit",
]);
const GIT_TAG_WRITES = new Set([
  "-a",
  "-s",
  "-u",
  "-f",
  "-d",
  "-m",
  "-F",
  "-e",
  "--annotate",
  "--sign",
  "--local-user",
  "--delete",
  "--force",
  "--message",
  "--file",
  "--edit",
]);
// Listing flags that take a commit or pattern, so a positional word is not a new ref name.
const GIT_LIST_FLAGS = new Set([
  "-l",
  "--list",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);

function gitReadOnly(args: string[]): boolean {
  const words = skipOptions(args, GIT_VALUE_OPTIONS);
  const subcommand = words[0];
  const rest = words.slice(1);
  if (subcommand == null) {
    return args.some((arg) => VERSION_ARGS.has(arg));
  }
  if (rest.some((arg) => arg.startsWith("--output"))) {
    return false;
  }
  const listsRefs =
    rest.every((arg) => arg.startsWith("-")) || rest.some((arg) => GIT_LIST_FLAGS.has(arg));
  switch (subcommand) {
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "config": {
      const [first, ...keys] = rest.filter((arg) => !arg.startsWith("-"));
      // Keys have a dot, so a bare first word is a subcommand (`git config get x`).
      if (first != null && !first.includes(".")) {
        return first === "list" || (first === "get" && !usesFlag(rest, GIT_CONFIG_WRITES));
      }
      // `git config key` reads one value; a second positional word sets it.
      return (
        rest.some((arg) => arg === "--list" || arg === "-l" || arg.startsWith("--get")) ||
        (first != null && keys.length === 0 && !usesFlag(rest, GIT_CONFIG_WRITES))
      );
    }
    case "branch":
      return listsRefs && !usesFlag(rest, GIT_BRANCH_WRITES);
    case "tag":
      return listsRefs && !usesFlag(rest, GIT_TAG_WRITES);
    case "remote":
      return rest.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(rest[0] ?? "");
    case "worktree":
      return rest[0] === "list";
    default:
      return READONLY_GIT.has(subcommand);
  }
}

const GH_READONLY: Record<string, Set<string>> = {
  pr: new Set(["view", "list", "diff", "checks", "status"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["view", "list"]),
  workflow: new Set(["view", "list"]),
  repo: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  auth: new Set(["status", "token"]),
  search: new Set(["code", "commits", "issues", "prs", "repos"]),
};
const GH_FIELD_OPTIONS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

function ghReadOnly(args: string[]): boolean {
  const [group, verb] = args;
  if (group === "api") {
    return ghApiReadOnly(args.slice(1));
  }
  // `gh pr checks --watch` waits on CI, like `gh run watch`.
  return (
    group != null &&
    verb != null &&
    (GH_READONLY[group]?.has(verb) ?? false) &&
    !args.includes("--watch")
  );
}

/** `gh api` sends GET unless a method says otherwise or a body field turns the
 * request into a POST; a GraphQL call writes only when it is a mutation. */
function ghApiReadOnly(args: string[]): boolean {
  let method: string | null = null;
  let fields = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-X" || arg === "--method") {
      method = unquote(args[i + 1] ?? "");
      i += 1;
    } else if (arg.startsWith("-X") || arg.startsWith("--method=")) {
      method = unquote(arg.replace(/^-X|^--method=/, ""));
    } else if (GH_FIELD_OPTIONS.has(arg) || /^--(?:raw-)?field=|^-[fF]./.test(arg)) {
      fields = true;
    }
  }
  if (method != null) {
    return /^(?:GET|HEAD)$/i.test(method);
  }
  if (args[0] === "graphql") {
    return !/\bmutation\b/.test(args.join(" "));
  }
  return !fields;
}

const KUBECTL_VALUE_OPTIONS = new Set([
  "--context",
  "-n",
  "--namespace",
  "--kubeconfig",
  "--cluster",
  "--user",
  "-s",
  "--server",
]);
const KUBECTL_READONLY = new Set([
  "get",
  "describe",
  "logs",
  "top",
  "explain",
  "api-resources",
  "api-versions",
  "version",
  "cluster-info",
  "events",
]);
const KUBECTL_READONLY_PAIRS: Record<string, Set<string>> = {
  config: new Set(["view", "get-contexts", "current-context", "get-clusters"]),
  auth: new Set(["can-i", "whoami"]),
  rollout: new Set(["status", "history"]),
};

function kubectlReadOnly(args: string[]): boolean {
  const [verb, object] = skipOptions(args, KUBECTL_VALUE_OPTIONS);
  if (verb == null) {
    return false;
  }
  if (verb === "cluster-info" && args.some((arg) => arg.startsWith("--output-directory"))) {
    return false;
  }
  return KUBECTL_READONLY.has(verb) || (KUBECTL_READONLY_PAIRS[verb]?.has(object ?? "") ?? false);
}

const DOCKER_READONLY = new Set([
  "ps",
  "images",
  "logs",
  "inspect",
  "version",
  "info",
  "top",
  "port",
  "history",
]);
const DOCKER_OBJECTS = new Set(["image", "container", "network", "volume", "context", "system"]);
const DOCKER_OBJECT_READONLY = new Set(["ls", "inspect", "logs", "history", "top", "port", "df"]);
const DOCKER_COMPOSE_VALUE_OPTIONS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--profile",
  "--env-file",
  "--project-directory",
]);
const DOCKER_COMPOSE_READONLY = new Set(["ps", "logs", "config", "images", "ls", "top", "port"]);

function composeReadOnly(args: string[]): boolean {
  const [command, ...rest] = skipOptions(args, DOCKER_COMPOSE_VALUE_OPTIONS);
  // `compose config -o file` writes the resolved file.
  if (command === "config" && rest.some((arg) => arg === "-o" || arg.startsWith("--output"))) {
    return false;
  }
  return DOCKER_COMPOSE_READONLY.has(command ?? "");
}

const DOCKER_VALUE_OPTIONS = new Set([
  "--context",
  "-c",
  "-H",
  "--host",
  "--config",
  "-l",
  "--log-level",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);

function dockerReadOnly(args: string[]): boolean {
  const [verb, object] = skipOptions(args, DOCKER_VALUE_OPTIONS);
  if (verb === "compose") {
    return composeReadOnly(args.slice(args.indexOf("compose") + 1));
  }
  return (
    DOCKER_READONLY.has(verb ?? "") ||
    (DOCKER_OBJECTS.has(verb ?? "") && DOCKER_OBJECT_READONLY.has(object ?? ""))
  );
}

// Short curl flags that send a body or write a file; `-o` and `-X` are judged
// by their value, and the rest of the value-taking flags just consume one.
// A config file (`-K`) can hold any of these, and `-Q` sends raw FTP/SFTP commands.
const CURL_WRITE_FLAGS = new Set(["d", "F", "T", "D", "c", "O", "K", "Q"]);
const CURL_VALUE_FLAGS = new Set([
  "o",
  "X",
  "H",
  "A",
  "u",
  "w",
  "m",
  "e",
  "E",
  "x",
  "b",
  "r",
  "C",
  "U",
  "Y",
  "y",
  "z",
]);
const CURL_WRITE_OPTIONS =
  /^--(?:data|form|json|upload-file|remote-name|dump-header|cookie-jar|output-dir|trace|config|quote|libcurl|stderr|etag-save|hsts|alt-svc)/;
const LOCAL_HOST = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b|\[::1\]/;

/** A remote GET that prints its response is web retrieval. Probing a local
 * dev server verifies the work, so it stays code, like running its tests. */
function curlReadOnly(args: string[]): boolean {
  // `-w '%output{file}'` switches the write-out to a file.
  if (args.some((arg) => LOCAL_HOST.test(arg) || arg.includes("%output{"))) {
    return false;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--output" || arg === "--request") {
      if (!readOnlyCurlValue(arg === "--output" ? "o" : "X", args[i + 1])) {
        return false;
      }
      i += 1;
    } else if (arg.startsWith("--output=") || arg.startsWith("--request=")) {
      const flag = arg.startsWith("--output") ? "o" : "X";
      if (!readOnlyCurlValue(flag, arg.slice(arg.indexOf("=") + 1))) {
        return false;
      }
    } else if (CURL_WRITE_OPTIONS.test(arg)) {
      return false;
    } else if (/^-[A-Za-z]/.test(arg)) {
      for (let j = 1; j < arg.length; j += 1) {
        const flag = arg[j] ?? "";
        if (CURL_WRITE_FLAGS.has(flag)) {
          return false;
        }
        if (CURL_VALUE_FLAGS.has(flag)) {
          const inline = arg.slice(j + 1);
          const value = inline === "" ? args[i + 1] : inline;
          if (inline === "") {
            i += 1;
          }
          if ((flag === "o" || flag === "X") && !readOnlyCurlValue(flag, value)) {
            return false;
          }
          break;
        }
      }
    }
  }
  return true;
}

function readOnlyCurlValue(flag: string, value: string | undefined): boolean {
  const clean = unquote(value ?? "");
  return flag === "o" ? clean === "/dev/null" || clean === "-" : /^(?:GET|HEAD)$/i.test(clean);
}

const FIND_WRITES = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** `find` reads unless it deletes, writes a listing, or `-exec`s a command
 * that is not itself read-only (`-exec cat {} \;` reads, `-exec rm` does not). */
function findReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (FIND_WRITES.has(arg)) {
      return false;
    }
    if (FIND_EXEC.has(arg)) {
      const rest = args.slice(i + 1);
      const end = rest.findIndex((word) => /^(?:\\;|';'|";"|;|\+)$/.test(word));
      const command = (end === -1 ? rest : rest.slice(0, end)).join(" ");
      if (stageVerdict(command) !== "context") {
        return false;
      }
      i += end === -1 ? rest.length : end + 1;
    }
  }
  return true;
}

/** awk reads unless its program shells out or prints into a file or command.
 * A lone `|` after print pipes to a command; `||` is only a logical or. */
function awkReadOnly(args: string[]): boolean {
  // Judge the program without its string literals, so `printf "a | b"` stays a read.
  const program = args
    .map((arg) => quotedWord(arg) ?? arg)
    .join(" ")
    .replace(/"(?:[^"\\]|\\[\s\S])*"?/g, '""');
  return !/\bsystem\s*\(|\|&?\s*getline\b|\bprintf?\b[^;}]*(?:>|(?<!\|)\|(?!\|))|\binplace\b/.test(
    program,
  );
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
  const parsed = typeof input === "string" ? parseJson(input) : input;
  if (typeof parsed === "string") {
    return parsed;
  }
  return parsed != null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof parsed.input === "string"
    ? parsed.input
    : null;
}

function execCommandArgument(
  argument: CallExpression["arguments"][number] | undefined,
): string | null {
  if (argument?.type !== "ObjectExpression") return null;
  // Later properties win; a spread or computed key may overwrite cmd at runtime.
  for (const property of argument.properties.toReversed()) {
    if (property.type === "SpreadElement" || property.computed) return null;
    const key = property.key;
    if (
      (key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : null) !== "cmd"
    ) {
      continue;
    }
    const value = property.value;
    if (property.kind !== "init") return null;
    if (value.type === "Literal" && typeof value.value === "string") return value.value;
    return value.type === "TemplateLiteral" && value.expressions.length === 0
      ? (value.quasis[0]?.value.cooked ?? null)
      : null;
  }
  return null;
}

/** The inner tool calls of a Codex `exec` program, in source order. Empty for any
 * other tool, or for a program that cannot be parsed or calls no tools. */
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
  try {
    const ast = parse(program, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
    });
    const calls: (CodexExecCall & { start: number })[] = [];
    simple(ast, {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.object.type !== "Identifier" ||
          callee.object.name !== "tools" ||
          callee.property.type !== "Identifier" ||
          callee.property.name.toLowerCase() === "exec"
        ) {
          return;
        }
        const name = callee.property.name;
        calls.push({
          name,
          command: name === "exec_command" ? execCommandArgument(node.arguments[0]) : null,
          start: node.start,
        });
      },
    });
    return calls.sort((a, b) => a.start - b.start).map(({ name, command }) => ({ name, command }));
  } catch {
    // Invalid or deeply nested source must not crash ingest or invent tool calls.
    return [];
  }
}

// A program that reads and then patches is an implementation step, so the strongest
// inner bucket labels the whole call. A program that asks the user is communicating.
const EXEC_BUCKET_PRECEDENCE: ActivityBucket[] = ["code", "planning", "communicating", "context"];

function innerInput(call: CodexExecCall): Json | undefined {
  return call.command == null ? undefined : { cmd: call.command };
}
