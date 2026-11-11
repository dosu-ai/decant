import type { Command } from "commander";
import { TOOLS } from "../model.ts";
import { DEFAULT_SERVE_PORT } from "../serve-defaults.ts";

const DOCS_URL = "https://github.com/dosu-ai/decant/blob/main/docs/cli.md";
const OPENAPI_URL = `http://127.0.0.1:${DEFAULT_SERVE_PORT}/api/openapi.json`;

const TOP_LEVEL = `
Examples:
  decant                                  open the web UI
  decant sync                             index new and changed sessions
  decant ls --json --limit 20             list recent sessions as JSON
  decant show 42                          print one transcript as Markdown
  decant search "auth test" --json        full-text search
  decant stats --by model                 sessions, tokens, and cost per model
  decant export 42 --as atif --out ./out  write one session as an ATIF file
  decant --db ./other.db --no-sync ls     read another archive as it is

Exit codes:
  0  success
  1  the command failed: no such session, a missing or unreadable archive,
     or a runtime error
  2  usage error: unknown command or flag, invalid value, missing argument,
     or an operation that needs a flag such as --yes or --force
  3  sync finished but dropped source lines it could not parse

Errors go to stderr and stdout stays empty. With --json, the last line of
stderr is {"error":{"code":"...","message":"..."}}. Two commands differ:
session rm --json and recommendations mark --json report a failed operation
as a JSON result on stdout, with an "error" string, and exit 1.
Read commands sync the source logs first. Pass --no-sync to skip that.
Reference: ${DOCS_URL}

Local API:
  decant serve also serves the archive over HTTP. While it runs, the OpenAPI
  document is at ${OPENAPI_URL}
`;

// Keyed by command path. A path with no command fails at startup, so a rename
// cannot drop its examples without a test noticing.
const EXAMPLES: Record<string, string[]> = {
  sync: [
    "decant sync                          index every source directory",
    "decant sync --json                   print the sync report as JSON",
    "decant sync --path ./session.jsonl   index one file",
  ],
  serve: [
    "decant serve                         serve the UI and API on port 3000",
    "decant serve --port 4000 --no-open   pick a port, leave the browser closed",
    `curl ${OPENAPI_URL}`,
    "                                     the local API's OpenAPI document",
  ],
  ls: [
    "decant ls --json --limit 20          recent sessions as JSON",
    "decant ls --tool codex               only Codex sessions",
    "decant ls -q                         session ids only",
    "",
    `--tool takes one of: ${TOOLS.join(", ")}`,
  ],
  show: [
    "decant show 42                       one transcript as Markdown",
    "decant show 42 --json                the same session as JSON",
  ],
  search: [
    'decant search "auth test"            search every transcript',
    'decant search "auth test" --json --limit 5',
  ],
  stats: [
    "decant stats                         archive totals",
    "decant stats --by model --json       one row per model",
  ],
  export: [
    "decant export 42                     Markdown on stdout",
    "decant export 42 --as atif --out ./out",
    "decant export --all --as json --out ./out",
  ],
};

export function installHelp(program: Command): void {
  program.addHelpText("after", TOP_LEVEL);
  for (const [path, lines] of Object.entries(EXAMPLES)) {
    const commands = commandsAt(program, path);
    if (commands.length === 0) {
      throw new Error(`help examples name an unknown command: ${path}`);
    }
    const text = `\nExamples:\n${lines.map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}\n`;
    for (const command of commands) {
      command.addHelpText("after", text);
    }
  }
}

/** The command at `path`, plus `session <path>`, which aliases `ls` and `show`. */
function commandsAt(program: Command, path: string): Command[] {
  const find = (parent: Command, name: string): Command | undefined =>
    parent.commands.find((command) => command.name() === name);
  const found: Command[] = [];
  const top = find(program, path);
  if (top != null) {
    found.push(top);
  }
  const session = find(program, "session");
  const aliased = session == null ? undefined : find(session, path);
  if (aliased != null) {
    found.push(aliased);
  }
  return found;
}
