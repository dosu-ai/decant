import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseFailure } from "../scripts/release/actions.ts";
import { missingLicenseFile, stagedPackageDirs } from "../scripts/release/assert-npm-packages.ts";
import { ghcrVisibility, manifestUrl } from "../scripts/release/check-ghcr-public.ts";
import { npxArgs, waitForNpx } from "../scripts/release/npx-smoke.ts";
import {
  attestationBundleName,
  ghReleaseArgs,
  type ReleasePlan,
} from "../scripts/release/publish-github-release.ts";
import { publishArgs, publishPackages } from "../scripts/release/publish-npm.ts";
import { launcherVersionProblem } from "../scripts/release/smoke-npm-staged.ts";

let stdout: Mock<typeof process.stdout.write>;

beforeEach(() => {
  stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdout.mockRestore();
});

describe("npm package assertions", () => {
  test("lists staged package directories in glob order", () => {
    const root = mkdtempSync(join(tmpdir(), "decant-release-npm-"));
    try {
      for (const name of ["decant-linux-x64", "decant", ".cache"]) {
        mkdirSync(join(root, name));
      }
      writeFileSync(join(root, "README"), "");
      expect(stagedPackageDirs(root)).toEqual([`${root}/decant/`, `${root}/decant-linux-x64/`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports the first package missing LICENSE or NOTICE", () => {
    const present = new Set(["dist/npm/decant/LICENSE", "dist/npm/decant/NOTICE"]);
    const isFile = (path: string) => present.has(path);
    expect(missingLicenseFile(["dist/npm/decant/"], isFile)).toBeNull();
    expect(missingLicenseFile(["dist/npm/decant/", "dist/npm/decant-darwin-x64/"], isFile)).toBe(
      "LICENSE missing from staged package dist/npm/decant-darwin-x64/ (Apache-2.0 §4(d))",
    );
    present.add("dist/npm/decant-darwin-x64/LICENSE");
    expect(missingLicenseFile(["dist/npm/decant-darwin-x64/"], isFile)).toBe(
      "NOTICE missing from staged package dist/npm/decant-darwin-x64/ (Apache-2.0 §4(d))",
    );
  });

  test("requires the staged launcher to report the release version", () => {
    expect(launcherVersionProblem("@dosu/decant", "decant 1.2.3", "1.2.3")).toBeNull();
    expect(launcherVersionProblem("@dosu/decant", "decant 1.2.2", "1.2.3")).toBe(
      "staged launcher @dosu/decant reported 'decant 1.2.2', expected version 1.2.3",
    );
  });
});

describe("npm publishing", () => {
  test("passes npm an explicit latest tag with public access and provenance", () => {
    expect(publishArgs("decant")).toEqual([
      "publish",
      "dist/npm/decant",
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
    ]);
  });

  test("publishes platform packages before the launcher and skips published versions", () => {
    const published: string[][] = [];
    const notices: string[] = [];
    publishPackages("1.2.3-beta.1", {
      packageName: (dir) => `@dosu/${dir.replace("dist/npm/", "")}`,
      isPublished: (spec) => spec === "@dosu/decant-darwin-x64@1.2.3-beta.1",
      publish: (args) => published.push(args),
      notice: (message) => notices.push(message),
    });
    expect(notices).toEqual([
      "@dosu/decant-darwin-x64@1.2.3-beta.1 already published — skipping (idempotent re-run)",
    ]);
    expect(published.map((args) => args[1])).toEqual([
      "dist/npm/decant-darwin-arm64",
      "dist/npm/decant-linux-arm64",
      "dist/npm/decant-linux-x64",
      "dist/npm/decant",
    ]);
    expect(published[0]).toEqual([
      "publish",
      "dist/npm/decant-darwin-arm64",
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
    ]);
  });

  test("polls npm exec until the published launcher runs", async () => {
    expect(npxArgs("1.2.3")).toEqual([
      "exec",
      "--yes",
      "--prefer-online",
      "@dosu/decant@1.2.3",
      "--",
      "--version",
    ]);
    const sleeps: number[] = [];
    let calls = 0;
    await waitForNpx({
      version: "1.2.3",
      exec: () => ++calls === 3,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([30_000, 30_000]);
    expect(stdout.mock.calls.map((call) => String(call[0]))).toEqual([
      "attempt 1/20: @dosu/decant@1.2.3 not resolvable yet — waiting for registry propagation\n",
      "attempt 2/20: @dosu/decant@1.2.3 not resolvable yet — waiting for registry propagation\n",
    ]);
  });

  test("fails after twenty unresolvable attempts", async () => {
    let calls = 0;
    await expect(
      waitForNpx({
        version: "1.2.3",
        exec: () => {
          calls++;
          return false;
        },
        sleep: async () => {},
      }),
    ).rejects.toThrow(
      new ReleaseFailure("@dosu/decant@1.2.3 never became runnable via npm exec after 10 minutes"),
    );
    expect(calls).toBe(20);
  });
});

describe("GitHub Release publishing", () => {
  const plan: ReleasePlan = {
    tag: "v1.2.3",
    tarballs: ["decant-darwin-arm64.tar.gz", "decant-linux-x64.tar.gz"],
    bundle: attestationBundleName("v1.2.3"),
  };
  const assets = [
    "./decant-darwin-arm64.tar.gz",
    "./decant-linux-x64.tar.gz",
    "decant-1.2.3.sigstore.json",
    "SHA256SUMS",
    "install.sh",
  ];

  test("creates every release as latest with generated notes", () => {
    expect(ghReleaseArgs(plan, false)).toEqual([
      "release",
      "create",
      "--verify-tag",
      "--generate-notes",
      "--latest",
      "--",
      "v1.2.3",
      ...assets,
    ]);
    const beta = { ...plan, tag: "v1.2.3-beta.1", bundle: attestationBundleName("v1.2.3-beta.1") };
    expect(ghReleaseArgs(beta, false).slice(2, 8)).toEqual([
      "--verify-tag",
      "--generate-notes",
      "--latest",
      "--",
      "v1.2.3-beta.1",
      "./decant-darwin-arm64.tar.gz",
    ]);
    expect(beta.bundle).toBe("decant-1.2.3-beta.1.sigstore.json");
  });

  test("refreshes assets on an existing release instead of recreating it", () => {
    expect(ghReleaseArgs(plan, true)).toEqual([
      "release",
      "upload",
      "--clobber",
      "--",
      "v1.2.3",
      ...assets,
    ]);
  });
});

describe("GHCR visibility check", () => {
  test("warns with the one-time fix when anonymous pulls fail", () => {
    expect(manifestUrl("1.2.3")).toBe("https://ghcr.io/v2/dosu-ai/decant/manifests/1.2.3");
    expect(ghcrVisibility(200, "1.2.3")).toEqual({
      public: true,
      message: "anonymous pull works (HTTP 200) — package is public",
    });
    const denied = ghcrVisibility(401, "1.2.3");
    expect(denied.public).toBe(false);
    expect(denied.message).toStartWith(
      "ghcr.io/dosu-ai/decant:1.2.3 is not anonymously pullable (HTTP 401). A GHCR package is private on first push",
    );
  });
});
