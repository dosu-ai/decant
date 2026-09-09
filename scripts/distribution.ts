import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface DistributionTarget {
  key: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  package: string;
  binary: string;
  bunTarget: string;
}

export interface BuildOptions {
  root?: string;
  outDir?: string;
  version?: string;
}

export interface StageOptions {
  root?: string;
  outDir?: string;
  binaryDir?: string;
  targets?: DistributionTarget[];
  buildMissing?: boolean;
  clean?: boolean;
  version?: string;
}

export const repoRoot = resolve(import.meta.dir, "..");

export function readTargets(root = repoRoot): DistributionTarget[] {
  const metadata = JSON.parse(
    readFileSync(join(root, "npm", "decant", "targets.json"), "utf8"),
  ) as {
    targets: DistributionTarget[];
  };
  return metadata.targets;
}

export function nativeTarget(targets = readTargets()): DistributionTarget | null {
  const key = `${process.platform}-${process.arch}`;
  return targets.find((target) => target.key === key) ?? null;
}

export function selectTargets(selector: string, targets = readTargets()): DistributionTarget[] {
  if (selector === "all") {
    return targets;
  }
  if (selector === "native") {
    const target = nativeTarget(targets);
    if (target == null) {
      throw new Error(`unsupported native target ${process.platform}/${process.arch}`);
    }
    return [target];
  }
  const target = targets.find((candidate) => candidate.key === selector);
  if (target == null) {
    throw new Error(
      `unknown target ${JSON.stringify(selector)} (expected: all | native | ${targetKeys(targets)})`,
    );
  }
  return [target];
}

export function targetKeys(targets = readTargets()): string {
  return targets.map((target) => target.key).join(" | ");
}

export function packageDirName(target: DistributionTarget): string {
  return target.package.replace("@dosu/", "");
}

export function binaryOutputPath(target: DistributionTarget, options: BuildOptions = {}): string {
  return join(
    resolve(options.root ?? repoRoot, options.outDir ?? "dist/bin"),
    target.key,
    "decant",
  );
}

export function buildTarget(target: DistributionTarget, options: BuildOptions = {}): string {
  const root = options.root ?? repoRoot;
  const outPath = binaryOutputPath(target, { root, outDir: options.outDir });
  mkdirSync(dirname(outPath), { recursive: true });
  const result = spawnSync("bun", buildTargetArgs(target, outPath, options.version), {
    cwd: root,
    env:
      options.version == null
        ? process.env
        : { ...process.env, DECANT_BUILD_VERSION: options.version },
    stdio: "inherit",
  });
  if (result.error != null) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`bun build failed for ${target.key} with status ${result.status ?? 1}`);
  }
  chmodSync(outPath, 0o755);
  return outPath;
}

export function buildTargetArgs(
  target: DistributionTarget,
  outPath: string,
  version?: string,
): string[] {
  // --minify halves the UI bundle the embedded server hands the browser, from
  // 6,211,618 bytes to 3,211,476 measured by fetching it from each binary. Bun
  // does not split chunks in a compiled binary (see test/ui-lazy-echarts.test.ts),
  // so echarts ships either way and the only lever on how much JavaScript the
  // browser parses on first load is how densely it is written.
  //
  // Only the shipped binary. Running from source stays unminified, because dev
  // wants fast rebuilds and legible output far more than it wants small bytes.
  //
  // What this costs: src/logging.ts emits `exception.stacktrace` for unexpected
  // errors, and mangled identifiers make that field much less useful in a bug
  // report. `exception.type` is unaffected, because every custom error class
  // assigns `this.name` from a string literal.
  //
  // DO NOT ADD --sourcemap TO RECOVER THOSE NAMES. It breaks the compiled binary.
  // The server answers /api/openapi.json and POST /api/sync, then dies before the
  // next request, and scripts/dist-check.ts fails with ConnectionRefused on
  // /api/analytics/token-economics. Reproduced 2 of 2 with the flag and 2 of 2
  // without, both with and without --minify, so it is --sourcemap on its own.
  // Bun 1.3.14.
  const args = ["build", "--compile", "--minify", "--target", target.bunTarget];
  if (version != null) {
    args.push("--env=DECANT_BUILD_VERSION*");
  }
  // Bun does not infer Worker entrypoints for standalone executables. Each
  // worker must be listed explicitly so its module is embedded alongside the
  // CLI entrypoint instead of being resolved from the runtime filesystem.
  args.push("src/cli.ts", "src/sync-worker.ts", "src/stats-worker.ts", "--outfile", outPath);
  return args;
}

export function stageNpmPackages(options: StageOptions = {}): string {
  const root = options.root ?? repoRoot;
  const outDir = resolve(root, options.outDir ?? "dist/npm");
  const binaryDir = options.binaryDir ?? "dist/bin";
  const targets = options.targets ?? readTargets(root);
  const version = options.version ?? packageVersion(root);
  if (options.clean === true) {
    rmSync(outDir, { recursive: true, force: true });
  }
  stageLauncherPackage(root, outDir, targets, version);
  for (const target of targets) {
    stagePlatformPackage(target, {
      root,
      outDir,
      binaryDir,
      buildMissing: options.buildMissing,
      version,
    });
  }
  return outDir;
}

// One launcher, published scoped. npm refuses the unscoped `decant` as too
// similar to existing packages, and that check runs only at publish time --
// see the npm package naming section in docs/distribution.md before changing
// this.
function stageLauncherPackage(
  root: string,
  outDir: string,
  targets: DistributionTarget[],
  version: string,
): void {
  const source = join(root, "npm", "decant");
  const dest = join(outDir, "decant");
  mkdirSync(join(dest, "bin"), { recursive: true });
  for (const file of ["package.json", "README.md", "targets.json"]) {
    copyFileSync(join(source, file), join(dest, file));
  }
  copyFileSync(join(source, "bin", "decant.cjs"), join(dest, "bin", "decant.cjs"));
  copyFileSync(join(root, "LICENSE"), join(dest, "LICENSE"));
  copyFileSync(join(root, "NOTICE"), join(dest, "NOTICE"));
  rewritePackageJson(join(dest, "package.json"), (pkg) => {
    pkg.version = version;
    pkg.optionalDependencies = Object.fromEntries(
      targets.map((target) => [target.package, version]),
    );
    return pkg;
  });
}

function stagePlatformPackage(
  target: DistributionTarget,
  options: {
    root: string;
    outDir: string;
    binaryDir: string;
    buildMissing?: boolean;
    version: string;
  },
): void {
  const source = join(options.root, "npm", packageDirName(target));
  const dest = join(options.outDir, packageDirName(target));
  const builtBinary = binaryOutputPath(target, { root: options.root, outDir: options.binaryDir });
  if (!existsSync(builtBinary)) {
    if (options.buildMissing === false) {
      throw new Error(`missing compiled binary for ${target.key}: ${builtBinary}`);
    }
    buildTarget(target, {
      root: options.root,
      outDir: options.binaryDir,
      version: options.version,
    });
  }

  mkdirSync(join(dest, dirname(target.binary)), { recursive: true });
  for (const file of ["package.json", "README.md"]) {
    copyFileSync(join(source, file), join(dest, file));
  }
  for (const file of ["LICENSE", "NOTICE"]) {
    copyFileSync(join(options.root, file), join(dest, file));
  }
  rewritePackageJson(join(dest, "package.json"), (pkg) => {
    pkg.version = options.version;
    return pkg;
  });
  copyFileSync(builtBinary, join(dest, target.binary));
  chmodSync(join(dest, target.binary), 0o755);
}

function packageVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

function rewritePackageJson(
  path: string,
  rewrite: (pkg: Record<string, unknown>) => Record<string, unknown>,
): void {
  const pkg = rewrite(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function parseDistributionArgs(
  args: string[],
  defaults: {
    target?: string;
    outDir?: string;
    binaryDir?: string;
    buildMissing?: boolean;
    version?: string;
  } = {},
): {
  target: string;
  outDir: string;
  binaryDir: string;
  buildMissing: boolean;
  clean: boolean;
  version: string | undefined;
} {
  let target = defaults.target ?? "all";
  let outDir = defaults.outDir ?? "dist/npm";
  let binaryDir = defaults.binaryDir ?? "dist/bin";
  let buildMissing = defaults.buildMissing ?? true;
  let version = defaults.version;
  let clean = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--target":
        index += 1;
        target = requiredValue(args, index, arg);
        break;
      case "--out-dir":
        index += 1;
        outDir = requiredValue(args, index, arg);
        break;
      case "--binary-dir":
        index += 1;
        binaryDir = requiredValue(args, index, arg);
        break;
      case "--build-missing":
        buildMissing = true;
        break;
      case "--no-build":
        buildMissing = false;
        break;
      case "--clean":
        clean = true;
        break;
      case "--version":
        index += 1;
        version = requiredValue(args, index, arg);
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }

  return { target, outDir, binaryDir, buildMissing, clean, version };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value == null || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
