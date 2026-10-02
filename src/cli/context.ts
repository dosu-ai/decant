import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { type Config, type ConfigOverrides, resolveConfig } from "../config.ts";
import { ARCHIVE_DIR_MODE, closeDb, openDb } from "../db.ts";
import { sync as ingestSync } from "../ingest.ts";
import type { OutputFormat } from "./parse.ts";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string | null;
  liveOutput?: boolean;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
}

export interface GlobalOptions {
  db?: string;
  json?: boolean;
  format?: OutputFormat;
  quiet?: boolean;
  sync?: boolean;
  color?: boolean;
}

export interface Io {
  stdout: string;
  stderr: string;
  writeOut(value: string): void;
  writeErr(value: string): void;
}

export interface Archive {
  db: ReturnType<typeof openDb>;
  config: Config;
}

// biome-ignore lint/suspicious/noConfusingVoidType: block-bodied actions without a return infer void, not undefined
export type CliAction = () => number | void | Promise<number | void>;

export interface WithArchiveOptions {
  overrides?: Partial<ConfigOverrides>;
  /** Sync the source directories first, unless `--no-sync` or `DECANT_NO_SYNC` say not to. */
  sync?: boolean;
}

export interface CliContext {
  program: Command;
  io: Io;
  env: Record<string, string | undefined> | undefined;
  globals(): GlobalOptions;
  isJson(): boolean;
  shouldSync(): boolean;
  resolve(overrides?: Partial<ConfigOverrides>): Config;
  writeJson(value: unknown): void;
  output(value: unknown, renderHuman: () => string): void;
  run(action: CliAction): Promise<void>;
  withArchive<T>(fn: (archive: Archive) => T, options?: WithArchiveOptions): T;
}

export function isJsonOutput(options: GlobalOptions): boolean {
  return options.json === true || options.format === "json";
}

export function shouldSyncOnRead(
  options: GlobalOptions,
  env: Record<string, string | undefined> | undefined,
): boolean {
  return options.sync !== false && (env ?? process.env).DECANT_NO_SYNC == null;
}

export function openArchive(config: Config): Archive {
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: ARCHIVE_DIR_MODE });
  const db = openDb(config.dbPath);
  return { db, config };
}

export function createContext(
  program: Command,
  io: Io,
  options: CliRunOptions,
  setCode: (value: number) => void,
): CliContext {
  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const ctx: CliContext = {
    program,
    io,
    env: options.env,
    globals,
    isJson: () => isJsonOutput(globals()),
    shouldSync: () => shouldSyncOnRead(globals(), options.env),
    resolve: (overrides = {}) =>
      resolveConfig({
        dbPath: globals().db,
        env: options.env,
        homeDir: options.homeDir,
        ...overrides,
      }),
    writeJson: (value) => {
      io.writeOut(`${JSON.stringify(value, null, 2)}\n`);
    },
    output: (value, renderHuman) => {
      if (ctx.isJson()) {
        ctx.writeJson(value);
      } else {
        io.writeOut(renderHuman());
      }
    },
    run: async (action) => {
      try {
        setCode((await action()) ?? 0);
      } catch (error) {
        io.writeErr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        setCode(1);
      }
    },
    withArchive: (fn, archiveOptions = {}) => {
      const archive = openArchive(ctx.resolve(archiveOptions.overrides));
      try {
        if (archiveOptions.sync === true && ctx.shouldSync()) {
          ingestSync(archive.db, archive.config);
        }
        return fn(archive);
      } finally {
        closeDb(archive.db);
      }
    },
  };
  return ctx;
}
