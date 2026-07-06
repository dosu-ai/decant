import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTargetArgs,
  packageDirName,
  parseDistributionArgs,
  readTargets,
  selectTargets,
  stageNpmPackages,
  targetKeys,
} from "../scripts/distribution.ts";

describe("distribution helpers", () => {
  test("loads the npm binary target matrix", () => {
    const targets = readTargets();
    expect(targets.map((target) => target.key)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
    expect(targets.map(packageDirName)).toEqual([
      "decant-darwin-arm64",
      "decant-darwin-x64",
      "decant-linux-arm64",
      "decant-linux-x64",
    ]);
    expect(targetKeys(targets)).toBe("darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64");
  });

  test("selects all targets or one named target", () => {
    const targets = readTargets();
    expect(selectTargets("all", targets)).toHaveLength(4);
    expect(selectTargets("linux-x64", targets).map((target) => target.package)).toEqual([
      "@dosu/decant-linux-x64",
    ]);
    expect(() => selectTargets("windows-x64", targets)).toThrow(/unknown target/);
  });

  test("parses build arguments", () => {
    expect(
      parseDistributionArgs([
        "--target",
        "native",
        "--out-dir",
        "/tmp/npm",
        "--binary-dir",
        "/tmp/bin",
        "--no-build",
        "--clean",
      ]),
    ).toEqual({
      target: "native",
      outDir: "/tmp/npm",
      binaryDir: "/tmp/bin",
      buildMissing: false,
      clean: true,
      version: undefined,
    });
    expect(parseDistributionArgs(["--version", "1.2.3"]).version).toBe("1.2.3");
  });

  test("passes release version through Bun env inlining for compiled binaries", () => {
    const target = selectTargets("linux-x64")[0];
    if (target == null) {
      throw new Error("missing linux-x64 target");
    }
    expect(buildTargetArgs(target, "/tmp/decant")).toEqual([
      "build",
      "--compile",
      "--target",
      "bun-linux-x64",
      "src/cli.ts",
      "--outfile",
      "/tmp/decant",
    ]);
    expect(buildTargetArgs(target, "/tmp/decant", "1.2.3")).toEqual([
      "build",
      "--compile",
      "--target",
      "bun-linux-x64",
      "--env=DECANT_BUILD_VERSION*",
      "src/cli.ts",
      "--outfile",
      "/tmp/decant",
    ]);
  });

  test("stamps staged npm packages to one release version", async () => {
    const root = mkdtempSync(join(tmpdir(), "decant-npm-stage-test-"));
    try {
      const target = selectTargets("linux-x64")[0];
      if (target == null) {
        throw new Error("missing linux-x64 target");
      }
      const binaryDir = join(root, "bin");
      mkdirSync(join(binaryDir, target.key), { recursive: true });
      writeFileSync(join(binaryDir, target.key, "decant"), "#!/bin/sh\n");

      const outDir = stageNpmPackages({
        outDir: join(root, "npm"),
        binaryDir,
        targets: [target],
        buildMissing: false,
        clean: true,
        version: "1.2.3",
      });
      const launcher = await Bun.file(join(outDir, "decant", "package.json")).json();
      const platform = await Bun.file(join(outDir, "decant-linux-x64", "package.json")).json();
      expect(launcher.version).toBe("1.2.3");
      expect(launcher.optionalDependencies).toEqual({ "@dosu/decant-linux-x64": "1.2.3" });
      expect(launcher.files).toEqual([
        "bin/decant.cjs",
        "targets.json",
        "README.md",
        "LICENSE",
        "NOTICE",
      ]);
      for (const file of ["README.md", "LICENSE", "NOTICE"]) {
        expect(existsSync(join(outDir, "decant", file)), `launcher ${file}`).toBe(true);
      }
      expect(platform.version).toBe("1.2.3");
      expect(platform.files).toEqual(["bin/decant", "README.md", "LICENSE", "NOTICE"]);
      for (const file of ["README.md", "LICENSE", "NOTICE"]) {
        expect(existsSync(join(outDir, "decant-linux-x64", file)), `platform ${file}`).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
