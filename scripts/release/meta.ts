#!/usr/bin/env bun
import { capture, chomp, fail, requireEnv, run, runMain, setOutput } from "./actions.ts";
import { commitSha, releaseVersion } from "./validate.ts";

export interface ReleaseMeta {
  version: string;
  tag: string;
}

export function parseReleaseVersion(raw: string): ReleaseMeta {
  const version = releaseVersion(raw.startsWith("v") ? raw.slice(1) : raw);
  return { version, tag: `v${version}` };
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

  setOutput("version", version);
}

if (import.meta.main) {
  runMain(main);
}
