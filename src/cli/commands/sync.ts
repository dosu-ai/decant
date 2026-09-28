import { existsSync } from "node:fs";
import { decideOpen, displayUrl, openBrowser } from "../../browser.ts";
import { shellQuote } from "../../distill.ts";
import { sync as ingestSync } from "../../ingest.ts";
import { getDecantLogger, logWatchEvent } from "../../logging.ts";
import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT } from "../../serve-defaults.ts";
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_SYNC_INTERVAL_MS,
  startWatch,
  type WatchEvent,
} from "../../watch.ts";
import type { CliContext } from "../context.ts";
import { collectOption, parseInteger } from "../parse.ts";

export function registerSyncCommands(ctx: CliContext): void {
  const { program, io } = ctx;
  const watchLogger = getDecantLogger("watch");
  const serverLogger = getDecantLogger("server");

  const runSync = (commandOptions: {
    claudeDir?: string;
    codexDir?: string;
    geminiDir?: string;
    path?: string[];
  }): number => {
    const missingPath = commandOptions.path?.find((path) => !existsSync(path));
    if (missingPath != null) {
      io.writeErr(`error: --path does not exist: ${missingPath}\n`);
      return 2;
    }

    return ctx.withArchive(
      (archive) => {
        const report = ingestSync(archive.db, {
          ...archive.config,
          sourcePaths: commandOptions.path,
        });
        // `env` is only populated by tests, so read through to the real
        // environment the way `shouldSync` and `resolveConfig` do -- otherwise
        // the hint omits `--db` for anyone running with `DECANT_DB` set.
        const dbFlag = ctx.globals().db ?? (ctx.env ?? process.env).DECANT_DB;
        const issuesHint =
          report.issues > 0
            ? `inspect affected sessions with: decant ${dbFlag ? `--db ${shellQuote(archive.config.dbPath)} ` : ""}ls --json | ` +
              "jq '[.[] | select(.ingest_issue_count + .informational_ingest_issue_count > 0)]' " +
              "(issue detail: GET /api/sessions/:id/issues under `decant serve`)"
            : undefined;
        const jsonReport = {
          scanned: report.scanned,
          ingested: report.ingested,
          skipped: report.skipped,
          issues: report.issues,
          issues_by_code: report.issuesByCode,
          failed: report.failed,
          ...(issuesHint != null ? { issues_hint: issuesHint } : {}),
        };
        if (ctx.isJson()) {
          ctx.writeJson(jsonReport);
        } else if (!ctx.globals().quiet) {
          io.writeErr(
            `synced: ${report.scanned} scanned, ${report.ingested} ingested, ` +
              `${report.skipped} skipped, ${report.issues} issues, ${report.failed} failed\n`,
          );
          if (issuesHint != null) {
            io.writeErr(`  ${issuesHint}\n`);
          }
        }
        // Exit 3 means decant dropped source content, which is what an unparsed
        // line is. The other codes are sensors over content that did land, so
        // they are reported without failing the command.
        return (report.issuesByCode.unparsed_line ?? 0) > 0 ? 3 : 0;
      },
      {
        overrides: {
          claudeDir: commandOptions.claudeDir,
          codexDir: commandOptions.codexDir,
          geminiDir: commandOptions.geminiDir,
        },
      },
    );
  };

  program
    .command("sync")
    .description("scan session directories and upsert new or changed sessions")
    .option("--claude-dir <dir>", "override the Claude projects directory")
    .option("--codex-dir <dir>", "override the Codex home directory")
    .option("--gemini-dir <dir>", "override the Gemini CLI tmp directory")
    .option(
      "--path <path>",
      "ingest only this source file or directory (repeatable)",
      collectOption,
      [] as string[],
    )
    .action(
      (commandOptions: {
        claudeDir?: string;
        codexDir?: string;
        geminiDir?: string;
        path?: string[];
      }) => ctx.run(() => runSync(commandOptions)),
    );

  // Terminal rendering only. Under `serve`, server.ts's applyWatchEvent already
  // publishes each event to SSE clients exactly once; publishing again here
  // would double every /api/events frame. Under `watch`, there is no HTTP
  // server or SSE client to publish to at all.
  const emitWatchEvent = (event: WatchEvent): void => {
    if (!ctx.globals().quiet) {
      logWatchEvent(watchLogger, event);
    }
    if (ctx.isJson()) {
      io.writeOut(`${JSON.stringify(event)}\n`);
    }
  };

  program
    .command("watch")
    .description("watch session directories and keep the session log index current")
    .option("--claude-dir <dir>", "override the Claude projects directory")
    .option("--codex-dir <dir>", "override the Codex home directory")
    .option("--gemini-dir <dir>", "override the Gemini CLI tmp directory")
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
        geminiDir?: string;
        intervalMs?: number;
        debounceMs?: number;
        fsWatch?: boolean;
      }) =>
        ctx.run(async () => {
          const config = ctx.resolve({
            claudeDir: commandOptions.claudeDir,
            codexDir: commandOptions.codexDir,
            geminiDir: commandOptions.geminiDir,
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
    .description(
      "serve the web UI and keep the index current (the default when run with no arguments)",
    )
    .option("--host <host>", "host to bind", DEFAULT_SERVE_HOST)
    .option("--port <n>", "port to bind", parseInteger, DEFAULT_SERVE_PORT)
    .option("--claude-dir <dir>", "override the Claude projects directory")
    .option("--codex-dir <dir>", "override the Codex home directory")
    .option("--gemini-dir <dir>", "override the Gemini CLI tmp directory")
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
    .option("--no-open", "do not open the browser after the server starts")
    .action(
      (commandOptions: {
        host?: string;
        port?: number;
        claudeDir?: string;
        codexDir?: string;
        geminiDir?: string;
        intervalMs?: number;
        debounceMs?: number;
        fsWatch?: boolean;
        trustedPeer?: string[];
        open?: boolean;
      }) =>
        ctx.run(async () => {
          const config = ctx.resolve({
            claudeDir: commandOptions.claudeDir,
            codexDir: commandOptions.codexDir,
            geminiDir: commandOptions.geminiDir,
          });
          // --no-sync must stop the watcher, or serving a scratch archive would
          // fill it from the real ~/.claude and ~/.codex. Omitting `watch` is how
          // serve() knows; POST /api/sync stays available for explicit syncs.
          const syncEnabled = ctx.shouldSync();
          // Loaded here so other commands skip the server's chart and report
          // dependencies at startup.
          const { parsePeerList, serve: serveApp } = await import("../../server.ts");
          let server: ReturnType<typeof serveApp>;
          try {
            server = serveApp({
              config,
              hostname: commandOptions.host ?? DEFAULT_SERVE_HOST,
              port: commandOptions.port ?? DEFAULT_SERVE_PORT,
              // Omitted rather than [] so resolveTrustedPeers() can still fall
              // through to DECANT_TRUSTED_PEERS and the gateway default.
              trustedPeers:
                commandOptions.trustedPeer != null && commandOptions.trustedPeer.length > 0
                  ? commandOptions.trustedPeer.flatMap((value) => parsePeerList(value))
                  : undefined,
              logger: ctx.globals().quiet ? undefined : serverLogger,
              watch: syncEnabled
                ? {
                    intervalMs: commandOptions.intervalMs,
                    debounceMs: commandOptions.debounceMs,
                    enableWatch: commandOptions.fsWatch !== false,
                    onEvent: emitWatchEvent,
                  }
                : undefined,
            });
          } catch (error) {
            if (isPortInUse(error)) {
              const wanted = commandOptions.port ?? DEFAULT_SERVE_PORT;
              const url = displayUrl(commandOptions.host ?? DEFAULT_SERVE_HOST, wanted);
              io.writeErr(
                `error: port ${wanted} is already in use — is Decant already running at ${url}?\n` +
                  "Pick another port with: decant serve --port <n>\n",
              );
              return 1;
            }
            throw error;
          }
          if (!ctx.globals().quiet) {
            serverLogger.info("Server started.", {
              "event.name": "decant.server.started",
              "server.address": commandOptions.host ?? DEFAULT_SERVE_HOST,
              "server.port": server.port,
              "watch.enabled": syncEnabled,
            });
          }
          const boundPort = server.port ?? commandOptions.port ?? DEFAULT_SERVE_PORT;
          const url = displayUrl(commandOptions.host ?? DEFAULT_SERVE_HOST, boundPort);
          const environment = ctx.env ?? process.env;
          const decision = decideOpen({
            enabled: commandOptions.open !== false,
            env: {
              BROWSER: environment.BROWSER,
              DECANT_NO_OPEN: environment.DECANT_NO_OPEN,
              CI: environment.CI,
            },
            isTTY: process.stdout.isTTY === true,
            platform: process.platform,
          });
          if (!ctx.globals().quiet) {
            io.writeErr(serveBanner(url, decision.open));
          }
          if (decision.open && decision.command != null) {
            openBrowser(url, decision.command);
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
            if (!ctx.globals().quiet) {
              serverLogger.info("Server stopped.", {
                "event.name": "decant.server.stopped",
                "server.address": commandOptions.host ?? DEFAULT_SERVE_HOST,
                "server.port": server.port,
              });
            }
          }
        }),
    );
}

function serveBanner(url: string, opening: boolean): string {
  return [
    "",
    "  Decant is running.",
    "",
    `    ${url}`,
    "",
    opening
      ? "  Opening your browser — the printed link works if it does not."
      : "  Open the link in your browser.",
    "  Ctrl-C stops the server; decant --help lists every command.",
    "",
    "",
  ].join("\n");
}

function isPortInUse(error: unknown): boolean {
  if (typeof error !== "object" || error == null) {
    return false;
  }
  const { code, message } = error as { code?: string; message?: string };
  return code === "EADDRINUSE" || (message?.includes("in use") ?? false);
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
