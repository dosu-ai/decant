#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail, log, requireEnv, retry, run, runMain } from "./actions.ts";
import { releaseVersion } from "./validate.ts";

export const NPX_ATTEMPTS = 20;
export const NPX_RETRY_DELAY_MS = 30_000;

export function npxArgs(version: string): string[] {
  return ["exec", "--yes", "--prefer-online", `@dosu/decant@${version}`, "--", "--version"];
}

/**
 * npm skips an optional dependency it cannot resolve yet and caches the install
 * without it, so an attempt that sees the launcher before its platform package
 * would poison every retry that shares the cache.
 */
export function npxCacheDir(root: string, attempt: number): string {
  return join(root, `npm-cache-${attempt}`);
}

/** A fresh publish takes a while to reach every registry edge, so polling spans ten minutes. */
export async function waitForNpx(options: {
  version: string;
  exec: (attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { version } = options;
  const runnable = await retry({
    attempts: NPX_ATTEMPTS,
    delayMs: NPX_RETRY_DELAY_MS,
    attempt: (index) => options.exec(index),
    onFailure: (attempt) =>
      log(
        `attempt ${attempt}/${NPX_ATTEMPTS}: @dosu/decant@${version} not resolvable yet — waiting for registry propagation`,
      ),
    sleep: options.sleep,
  });
  if (!runnable) {
    fail(`@dosu/decant@${version} never became runnable via npm exec after 10 minutes`);
  }
}

async function main(): Promise<void> {
  const version = releaseVersion(requireEnv("VERSION"));
  // Outside the checkout, so npm cannot resolve the spec against this repo's own package.json.
  const cwd = mkdtempSync(join(tmpdir(), "decant-npx-smoke-"));
  try {
    await waitForNpx({
      version,
      exec: (attempt) =>
        run("npm", npxArgs(version), {
          cwd,
          env: { npm_config_cache: npxCacheDir(cwd, attempt) },
        }) === 0,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runMain(main);
}
