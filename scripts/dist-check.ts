#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTarget,
  nativeTarget,
  packageDirName,
  readTargets,
  stageNpmPackages,
} from "./distribution.ts";

const version = process.env.DECANT_DISTCHECK_VERSION ?? "0.0.0-check";
const isTemporaryRoot = process.env.DECANT_DISTCHECK_DIR == null;
const outRoot = process.env.DECANT_DISTCHECK_DIR ?? mkdtempSync(join(tmpdir(), "decant-check-"));
if (isTemporaryRoot) {
  process.on("exit", () => {
    try {
      rmSync(outRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not mask the distribution check result.
    }
  });
}
const binaryDir = join(outRoot, "bin");
const npmDir = join(outRoot, "npm");
const packDir = join(outRoot, "packs");
const installDir = join(outRoot, "install");
const npmEnv = { npm_config_cache: join(outRoot, "npm-cache") };
const target = nativeTarget(readTargets());

if (target == null) {
  throw new Error(`unsupported native target ${process.platform}/${process.arch}`);
}

const binary = buildTarget(target, { outDir: binaryDir, version });
assertVersion(binary, ["--version"], {}, version);

stageNpmPackages({
  outDir: npmDir,
  binaryDir,
  targets: [target],
  buildMissing: false,
  clean: true,
  version,
});

assertVersion(
  "node",
  [join(npmDir, "decant", "bin", "decant.cjs"), "--version"],
  { DECANT_BINARY_PATH: binary },
  version,
);

mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
const launcherPack = npmPack(join(npmDir, "decant"), packDir);
const platformPack = npmPack(join(npmDir, packageDirName(target)), packDir);
runCommand(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund", launcherPack, platformPack],
  {
    cwd: installDir,
    env: npmEnv,
  },
);
assertVersion(
  "node",
  [join(installDir, "node_modules", "@dosu", "decant", "bin", "decant.cjs"), "--version"],
  { DECANT_BINARY_PATH: undefined },
  version,
);

process.stdout.write(`dist check ok for ${target.key} (${version})\n`);

function npmPack(packageDir: string, packDestination: string): string {
  const result = runCommand("npm", ["pack", packageDir, "--pack-destination", packDestination], {
    env: npmEnv,
  });
  const file = result.stdout.trim().split("\n").at(-1);
  if (file == null || file === "") {
    throw new Error(`npm pack ${packageDir} did not report a tarball`);
  }
  return join(packDestination, file);
}

function assertVersion(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  expected: string,
): void {
  const result = runCommand(command, args, { env });
  if (!result.stdout.includes(expected)) {
    throw new Error(`expected ${expected} in version output, got: ${result.stdout.trim()}`);
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): { stdout: string; stderr: string } {
  const env = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value == null) {
      delete env[key];
    }
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env,
    stdio: "pipe",
  });
  if (result.error != null) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? 1}: ${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}
