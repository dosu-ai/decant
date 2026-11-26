import { statSync } from "node:fs";
import { compactBlockToolResultStorage, compactMessageStorage } from "../../message-storage.ts";
import type { Archive, CliContext } from "../context.ts";

interface DbInfo {
  path: string;
  size_bytes: number;
  schema_version: number;
  sessions: number;
  messages: number;
  blocks: number;
  tool_calls: number;
  file_refs: number;
  freelist_bytes: number;
  fts_rows?: number;
  text_bytes?: number;
  compressed_messages?: number;
  raw_stored_bytes?: number;
  compressed_tool_results?: number;
  tool_result_stored_bytes?: number;
}

export function registerDbCommands(ctx: CliContext): void {
  const { program, io } = ctx;

  const dbCommand = program.command("db").description("inspect and maintain the session log index");
  dbCommand
    .command("info")
    .description("show DB path, size, schema version, row counts, and freed pages")
    .option("--full", "add full-scan totals (fts_rows, text_bytes); slow on a large archive")
    .action((commandOptions: { full?: boolean }) =>
      ctx.run(() =>
        ctx.withArchive((archive) => {
          const row = dbInfo(archive, { includeFullScanTotals: commandOptions.full === true });
          const fields: [string, string | number][] = [
            ["path", row.path],
            ["size_bytes", row.size_bytes],
            ["schema", `v${row.schema_version}`],
            ["sessions", row.sessions],
            ["messages", row.messages],
            ["blocks", row.blocks],
            ["tool_calls", row.tool_calls],
            ["file_refs", row.file_refs],
            ["freelist_bytes", row.freelist_bytes],
          ];
          if (row.fts_rows != null) {
            fields.push(["fts_rows", row.fts_rows]);
          }
          if (row.text_bytes != null) {
            fields.push(["text_bytes", row.text_bytes]);
          }
          if (row.compressed_messages != null) {
            fields.push(["compressed_messages", row.compressed_messages]);
          }
          if (row.raw_stored_bytes != null) {
            fields.push(["raw_stored_bytes", row.raw_stored_bytes]);
          }
          if (row.compressed_tool_results != null) {
            fields.push(["compressed_tool_results", row.compressed_tool_results]);
          }
          if (row.tool_result_stored_bytes != null) {
            fields.push(["tool_result_stored_bytes", row.tool_result_stored_bytes]);
          }
          ctx.output(row, () =>
            fields.map(([label, value]) => `${`${label}:`.padEnd(16)}${value}\n`).join(""),
          );
        }),
      ),
    );
  dbCommand
    .command("migrate")
    .description("apply schema migrations explicitly")
    .action(() =>
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            io.writeErr(`schema up to date at ${archive.config.dbPath}\n`);
          },
          { create: true },
        ),
      ),
    );
  dbCommand
    .command("compact")
    .description(
      "losslessly compress retained source records and tool results and reclaim free space",
    )
    .action(() =>
      ctx.run(() =>
        ctx.withArchive(
          (archive) => {
            io.writeErr("compressing retained source records\n");
            let lastProgress = Date.now();
            const messages = compactMessageStorage(archive.db, (progress) => {
              if (Date.now() - lastProgress < 1_000) return;
              io.writeErr(
                `compressed ${progress.compressed} messages, saved ${progress.saved_bytes} bytes\n`,
              );
              lastProgress = Date.now();
            });
            io.writeErr("compressing tool results\n");
            lastProgress = Date.now();
            const toolResults = compactBlockToolResultStorage(archive.db, (progress) => {
              if (Date.now() - lastProgress < 1_000) return;
              io.writeErr(
                `compressed ${progress.compressed} tool results, saved ${progress.saved_bytes} bytes\n`,
              );
              lastProgress = Date.now();
            });
            io.writeErr("vacuuming archive to reclaim free pages\n");
            archive.db.exec("VACUUM;");
            const result = {
              ...messages,
              tool_results_scanned: toolResults.scanned,
              tool_results_compressed: toolResults.compressed,
              tool_results_saved_bytes: toolResults.saved_bytes,
            };
            ctx.output(
              result,
              () =>
                `compressed ${messages.compressed} messages (saved ${messages.saved_bytes} bytes) and ${toolResults.compressed} tool results (saved ${toolResults.saved_bytes} bytes)\n`,
            );
          },
          { sync: false },
        ),
      ),
    );
  dbCommand
    .command("vacuum")
    .description("reclaim free space")
    .action(() =>
      ctx.run(() =>
        ctx.withArchive((archive) => {
          archive.db.exec("VACUUM;");
          io.writeErr(`vacuumed ${archive.config.dbPath}\n`);
        }),
      ),
    );
}

function dbInfo(archive: Archive, options: { includeFullScanTotals?: boolean } = {}): DbInfo {
  const version =
    (
      archive.db.query("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as {
        v: number;
      }
    ).v ?? 0;
  const counts = archive.db
    .query(
      `SELECT (SELECT COUNT(*) FROM session) AS sessions,
              (SELECT COUNT(*) FROM message) AS messages,
              (SELECT COUNT(*) FROM block) AS blocks,
              (SELECT COUNT(*) FROM tool_call) AS tool_calls,
              (SELECT COUNT(*) FROM file_ref) AS file_refs`,
    )
    .get() as Pick<DbInfo, "sessions" | "messages" | "blocks" | "tool_calls" | "file_refs">;
  const pages = archive.db
    .query(
      `SELECT (SELECT * FROM pragma_freelist_count()) AS freelist,
              (SELECT * FROM pragma_page_size()) AS page_size`,
    )
    .get() as { freelist: number; page_size: number };
  const scans =
    options.includeFullScanTotals === true
      ? (archive.db
          .query(
            // OCTET_LENGTH, not LENGTH: LENGTH counts characters on a TEXT
            // column, which understates a non-ASCII archive by a third to a
            // half. text_bytes is printed beside size_bytes, which is real
            // bytes from statSync, so the two have to be the same unit.
            `SELECT (SELECT COUNT(*) FROM block_fts) AS fts_rows,
                    (SELECT COALESCE(SUM(COALESCE(raw_bytes, OCTET_LENGTH(raw))), 0) FROM message)
                    + (SELECT COALESCE(SUM(OCTET_LENGTH(COALESCE(text, ''))
                                          + OCTET_LENGTH(COALESCE(tool_input, ''))
                                          + COALESCE(tool_result_bytes, OCTET_LENGTH(COALESCE(tool_result, '')))), 0)
                       FROM block) AS text_bytes,
                    (SELECT COUNT(*) FROM message WHERE typeof(raw) = 'blob') AS compressed_messages,
                    (SELECT COALESCE(SUM(OCTET_LENGTH(raw) + COALESCE(OCTET_LENGTH(raw_meta), 0)), 0)
                       FROM message) AS raw_stored_bytes,
                    (SELECT COUNT(*) FROM block WHERE typeof(tool_result) = 'blob') AS compressed_tool_results,
                    (SELECT COALESCE(SUM(OCTET_LENGTH(tool_result)), 0)
                       FROM block WHERE tool_result IS NOT NULL) AS tool_result_stored_bytes`,
          )
          .get() as {
          fts_rows: number;
          text_bytes: number;
          compressed_messages: number;
          raw_stored_bytes: number;
          compressed_tool_results: number;
          tool_result_stored_bytes: number;
        })
      : null;
  return {
    path: archive.config.dbPath,
    size_bytes: statSync(archive.config.dbPath, { throwIfNoEntry: false })?.size ?? 0,
    schema_version: version,
    ...counts,
    freelist_bytes: pages.freelist * pages.page_size,
    ...(scans ?? {}),
  };
}
