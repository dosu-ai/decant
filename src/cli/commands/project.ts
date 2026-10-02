import { listProjects } from "../../query.ts";
import type { CliContext } from "../context.ts";

export function registerProjectCommands(ctx: CliContext): void {
  const { program } = ctx;

  const project = program.command("project").description("inspect projects");
  project
    .command("ls")
    .description("list projects with session counts and cost")
    .action(() =>
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            const rows = listProjects(archive.db);
            ctx.output(rows, () =>
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
          },
          { sync: true },
        ),
      ),
    );
}
