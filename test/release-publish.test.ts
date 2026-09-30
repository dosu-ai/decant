import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseFailure } from "../scripts/release/actions.ts";
import { missingLicenseFile, stagedPackageDirs } from "../scripts/release/assert-npm-packages.ts";
import { ghcrVisibility, manifestUrl } from "../scripts/release/check-ghcr-public.ts";
import type { ReleaseChannel } from "../scripts/release/meta.ts";
import { npxArgs, npxCacheDir, waitForNpx } from "../scripts/release/npx-smoke.ts";
import {
  attestationBundleName,
  ghChannelFlags,
  ghReleaseArgs,
  type ReleasePlan,
} from "../scripts/release/publish-github-release.ts";
import {
  type NpmDistTag,
  npmDistTag,
  publishArgs,
  publishPackages,
} from "../scripts/release/publish-npm.ts";

import { launcherVersionProblem } from "../scripts/release/smoke-npm-staged.ts";

const LATEST: ReleaseChannel = { isPrerelease: false, isLatest: true };
const BACKPORT: ReleaseChannel = { isPrerelease: false, isLatest: false };
const PRERELEASE: ReleaseChannel = { isPrerelease: true, isLatest: false };

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
  test("maps the release channel to next, latest or previous", () => {
    expect(npmDistTag(LATEST)).toBe("latest");
    expect(npmDistTag(BACKPORT)).toBe("previous");
    expect(npmDistTag(PRERELEASE)).toBe("next");
  });

  test("passes npm an explicit dist-tag with public access and provenance", () => {
    expect(publishArgs("decant", "latest")).toEqual([
      "publish",
      "dist/npm/decant",
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
    ]);
    expect(publishArgs("decant", "next")).toContain("next");
    expect(() => publishArgs("decant", "beta" as NpmDistTag)).toThrow(
      "npm dist-tag must be one of next, latest, previous, got 'beta'",
    );
  });

  test("publishes platform packages before the launcher and skips published versions", () => {
    const published: string[][] = [];
    const notices: string[] = [];
    publishPackages("1.2.3-beta.1", "next", {
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
      "next",
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

  test("gives every attempt its own npm cache", async () => {
    const attempts: number[] = [];
    await waitForNpx({
      version: "1.2.3",
      exec: (attempt) => {
        attempts.push(attempt);
        return attempt === 3;
      },
      sleep: async () => {},
    });
    expect(attempts).toEqual([1, 2, 3]);
    const dirs = attempts.map((attempt) => npxCacheDir("/tmp/smoke", attempt));
    expect(new Set(dirs).size).toBe(3);
    expect(dirs[0]).toBe("/tmp/smoke/npm-cache-1");
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

  test("marks only the highest stable release latest", () => {
    expect(ghChannelFlags(LATEST)).toEqual(["--latest"]);
    expect(ghChannelFlags(BACKPORT)).toEqual(["--latest=false"]);
    expect(ghChannelFlags(PRERELEASE)).toEqual(["--prerelease", "--latest=false"]);
  });

  test("creates a release with generated notes and its channel flags", () => {
    expect(ghReleaseArgs(plan, false, LATEST)).toEqual([
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
    expect(ghReleaseArgs(beta, false, PRERELEASE).slice(2, 9)).toEqual([
      "--verify-tag",
      "--generate-notes",
      "--prerelease",
      "--latest=false",
      "--",
      "v1.2.3-beta.1",
      "./decant-darwin-arm64.tar.gz",
    ]);
    expect(beta.bundle).toBe("decant-1.2.3-beta.1.sigstore.json");
  });

  test("refreshes assets on an existing release instead of recreating it", () => {
    expect(ghReleaseArgs(plan, true, BACKPORT)).toEqual([
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
