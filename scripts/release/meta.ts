#!/usr/bin/env bun
import { capture, chomp, type Env, fail, requireEnv, run, runMain, setOutput } from "./actions.ts";
import { commitSha, oneOf, releaseVersion } from "./validate.ts";

export interface ReleaseMeta {
  version: string;
  tag: string;
}

/**
 * A prerelease never moves a stable channel. A stable release moves them only
 * when it is the highest stable tag, so a backport such as v0.2.5 cut after
 * v0.3.0 cannot roll npm, GitHub, GHCR or the Homebrew tap back.
 */
export interface ReleaseChannel {
  isPrerelease: boolean;
  isLatest: boolean;
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export function parseReleaseVersion(raw: string): ReleaseMeta {
  const version = releaseVersion(raw.startsWith("v") ? raw.slice(1) : raw);
  return { version, tag: `v${version}` };
}

/** Stable versions named by `git ls-remote --tags` output, with peeled `^{}` refs folded in. */
export function stableVersionsFromLsRemote(output: string): string[] {
  const versions = new Set<string>();
  for (const line of output.split("\n")) {
    const ref = line.split("\t")[1]?.trim();
    if (ref === undefined) {
      continue;
    }
    const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    if (name.startsWith("v") && STABLE_VERSION.test(name.slice(1))) {
      versions.add(name.slice(1));
    }
  }
  return [...versions];
}

export function compareStableVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function releaseChannel(version: string, stableTags: readonly string[]): ReleaseChannel {
  if (version.includes("-")) {
    return { isPrerelease: true, isLatest: false };
  }
  const higher = stableTags.some((tag) => compareStableVersions(tag, version) > 0);
  return { isPrerelease: false, isLatest: !higher };
}

/** Reads the channel the meta job passed into a downstream job's environment. */
export function channelFromEnv(env: Env = process.env): ReleaseChannel {
  const flag = (name: string): boolean =>
    oneOf(name, requireEnv(name, env), ["true", "false"] as const) === "true";
  const channel = { isPrerelease: flag("IS_PRERELEASE"), isLatest: flag("IS_LATEST") };
  if (channel.isPrerelease && channel.isLatest) {
    fail("IS_PRERELEASE and IS_LATEST cannot both be true");
  }
  return channel;
}

function main(): void {
  const { version, tag } = parseReleaseVersion(process.env.RAW ?? "");
  const runSha = commitSha("GITHUB_SHA", requireEnv("GITHUB_SHA"));

  const fetched = run("git", [
    "fetch",
    "--no-tags",
    "--force",
    "--",
    "origin",
    `refs/tags/${tag}:refs/tags/${tag}`,
  ]);
  if (fetched !== 0) {
    fail(`tag ${tag} not found on origin — push the tag before releasing`);
  }
  const tagCommit = chomp(capture("git", ["rev-parse", `refs/tags/${tag}^{commit}`]));
  if (tagCommit !== runSha) {
    fail(
      `tag ${tag} points at ${tagCommit} but this run builds ${runSha} — dispatch with the tag as the run ref`,
    );
  }

  const stableTags = version.includes("-")
    ? []
    : stableVersionsFromLsRemote(capture("git", ["ls-remote", "--tags", "origin", "v*"]));
  const channel = releaseChannel(version, stableTags);

  setOutput("version", version);
  setOutput("is_prerelease", String(channel.isPrerelease));
  setOutput("is_latest", String(channel.isLatest));
}

if (import.meta.main) {
  runMain(main);
}
