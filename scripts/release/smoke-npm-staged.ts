#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { capture, chomp, fail, lastLine, log, requireEnv, runChecked, runMain } from "./actions.ts";
import { packageName } from "./npm.ts";

export function launcherVersionProblem(
  launcher: string,
  reported: string,
  version: string,
): string | null {
  return reported.includes(version)
    ? null
    : `staged launcher ${launcher} reported '${reported}', expected version ${version}`;
}

function npmPack(packageDir: string): string {
  return lastLine(capture("npm", ["pack", "--silent"], { cwd: packageDir }));
}

function main(): void {
  const version = requireEnv("VERSION");
  const platformDir = resolve("dist/npm/decant-linux-x64");
  const launcherDir = resolve("dist/npm/decant");

  const platformTgz = npmPack(platformDir);
  const launcher = packageName(launcherDir);
  const launcherTgz = npmPack(launcherDir);
  const smokeDir = mkdtempSync(join(tmpdir(), "decant-npm-smoke-"));
  try {
    capture("npm", ["init", "-y"], { cwd: smokeDir });
    runChecked(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(platformDir, platformTgz),
        join(launcherDir, launcherTgz),
      ],
      { cwd: smokeDir },
    );
    const reported = chomp(
      capture("node", [join("node_modules", launcher, "bin", "decant.cjs"), "--version"], {
        cwd: smokeDir,
        env: { DECANT_BINARY_PATH: undefined },
      }),
    );
    log(`staged launcher ${launcher} reports: ${reported}`);
    const problem = launcherVersionProblem(launcher, reported, version);
    if (problem != null) {
      fail(problem);
    }
  } finally {
    rmSync(smokeDir, { recursive: true, force: true });
    rmSync(join(launcherDir, launcherTgz), { force: true });
    rmSync(join(platformDir, platformTgz), { force: true });
  }
}

if (import.meta.main) {
  runMain(main);
}
