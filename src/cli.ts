#!/usr/bin/env bun
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { type Config, type ConfigOverrides, resolveConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { refreshDerivedMetadata } from "./derived.ts";
import {
  DECANT_VERSION,
  defaultScriptOpts,
  hotContext,
  parseScriptFormat,
  parseSkillKind,
  renderReplay,
  renderScript,
  renderSkill,
  replayOps,
  timeline,
} from "./distill.ts";
import type { Operation } from "./enrich.ts";
import { toMarkdown } from "./export.ts";
import { sync as ingestSync } from "./ingest.ts";
import { getSession, listProjects, listSessions, search } from "./query.ts";
import {
  list as listRecommendations,
  markImplemented,
  parseStatusFilter,
} from "./recommendations.ts";
import {
  DEFAULT_SERVE_HOST,
  DEFAULT_SERVE_PORT,
  parsePeerList,
  serve as serveApp,
} from "./server.ts";
import {
  byDimension,
  fileHotspots,
  mcpUsage,
  parseDimension,
  parseFileGroup,
  toolUsage,
  totals,
} from "./stats.ts";
import { tokenEconomics } from "./token-economics.ts";
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_SYNC_INTERVAL_MS,
  startWatch,
  type WatchEvent,
} from "./watch.ts";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  liveOutput?: boolean;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
}

interface GlobalOptions {
  db?: string;
  json?: boolean;
  format?: OutputFormat;
  quiet?: boolean;
  sync?: boolean;
  color?: boolean;
}

interface Io {
  stdout: string;
  stderr: string;
  writeOut(value: string): void;
  writeErr(value: string): void;
}

interface Archive {
  db: ReturnType<typeof openDb>;
  config: Config;
}

type CliAction = () => number | undefined;
type CliAsyncAction = () => Promise<number | undefined>;
type OutputFormat = "table" | "json" | "md";

interface ArtifactOptions {
  out?: string;
  force?: boolean;
}

interface DbInfo {
  path: string;
  size_bytes: number;
  schema_version: number;
  sessions: number;
  messages: number;
  tool_calls: number;
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
  const run = (action: CliAction): void => {
    try {
      setCode(action() ?? 0);
    } catch (error) {
      io.writeErr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      setCode(1);
    }
  };
  const runAsync = async (action: CliAsyncAction): Promise<void> => {
    try {
      setCode((await action()) ?? 0);
    } catch (error) {
      io.writeErr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      setCode(1);
    }
  };

  const program = new Command();
  program
    .name("decant")
    .description("extract, browse, and search Claude Code and Codex sessions")
    .version(DECANT_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (value) => io.writeOut(value),
      writeErr: (value) => io.writeErr(value),
    })
    .option("--db <path>", "path to the decant SQLite database")
    .option("--json", "emit machine-readable JSON")
    .option("--format <format>", "output format (table | json | md)", parseOutputFormat)
    .option("-q, --quiet", "suppress non-essential output")
    .option("--no-color", "disable ANSI color")
    .option("--no-sync", "skip sync-on-read for read commands");

  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const resolve = (overrides: Partial<ConfigOverrides> = {}): Config =>
    resolveConfig({
      dbPath: globals().db,
      env: options.env,
      homeDir: options.homeDir,
      ...overrides,
    });
  const output = (value: unknown, renderHuman: () => string): void => {
    if (isJson(globals())) {
      io.writeOut(`${JSON.stringify(value, null, 2)}\n`);
    } else {
      io.writeOut(renderHuman());
    }
  };
  const readArchive = (overrides: Partial<ConfigOverrides> = {}): Archive => {
    const archive = openArchive(resolve(overrides));
    if (shouldSync(globals(), options.env)) {
      ingestSync(archive.db, archive.config);
    }
    return archive;
  };

  const runSync = (commandOptions: {
    claudeDir?: string;
    codexDir?: string;
    path?: string[];
  }): number => {
    const missingPath = commandOptions.path?.find((path) => !existsSync(path));
    if (missingPath != null) {
      io.writeErr(`error: --path does not exist: ${missingPath}\n`);
      return 2;
    }

    const archive = openArchive(
      resolve({ claudeDir: commandOptions.claudeDir, codexDir: commandOptions.codexDir }),
    );
    try {
      const report = ingestSync(archive.db, {
        ...archive.config,
        sourcePaths: commandOptions.path,
      });
      const jsonReport = {
        scanned: report.scanned,
        ingested: report.ingested,
        skipped: report.skipped,
        issues: report.issues,
        failed: report.failed,
      };
      if (isJson(globals())) {
        io.writeOut(`${JSON.stringify(jsonReport, null, 2)}\n`);
      } else if (!globals().quiet) {
        io.writeErr(
          `synced: ${report.scanned} scanned, ${report.ingested} ingested, ` +
            `${report.skipped} skipped, ${report.issues} issues, ${report.failed} failed\n`,
        );
      }
      return report.issues > 0 ? 3 : 0;
    } finally {
      archive.db.close();
    }
  };

  program
    .command("sync")
    .description("scan session directories and upsert new or changed sessions")
    .option("--claude-dir <dir>", "override the Claude projects directory")
    .option("--codex-dir <dir>", "override the Codex home directory")
    .option(
      "--path <path>",
      "ingest only this source file or directory (repeatable)",
      collectOption,
      [] as string[],
    )
    .action((commandOptions: { claudeDir?: string; codexDir?: string; path?: string[] }) =>
      run(() => runSync(commandOptions)),
    );

  // Terminal rendering only. Under `serve`, server.ts's applyWatchEvent already
  // publishes each event to SSE clients exactly once; publishing again here
  // would double every /api/events frame. Under `watch`, there is no HTTP
  // server or SSE client to publish to at all.
  const emitWatchEvent = (event: WatchEvent): void => {
    if (isJson(globals())) {
      io.writeOut(`${JSON.stringify(event)}\n`);
    } else if (!globals().quiet) {
      io.writeErr(renderWatchEvent(event));
    }
  };

  program
    .command("watch")
    .description("watch session directories and keep the archive current")
    .option("--claude-dir <dir>", "override the Claude projects directory")
    .option("--codex-dir <dir>", "override the Codex home directory")
    .option(
      "--trusted-peer <peer>",
      "allow API requests from this peer IP/CIDR when bound broadly (repeatable or comma-separated)",
      collectOption,
      [] as string[],
    )
    .option("--interval-ms <ms>", "fallback sweep interval", parseInteger, DEFAULT_SYNC_INTERVAL_MS)
    .option(
      "--debounce-ms <ms>",
      "filesystem event debounce window",
      parseInteger,
      DEFAULT_DEBOUNCE_MS,
    )
    .option("--no-fs-watch", "disable native filesystem watching and rely on sweeps")
    .action(
      (commandOptions: {
        claudeDir?: string;
        codexDir?: string;
        intervalMs?: number;
        debounceMs?: number;
        fsWatch?: boolean;
        trustedPeer?: string[];
      }) =>
        runAsync(async () => {
          const config = resolve({
            claudeDir: commandOptions.claudeDir,
            codexDir: commandOptions.codexDir,
          });
          const stop = waitForProcessSignal();
          const handle = startWatch({
            config,
            intervalMs: commandOptions.intervalMs,
            debounceMs: commandOptions.debounceMs,
            enableWatch: commandOptions.fsWatch !== false,
            onEvent: emitWatchEvent,
          });
          await stop;
          await handle.stop();
        }),
    );

  program
    .command("serve")
    .description("serve the in-process web UI and keep the archive current")
    .option("--host <host>", "host to bind", DEFAULT_SERVE_HOST)
    .option("--port <n>", "port to bind", parseInteger, DEFAULT_SERVE_PORT)
    .option("--claude-dir <dir>", "override the Claude projects directory")
    .option("--codex-dir <dir>", "override the Codex home directory")
    .option("--interval-ms <ms>", "fallback sweep interval", parseInteger, DEFAULT_SYNC_INTERVAL_MS)
    .option(
      "--debounce-ms <ms>",
      "filesystem event debounce window",
      parseInteger,
      DEFAULT_DEBOUNCE_MS,
    )
    .option("--no-fs-watch", "disable native filesystem watching and rely on sweeps")
    .option(
      "--trusted-peer <peer>",
      "allow API requests from this peer IP/CIDR when bound broadly (repeatable or comma-separated)",
      collectOption,
      [] as string[],
    )
    .action(
      (commandOptions: {
        host?: string;
        port?: number;
        claudeDir?: string;
        codexDir?: string;
        intervalMs?: number;
        debounceMs?: number;
        fsWatch?: boolean;
        trustedPeer?: string[];
      }) =>
        runAsync(async () => {
          const config = resolve({
            claudeDir: commandOptions.claudeDir,
            codexDir: commandOptions.codexDir,
          });
          const server = serveApp({
            config,
            hostname: commandOptions.host ?? DEFAULT_SERVE_HOST,
            port: commandOptions.port ?? DEFAULT_SERVE_PORT,
            // Omit entirely (rather than passing []) when no --trusted-peer was
            // given, so serve()'s `options.trustedPeers ?? parsePeerList(env)`
            // can still fall through to DECANT_TRUSTED_PEERS.
            trustedPeers:
              commandOptions.trustedPeer != null && commandOptions.trustedPeer.length > 0
                ? trustedPeers(commandOptions.trustedPeer)
                : undefined,
            watch: {
              intervalMs: commandOptions.intervalMs,
              debounceMs: commandOptions.debounceMs,
              enableWatch: commandOptions.fsWatch !== false,
              onEvent: emitWatchEvent,
            },
          });
          if (!isJson(globals()) && !globals().quiet) {
            io.writeErr(
              `serving http://${commandOptions.host ?? DEFAULT_SERVE_HOST}:${server.port}\n`,
            );
          }
          try {
            await waitForProcessSignal();
          } finally {
            // Force-close: a graceful stop() never resolves while a browser
            // tab's /api/events SSE connection is open (Bun waits for active
            // connections to end on their own), which would hang shutdown
            // indefinitely on Ctrl-C. This is a local dev server being
            // intentionally torn down, so dropping open connections is fine.
            await server.stop(true);
          }
        }),
    );

  const addLs = (command: Command): void => {
    command
      .description("list sessions")
      .option("--tool <tool>", "only this tool")
      .option("--model <model>", "only this model")
      .option("--project <path>", "only this project path")
      .option("--include-subagents", "include nested subagent sessions")
      .option("--limit <n>", "max rows", parseInteger, 50)
      .action(
        (commandOptions: {
          tool?: string;
          model?: string;
          project?: string;
          includeSubagents?: boolean;
          limit?: number;
        }) =>
          run(() => {
            const archive = readArchive();
            try {
              const rows = listSessions(archive.db, {
                tool: commandOptions.tool,
                model: commandOptions.model,
                project: commandOptions.project,
                includeSubagents: commandOptions.includeSubagents === true,
                limit: commandOptions.limit,
              });
              output(rows, () =>
                globals().quiet
                  ? `${rows.map((row) => row.id).join("\n")}${rows.length > 0 ? "\n" : ""}`
                  : `${rows.map((row) => `${row.id}\t${row.tool}\t${row.title ?? ""}`).join("\n")}\n`,
              );
            } finally {
              archive.db.close();
            }
          }),
      );
  };

  const addShow = (command: Command): void => {
    command
      .description("render a full transcript")
      .argument("<id>", "session id", parseInteger)
      .action((id: number) =>
        run(() => {
          const archive = readArchive();
          try {
            const detail = getSession(archive.db, id);
            if (detail == null) {
              io.writeErr(`error: no session with id ${id}\n`);
              return 1;
            }
            output(detail, () => toMarkdown(detail));
          } finally {
            archive.db.close();
          }
        }),
      );
  };

  const session = program.command("session").description("inspect sessions");
  addLs(session.command("ls"));
  addShow(session.command("show"));
  addLs(program.command("ls"));
  addShow(program.command("show"));

  const project = program.command("project").description("inspect projects");
  project
    .command("ls")
    .description("list projects with session counts and cost")
    .action(() =>
      run(() => {
        const archive = readArchive();
        try {
          const rows = listProjects(archive.db);
          output(rows, () =>
            rows
              .map(
                (row) =>
                  `${row.id}\t${row.is_worktree ? "worktree" : "project"}\t${row.path}\t` +
                  `${row.worktree_tool ?? row.session_tools.join(",")}\t${row.sessions}\t` +
                  `${row.estimated_cost_usd.toFixed(2)}\t${row.last_seen_at ?? ""}`,
              )
              .join("\n")
              .concat(rows.length > 0 ? "\n" : ""),
          );
        } finally {
          archive.db.close();
        }
      }),
    );

  const dbCommand = program.command("db").description("inspect and maintain the archive");
  dbCommand
    .command("info")
    .description("show DB path, size, schema version, and row counts")
    .action(() =>
      run(() => {
        const archive = openArchive(resolve());
        try {
          const row = dbInfo(archive);
          output(
            row,
            () =>
              `path:       ${row.path}\n` +
              `size_bytes: ${row.size_bytes}\n` +
              `schema:     v${row.schema_version}\n` +
              `sessions:   ${row.sessions}\n` +
              `messages:   ${row.messages}\n` +
              `tool_calls: ${row.tool_calls}\n`,
          );
        } finally {
          archive.db.close();
        }
      }),
    );
  dbCommand
    .command("migrate")
    .description("apply schema migrations explicitly")
    .action(() =>
      run(() => {
        const archive = openArchive(resolve());
        try {
          io.writeErr(`schema up to date at ${archive.config.dbPath}\n`);
        } finally {
          archive.db.close();
        }
      }),
    );
  dbCommand
    .command("vacuum")
    .description("reclaim free space")
    .action(() =>
      run(() => {
        const archive = openArchive(resolve());
        try {
          archive.db.exec("VACUUM;");
          io.writeErr(`vacuumed ${archive.config.dbPath}\n`);
        } finally {
          archive.db.close();
        }
      }),
    );

  const distill = program
    .command("distill")
    .description("generate runnable artifacts from history");
  distill
    .command("script")
    .description("workflow script from command history")
    .option("--project <project>", "limit to a project name or path")
    .option("--work-type <type>", "limit to a work type")
    .option("--from-session <id>", "distill one session faithfully", parseInteger)
    .option("--as <format>", "sh | just | make", "sh")
    .option("--min-frequency <n>", "frequency floor from 0.0 to 1.0", parseNumber)
    .option("-o, --out <path>", "write to a file instead of stdout")
    .option("--force", "overwrite the output file")
    .action(
      (
        commandOptions: {
          project?: string;
          workType?: string;
          fromSession?: number;
          as?: string;
          minFrequency?: number;
        } & ArtifactOptions,
      ) =>
        run(() => {
          const format = parseScriptFormat(commandOptions.as ?? "sh");
          if (format == null) {
            io.writeErr(
              `error: unknown --as ${JSON.stringify(commandOptions.as)} ` +
                "(expected: sh | just | make)\n",
            );
            return 2;
          }
          const minFrequency = commandOptions.minFrequency ?? 0.25;
          if (!Number.isFinite(minFrequency) || minFrequency < 0 || minFrequency > 1) {
            io.writeErr("error: --min-frequency must be a number between 0.0 and 1.0\n");
            return 2;
          }
          const archive = readArchive();
          try {
            const d = timeline(archive.db, {
              project: commandOptions.project,
              workType: commandOptions.workType,
              fromSession: commandOptions.fromSession,
            });
            if (d.ops.length === 0) {
              io.writeErr(`no commands found for ${d.scope_label} - try a different scope\n`);
              return 1;
            }
            const artifact = renderScript(d, {
              ...defaultScriptOpts(),
              format,
              minFrequency,
              exemplar: commandOptions.fromSession != null,
            });
            if (isJson(globals())) {
              io.writeOut(
                `${JSON.stringify(
                  {
                    scope: d.scope_label,
                    session_count: d.session_count,
                    date_from: d.date_from,
                    date_to: d.date_to,
                    generated_with: d.generated_with,
                    ops: d.ops,
                    artifact,
                  },
                  null,
                  2,
                )}\n`,
              );
              return 0;
            }
            return emitArtifact(io, globals(), artifact, commandOptions);
          } finally {
            archive.db.close();
          }
        }),
    );
  distill
    .command("replay")
    .description("reproduce one session's commands and file writes as a script")
    .argument("<id>", "session id", parseInteger)
    .option("--include-errors", "keep errored commands commented")
    .option("-o, --out <path>", "write to a file instead of stdout")
    .option("--force", "overwrite the output file")
    .action((id: number, commandOptions: { includeErrors?: boolean } & ArtifactOptions) =>
      run(() => {
        const archive = readArchive();
        try {
          const artifact = renderReplay(archive.db, id, commandOptions.includeErrors === true);
          if (artifact == null) {
            io.writeErr(`error: no session with id ${id}\n`);
            return 1;
          }
          if (isJson(globals())) {
            const ops = replayOps(archive.db, id).filter(
              (op) =>
                commandOptions.includeErrors === true || !(op.kind === "command" && op.is_error),
            );
            io.writeOut(`${JSON.stringify({ session_id: id, ops, artifact }, null, 2)}\n`);
            return 0;
          }
          return emitArtifact(io, globals(), artifact, commandOptions);
        } finally {
          archive.db.close();
        }
      }),
    );
  distill
    .command("skill")
    .description("generate a SKILL.md, AGENTS.md section, or slash command")
    .option("--project <project>", "limit to a project name or path")
    .option("--work-type <type>", "limit to a work type")
    .option("--kind <kind>", "skill | agents | command", "skill")
    .option("-o, --out <path>", "write to a file instead of stdout")
    .option("--force", "overwrite the output file")
    .action(
      (
        commandOptions: {
          project?: string;
          workType?: string;
          kind?: string;
        } & ArtifactOptions,
      ) =>
        run(() => {
          const kind = parseSkillKind(commandOptions.kind ?? "skill");
          if (kind == null) {
            io.writeErr(
              `error: unknown --kind ${JSON.stringify(commandOptions.kind)} ` +
                "(expected: skill | agents | command)\n",
            );
            return 2;
          }
          const archive = readArchive();
          try {
            const scope = {
              project: commandOptions.project,
              workType: commandOptions.workType,
              fromSession: null,
            };
            const d = timeline(archive.db, scope);
            const hot = hotContext(archive.db, scope, 15);
            if (d.ops.length === 0 && hot.length === 0) {
              io.writeErr(`no data found for ${d.scope_label} - try a different scope\n`);
              return 1;
            }
            const project = commandOptions.project ?? "your project";
            const artifact = renderSkill(d, hot, kind, project);
            if (isJson(globals())) {
              io.writeOut(
                `${JSON.stringify(
                  {
                    project,
                    session_count: d.session_count,
                    hot_context: hot,
                    ops: d.ops,
                    artifact,
                  },
                  null,
                  2,
                )}\n`,
              );
              return 0;
            }
            return emitArtifact(io, globals(), artifact, commandOptions);
          } finally {
            archive.db.close();
          }
        }),
    );

  const recommendations = program
    .command("recommendations")
    .description("inspect and update recommendations");
  recommendations
    .command("ls")
    .description("list persisted recommendations")
    .option("--status <status>", "open | implemented | all", "open")
    .action((commandOptions: { status?: string }) =>
      run(() => {
        const status = parseStatusFilter(commandOptions.status ?? "open");
        if (status == null) {
          io.writeErr(
            `error: unknown --status ${JSON.stringify(commandOptions.status)} ` +
              "(expected: open | implemented | all)\n",
          );
          return 2;
        }
        const archive = readArchive();
        try {
          const rows = listRecommendations(archive.db, status);
          output(
            rows,
            () =>
              rows.map((row) => `${row.key}\t${row.status}\t${row.title}`).join("\n") +
              (rows.length > 0 ? "\n" : ""),
          );
        } finally {
          archive.db.close();
        }
      }),
    );
  recommendations
    .command("mark")
    .description("mark a recommendation implemented")
    .argument("<key>", "recommendation key")
    .option("--source <source>", "who marked it implemented", "agent")
    .option("--note <note>", "optional note")
    .action((key: string, commandOptions: { source?: string; note?: string }) =>
      run(() => {
        const archive = openArchive(resolve());
        try {
          const ok = markImplemented(
            archive.db,
            key,
            commandOptions.source ?? "agent",
            commandOptions.note,
          );
          if (isJson(globals())) {
            io.writeOut(
              `${JSON.stringify(
                ok
                  ? { ok: true, key, status: "implemented" }
                  : { ok: false, key, error: "recommendation not found" },
                null,
                2,
              )}\n`,
            );
          } else if (!globals().quiet) {
            io[ok ? "writeOut" : "writeErr"](
              ok ? `Marked ${key} as implemented.\n` : `recommendation not found: ${key}\n`,
            );
          }
          return ok ? 0 : 1;
        } finally {
          archive.db.close();
        }
      }),
    );

  program
    .command("completion")
    .description("generate a shell completion script")
    .argument("<shell>", "bash | zsh | fish | powershell | elvish")
    .action((shell: string) =>
      run(() => {
        const script = renderCompletion(shell);
        if (script == null) {
          io.writeErr(
            `error: unknown completion shell ${JSON.stringify(shell)} ` +
              "(expected: bash | zsh | fish | powershell | elvish)\n",
          );
          return 2;
        }
        io.writeOut(script);
      }),
    );

  program
    .command("search")
    .description("full-text search across all sessions")
    .argument("<query>", "FTS query")
    .option("--limit <n>", "max rows", parseInteger, 30)
    .action((query: string, commandOptions: { limit?: number }) =>
      run(() => {
        const archive = readArchive();
        try {
          const rows = search(archive.db, query, commandOptions.limit ?? 30);
          output(rows, () => rows.map((row) => `${row.session_id}\t${row.snippet}`).join("\n"));
        } finally {
          archive.db.close();
        }
      }),
    );

  program
    .command("stats")
    .description("usage and cost rollups")
    .option("--by <dimension>", "tool | model | project | day")
    .action((commandOptions: { by?: string }) =>
      run(() => {
        const archive = readArchive();
        try {
          if (commandOptions.by != null) {
            const dimension = parseDimension(commandOptions.by);
            if (dimension == null) {
              io.writeErr(
                `error: unknown --by value ${JSON.stringify(commandOptions.by)} ` +
                  "(expected: tool | model | project | day)\n",
              );
              return 2;
            }
            const rows = byDimension(archive.db, dimension);
            output(rows, () => rows.map((row) => `${row.key}\t${row.sessions}`).join("\n"));
          } else {
            const row = totals(archive.db);
            output(row, () => `sessions:   ${row.sessions}\nmessages:   ${row.messages}\n`);
          }
        } finally {
          archive.db.close();
        }
      }),
    );

  program
    .command("tokens")
    .alias("economics")
    .description(
      "break tokens, cost, agent time, and user wait into context, planning, code, and communicating",
    )
    .action(() =>
      run(() => {
        const archive = readArchive();
        try {
          const row = tokenEconomics(archive.db);
          output(row, () =>
            row.buckets
              .map(
                (bucket) =>
                  `${bucket.bucket}\t${formatNumber(bucket.generation_tokens)}\t` +
                  `${formatNumber(bucket.context_window_tokens)}\t` +
                  `${bucket.estimated_cost_usd.toFixed(4)}\t` +
                  `${formatDuration(bucket.active_ms)}`,
              )
              .join("\n")
              .concat(row.buckets.length > 0 ? "\n" : "")
              .concat(
                `waiting_on_user\t-\t-\t-\t${formatDuration(row.totals.waiting_on_user_ms)}\n`,
              ),
          );
        } finally {
          archive.db.close();
        }
      }),
    );

  program
    .command("files")
    .description("file hotspots")
    .option("--group <group>", "path | ext", "path")
    .option("--op <op>", "read | edit | write | delete")
    .option("--limit <n>", "max rows", parseInteger, 25)
    .action((commandOptions: { group: string; op?: string; limit?: number }) =>
      run(() => {
        const group = parseFileGroup(commandOptions.group);
        if (group == null) {
          io.writeErr(
            `error: unknown --group value ${JSON.stringify(commandOptions.group)} ` +
              "(expected: path | ext)\n",
          );
          return 2;
        }
        const op = commandOptions.op == null ? null : parseOperation(commandOptions.op);
        if (commandOptions.op != null && op == null) {
          io.writeErr(
            `error: unknown --op value ${JSON.stringify(commandOptions.op)} ` +
              "(expected: read | edit | write | delete)\n",
          );
          return 2;
        }
        const archive = readArchive();
        try {
          const rows = fileHotspots(archive.db, group, op, commandOptions.limit ?? 25);
          output(rows, () => rows.map((row) => `${row.key}\t${row.sessions}`).join("\n"));
        } finally {
          archive.db.close();
        }
      }),
    );

  const addToolStats = (command: Command): void => {
    command
      .description("tool usage stats")
      .option("--errors-only", "only tools with at least one error")
      .option("--limit <n>", "max rows", parseInteger, 50)
      .action((commandOptions: { errorsOnly?: boolean; limit?: number }) =>
        run(() => {
          const archive = readArchive();
          try {
            const rows = toolUsage(
              archive.db,
              commandOptions.errorsOnly === true,
              commandOptions.limit ?? 50,
            );
            output(rows, () => rows.map((row) => `${row.tool_name}\t${row.calls}`).join("\n"));
          } finally {
            archive.db.close();
          }
        }),
      );
  };
  const tool = program.command("tool").description("tool usage");
  addToolStats(tool.command("ls"));
  addToolStats(tool.command("stats"));

  const addMcpStats = (command: Command): void => {
    command
      .description("MCP server usage")
      .option("--limit <n>", "max rows", parseInteger, 50)
      .action((commandOptions: { limit?: number }) =>
        run(() => {
          const archive = readArchive();
          try {
            const rows = mcpUsage(archive.db, commandOptions.limit ?? 50);
            output(rows, () => rows.map((row) => `${row.mcp_server}\t${row.calls}`).join("\n"));
          } finally {
            archive.db.close();
          }
        }),
      );
  };
  const mcp = program.command("mcp").description("MCP server usage");
  addMcpStats(mcp.command("ls"));
  addMcpStats(mcp.command("stats"));

  program
    .command("export")
    .description("export a session to Markdown or JSON")
    .argument("[id]", "session id", optionalInteger)
    .option("--all", "export every session")
    .option("--out <dir>", "output directory")
    .action((id: number | undefined, commandOptions: { all?: boolean; out?: string }) =>
      run(() => {
        const archive = readArchive();
        try {
          const ext = isJson(globals()) ? "json" : "md";
          const render = (sessionId: number): string | null => {
            const detail = getSession(archive.db, sessionId);
            if (detail == null) {
              return null;
            }
            return isJson(globals()) ? JSON.stringify(detail, null, 2) : toMarkdown(detail);
          };

          if (commandOptions.all === true) {
            if (commandOptions.out == null) {
              io.writeErr("error: --all requires --out <dir>\n");
              return 2;
            }
            mkdirSync(commandOptions.out, { recursive: true });
            let count = 0;
            for (const session of listSessions(archive.db, { limit: Number.MAX_SAFE_INTEGER })) {
              const content = render(session.id);
              if (content != null) {
                writeFileSync(join(commandOptions.out, `${session.id}.${ext}`), content);
                count += 1;
              }
            }
            io.writeErr(`exported ${count} sessions to ${commandOptions.out}\n`);
            return 0;
          }

          if (id == null) {
            io.writeErr("error: provide a session id, or --all --out <dir>\n");
            return 2;
          }
          const content = render(id);
          if (content == null) {
            io.writeErr(`error: no session with id ${id}\n`);
            return 1;
          }
          if (commandOptions.out != null) {
            mkdirSync(commandOptions.out, { recursive: true });
            const path = join(commandOptions.out, `${id}.${ext}`);
            writeFileSync(path, content);
            io.writeErr(`wrote ${path}\n`);
          } else {
            io.writeOut(`${content}\n`);
          }
          return 0;
        } finally {
          archive.db.close();
        }
      }),
    );

  try {
    await program.parseAsync(argv, { from: "user" });
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

function openArchive(config: Config): Archive {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDb(config.dbPath);
  refreshDerivedMetadata(db, { ignoreReadonly: true });
  return { db, config };
}

function isJson(options: GlobalOptions): boolean {
  return options.json === true || options.format === "json";
}

function parseOutputFormat(value: string): OutputFormat {
  if (value === "table" || value === "json" || value === "md") {
    return value;
  }
  throw new InvalidArgumentError("expected: table | json | md");
}

function shouldSync(
  options: GlobalOptions,
  env: Record<string, string | undefined> | undefined,
): boolean {
  return options.sync !== false && (env ?? process.env).DECANT_NO_SYNC == null;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError("expected an integer");
  }
  return parsed;
}

function parseNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError("expected a number");
  }
  return parsed;
}

function optionalInteger(value: string | undefined): number | undefined {
  return value == null ? undefined : parseInteger(value);
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function trustedPeers(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => parsePeerList(value));
}

function formatNumber(value: number): string {
  return String(Math.round(value));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${totalSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function parseOperation(value: string): Operation | null {
  return value === "read" || value === "edit" || value === "write" || value === "delete"
    ? value
    : null;
}

function emitArtifact(
  io: Io,
  options: GlobalOptions,
  artifact: string,
  artifactOptions: ArtifactOptions,
): number {
  if (artifactOptions.out != null) {
    if (existsSync(artifactOptions.out) && artifactOptions.force !== true) {
      io.writeErr(`error: ${artifactOptions.out} exists (use --force to overwrite)\n`);
      return 2;
    }
    writeFileSync(artifactOptions.out, artifact);
    if (!options.quiet) {
      io.writeErr(`wrote ${artifactOptions.out}\n`);
    }
  } else {
    io.writeOut(artifact);
  }
  return 0;
}

function renderWatchEvent(event: WatchEvent): string {
  switch (event.type) {
    case "ready":
      return `watching ${event.dirs.length} source dirs\n`;
    case "sync":
      return `sync (${event.reason}): ${event.report.scanned} scanned, ${event.report.ingested} ingested, ${event.report.skipped} skipped, ${event.report.issues} issues, ${event.report.failed} failed\n`;
    case "error":
      return `error (${event.reason}): ${event.error}\n`;
    case "stopped":
      return "stopped\n";
  }
}

function waitForProcessSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function dbInfo(archive: Archive): DbInfo {
  const version =
    (
      archive.db.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as {
        v: number;
      }
    ).v ?? 0;
  const counts = archive.db
    .query(
      `SELECT (SELECT COUNT(*) FROM session) AS sessions,
              (SELECT COUNT(*) FROM message) AS messages,
              (SELECT COUNT(*) FROM tool_call) AS tool_calls`,
    )
    .get() as Pick<DbInfo, "sessions" | "messages" | "tool_calls">;
  return {
    path: archive.config.dbPath,
    size_bytes: statSync(archive.config.dbPath, { throwIfNoEntry: false })?.size ?? 0,
    schema_version: version,
    ...counts,
  };
}

const completionWords = [
  "sync",
  "watch",
  "serve",
  "session",
  "ls",
  "show",
  "project",
  "db",
  "distill",
  "script",
  "replay",
  "skill",
  "recommendations",
  "mark",
  "search",
  "stats",
  "tokens",
  "economics",
  "files",
  "tool",
  "mcp",
  "export",
  "completion",
  "--db",
  "--json",
  "--format",
  "--quiet",
  "--no-color",
  "--no-sync",
];

function renderCompletion(shell: string): string | null {
  const words = completionWords.join(" ");
  switch (shell) {
    case "bash":
      return `_decant_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
}
complete -F _decant_complete decant
`;
    case "zsh":
      return `#compdef decant
_arguments '1:command:(${words})' '*::arg:->args'
`;
    case "fish":
      return `${completionWords.map((word) => `complete -c decant -f -a '${word}'`).join("\n")}\n`;
    case "powershell":
      return `Register-ArgumentCompleter -Native -CommandName decant -ScriptBlock {
  param($wordToComplete)
  "${words}".Split(" ") | Where-Object { $_ -like "$wordToComplete*" }
}
`;
    case "elvish":
      return `set edit:completion:arg-completer[decant] = {|@words|
  put ${completionWords.map((word) => JSON.stringify(word)).join(" ")}
}
`;
    default:
      return null;
  }
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2), { liveOutput: true });
  process.exit(result.code);
}
