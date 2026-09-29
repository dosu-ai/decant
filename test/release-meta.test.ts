import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseFailure } from "../scripts/release/actions.ts";
import {
  channelFromEnv,
  compareStableVersions,
  parseReleaseVersion,
  releaseChannel,
  stableVersionsFromLsRemote,
} from "../scripts/release/meta.ts";

const script = join(import.meta.dir, "..", "scripts", "release", "meta.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("release version parsing", () => {
  test("strips one leading v and accepts semver with an optional suffix", () => {
    expect(parseReleaseVersion("v1.2.3")).toEqual({ version: "1.2.3", tag: "v1.2.3" });
    expect(parseReleaseVersion("1.2.3-beta.1")).toEqual({
      version: "1.2.3-beta.1",
      tag: "v1.2.3-beta.1",
    });
    expect(parseReleaseVersion("v0.0.1-alpha-2.x").version).toBe("0.0.1-alpha-2.x");
  });

  test("rejects anything the release regex rejects, echoing the stripped value", () => {
    for (const raw of [
      "",
      "v",
      "1.2",
      "vv1.2.3",
      "1.2.3+build",
      "1.2.3-",
      "1.2.3-rc_1",
      "1.2.3 ",
    ]) {
      expect(() => parseReleaseVersion(raw)).toThrow(ReleaseFailure);
    }
    expect(() => parseReleaseVersion("vv1.2.3")).toThrow("'v1.2.3' is not semver");
    expect(() => parseReleaseVersion("")).toThrow("'' is not semver");
  });
});

describe("release channel", () => {
  const remote = [
    "aaa\trefs/tags/v0.2.1",
    "bbb\trefs/tags/v0.3.0",
    "ccc\trefs/tags/v0.3.0^{}",
    "ddd\trefs/tags/v0.10.0",
    "eee\trefs/tags/v0.11.0-beta.1",
    "fff\trefs/tags/v0.11.0-beta.1^{}",
    "ggg\trefs/tags/vnext",
    "hhh\trefs/tags/release-1.0.0",
    "",
  ].join("\n");

  test("keeps only stable vX.Y.Z tags and folds peeled refs", () => {
    expect(stableVersionsFromLsRemote(remote).sort(compareStableVersions)).toEqual([
      "0.2.1",
      "0.3.0",
      "0.10.0",
    ]);
    expect(stableVersionsFromLsRemote("")).toEqual([]);
  });

  test("compares versions numerically, not lexically", () => {
    expect(compareStableVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareStableVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareStableVersions("1.2.3", "1.10.0")).toBeLessThan(0);
  });

  test("a stable release is latest only when no higher stable tag exists", () => {
    const tags = stableVersionsFromLsRemote(remote);
    expect(releaseChannel("0.10.1", tags)).toEqual({ isPrerelease: false, isLatest: true });
    expect(releaseChannel("0.10.0", tags)).toEqual({ isPrerelease: false, isLatest: true });
    expect(releaseChannel("0.3.1", tags)).toEqual({ isPrerelease: false, isLatest: false });
    expect(releaseChannel("1.0.0", [])).toEqual({ isPrerelease: false, isLatest: true });
  });

  test("a suffixed release is a prerelease and never latest", () => {
    const tags = stableVersionsFromLsRemote(remote);
    expect(releaseChannel("0.11.0-beta.1", tags)).toEqual({ isPrerelease: true, isLatest: false });
    expect(releaseChannel("9.0.0-rc.2", [])).toEqual({ isPrerelease: true, isLatest: false });
  });

  test("reads the channel back from job env and rejects anything but true or false", () => {
    expect(channelFromEnv({ IS_PRERELEASE: "false", IS_LATEST: "true" })).toEqual({
      isPrerelease: false,
      isLatest: true,
    });
    expect(channelFromEnv({ IS_PRERELEASE: "true", IS_LATEST: "false" })).toEqual({
      isPrerelease: true,
      isLatest: false,
    });
    expect(() => channelFromEnv({ IS_PRERELEASE: "yes", IS_LATEST: "true" })).toThrow(
      "IS_PRERELEASE must be one of true, false, got 'yes'",
    );
    expect(() => channelFromEnv({ IS_PRERELEASE: "false" })).toThrow("IS_LATEST is not set");
    expect(() => channelFromEnv({ IS_PRERELEASE: "true", IS_LATEST: "true" })).toThrow(
      "IS_PRERELEASE and IS_LATEST cannot both be true",
    );
  });
});

describe("meta CLI", () => {
  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  function fixture(): { work: string; head: string; first: string } {
    const root = mkdtempSync(join(tmpdir(), "decant-release-meta-"));
    dirs.push(root);
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    git(root, "init", "--bare", "-q", origin);
    git(root, "init", "-q", work);
    git(work, "commit", "-q", "--allow-empty", "-m", "one");
    const first = git(work, "rev-parse", "HEAD");
    git(work, "tag", "-a", "v0.3.0", "-m", "v0.3.0");
    git(work, "commit", "-q", "--allow-empty", "-m", "two");
    const head = git(work, "rev-parse", "HEAD");
    git(work, "tag", "v0.2.1");
    git(work, "tag", "-a", "v0.4.0", "-m", "v0.4.0");
    git(work, "tag", "-a", "v0.5.0-beta.1", "-m", "v0.5.0-beta.1");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "--tags");
    for (const tag of ["v0.2.1", "v0.3.0", "v0.4.0", "v0.5.0-beta.1"]) {
      git(work, "tag", "-d", tag);
    }
    return { work, head, first };
  }

  function runMeta(work: string, raw: string, sha: string) {
    const output = join(work, "..", "github-output");
    writeFileSync(output, "");
    const result = spawnSync("bun", [script], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, RAW: raw, GITHUB_SHA: sha, GITHUB_OUTPUT: output },
    });
    return { ...result, outputs: existsSync(output) ? readFileSync(output, "utf8") : "" };
  }

  test("writes the version and channel for any tag at the run commit", () => {
    const { work, head } = fixture();
    for (const [raw, version, prerelease, latest] of [
      ["v0.4.0", "0.4.0", false, true],
      ["0.2.1", "0.2.1", false, false],
      ["v0.5.0-beta.1", "0.5.0-beta.1", true, false],
    ] as const) {
      const result = runMeta(work, raw, head);
      expect(result.status).toBe(0);
      expect(result.outputs).toBe(
        `version=${version}\nis_prerelease=${prerelease}\nis_latest=${latest}\n`,
      );
    }
  });

  test("fails with the guard annotations for bad input, missing tags, and moved tags", () => {
    const { work, head, first } = fixture();

    const bad = runMeta(work, "v1.2", head);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("::error::'1.2' is not semver");

    const badSha = runMeta(work, "v0.4.0", "--upload-pack=touch pwned");
    expect(badSha.status).toBe(1);
    expect(badSha.stdout).toContain(
      "::error::GITHUB_SHA must be a 40-character lowercase hex commit SHA",
    );
    expect(badSha.outputs).toBe("");

    const missing = runMeta(work, "v9.9.9", head);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain(
      "::error::tag v9.9.9 not found on origin — push the tag before releasing",
    );

    const moved = runMeta(work, "v0.3.0", head);
    expect(moved.status).toBe(1);
    expect(moved.stdout).toContain(
      `::error::tag v0.3.0 points at ${first} but this run builds ${head} — dispatch with the tag as the run ref`,
    );
    expect(moved.outputs).toBe("");
  });
});
