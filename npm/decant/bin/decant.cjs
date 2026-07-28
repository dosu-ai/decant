#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { constants: osConstants } = require("node:os");
const { dirname, join } = require("node:path");
const targetsMetadata = require("../targets.json");

const overrideEnvVar = "DECANT_BINARY_PATH";
const supportedTargets = targetsMetadata.targets;

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function targetForPlatform(platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch);
  return supportedTargets.find((target) => target.key === key) ?? null;
}

function supportedTargetList() {
  return supportedTargets.map((target) => `${target.platform}/${target.arch}`).join(", ");
}

function resolveBinary(options = {}) {
  const env = options.env ?? process.env;
  const overridePath = env[overrideEnvVar];
  if (overridePath != null && overridePath !== "") {
    if (!existsSync(overridePath)) {
      throw new Error(`${overrideEnvVar} points to a missing file: ${overridePath}`);
    }
    return { binary: overridePath, source: overrideEnvVar, target: null };
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = targetForPlatform(platform, arch);
  if (target == null) {
    throw new Error(
      `Decant does not ship a binary for ${platform}/${arch}. Supported targets: ${supportedTargetList()}.`,
    );
  }

  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${target.package}/package.json`, {
      paths: [__dirname],
    });
  } catch (error) {
    throw new Error(
      `Could not find ${target.package}. Reinstall @dosu/decant with optional dependencies enabled.`,
      { cause: error },
    );
  }

  const packageRoot = dirname(packageJsonPath);
  const binary = join(packageRoot, target.binary);
  if (!existsSync(binary)) {
    throw new Error(`Installed package ${target.package} is missing ${target.binary}.`);
  }
  return { binary, source: target.package, target };
}

function run(argv = process.argv.slice(2), options = {}) {
  const resolved = resolveBinary(options);
  const result = (options.spawnSync ?? spawnSync)(resolved.binary, argv, {
    stdio: options.stdio ?? "inherit",
  });
  if (result.error != null) {
    throw result.error;
  }
  if (result.signal != null) {
    return signalExitCode(result.signal);
  }
  return result.status ?? 1;
}

function signalExitCode(signal) {
  const signalNumber = osConstants.signals?.[signal];
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

function main() {
  try {
    process.exitCode = run();
  } catch (error) {
    process.stderr.write(`decant: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  overrideEnvVar,
  platformKey,
  resolveBinary,
  run,
  signalExitCode,
  supportedTargets,
  supportedTargetList,
  targetForPlatform,
};

if (require.main === module) {
  main();
}
