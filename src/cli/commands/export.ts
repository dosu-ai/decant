import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mirrorAtif } from "../../atif-mirror.ts";
import { exportTrajectory, toMarkdown } from "../../export.ts";
import { exportAtif } from "../../export-atif.ts";
import { getSession, listSessions } from "../../query.ts";
import type { CliContext } from "../context.ts";
import { optionalInteger, parseChoice } from "../parse.ts";

const EXPORT_FORMATS = ["md", "json", "trajectory", "atif"] as const;

export function registerExportCommand(ctx: CliContext): void {
  const { io } = ctx;

  ctx.program
    .command("export")
    .description("export a session to Markdown, JSON, a trajectory-v1 record file, or ATIF")
    .argument("[id]", "session id", optionalInteger)
    .option("--all", "export every session")
    .option("--include-subagents", "with --all, also export subagent sessions")
    // Named --as, not --format, to match `distill script --as` rather than
    // collide with the global --format table|json|md: Commander resolves a
    // global option's flag anywhere in argv (before or after a subcommand),
    // so a same-named local option on export would be shadowed by the root's.
    .option(
      "--as <format>",
      "md | json | trajectory | atif (default: md, or json with --json)",
      parseChoice(EXPORT_FORMATS),
    )
    .option("--out <dir>", "output directory")
    .option("--mirror <dir>", "keep a folder of standalone ATIF documents, one per session")
    .action(
      (
        id: number | undefined,
        commandOptions: {
          all?: boolean;
          includeSubagents?: boolean;
          as?: (typeof EXPORT_FORMATS)[number];
          out?: string;
          mirror?: string;
        },
      ) =>
        ctx.run(() => {
          if (commandOptions.mirror != null) {
            const mirror = commandOptions.mirror;
            if (commandOptions.as != null && commandOptions.as !== "atif") {
              io.writeErr("error: --mirror writes ATIF only\n");
              return 2;
            }
            if (id != null || commandOptions.all === true || commandOptions.out != null) {
              io.writeErr("error: --mirror takes every session and its own folder\n");
              return 2;
            }
            return ctx.withArchive(
              (archive) => {
                const result = mirrorAtif(archive.db, { out: mirror });
                if (!result.ok) {
                  io.writeErr(`error: refusing to write through the link at ${result.path}\n`);
                  return 1;
                }
                const report = result.report;
                ctx.output(report, () =>
                  [
                    `mirrored ATIF to ${report.out}`,
                    `  written: ${report.written}`,
                    `  unchanged: ${report.unchanged}`,
                    ...(report.skipped > 0 ? [`  no steps to export: ${report.skipped}`] : []),
                  ].join("\n"),
                );
                return 0;
              },
              { sync: true },
            );
          }
          // Checked before the archive is opened, so a wrong command line exits 2
          // whether or not the archive exists.
          if (commandOptions.all === true && commandOptions.out == null) {
            io.writeErr("error: --all requires --out <dir>\n");
            return 2;
          }
          if (commandOptions.all !== true && id == null) {
            io.writeErr("error: provide a session id, or --all --out <dir>\n");
            return 2;
          }
          const format = commandOptions.as ?? (ctx.isJson() ? "json" : "md");
          return ctx.withArchive(
            (archive) => {
              const ext =
                format === "md"
                  ? "md"
                  : format === "json"
                    ? "json"
                    : format === "atif"
                      ? "atif.json"
                      : "trajectory.json";
              const render = (sessionId: number): { content: string } | { error: string } => {
                if (format === "atif") {
                  const out = exportAtif(archive.db, sessionId);
                  if (!out.ok) {
                    return out.reason === "not_found"
                      ? { error: `no session with id ${sessionId}` }
                      : { error: `session ${sessionId} has no exportable steps` };
                  }
                  if (!ctx.globals().quiet) {
                    const notes = Object.entries(out.report)
                      .filter(([key, value]) => key !== "dropped_blocks" && (value as number) > 0)
                      .map(([key, value]) => `${key}=${value}`);
                    const dropped = Object.entries(out.report.dropped_blocks)
                      .map(([kind, count]) => `${kind}=${count}`)
                      .join(" ");
                    if (dropped !== "") {
                      notes.push(`dropped[${dropped}]`);
                    }
                    if (notes.length > 0) {
                      io.writeErr(`session ${sessionId}: ${notes.join(" ")}\n`);
                    }
                  }
                  return { content: JSON.stringify(out.trajectory, null, 2) };
                }
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
