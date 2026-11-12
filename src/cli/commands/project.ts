import { listProjects, type ProjectSummary } from "../../query.ts";
import type { CliContext } from "../context.ts";
import { fieldsParser, outputRows, PROJECT_FIELDS, parseOffset } from "../list-options.ts";
import { parsePositiveInteger } from "../parse.ts";

export function registerProjectCommands(ctx: CliContext): void {
  const { program } = ctx;

  const project = program.command("project").description("inspect projects");
  project
    .command("ls")
    .description("list projects with session counts and cost")
    .option("--limit <n>", "max rows (default: all)", parsePositiveInteger)
    .option("--offset <n>", "skip this many rows", parseOffset, 0)
    .option(
      "--fields <list>",
      "print only these comma-separated fields (the keys of a --json row)",
      fieldsParser(PROJECT_FIELDS),
    )
    .action((commandOptions: { limit?: number; offset?: number; fields?: string[] }) =>
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            const offset = commandOptions.offset ?? 0;
            const limit = commandOptions.limit;
            // The query aggregates every project either way, so paging the
            // result costs nothing more than paging the statement would.
            const rows = listProjects(archive.db).slice(
              offset,
              limit == null ? undefined : offset + limit,
            );
            outputRows(ctx, rows, commandOptions.fields, () =>
              rows
                .map(
                  (row) =>
                    `${row.id}\t${row.is_worktree ? "worktree" : "project"}\t${row.path}\t` +
                    `${row.worktree_tool ?? row.session_tools.join(",")}\t${row.sessions}\t` +
                    `${projectCost(row)}\t${row.last_seen_at ?? ""}`,
                )
                .join("\n")
                .concat(rows.length > 0 ? "\n" : ""),
            );
          },
          { sync: true },
        ),
      ),
    );
}

/** "-" when no session recorded usage (Cursor CLI records none), and an
 * asterisk when the cost leaves some sessions out. */
function projectCost(row: ProjectSummary): string {
  if (row.sessions > 0 && row.usage_sessions === 0) return "-";
  return `${row.estimated_cost_usd.toFixed(2)}${row.usage_sessions < row.sessions ? "*" : ""}`;
}
