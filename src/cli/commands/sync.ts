import { existsSync } from "node:fs";
import { decideOpen, displayUrl, openBrowser } from "../../browser.ts";
import { shellQuote } from "../../distill.ts";
import { sync as ingestSync } from "../../ingest.ts";
import { getDecantLogger, logWatchEvent } from "../../logging.ts";
import { DEFAULT_SERVE_HOST, DEFAULT_SERVE_PORT } from "../../serve-defaults.ts";
import {
  binaryChanged,
  binaryFingerprint,
  isServiceProcess,
  SERVICE_RESTART_EXIT_CODE,
  serviceBinary,
  serviceStatus,
} from "../../service.ts";
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_SYNC_INTERVAL_MS,
  startWatch,
  type WatchEvent,
} from "../../watch.ts";
import type { CliContext } from "../context.ts";
import { collectOption, parseInteger } from "../parse.ts";
import { renderUpdateNotice } from "../update-notice.ts";

export function registerSyncCommands(ctx: CliContext): void {
  const { program, io } = ctx;
  const watchLogger = getDecantLogger("watch");
  const serverLogger = getDecantLogger("server");

  const runSync = (commandOptions: {
    claudeDir?: string;
    codexDir?: string;
    geminiDir?: string;
    opencodeDir?: string;
    cursorDir?: string;
    copilotDir?: string;
    vscodeCopilotDir?: string;
    atifDir?: string;
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
          opencodeDir: commandOptions.opencodeDir,
          cursorDir: commandOptions.cursorDir,
          copilotDir: commandOptions.copilotDir,
          vscodeCopilotDir: commandOptions.vscodeCopilotDir,
          atifDir: commandOptions.atifDir,
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
    .option("--opencode-dir <dir>", "override the OpenCode data directory")
    .option("--cursor-dir <dir>", "override the Cursor CLI chats directory")
    .option("--copilot-dir <dir>", "override the GitHub Copilot CLI session-state directory")
    .option(
      "--vscode-copilot-dir <dir>",
      "override the VS Code User directory read for Copilot Chat",
    )
    .option("--atif-dir <dir>", "override the directory read for ATIF trajectory files")
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
        opencodeDir?: string;
        cursorDir?: string;
        copilotDir?: string;
        vscodeCopilotDir?: string;
        atifDir?: string;
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
    .option("--opencode-dir <dir>", "override the OpenCode data directory")
    .option("--cursor-dir <dir>", "override the Cursor CLI chats directory")
    .option("--copilot-dir <dir>", "override the GitHub Copilot CLI session-state directory")
    .option(
      "--vscode-copilot-dir <dir>",
      "override the VS Code User directory read for Copilot Chat",
    )
    .option("--atif-dir <dir>", "override the directory read for ATIF trajectory files")
    .option("--interval-ms <ms>", "fallback sweep interval", parseInteger, DEFAULT_SYNC_INTERVAL_MS)
    .option(
      "--debounce-ms <ms>",
      "quiet period before file events sync (a busy log still syncs every 5s)",
      parseInteger,
      DEFAULT_DEBOUNCE_MS,
    )
    .option(
      "--no-fs-watch",
      "disable native filesystem watching and rely on sweeps (OpenCode databases are still polled)",
    )
    .action(
      (commandOptions: {
        claudeDir?: string;
        codexDir?: string;
        geminiDir?: string;
        opencodeDir?: string;
        cursorDir?: string;
        copilotDir?: string;
        vscodeCopilotDir?: string;
        atifDir?: string;
        intervalMs?: number;
        debounceMs?: number;
        fsWatch?: boolean;
      }) =>
        ctx.run(async () => {
          const config = ctx.resolve({
            claudeDir: commandOptions.claudeDir,
            codexDir: commandOptions.codexDir,
            geminiDir: commandOptions.geminiDir,
            opencodeDir: commandOptions.opencodeDir,
            cursorDir: commandOptions.cursorDir,
            copilotDir: commandOptions.copilotDir,
            vscodeCopilotDir: commandOptions.vscodeCopilotDir,
            atifDir: commandOptions.atifDir,
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
    .option("--opencode-dir <dir>", "override the OpenCode data directory")
    .option("--cursor-dir <dir>", "override the Cursor CLI chats directory")
    .option("--copilot-dir <dir>", "override the GitHub Copilot CLI session-state directory")
    .option(
      "--vscode-copilot-dir <dir>",
      "override the VS Code User directory read for Copilot Chat",
    )
    .option("--atif-dir <dir>", "override the directory read for ATIF trajectory files")
    .option("--interval-ms <ms>", "fallback sweep interval", parseInteger, DEFAULT_SYNC_INTERVAL_MS)
    .option(
      "--debounce-ms <ms>",
      "quiet period before file events sync (a busy log still syncs every 5s)",
      parseInteger,
      DEFAULT_DEBOUNCE_MS,
    )
    .option(
      "--no-fs-watch",
      "disable native filesystem watching and rely on sweeps (OpenCode databases are still polled)",
    )
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
        opencodeDir?: string;
        cursorDir?: string;
        copilotDir?: string;
        vscodeCopilotDir?: string;
        atifDir?: string;
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
            opencodeDir: commandOptions.opencodeDir,
            cursorDir: commandOptions.cursorDir,
            copilotDir: commandOptions.copilotDir,
            vscodeCopilotDir: commandOptions.vscodeCopilotDir,
            atifDir: commandOptions.atifDir,
          });
          // --no-sync must stop the watcher, or serving a scratch archive would
          // fill it from the real ~/.claude and ~/.codex. Omitting `watch` is how
          // serve() knows; POST /api/sync stays available for explicit syncs.
          const syncEnabled = ctx.shouldSync();
          // Loaded here so other commands skip the server's chart and report
          // dependencies at startup.
          const { parsePeerList, serve: serveApp } = await import("../../server.ts");
          const environment = ctx.env ?? process.env;
          const supervised = isServiceProcess(environment);
          const host = commandOptions.host ?? DEFAULT_SERVE_HOST;
          const wanted = commandOptions.port ?? DEFAULT_SERVE_PORT;
          let requestShutdown: () => void = () => undefined;
          const shutdownRequested = new Promise<void>((resolve) => {
            requestShutdown = resolve;
          });
          const start = (): ReturnType<typeof serveApp> =>
            serveApp({
              config,
              hostname: host,
              port: wanted,
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
              onShutdownRequested: () => requestShutdown(),
              service: ctx.serviceOptions,
            });
          let server: ReturnType<typeof serveApp>;
          try {
            server = supervised
              ? await bindWhenFree(start, () =>
                  serverLogger.warning("Port in use; waiting for it to be released.", {
                    "event.name": "decant.service.port_busy",
                    "server.port": wanted,
                  }),
                )
              : start();
          } catch (error) {
            if (isPortInUse(error)) {
              const url = displayUrl(host, wanted);
              const background = await serviceStatus(ctx.serviceOptions).catch(() => null);
              if (background?.running === true && background.url === `http://127.0.0.1:${wanted}`) {
                // The background service already serves this port, so running
                // `decant` just takes the user there.
                const decision = openDecision(commandOptions.open !== false, environment);
                io.writeErr(
                  `Decant is already running in the background at ${url}\n` +
                    "Stop it with: decant service uninstall\n",
                );
                if (decision.open && decision.command != null) {
                  openBrowser(url, decision.command);
                }
                return 0;
              }
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
              "server.address": host,
              "server.port": server.port,
              "watch.enabled": syncEnabled,
              "service.supervised": supervised,
            });
          }
          const boundPort = server.port ?? wanted;
          const url = displayUrl(host, boundPort);
          const decision = openDecision(commandOptions.open !== false, environment);
          if (!ctx.globals().quiet && !supervised) {
            io.writeErr(serveBanner(url, decision.open));
          }
          void ctx.pendingUpdateNotice?.then(
            (status) => {
              const notice = renderUpdateNotice(status);
              if (notice != null) {
                io.writeErr(notice);
              }
            },
            () => undefined,
          );
          if (decision.open && decision.command != null) {
            openBrowser(url, decision.command);
          }
          let exitCode = 0;
          const binaryWatch = supervised
            ? watchBinary(ctx, () => {
                // A failing exit is what makes launchd and systemd start the
                // new binary; a clean exit would leave the service stopped.
                exitCode = SERVICE_RESTART_EXIT_CODE;
                serverLogger.info("Decant was updated; restarting the background service.", {
                  "event.name": "decant.service.binary_changed",
                });
                requestShutdown();
              })
            : null;
          const signal = waitForProcessSignal();
          try {
            await Promise.race([signal.promise, shutdownRequested]);
          } finally {
            signal.cancel();
            if (binaryWatch != null) {
              clearInterval(binaryWatch);
            }
            // Force-close: a graceful stop() never resolves while a browser
            // tab's /api/events SSE connection is open (Bun waits for active
            // connections to end on their own), which would hang shutdown
            // indefinitely on Ctrl-C. This is a local dev server being
            // intentionally torn down, so dropping open connections is fine.
            await server.stop(true);
            if (!ctx.globals().quiet) {
              serverLogger.info("Server stopped.", {
                "event.name": "decant.server.stopped",
                "server.address": host,
                "server.port": server.port,
              });
            }
          }
          return exitCode;
        }),
    );
}

const BINARY_CHECK_MS = 60_000;
const BIND_RETRY_FAST_MS = 250;
const BIND_RETRY_SLOW_MS = 2_000;
const BIND_FAST_WINDOW_MS = 30_000;

// The background service waits for its port instead of exiting: during a
// handoff the terminal copy releases it within a second, and while someone runs
// `decant serve` in a terminal, exiting would only make the OS restart the
// service every few seconds.
async function bindWhenFree<T>(start: () => T, onFirstWait: () => void): Promise<T> {
  const startedAt = Date.now();
  let warned = false;
  for (;;) {
    try {
      return start();
    } catch (error) {
      if (!isPortInUse(error)) {
        throw error;
      }
      if (!warned) {
        warned = true;
        onFirstWait();
      }
      const fast = Date.now() - startedAt < BIND_FAST_WINDOW_MS;
      await Bun.sleep(fast ? BIND_RETRY_FAST_MS : BIND_RETRY_SLOW_MS);
    }
  }
}

function watchBinary(ctx: CliContext, onChange: () => void): ReturnType<typeof setInterval> | null {
  const binary = serviceBinary(ctx.serviceOptions).path;
  const initial = binary == null ? null : binaryFingerprint(binary);
  if (binary == null || initial == null) {
    return null;
  }
  const timer = setInterval(() => {
    if (binaryChanged(initial, binaryFingerprint(binary))) {
      onChange();
    }
  }, BINARY_CHECK_MS);
  timer.unref?.();
  return timer;
}

function openDecision(enabled: boolean, environment: Record<string, string | undefined>) {
  return decideOpen({
    enabled,
    env: {
      BROWSER: environment.BROWSER,
      DECANT_NO_OPEN: environment.DECANT_NO_OPEN,
      CI: environment.CI,
    },
    isTTY: process.stdout.isTTY === true,
    platform: process.platform,
  });
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

function waitForProcessSignal(): { promise: Promise<void>; cancel: () => void } {
  let done: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  return { promise, cancel: () => done() };
}
