import { writeFileSync } from "node:fs";
import {
  defaultScriptOpts,
  hotContext,
  parseScriptFormat,
  parseSkillKind,
  renderReplay,
  renderScript,
  renderSkill,
  replayOps,
  timeline,
} from "../../distill.ts";
import type { CliContext, GlobalOptions, Io } from "../context.ts";
import { parseInteger, parseNumber } from "../parse.ts";

interface ArtifactOptions {
  out?: string;
  force?: boolean;
}

export function registerDistillCommands(ctx: CliContext): void {
  const { program, io } = ctx;

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
        ctx.run(() => {
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
          return ctx.withArchive(
            (archive) => {
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
              if (ctx.isJson()) {
                ctx.writeJson({
                  scope: d.scope_label,
                  session_count: d.session_count,
                  date_from: d.date_from,
                  date_to: d.date_to,
                  generated_with: d.generated_with,
                  ops: d.ops,
                  artifact,
                });
                return 0;
              }
              return emitArtifact(io, ctx.globals(), artifact, commandOptions);
            },
            { sync: true },
          );
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
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            const artifact = renderReplay(archive.db, id, commandOptions.includeErrors === true);
            if (artifact == null) {
              io.writeErr(`error: no session with id ${id}\n`);
              return 1;
            }
            if (ctx.isJson()) {
              const ops = replayOps(archive.db, id).filter(
                (op) =>
                  commandOptions.includeErrors === true || !(op.kind === "command" && op.is_error),
              );
              ctx.writeJson({ session_id: id, ops, artifact });
              return 0;
            }
            return emitArtifact(io, ctx.globals(), artifact, commandOptions);
          },
          { sync: true },
        ),
      ),
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
        ctx.run(() => {
          const kind = parseSkillKind(commandOptions.kind ?? "skill");
          if (kind == null) {
            io.writeErr(
              `error: unknown --kind ${JSON.stringify(commandOptions.kind)} ` +
                "(expected: skill | agents | command)\n",
            );
            return 2;
          }
          return ctx.withArchive(
            (archive) => {
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
              if (ctx.isJson()) {
                ctx.writeJson({
                  project,
                  session_count: d.session_count,
                  hot_context: hot,
                  ops: d.ops,
                  artifact,
                });
                return 0;
              }
              return emitArtifact(io, ctx.globals(), artifact, commandOptions);
            },
            { sync: true },
          );
        }),
    );
}

function emitArtifact(
  io: Io,
  options: GlobalOptions,
  artifact: string,
  artifactOptions: ArtifactOptions,
): number {
  if (artifactOptions.out != null) {
    // "wx" makes the no-clobber check and the write one atomic open(O_EXCL)
    // instead of exists-then-write.
    try {
      writeFileSync(artifactOptions.out, artifact, {
        flag: artifactOptions.force === true ? "w" : "wx",
      });
    } catch (error) {
      if ((error as { code?: string }).code === "EEXIST") {
        io.writeErr(`error: ${artifactOptions.out} exists (use --force to overwrite)\n`);
        return 2;
      }
      throw error;
    }
    if (!options.quiet) {
      io.writeErr(`wrote ${artifactOptions.out}\n`);
    }
  } else {
    io.writeOut(artifact);
  }
  return 0;
}
