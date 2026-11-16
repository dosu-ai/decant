import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";

export function makeFifo(path: string): string {
  const made = spawnSync("mkfifo", [path]);
  if (made.status !== 0) {
    throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
  }
  return path;
}

export function releaseFifo(path: string): void {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {}
}

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
