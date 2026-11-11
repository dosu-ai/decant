import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";

/** A FIFO with no writer: a plain read of it blocks inside the syscall, as a
 * read does in a folder macOS is still asking permission for. */
export function makeFifo(path: string): string {
  const made = spawnSync("mkfifo", [path]);
  if (made.status !== 0) {
    throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
  }
  return path;
}

/** Lets a read that is blocked on the FIFO return, so its thread can end.
 * Without a blocked reader the open fails and there is nothing to release. */
export function releaseFifo(path: string): void {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {
    // No reader is waiting.
  }
}

/** Runs one probe in its own process. A regression blocks inside a syscall,
 * which no in-process test timeout can interrupt, so the child is killed
 * instead and the result is null. */
export function runProbeChild(mode: string, args: readonly string[]): unknown {
  const child = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "stalled-directory-child.ts"), mode, ...args],
    { timeout: 30_000, stdout: "pipe", stderr: "pipe" },
  );
  if (child.exitCode !== 0) {
    return null;
  }
  return JSON.parse(child.stdout.toString());
}
