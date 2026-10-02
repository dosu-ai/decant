import {
  list as listRecommendations,
  markImplemented,
  parseStatusFilter,
} from "../../recommendations.ts";
import type { CliContext } from "../context.ts";

export function registerRecommendationsCommands(ctx: CliContext): void {
  const { program, io } = ctx;

  const recommendations = program
    .command("recommendations")
    .description("inspect and update recommendations");
  recommendations
    .command("ls")
    .description("list persisted recommendations")
    .option("--status <status>", "open | implemented | all", "open")
    .action((commandOptions: { status?: string }) =>
      ctx.run(() => {
        const status = parseStatusFilter(commandOptions.status ?? "open");
        if (status == null) {
          io.writeErr(
            `error: unknown --status ${JSON.stringify(commandOptions.status)} ` +
              "(expected: open | implemented | all)\n",
          );
          return 2;
        }
        return ctx.withArchive(
          (archive) => {
            const rows = listRecommendations(archive.db, status);
            ctx.output(
              rows,
              () =>
                rows.map((row) => `${row.key}\t${row.status}\t${row.title}`).join("\n") +
                (rows.length > 0 ? "\n" : ""),
            );
          },
          { sync: true },
        );
      }),
    );
  recommendations
    .command("mark")
    .description("mark a recommendation implemented")
    .argument("<key>", "recommendation key")
    .option("--source <source>", "who marked it implemented", "agent")
    .option("--note <note>", "optional note")
    .action((key: string, commandOptions: { source?: string; note?: string }) =>
      ctx.run(() =>
        ctx.withArchive((archive) => {
          const ok = markImplemented(
            archive.db,
            key,
            commandOptions.source ?? "agent",
            commandOptions.note,
          );
          if (ctx.isJson()) {
            ctx.writeJson(
              ok
                ? { ok: true, key, status: "implemented" }
                : { ok: false, key, error: "recommendation not found" },
            );
          } else if (!ctx.globals().quiet) {
            io[ok ? "writeOut" : "writeErr"](
              ok ? `Marked ${key} as implemented.\n` : `recommendation not found: ${key}\n`,
            );
          }
          return ok ? 0 : 1;
        }),
      ),
    );
}
