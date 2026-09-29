import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export type Env = Record<string, string | undefined>;

export interface CommandOptions {
  cwd?: string;
  env?: Env;
}

/** A release gate failed; reported as an `::error::` annotation. */
export class ReleaseFailure extends Error {}

/** A child command exited non-zero; its own output already explains why. */
export class CommandFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function fail(message: string): never {
  throw new ReleaseFailure(message);
}

export function formatAnnotation(kind: "error" | "warning" | "notice", message: string): string {
  const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::${kind}::${escaped}`;
}

export function error(message: string): void {
  log(formatAnnotation("error", message));
}

export function warning(message: string): void {
  log(formatAnnotation("warning", message));
}

export function notice(message: string): void {
  log(formatAnnotation("notice", message));
}

export function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function requireEnv(name: string, env: Env = process.env): string {
  const value = env[name];
  if (value == null || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

export function setOutput(name: string, value: string, file = process.env.GITHUB_OUTPUT): void {
  appendCommandFile(file, `${name}=${value}`);
}

export function addPath(dir: string, file = process.env.GITHUB_PATH): void {
  appendCommandFile(file, dir);
}

// Outside Actions there is no command file, so local runs print what CI would record.
function appendCommandFile(file: string | undefined, line: string): void {
  if (line.includes("\n") || line.includes("\r")) {
    throw new Error(`refusing to write a multi-line value to a command file: ${line}`);
  }
  if (file == null || file === "") {
    log(line);
    return;
  }
  appendFileSync(file, `${line}\n`);
}

function childEnv(env: Env | undefined): NodeJS.ProcessEnv {
  const merged: Env = { ...process.env, ...env };
  for (const [key, value] of Object.entries(merged)) {
    if (value == null) {
      delete merged[key];
    }
  }
  return merged as NodeJS.ProcessEnv;
}

function describe(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export function run(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): number {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    stdio: "inherit",
  });
  if (result.error != null) {
    throw result.error;
  }
  return result.status ?? 1;
}

export function runQuiet(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): number {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    stdio: "ignore",
  });
  if (result.error != null) {
    throw result.error;
  }
  return result.status ?? 1;
}

export function runChecked(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): void {
  const status = run(command, args, options);
  if (status !== 0) {
    throw new CommandFailure(`${describe(command, args)} exited with status ${status}`, status);
  }
}

export function capture(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error != null) {
    throw result.error;
  }
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new CommandFailure(`${describe(command, args)} exited with status ${status}`, status);
  }
  return result.stdout;
}

/**
 * Runs a command and returns its stdout followed by its stderr. The streams are
 * read from separate pipes, so unlike `2>&1` their relative order is lost;
 * callers may search the combined text but must not depend on line order.
 */
export function captureMerged(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): { status: number; output: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error != null) {
    throw result.error;
  }
  return { status: result.status ?? 1, output: result.stdout + result.stderr };
}

/** Strips trailing newlines the way shell command substitution does. */
export function chomp(text: string): string {
  return text.replace(/\n+$/, "");
}

export function lastLine(text: string): string {
  return chomp(text).split("\n").at(-1) ?? "";
}

export function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  attempt: (index: number) => boolean | Promise<boolean>;
  onFailure: (index: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Retries `attempt` and waits `delayMs` after every failure, including the last. */
export async function retry(options: RetryOptions): Promise<boolean> {
  const wait = options.sleep ?? sleep;
  for (let index = 1; index <= options.attempts; index++) {
    if (await options.attempt(index)) {
      return true;
    }
    options.onFailure(index);
    await wait(options.delayMs);
  }
  return false;
}

export function runMain(main: () => void | Promise<void>): void {
  Promise.resolve()
    .then(main)
    .catch((cause: unknown) => {
      if (cause instanceof ReleaseFailure) {
        error(cause.message);
        process.exitCode = 1;
      } else if (cause instanceof CommandFailure) {
        process.stderr.write(`${cause.message}\n`);
        process.exitCode = cause.status;
      } else {
        process.stderr.write(
          `${cause instanceof Error ? (cause.stack ?? cause.message) : cause}\n`,
        );
        process.exitCode = 1;
      }
    });
}
