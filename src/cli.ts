#!/usr/bin/env bun
import { Command } from "commander";
import { registerCompletionCommand } from "./cli/commands/completion.ts";
import { registerDbCommands } from "./cli/commands/db.ts";
import { registerDistillCommands } from "./cli/commands/distill.ts";
import { registerExportCommand } from "./cli/commands/export.ts";
import { registerProjectCommands } from "./cli/commands/project.ts";
import { registerRecommendationsCommands } from "./cli/commands/recommendations.ts";
import { registerSessionCommands } from "./cli/commands/session.ts";
import { registerStatsCommands } from "./cli/commands/stats.ts";
import { registerSyncCommands } from "./cli/commands/sync.ts";
import { type CliResult, type CliRunOptions, createContext, type Io } from "./cli/context.ts";
import { parseOutputFormat } from "./cli/parse.ts";
import { configureLogging } from "./logging.ts";
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
      "analyze Claude Code, Codex, and Gemini CLI sessions: tokens, context windows, and cost",
    )
    .version(DECANT_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => io.writeOut(value),
      writeErr: (value) => io.writeErr(value),
    })
    .option("--db <path>", "path to the Decant SQLite database")
    .option("--json", "emit machine-readable JSON")
    .option("--format <format>", "output format (table | json | md)", parseOutputFormat)
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

  try {
    await program.parseAsync(defaultArgv(argv), { from: "user" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "exitCode" in error) {
      setCode(commanderExitCode(error as { exitCode: number; code?: string }));
    } else {
      io.writeErr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      setCode(1);
    }
  }
  return { code, stdout: io.stdout, stderr: io.stderr };
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
