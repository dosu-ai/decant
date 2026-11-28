import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import { type Config, type ConfigOverrides, resolveConfig } from "../config.ts";
import { ARCHIVE_DIR_MODE, closeDb, openDb } from "../db.ts";
import { shellQuote } from "../distill.ts";
import { sync as ingestSync } from "../ingest.ts";
import type { ServiceOptions } from "../service.ts";
import type { FetchLike, InstallInfo, UpdateStatus } from "../update.ts";
import {
  CliError,
  EXIT_FAILURE,
  EXIT_USAGE,
  formatCliError,
  fromErrorLine,
  isErrorLine,
  toCliError,
} from "./errors.ts";
import type { OutputFormat } from "./parse.ts";

export const SYNC_NOTICE_AFTER_MS = 1_000;

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
  update?: UpdateDeps;
  service?: ServiceOptions;
  syncNoticeAfterMs?: number;
}

export interface UpdateDeps {
  fetch?: FetchLike;
  install?: InstallInfo;
  current?: string;
  now?: () => Date;
  runCommand?: (argv: string[]) => number;
  installedOnPath?: () => { path: string; version: string | null } | null;
  stderrIsTTY?: boolean;
  bunVersion?: string;
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
  sync?: boolean;
  create?: boolean;
}

export interface CliContext {
  program: Command;
  io: Io;
  env: Record<string, string | undefined> | undefined;
  homeDir: string | null | undefined;
  updateDeps: UpdateDeps;
  serviceOptions: ServiceOptions;
  globals(): GlobalOptions;
  isJson(): boolean;
  shouldSync(): boolean;
  resolve(overrides?: Partial<ConfigOverrides>): Config;
  writeJson(value: unknown): void;
  output(value: unknown, renderHuman: () => string): void;
  run(action: CliAction): Promise<void>;
  fail(error: unknown, json?: boolean): number;
  pendingUpdateNotice: Promise<UpdateStatus> | null;
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
  sink: Io,
  options: CliRunOptions,
  setCode: (value: number) => void,
): CliContext {
  const globals = (): GlobalOptions => program.opts<GlobalOptions>();
  const environment = (): Record<string, string | undefined> => options.env ?? process.env;
  let heldErrorLines: string[] | null = null;
  let wroteResult = false;
  let reportedFailure = false;
  const io: Io = {
    get stdout() {
      return sink.stdout;
    },
    get stderr() {
      return sink.stderr;
    },
    writeOut: (value) => {
      wroteResult = true;
      sink.writeOut(value);
    },
    writeErr: (value) => {
      if (heldErrorLines != null && isErrorLine(value)) {
        heldErrorLines.push(value);
      } else {
        sink.writeErr(value);
      }
    },
  };
  const explicitArchive = (): "--db" | "DECANT_DB" | null => {
    if (globals().db != null) {
      return "--db";
    }
    return environment().DECANT_DB != null ? "DECANT_DB" : null;
  };
  const syncBeforeRead = (archive: Archive): void => {
    if (globals().quiet === true) {
      ingestSync(archive.db, archive.config);
      return;
    }
    const wait = options.syncNoticeAfterMs ?? SYNC_NOTICE_AFTER_MS;
    const startedAt = Date.now();
    let announced = false;
    ingestSync(archive.db, archive.config, undefined, (progress) => {
      if (announced || Date.now() - startedAt < wait) {
        return;
      }
      announced = true;
      sink.writeErr(
        `note: syncing session logs before this command, ${progress.scanned} of ` +
          `${progress.total} files checked so far. Pass --no-sync to skip the sync.\n`,
      );
    });
  };
  const ctx: CliContext = {
    program,
    io,
    env: options.env,
    homeDir: options.homeDir,
    updateDeps: options.update ?? {},
    serviceOptions: { env: options.env, homeDir: options.homeDir, ...options.service },
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
        const text = renderHuman();
        io.writeOut(text === "" || text.endsWith("\n") ? text : `${text}\n`);
      }
    },
    pendingUpdateNotice: null,
    fail: (error, json = ctx.isJson()) => {
      const failure = toCliError(error);
      reportedFailure = true;
      sink.writeErr(formatCliError(failure, json));
      return failure.exitCode;
    },
    run: async (action) => {
      heldErrorLines = ctx.isJson() ? [] : null;
      wroteResult = false;
      reportedFailure = false;
      let code: number;
      try {
        code = (await action()) ?? 0;
      } catch (error) {
        code = ctx.fail(error);
      }
      const held = heldErrorLines ?? [];
      heldErrorLines = null;
      if (held.length > 0) {
        if (code === 0) {
          sink.writeErr(held.join(""));
        } else {
          ctx.fail(fromErrorLine(held.join(""), code));
        }
      }
      const silent = !reportedFailure && !wroteResult;
      if (ctx.isJson() && silent && (code === EXIT_FAILURE || code === EXIT_USAGE)) {
        ctx.fail(
          new CliError(
            code === EXIT_USAGE ? "usage_error" : "command_failed",
            `the command exited with code ${code}`,
            code,
          ),
        );
      }
      setCode(code);
    },
    withArchive: (fn, archiveOptions = {}) => {
      const config = ctx.resolve(archiveOptions.overrides);
      const source = explicitArchive();
      if (source != null && archiveOptions.create !== true && !existsSync(config.dbPath)) {
        throw new CliError(
          "archive_not_found",
          `no Decant archive at ${config.dbPath} (from ${source}). Check the path, or create ` +
            `the archive with: decant --db ${shellQuote(config.dbPath)} sync`,
          1,
          { path: config.dbPath },
        );
      }
      let archive: Archive;
      try {
        archive = openArchive(config);
      } catch (error) {
        const failure = toCliError(error);
        throw failure.code === "command_failed"
          ? new CliError(
              "archive_unreadable",
              `cannot open the archive at ${config.dbPath}: ${failure.message}`,
              1,
              { path: config.dbPath },
            )
          : failure;
      }
      try {
        if (archiveOptions.sync === true && ctx.shouldSync()) {
          syncBeforeRead(archive);
        }
        return fn(archive);
      } finally {
        closeDb(archive.db);
      }
    },
  };
  return ctx;
}
