import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  test("keeps source development startup direct and dependency installation explicit", () => {
    const root = join(import.meta.dir, "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.dev).toBe("bun run src/cli.ts serve");
    expect(pkg.scripts?.up).toBeUndefined();
    expect(existsSync(join(root, "scripts", "dev.ts"))).toBe(false);
  });

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
      expect(platform.version).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("docker image", () => {
  test("bakes in no trusted peer allowlist", () => {
    const dockerfile = readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8");
    // The archive is served without credentials, so a pre-set peer address or
    // CIDR hands it to every host that matches. Both `ENV KEY=value` and the
    // legacy `ENV KEY value` form count.
    expect(dockerfile).not.toMatch(/^\s*ENV\s+DECANT_TRUSTED_PEERS[\s=]/m);
    // The image opts into deriving one address instead, never a range.
    expect(dockerfile).toMatch(/^ENV DECANT_TRUST_DEFAULT_GATEWAY=1$/m);
  });
});
