import {
  list as listRecommendations,
  markImplemented,
  STATUS_FILTERS,
  type StatusFilter,
} from "../../recommendations.ts";
import type { CliContext } from "../context.ts";
import { parseChoice } from "../parse.ts";

export function registerRecommendationsCommands(ctx: CliContext): void {
  const { program, io } = ctx;

  const recommendations = program
    .command("recommendations")
    .description("inspect and update recommendations");
  recommendations
    .command("ls")
    .description("list persisted recommendations")
    .option("--status <status>", STATUS_FILTERS.join(" | "), parseChoice(STATUS_FILTERS), "open")
    .action((commandOptions: { status?: StatusFilter }) =>
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            const rows = listRecommendations(archive.db, commandOptions.status ?? "open");
            ctx.output(
              rows,
              () =>
                rows.map((row) => `${row.key}\t${row.status}\t${row.title}`).join("\n") +
                (rows.length > 0 ? "\n" : ""),
            );
          },
          { sync: true },
        ),
      ),
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
          } else if (!ok) {
            // --quiet drops notes, not the reason a command failed.
            io.writeErr(`recommendation not found: ${key}\n`);
          } else if (!ctx.globals().quiet) {
            io.writeOut(`Marked ${key} as implemented.\n`);
          }
          return ok ? 0 : 1;
        }),
      ),
    );
}
