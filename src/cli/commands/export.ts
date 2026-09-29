import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportTrajectory, toMarkdown } from "../../export.ts";
import { getSession, listSessions } from "../../query.ts";
import type { CliContext } from "../context.ts";
import { optionalInteger } from "../parse.ts";

export function registerExportCommand(ctx: CliContext): void {
  const { io } = ctx;

  ctx.program
    .command("export")
    .description("export a session to Markdown, JSON, or a trajectory-v1 record file")
    .argument("[id]", "session id", optionalInteger)
    .option("--all", "export every session")
    .option("--include-subagents", "with --all, also export subagent sessions")
    // Named --as, not --format, to match `distill script --as` rather than
    // collide with the global --format table|json|md: Commander resolves a
    // global option's flag anywhere in argv (before or after a subcommand),
    // so a same-named local option on export would be shadowed by the root's.
    .option("--as <format>", "md | json | trajectory (default: md, or json with --json)")
    .option("--out <dir>", "output directory")
    .action(
      (
        id: number | undefined,
        commandOptions: {
          all?: boolean;
          includeSubagents?: boolean;
          as?: string;
          out?: string;
        },
      ) =>
        ctx.run(() => {
          const format = commandOptions.as ?? (ctx.isJson() ? "json" : "md");
          if (format !== "md" && format !== "json" && format !== "trajectory") {
            io.writeErr(`error: unknown export format: ${format}\n`);
            return 2;
          }
          return ctx.withArchive(
            (archive) => {
              const ext = format === "md" ? "md" : format === "json" ? "json" : "trajectory.json";
              const render = (sessionId: number): { content: string } | { error: string } => {
                if (format === "trajectory") {
                  const out = exportTrajectory(archive.db, sessionId);
                  if (!out.ok) {
                    return out.reason === "not_found"
                      ? { error: `no session with id ${sessionId}` }
                      : {
                          error:
                            `session ${sessionId} has no ` +
                            `${out.reason === "missing_user_records" ? "user" : "assistant"} ` +
                            "records; not exportable as a trajectory",
                        };
                  }
                  if (!ctx.globals().quiet) {
                    const repairs = Object.entries(out.report)
                      .filter(([key, value]) => key !== "dropped_blocks" && (value as number) > 0)
                      .map(([key, value]) => `${key}=${value}`);
                    const dropped = Object.entries(out.report.dropped_blocks)
                      .map(([kind, count]) => `${kind}=${count}`)
                      .join(" ");
                    if (dropped !== "") {
                      repairs.push(`dropped[${dropped}]`);
                    }
                    const line = repairs.join(" ");
                    if (line !== "") {
                      io.writeErr(`session ${sessionId}: ${line}\n`);
                    }
                  }
                  return { content: JSON.stringify(out.records, null, 2) };
                }
                const detail = getSession(archive.db, sessionId);
                if (detail == null) {
                  return { error: `no session with id ${sessionId}` };
                }
                return {
                  content: format === "json" ? JSON.stringify(detail, null, 2) : toMarkdown(detail),
                };
              };

              if (commandOptions.all === true) {
                if (commandOptions.out == null) {
                  io.writeErr("error: --all requires --out <dir>\n");
                  return 2;
                }
                mkdirSync(commandOptions.out, { recursive: true });
                let count = 0;
                let skipped = 0;
                const sessions = listSessions(archive.db, {
                  limit: Number.MAX_SAFE_INTEGER,
                  includeSubagents: commandOptions.includeSubagents === true,
                });
                for (const session of sessions) {
                  const rendered = render(session.id);
                  if ("error" in rendered) {
                    skipped += 1;
                    continue;
                  }
                  writeFileSync(join(commandOptions.out, `${session.id}.${ext}`), rendered.content);
                  count += 1;
                }
                io.writeErr(
                  `exported ${count} sessions to ${commandOptions.out}` +
                    `${skipped > 0 ? ` (${skipped} skipped)` : ""}\n`,
                );
                return 0;
              }

              if (id == null) {
                io.writeErr("error: provide a session id, or --all --out <dir>\n");
                return 2;
              }
              const rendered = render(id);
              if ("error" in rendered) {
                io.writeErr(`error: ${rendered.error}\n`);
                return 1;
              }
              if (commandOptions.out != null) {
                mkdirSync(commandOptions.out, { recursive: true });
                const path = join(commandOptions.out, `${id}.${ext}`);
                writeFileSync(path, rendered.content);
                io.writeErr(`wrote ${path}\n`);
              } else {
                io.writeOut(`${rendered.content}\n`);
              }
              return 0;
            },
            { sync: true },
          );
        }),
    );
}
