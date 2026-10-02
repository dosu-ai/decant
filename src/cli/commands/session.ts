import type { Command } from "commander";
import { toMarkdown } from "../../export.ts";
import { getSession, listSessions } from "../../query.ts";
import { setSessionUserState } from "../../session-user-state.ts";
import type { CliContext } from "../context.ts";
import { parseInteger } from "../parse.ts";

export function registerSessionCommands(ctx: CliContext): void {
  const { program, io } = ctx;

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
          ctx.run(() =>
            ctx.withArchive(
              (archive) => {
                const rows = listSessions(archive.db, {
                  tool: commandOptions.tool,
                  model: commandOptions.model,
                  project: commandOptions.project,
                  includeSubagents: commandOptions.includeSubagents === true,
                  limit: commandOptions.limit,
                });
                ctx.output(rows, () =>
                  ctx.globals().quiet
                    ? `${rows.map((row) => row.id).join("\n")}${rows.length > 0 ? "\n" : ""}`
                    : `${rows.map((row) => `${row.id}\t${row.tool}\t${row.title ?? ""}`).join("\n")}\n`,
                );
              },
              { sync: true },
            ),
          ),
      );
  };

  const addShow = (command: Command): void => {
    command
      .description("render a full transcript")
      .argument("<id>", "session id", parseInteger)
      .action((id: number) =>
        ctx.run(() =>
          ctx.withArchive(
            (archive) => {
              const detail = getSession(archive.db, id);
              if (detail == null) {
                io.writeErr(`error: no session with id ${id}\n`);
                return 1;
              }
              ctx.output(detail, () => toMarkdown(detail));
            },
            { sync: true },
          ),
        ),
      );
  };

  const addRm = (command: Command): void => {
    command
      .description("delete a session and its descendants from the archive")
      .argument("<id>", "session id", parseInteger)
      .option("--yes", "confirm deleting a session that has descendants")
      .option("--dry-run", "report what would be deleted, and delete nothing")
      .action((id: number, commandOptions: { yes?: boolean; dryRun?: boolean }) =>
        // Deliberately not a syncing archive: deleting must not first re-ingest
        // the source directories, and the id came from a read that already
        // synced.
        ctx.run(() =>
          ctx.withArchive((archive) => {
            const json = ctx.isJson();
            const reportMiss = (): number => {
              if (json) {
                ctx.writeJson({ deleted: false, session_id: id, error: "session not found" });
              } else {
                io.writeErr(`error: no session with id ${id}\n`);
              }
              return 1;
            };

            let outcome: "missing" | "dry_run" | "confirmation_required" | "deleted" = "missing";
            let descendants = 0;
            const deleted = setSessionUserState(archive.db, id, "deleted", {
              // The callback runs after BEGIN IMMEDIATE and before any write,
              // so another ingest cannot add a descendant between this guard
              // and the deletion.
              confirmDelete: (sessionIds) => {
                descendants = sessionIds.length - 1;
                if (commandOptions.dryRun === true) {
                  outcome = "dry_run";
                  return false;
                }
                if (descendants > 0 && commandOptions.yes !== true) {
                  outcome = "confirmation_required";
                  return false;
                }
                outcome = "deleted";
                return true;
              },
            });
            if (outcome === "missing") {
              return reportMiss();
            }
            const plural = descendants === 1 ? "" : "s";

            if (outcome === "dry_run") {
              if (json) {
                ctx.writeJson({ deleted: false, dry_run: true, session_id: id, descendants });
              } else if (!ctx.globals().quiet) {
                io.writeOut(
                  `would delete session ${id} (${descendants} descendant${plural})\n` +
                    "nothing was deleted (--dry-run)\n",
                );
              }
              return 0;
            }

            // Deletion has no un-delete. The rows go, tombstones stop every
            // later sync from re-ingesting the source, and the only way back is
            // editing two tables by hand. A mistyped id must not silently take
            // a whole tree with it.
            if (outcome === "confirmation_required") {
              if (json) {
                ctx.writeJson({
                  deleted: false,
                  session_id: id,
                  descendants,
                  error: "refusing to delete a session tree without --yes",
                });
              } else {
                io.writeErr(
                  `error: session ${id} has ${descendants} descendant${plural}; ` +
                    `deleting it removes ${descendants + 1} sessions\n` +
                    "re-run with --yes to confirm, or --dry-run to preview\n",
                );
              }
              return 2;
            }

            if (!deleted) {
              // The deletion callback authorized the write, so false here is
              // defensive rather than an expected state.
              return reportMiss();
            }
            if (json) {
              ctx.writeJson({ deleted: true, session_id: id, descendants });
            } else if (!ctx.globals().quiet) {
              io.writeOut(
                `deleted session ${id} (${descendants} descendant${plural})\n` +
                  // SQLite may leave deleted transcript bytes readable in
                  // freed pages until a vacuum rewrites the archive.
                  "run `decant db vacuum` to release the freed pages\n",
              );
            }
            return 0;
          }),
        ),
      );
  };

  const session = program.command("session").description("inspect sessions");
  addLs(session.command("ls"));
  addShow(session.command("show"));
  addRm(session.command("rm"));
  addLs(program.command("ls"));
  addShow(program.command("show"));
}
