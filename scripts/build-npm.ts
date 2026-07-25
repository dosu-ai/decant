#!/usr/bin/env bun
import {
  parseDistributionArgs,
  readTargets,
  selectTargets,
  stageNpmPackages,
  targetKeys,
} from "./distribution.ts";

try {
  const args = parseDistributionArgs(process.argv.slice(2), {
    target: "all",
    outDir: "dist/npm",
    binaryDir: "dist/bin",
    buildMissing: true,
  });
  const allTargets = readTargets();
  const targets = selectTargets(args.target, allTargets);
  const outDir = stageNpmPackages({
    outDir: args.outDir,
    binaryDir: args.binaryDir,
    targets,
    buildMissing: args.buildMissing,
    clean: args.clean,
    version: args.version,
  });
  process.stdout.write(
    `staged launcher plus ${targets.length} platform package${targets.length === 1 ? "" : "s"} in ${outDir}\n`,
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\nSupported targets: all | native | ${targetKeys()}\n`,
  );
  process.exitCode = 1;
}
