import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseFailure } from "../scripts/release/actions.ts";
import { parseReleaseVersion } from "../scripts/release/meta.ts";

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

  test("writes only the version for any tag at the run commit", () => {
    const { work, head } = fixture();
    for (const [raw, version] of [
      ["v0.4.0", "0.4.0"],
      ["0.2.1", "0.2.1"],
      ["v0.5.0-beta.1", "0.5.0-beta.1"],
    ] as const) {
      const result = runMeta(work, raw, head);
      expect(result.status).toBe(0);
      expect(result.outputs).toBe(`version=${version}\n`);
    }
  });

  test("fails with the guard annotations for bad input, missing tags, and moved tags", () => {
    const { work, head, first } = fixture();

    const bad = runMeta(work, "v1.2", head);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("::error::'1.2' is not semver");

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
