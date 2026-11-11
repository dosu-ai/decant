import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argvRequestsJson, fromErrorLine, toCliError } from "../src/cli/errors.ts";
import { type CliResult, runCli } from "../src/cli.ts";
import { SchemaTooNewError } from "../src/db.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-cli-errors-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

// Every source directory points into the temp dir, so a sync that does run
// reads the synthetic fixture and nothing else.
const home = join(workDir, "home");
const claudeDir = join(workDir, "sources", "claude");
const emptyDir = join(workDir, "sources", "empty");
const sourceEnv = {
  DECANT_CLAUDE_DIR: claudeDir,
  DECANT_CODEX_DIR: emptyDir,
  DECANT_GEMINI_DIR: emptyDir,
  DECANT_OPENCODE_DIR: emptyDir,
  DECANT_CURSOR_DIR: emptyDir,
  DECANT_COPILOT_DIR: emptyDir,
  DECANT_VSCODE_COPILOT_DIR: emptyDir,
  DECANT_ATIF_DIR: emptyDir,
};
const noSyncEnv = { ...sourceEnv, DECANT_NO_SYNC: "1" };
const archive = join(workDir, "archive.db");
const garbage = join(workDir, "garbage.db");

function run(argv: string[], env: Record<string, string> = noSyncEnv): Promise<CliResult> {
  return runCli(argv, { env, homeDir: home });
}

interface ErrorLine {
  error: { code: string; message: string; [key: string]: unknown };
}

/** The contract for a failing `--json` command: one JSON object, last on stderr. */
function lastErrorLine(result: CliResult): ErrorLine {
  const lines = result.stderr.split("\n").filter((line) => line !== "");
  const parsed = JSON.parse(lines.at(-1) ?? "") as ErrorLine;
  expect(typeof parsed.error.code).toBe("string");
  expect(typeof parsed.error.message).toBe("string");
  return parsed;
}

beforeAll(async () => {
  for (const dir of [home, claudeDir, emptyDir]) {
    mkdirSync(dir, { recursive: true });
  }
  // distill.jsonl has shell commands, which `distill script` needs.
  for (const name of ["sample.jsonl", "distill.jsonl"]) {
    copyFileSync(join(import.meta.dir, "..", "fixtures", "claude", name), join(claudeDir, name));
  }
  const synced = await run(["--db", archive, "--json", "sync"], sourceEnv);
  expect(synced.code).toBe(0);
  expect(JSON.parse(synced.stdout)).toMatchObject({ ingested: 2 });
  writeFileSync(garbage, "synthetic text, not a database\n".repeat(200));
});

describe("an explicit archive path that does not exist", () => {
  const commands: string[][] = [
    ["ls"],
    ["session", "ls"],
    ["show", "1"],
    ["session", "show", "1"],
    ["search", "auth"],
    ["stats"],
    ["stats", "--by", "tool"],
    ["tokens"],
    ["files"],
    ["tool", "ls"],
    ["mcp", "ls"],
    ["project", "ls"],
    ["recommendations", "ls"],
    ["export", "1"],
    ["export", "--mirror", join(workDir, "mirror-out")],
    ["distill", "script"],
    ["distill", "replay", "1"],
    ["distill", "skill"],
    ["db", "info"],
    // These change an archive but have nothing to change in a new one.
    ["session", "rm", "1"],
    ["recommendations", "mark", "some-key"],
    ["db", "vacuum"],
    ["db", "compact"],
  ];

  test.each(commands)("decant %s %s %s fails and creates nothing", async (...command) => {
    const args = command.filter((part) => part != null);
    const dir = mkdtempSync(join(workDir, "missing-"));
    const missing = join(dir, "nested", "typo.db");

    const human = await run(["--db", missing, ...args]);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe(
      `error: no Decant archive at ${missing} (from --db). Check the path, or create the ` +
        `archive with: decant --db '${missing}' sync\n`,
    );

    const json = await run(["--db", missing, "--json", ...args]);
    expect(json.code).toBe(1);
    expect(json.stdout).toBe("");
    expect(lastErrorLine(json).error).toMatchObject({ code: "archive_not_found", path: missing });

    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(workDir, "mirror-out"))).toBe(false);
  });

  test("DECANT_DB counts as explicit and is named in the message", async () => {
    const dir = mkdtempSync(join(workDir, "missing-env-"));
    const missing = join(dir, "typo.db");
    const result = await run(["--json", "ls"], { ...noSyncEnv, DECANT_DB: missing });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const { error } = lastErrorLine(result);
    expect(error.code).toBe("archive_not_found");
    expect(error.message).toContain(`${missing} (from DECANT_DB)`);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("sync and db migrate still create the archive they are pointed at", async () => {
    const dir = mkdtempSync(join(workDir, "create-"));
    const synced = await run(["--db", join(dir, "a", "sync.db"), "--json", "sync"], sourceEnv);
    expect(synced.code).toBe(0);
    expect(existsSync(join(dir, "a", "sync.db"))).toBe(true);

    const migrated = await run(["--db", join(dir, "b", "migrate.db"), "db", "migrate"]);
    expect(migrated.code).toBe(0);
    expect(existsSync(join(dir, "b", "migrate.db"))).toBe(true);

    // Once it exists, the same path reads normally.
    const list = await run(["--db", join(dir, "a", "sync.db"), "--json", "ls"]);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toHaveLength(2);
  });

  test("a read command still creates the default archive on first run", async () => {
    const firstHome = mkdtempSync(join(workDir, "first-run-"));
    const result = await runCli(["--json", "ls"], { env: sourceEnv, homeDir: firstHome });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(2);
    expect(existsSync(join(firstHome, ".decant", "decant.db"))).toBe(true);
  });

  test("a file that is not an archive is reported with its path", async () => {
    const result = await run(["--db", garbage, "--json", "ls"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const { error } = lastErrorLine(result);
    expect(error).toMatchObject({ code: "archive_unreadable", path: garbage });
    expect(error.message).toContain(garbage);
  });
});

describe("invalid flag values", () => {
  const TOOLS =
    "claude_code | codex | gemini | opencode | cursor | copilot | vscode_copilot | atif";
  const cases: { argv: string[]; message: string; details: Record<string, unknown> }[] = [
    {
      argv: ["ls", "--tool", "claude"],
      message: `option '--tool <tool>' argument 'claude' is invalid. expected: ${TOOLS}`,
      details: { option: "--tool", value: "claude", expected: TOOLS.split(" | ") },
    },
    {
      argv: ["session", "ls", "--tool", "Codex"],
      message: `option '--tool <tool>' argument 'Codex' is invalid. expected: ${TOOLS}`,
      details: { option: "--tool", value: "Codex" },
    },
    {
      argv: ["ls", "--limit", "0"],
      message: "option '--limit <n>' argument '0' is invalid. expected a positive integer",
      details: { option: "--limit", value: "0" },
    },
    {
      argv: ["search", "auth", "--limit", "-3"],
      message: "option '--limit <n>' argument '-3' is invalid. expected a positive integer",
      details: { option: "--limit", value: "-3" },
    },
    {
      argv: ["tool", "ls", "--limit", "ten"],
      message: "option '--limit <n>' argument 'ten' is invalid. expected a positive integer",
      details: { option: "--limit", value: "ten" },
    },
    {
      argv: ["--format", "md", "ls"],
      message:
        "option '--format <format>' argument 'md' is invalid for 'decant ls'. expected: table | json",
      details: { option: "--format", value: "md", expected: ["table", "json"], command: "ls" },
    },
    {
      argv: ["stats", "--format", "md"],
      message:
        "option '--format <format>' argument 'md' is invalid for 'decant stats'. expected: table | json",
      details: { option: "--format", value: "md", command: "stats" },
    },
    {
      argv: ["--format", "yaml", "ls"],
      message: "option '--format <format>' argument 'yaml' is invalid. expected: table | json | md",
      details: { option: "--format", value: "yaml", expected: ["table", "json", "md"] },
    },
    {
      argv: ["files", "--group", "dir"],
      message: "option '--group <group>' argument 'dir' is invalid. expected: path | ext",
      details: { option: "--group", value: "dir", expected: ["path", "ext"] },
    },
    {
      argv: ["files", "--op", "chew"],
      message:
        "option '--op <op>' argument 'chew' is invalid. expected: read | edit | write | delete",
      details: { option: "--op", value: "chew" },
    },
    {
      argv: ["distill", "script", "--min-frequency", "2"],
      message:
        "option '--min-frequency <n>' argument '2' is invalid. expected a number from 0.0 to 1.0",
      details: { option: "--min-frequency", value: "2" },
    },
    {
      argv: ["distill", "skill", "--kind", "plugin"],
      message:
        "option '--kind <kind>' argument 'plugin' is invalid. expected: skill | agents | command",
      details: { option: "--kind", value: "plugin" },
    },
    {
      argv: ["serve", "--port", "70000"],
      message: "option '--port <n>' argument '70000' is invalid. expected a port from 0 to 65535",
      details: { option: "--port", value: "70000" },
    },
    {
      argv: ["show", "abc"],
      message: "command-argument value 'abc' is invalid for argument 'id'. expected an integer",
      details: { argument: "id", value: "abc" },
    },
  ];

  test.each(cases)("decant $argv is a usage error", async ({ argv, message, details }) => {
    const human = await run(["--db", archive, ...argv]);
    expect(human).toEqual({ code: 2, stdout: "", stderr: `error: ${message}\n` });

    const json = await run(["--db", archive, "--json", ...argv]);
    expect(json.code).toBe(2);
    expect(json.stdout).toBe("");
    expect(JSON.parse(json.stderr)).toMatchObject({
      error: { code: "invalid_argument", message, ...details },
    });
  });

  test("valid values still run", async () => {
    const tool = await run(["--db", archive, "--json", "ls", "--tool", "claude_code"]);
    expect(tool.code).toBe(0);
    expect(JSON.parse(tool.stdout)).toHaveLength(2);

    const none = await run(["--db", archive, "--json", "ls", "--tool", "codex", "--limit", "1"]);
    expect(none).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(none.stdout)).toEqual([]);

    const markdown = await run(["--db", archive, "--format", "md", "show", "1"]);
    expect(markdown.code).toBe(0);
    expect(markdown.stdout.startsWith("# ")).toBe(true);

    const alias = await run(["--db", archive, "--json", "distill", "script", "--as", "bash"]);
    expect(alias.code).toBe(0);
    expect(JSON.parse(alias.stdout).artifact).toBeString();
  });
});

describe("errors under --json", () => {
  // `stdout` is "result" for the two commands that report a failed operation
  // as their JSON result, which predates the error object and stays as it was.
  const cases: { argv: string[]; exit: number; code: string; stdout?: "result" }[] = [
    { argv: ["frobnicate"], exit: 2, code: "unknown_command" },
    { argv: ["ls", "--definitely-not-real"], exit: 2, code: "unknown_option" },
    { argv: ["show"], exit: 2, code: "missing_argument" },
    { argv: ["ls", "--limit"], exit: 2, code: "missing_argument" },
    { argv: ["show", "1", "2"], exit: 2, code: "usage_error" },
    { argv: ["session"], exit: 2, code: "usage_error" },
    { argv: ["ls", "--limit", "0"], exit: 2, code: "invalid_argument" },
    { argv: ["ls", "--tool", "claude"], exit: 2, code: "invalid_argument" },
    { argv: ["--format", "md", "ls"], exit: 2, code: "invalid_argument" },
    { argv: ["completion", "tcsh"], exit: 2, code: "invalid_argument" },
    { argv: ["export"], exit: 2, code: "usage_error" },
    { argv: ["export", "--all"], exit: 2, code: "usage_error" },
    { argv: ["export", "--mirror", "out", "--as", "md"], exit: 2, code: "usage_error" },
    { argv: ["sync", "--path", join(workDir, "no-such-file.jsonl")], exit: 2, code: "usage_error" },
    { argv: ["show", "999"], exit: 1, code: "session_not_found" },
    { argv: ["session", "show", "999"], exit: 1, code: "session_not_found" },
    { argv: ["export", "999"], exit: 1, code: "session_not_found" },
    { argv: ["export", "999", "--as", "atif"], exit: 1, code: "session_not_found" },
    { argv: ["distill", "replay", "999"], exit: 1, code: "session_not_found" },
    { argv: ["distill", "script", "--project", "no-such-project"], exit: 1, code: "no_data" },
    { argv: ["distill", "skill", "--project", "no-such-project"], exit: 1, code: "no_data" },
    { argv: ["session", "rm", "999"], exit: 1, code: "session not found", stdout: "result" },
    {
      argv: ["recommendations", "mark", "no-such-key"],
      exit: 1,
      code: "recommendation not found",
      stdout: "result",
    },
  ];

  test.each(cases)("decant --json $argv", async ({ argv, exit, code, stdout }) => {
    const result = await run(["--db", archive, "--json", ...argv]);
    expect(result.code).toBe(exit);
    if (stdout === "result") {
      expect(JSON.parse(result.stdout)).toMatchObject({ error: code });
      expect(result.stderr).toBe("");
      return;
    }
    expect(result.stdout).toBe("");
    expect(lastErrorLine(result).error.code).toBe(code);
  });

  test.each(cases)("decant $argv without --json stays plain text", async ({ argv, exit }) => {
    const result = await run(["--db", archive, ...argv]);
    expect(result.code).toBe(exit);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
    expect(result.stderr.startsWith("{")).toBe(false);
    expect(() => JSON.parse(result.stderr.split("\n").filter(Boolean).at(-1) ?? "")).toThrow();
  });

  test("the error is one line, and a command group's help precedes it", async () => {
    const unknown = await run(["--db", archive, "--json", "sesion", "ls"]);
    expect(unknown.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(unknown.stderr)).toEqual({
      error: {
        code: "unknown_command",
        message: "unknown command 'sesion'\n(Did you mean session?)",
      },
    });

    const group = await run(["--db", archive, "--json", "session"]);
    expect(group.stderr).toContain("Usage: decant session");
    expect(lastErrorLine(group).error.code).toBe("usage_error");
  });

  test("JSON is honored wherever the flag sits, including after the mistake", async () => {
    for (const argv of [
      ["ls", "--limit", "abc", "--json"],
      ["--format", "json", "frobnicate"],
      ["--format=json", "ls", "--tool", "claude"],
      ["frobnicate", "--json"],
    ]) {
      const result = await run(["--db", archive, ...argv]);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(() => lastErrorLine(result)).not.toThrow();
    }
  });

  test("exit 3 from sync is a report on stdout, not an error object", async () => {
    const dir = mkdtempSync(join(workDir, "unparsed-"));
    const source = join(dir, "claude");
    mkdirSync(source);
    writeFileSync(
      join(source, "broken.jsonl"),
      `${readFileSync(join(claudeDir, "sample.jsonl"), "utf8")}{"type":"user","uuid":\n`,
    );
    const result = await run(["--db", join(dir, "archive.db"), "--json", "sync"], {
      ...sourceEnv,
      DECANT_CLAUDE_DIR: source,
    });
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).issues_by_code.unparsed_line).toBeGreaterThan(0);
  });
});

describe("error helpers", () => {
  test("argvRequestsJson reads --json and --format json, and stops at --", () => {
    expect(argvRequestsJson(["ls", "--json"])).toBe(true);
    expect(argvRequestsJson(["--format", "json", "ls"])).toBe(true);
    expect(argvRequestsJson(["--format=json", "ls"])).toBe(true);
    expect(argvRequestsJson(["--format", "md", "ls"])).toBe(false);
    expect(argvRequestsJson(["search", "--", "--json"])).toBe(false);
    expect(argvRequestsJson([])).toBe(false);
  });

  test("a core error keeps its own code, and a system error does not leak one", () => {
    expect(toCliError(new SchemaTooNewError(99_999))).toMatchObject({
      code: "schema_too_new",
      exitCode: 1,
    });
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    expect(toCliError(enoent)).toMatchObject({ code: "command_failed", exitCode: 1 });
    expect(toCliError("plain string")).toMatchObject({
      code: "command_failed",
      message: "plain string",
    });
  });

  test("fromErrorLine maps an error line and its exit code to a code", () => {
    expect(fromErrorLine("error: no session with id 12\n", 1)).toMatchObject({
      code: "session_not_found",
      message: "no session with id 12",
      exitCode: 1,
    });
    // A session id parses as any integer, so a negative one can be reported missing.
    expect(fromErrorLine("error: no session with id -1\n", 1).code).toBe("session_not_found");
    expect(fromErrorLine("error: --all requires --out <dir>\n", 2)).toMatchObject({
      code: "usage_error",
      exitCode: 2,
    });
    expect(fromErrorLine("error: something else\n", 1)).toMatchObject({ code: "command_failed" });
  });
});

describe("help", () => {
  test("top-level help has examples, exit codes, and the API pointer", async () => {
    const help = await run(["--help"]);
    expect(help).toMatchObject({ code: 0, stderr: "" });
    expect(help.stdout).toContain("Examples:");
    expect(help.stdout).toContain("decant ls --json --limit 20");
    expect(help.stdout).toContain("Exit codes:");
    for (const line of [
      "  0  success",
      "  1  the command failed",
      "  2  usage error",
      "  3  sync",
    ]) {
      expect(help.stdout).toContain(line);
    }
    expect(help.stdout).toContain('{"error":{"code":"...","message":"..."}}');
    expect(help.stdout).toContain("--no-sync");
    expect(help.stdout).toContain("http://127.0.0.1:3000/api/openapi.json");
    expect(help.stdout).toContain("docs/cli.md");
  });

  test.each([["ls"], ["show"], ["search"], ["stats"], ["export"], ["sync"], ["serve"]])(
    "decant %s --help ends with examples",
    async (command) => {
      const help = await run([command, "--help"]);
      expect(help).toMatchObject({ code: 0, stderr: "" });
      expect(help.stdout).toContain(`Examples:\n  decant ${command}`);
    },
  );

  test("session ls and session show carry the same examples as ls and show", async () => {
    for (const command of ["ls", "show"]) {
      const help = await run(["session", command, "--help"]);
      expect(help.stdout).toContain(`Examples:\n  decant ${command}`);
    }
  });

  test("serve --help points at the OpenAPI document", async () => {
    const help = await run(["serve", "--help"]);
    expect(help.stdout).toContain("http://127.0.0.1:3000/api/openapi.json");
  });
});

describe("docs/cli.md", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "cli.md"), "utf8");

  test("documents every error code the CLI emits", () => {
    for (const code of [
      "unknown_command",
      "unknown_option",
      "missing_argument",
      "invalid_argument",
      "usage_error",
      "archive_not_found",
      "archive_unreadable",
      "session_not_found",
      "no_data",
      "schema_too_new",
      "schema_too_old",
      "schema_drift",
      "command_failed",
    ]) {
      expect(doc).toContain(`\`${code}\``);
    }
  });
});
