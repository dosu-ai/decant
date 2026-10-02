import { statSync } from "node:fs";
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
  /**
   * Pages SQLite has freed but not returned to the filesystem. Deleted rows
   * can leave readable bytes in those pages until `decant db vacuum` runs, so
   * this is the number that says a vacuum is owed.
   */
  freelist_bytes: number;
  /** Full-scan totals, present only under `--full`. */
  fts_rows?: number;
  text_bytes?: number;
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
          const row = dbInfo(archive, { full: commandOptions.full === true });
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
        ctx.withArchive((archive) => {
          io.writeErr(`schema up to date at ${archive.config.dbPath}\n`);
        }),
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

/**
 * `full` adds the two totals that cost a full scan of the archive. Measured on
 * a 2.5 GB archive: the row counts and the freelist pragma finish in under
 * 10 ms, while the byte sum takes 5-13 s and the FTS row count 0.6-2 s. A
 * command whose job is to report a path and a schema version must not pay
 * that, so those two are opt-in.
 */
function dbInfo(archive: Archive, options: { full?: boolean } = {}): DbInfo {
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
    options.full === true
      ? (archive.db
          .query(
            // OCTET_LENGTH, not LENGTH: LENGTH counts characters on a TEXT
            // column, which understates a non-ASCII archive by a third to a
            // half. text_bytes is printed beside size_bytes, which is real
            // bytes from statSync, so the two have to be the same unit.
            //
            // block.tool_result and message.raw are stored but not indexed, so
            // this total is deliberately wider than what search can reach.
            `SELECT (SELECT COUNT(*) FROM block_fts) AS fts_rows,
                    (SELECT COALESCE(SUM(OCTET_LENGTH(raw)), 0) FROM message)
                    + (SELECT COALESCE(SUM(OCTET_LENGTH(COALESCE(text, ''))
                                          + OCTET_LENGTH(COALESCE(tool_input, ''))
                                          + OCTET_LENGTH(COALESCE(tool_result, ''))), 0)
                       FROM block) AS text_bytes`,
          )
          .get() as { fts_rows: number; text_bytes: number })
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
