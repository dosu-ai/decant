#!/usr/bin/env bun
import { Command } from "commander";
import { registerCompletionCommand } from "./cli/commands/completion.ts";
import { registerDbCommands } from "./cli/commands/db.ts";
import { registerDistillCommands } from "./cli/commands/distill.ts";
import { registerDoctorCommand } from "./cli/commands/doctor.ts";
import { registerExportCommand } from "./cli/commands/export.ts";
import { registerProjectCommands } from "./cli/commands/project.ts";
import { registerRecommendationsCommands } from "./cli/commands/recommendations.ts";
import { registerServiceCommands } from "./cli/commands/service.ts";
import { registerSessionCommands } from "./cli/commands/session.ts";
import { registerStatsCommands } from "./cli/commands/stats.ts";
import { registerSyncCommands } from "./cli/commands/sync.ts";
import { registerUpdateCommand } from "./cli/commands/update.ts";
import { type CliResult, type CliRunOptions, createContext, type Io } from "./cli/context.ts";
import {
  argvRequestsJson,
  CliError,
  fromCommanderError,
  toCliError,
  usageError,
} from "./cli/errors.ts";
import { installHelp } from "./cli/help.ts";
import { assertFormatSupported, installValueValidation, parseOutputFormat } from "./cli/parse.ts";
import {
  renderUpdateNotice,
  shouldShowUpdateNotice,
  UPDATE_NOTICE_WAIT_MS,
} from "./cli/update-notice.ts";
import { configureLogging } from "./logging.ts";
import { checkForUpdate } from "./update.ts";
import { DECANT_VERSION } from "./version.ts";

export type { CliResult, CliRunOptions };

/**
 * Bare `decant` is the fast entrypoint: it serves the UI. Only a completely
 * empty argv rewrites — flag-only invocations stay errors because token
 * splitting makes them ambiguous, and typos must never boot a server.
 */
export function defaultArgv(argv: string[]): string[] {
  return argv.length === 0 ? ["serve"] : argv;
}

export async function runCli(argv: string[], options: CliRunOptions = {}): Promise<CliResult> {
  const streamOutput = options.liveOutput === true;
  const io: Io = {
    stdout: "",
    stderr: "",
    writeOut(value) {
      if (streamOutput) {
        (options.writeStdout ?? ((chunk) => process.stdout.write(chunk)))(value);
      } else {
        this.stdout += value;
      }
    },
    writeErr(value) {
      if (streamOutput) {
        (options.writeStderr ?? ((chunk) => process.stderr.write(chunk)))(value);
      } else {
        this.stderr += value;
      }
    },
  };
  let code = 0;
  const setCode = (value: number): void => {
    if (code === 0 || value !== 0) {
      code = value;
    }
  };

  const program = new Command();
  program
    .name("decant")
    .description(
      "analyze Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI, GitHub Copilot CLI, Copilot Chat in VS Code, and Hermes Agent sessions: tokens, context windows, and cost",
    )
    .version(DECANT_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => io.writeOut(value),
      writeErr: (value) => io.writeErr(value),
      // Commander's errors are printed below, where --json can reshape them.
      outputError: () => undefined,
    })
    .option("--db <path>", "path to the Decant SQLite database (read commands never create it)")
    .option("--json", "emit machine-readable JSON")
    .option(
      "--format <format>",
      "output format (table | json | md); md only where a command prints Markdown",
      parseOutputFormat,
    )
    .option("-q, --quiet", "suppress non-essential output")
    .option("--no-color", "disable ANSI color")
    .option("--no-sync", "skip sync-on-read, and serve without the source watcher");

  const ctx = createContext(program, io, options, setCode);
  registerSyncCommands(ctx);
  registerSessionCommands(ctx);
  registerProjectCommands(ctx);
  registerDbCommands(ctx);
  registerDistillCommands(ctx);
  registerRecommendationsCommands(ctx);
  registerCompletionCommand(ctx);
  registerStatsCommands(ctx);
  registerExportCommand(ctx);
  registerUpdateCommand(ctx);
  registerDoctorCommand(ctx);
  registerServiceCommands(ctx);
  installValueValidation(program);
  installHelp(program);

  let noticeCommand: string | null = null;
  program.hook("preAction", (_root, actionCommand) => {
    assertFormatSupported(commandPath(actionCommand), ctx.globals().format);
    const command = topLevelName(actionCommand);
    const deps = ctx.updateDeps;
    const show = shouldShowUpdateNotice({
      command,
      json: ctx.isJson(),
      quiet: ctx.globals().quiet === true,
      stderrIsTTY: deps.stderrIsTTY ?? (streamOutput && process.stderr.isTTY === true),
      env: options.env ?? process.env,
    });
    if (!show) {
      return;
    }
    noticeCommand = command;
    // Started before the command runs so a slow registry overlaps its work.
    // checkForUpdate does nothing over the network unless the user opted in.
    ctx.pendingUpdateNotice = checkForUpdate({
      env: options.env,
      homeDir: options.homeDir,
      install: deps.install,
      current: deps.current,
      fetch: deps.fetch,
      now: deps.now,
      // A short command exits only after this request settles, so it gets the
      // notice's wait. serve stays up and shares this check with /api/update,
      // so a slow registry there should not count as a failed check.
      timeoutMs: command === "serve" ? undefined : UPDATE_NOTICE_WAIT_MS,
    });
  });

  try {
    await program.parseAsync(defaultArgv(argv), { from: "user" });
    // serve prints its own notice under the banner; it never gets here
    // until the server stops.
    if (ctx.pendingUpdateNotice != null && noticeCommand !== "serve") {
      const notice = await settleWithin(
        ctx.pendingUpdateNotice.then(renderUpdateNotice, () => null),
        UPDATE_NOTICE_WAIT_MS,
      );
      if (notice != null) {
        io.writeErr(notice);
      }
    }
  } catch (error) {
    // The flags may not be parsed yet when the command line itself is wrong.
    const json = ctx.isJson() || argvRequestsJson(argv);
    if (error instanceof CliError || !isCommanderExit(error)) {
      setCode(ctx.fail(toCliError(error), json));
    } else if (HELP_EXITS.has(error.code ?? "")) {
      const exitCode = commanderExitCode(error);
      // A command group run without a subcommand prints its help and fails.
      if (exitCode !== 0 && json) {
        ctx.fail(usageError("usage_error", "a subcommand is required; see the help above"), json);
      }
      setCode(exitCode);
    } else {
      ctx.fail(fromCommanderError(error), json);
      setCode(commanderExitCode(error));
    }
  }
  return { code, stdout: io.stdout, stderr: io.stderr };
}

interface CommanderExit {
  exitCode: number;
  code?: string;
  message?: string;
}

// Commander has already written the help or version text for these.
const HELP_EXITS = new Set(["commander.help", "commander.helpDisplayed", "commander.version"]);

function isCommanderExit(error: unknown): error is CommanderExit {
  return typeof error === "object" && error !== null && "exitCode" in error;
}

// The entrypoint sets process.exitCode and lets the event loop drain, so a
// timer left running would hold every command open for the full wait.
async function settleWithin<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function topLevelName(command: Command): string {
  let current = command;
  while (current.parent?.parent != null) {
    current = current.parent;
  }
  return current.name();
}

/** The command's name under `decant`, such as "session show". */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current = command; current.parent != null; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(" ");
}

function commanderExitCode(error: { exitCode: number; code?: string }): number {
  if (error.exitCode === 1 && error.code?.startsWith("commander.") === true) {
    return 2;
  }
  return Number(error.exitCode);
}

if (import.meta.main) {
  configureLogging({ level: process.env.DECANT_LOG_LEVEL });
  const result = await runCli(process.argv.slice(2), { liveOutput: true });
  process.exitCode = result.code;
}
