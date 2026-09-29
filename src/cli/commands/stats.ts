import type { Command } from "commander";
import { parseFileOperation } from "../../distill.ts";
import { search } from "../../query.ts";
import {
  byDimension,
  fileHotspots,
  mcpUsage,
  parseDimension,
  parseFileGroup,
  toolUsage,
  totals,
} from "../../stats.ts";
import { tokenEconomics } from "../../token-economics.ts";
import type { CliContext } from "../context.ts";
import { parseInteger } from "../parse.ts";

export function registerStatsCommands(ctx: CliContext): void {
  const { program, io } = ctx;

  program
    .command("search")
    .description("full-text search across all sessions")
    .argument("<query>", "FTS query")
    .option("--limit <n>", "max rows", parseInteger, 30)
    .action((query: string, commandOptions: { limit?: number }) =>
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            const rows = search(archive.db, query, commandOptions.limit ?? 30);
            ctx.output(rows, () =>
              rows.map((row) => `${row.session_id}\t${row.snippet}`).join("\n"),
            );
          },
          { sync: true },
        ),
      ),
    );

  program
    .command("stats")
    .description("usage and cost rollups")
    .option("--by <dimension>", "tool | model | project | day")
    .action((commandOptions: { by?: string }) =>
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            if (commandOptions.by != null) {
              const dimension = parseDimension(commandOptions.by);
              if (dimension == null) {
                io.writeErr(
                  `error: unknown --by value ${JSON.stringify(commandOptions.by)} ` +
                    "(expected: tool | model | project | day)\n",
                );
                return 2;
              }
              const rows = byDimension(archive.db, dimension);
              ctx.output(rows, () => rows.map((row) => `${row.key}\t${row.sessions}`).join("\n"));
            } else {
              const row = totals(archive.db);
              ctx.output(row, () => `sessions:   ${row.sessions}\nmessages:   ${row.messages}\n`);
            }
          },
          { sync: true },
        ),
      ),
    );

  program
    .command("tokens")
    .alias("economics")
    .description(
      "break tokens, cost, agent time, and user wait into context, planning, code, and communicating",
    )
    .action(() =>
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            const row = tokenEconomics(archive.db);
            ctx.output(row, () =>
              row.buckets
                .map(
                  (bucket) =>
                    `${bucket.bucket}\t${formatNumber(bucket.generation_tokens)}\t` +
                    `${formatNumber(bucket.context_window_tokens)}\t` +
                    `${bucket.estimated_cost_usd.toFixed(4)}\t` +
                    `${formatDuration(bucket.active_ms)}`,
                )
                .join("\n")
                .concat(row.buckets.length > 0 ? "\n" : "")
                .concat(
                  `waiting_on_user\t-\t-\t-\t${formatDuration(row.totals.waiting_on_user_ms)}\n`,
                ),
            );
          },
          { sync: true },
        ),
      ),
    );

  program
    .command("files")
    .description("file hotspots")
    .option("--group <group>", "path | ext", "path")
    .option("--op <op>", "read | edit | write | delete")
    .option("--limit <n>", "max rows", parseInteger, 25)
    .action((commandOptions: { group: string; op?: string; limit?: number }) =>
      ctx.run(() => {
        const group = parseFileGroup(commandOptions.group);
        if (group == null) {
          io.writeErr(
            `error: unknown --group value ${JSON.stringify(commandOptions.group)} ` +
              "(expected: path | ext)\n",
          );
          return 2;
        }
        const op = commandOptions.op == null ? null : parseFileOperation(commandOptions.op);
        if (commandOptions.op != null && op == null) {
          io.writeErr(
            `error: unknown --op value ${JSON.stringify(commandOptions.op)} ` +
              "(expected: read | edit | write | delete)\n",
          );
          return 2;
        }
        return ctx.withArchive(
          (archive) => {
            const rows = fileHotspots(archive.db, group, op, commandOptions.limit ?? 25);
            ctx.output(rows, () => rows.map((row) => `${row.key}\t${row.sessions}`).join("\n"));
          },
          { sync: true },
        );
      }),
    );

  const addToolStats = (command: Command): void => {
    command
      .description("tool usage stats")
      .option("--errors-only", "only tools with at least one error")
      .option("--limit <n>", "max rows", parseInteger, 50)
      .action((commandOptions: { errorsOnly?: boolean; limit?: number }) =>
        ctx.run(() =>
          ctx.withArchive(
            (archive) => {
              const rows = toolUsage(
                archive.db,
                commandOptions.errorsOnly === true,
                commandOptions.limit ?? 50,
              );
              ctx.output(rows, () =>
                rows.map((row) => `${row.tool_name}\t${row.calls}`).join("\n"),
              );
            },
            { sync: true },
          ),
        ),
      );
  };
  const tool = program.command("tool").description("tool usage");
  addToolStats(tool.command("ls"));
  addToolStats(tool.command("stats"));

  const addMcpStats = (command: Command): void => {
    command
      .description("MCP server usage")
      .option("--limit <n>", "max rows", parseInteger, 50)
      .action((commandOptions: { limit?: number }) =>
        ctx.run(() =>
          ctx.withArchive(
            (archive) => {
              const rows = mcpUsage(archive.db, commandOptions.limit ?? 50);
              ctx.output(rows, () =>
                rows.map((row) => `${row.mcp_server}\t${row.calls}`).join("\n"),
              );
            },
            { sync: true },
          ),
        ),
      );
  };
  const mcp = program.command("mcp").description("MCP server usage");
  addMcpStats(mcp.command("ls"));
  addMcpStats(mcp.command("stats"));
}

function formatNumber(value: number): string {
  return String(Math.round(value));
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${totalSeconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
