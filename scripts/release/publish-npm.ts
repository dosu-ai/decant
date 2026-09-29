#!/usr/bin/env bun
import { notice, requireEnv, runChecked, runMain, runQuiet } from "./actions.ts";
import { channelFromEnv, type ReleaseChannel } from "./meta.ts";
import { packageName } from "./npm.ts";
import { oneOf, releaseVersion } from "./validate.ts";

/** Platform packages publish before the launcher so its optional dependencies resolve. */
export const NPM_PACKAGE_DIRS = [
  "decant-darwin-arm64",
  "decant-darwin-x64",
  "decant-linux-arm64",
  "decant-linux-x64",
  "decant",
] as const;

export interface PublishDeps {
  packageName: (dir: string) => string;
  isPublished: (spec: string) => boolean;
  publish: (args: string[]) => void;
  notice: (message: string) => void;
}

export const NPM_DIST_TAGS = ["next", "latest", "previous"] as const;
export type NpmDistTag = (typeof NPM_DIST_TAGS)[number];

/**
 * Only the highest stable release moves `latest`, so `npx decant` never lands
 * on a prerelease or on a backport cut after a newer release.
 */
export function npmDistTag(channel: ReleaseChannel): NpmDistTag {
  if (channel.isPrerelease) {
    return "next";
  }
  return channel.isLatest ? "latest" : "previous";
}

export function publishArgs(dir: string, distTag: NpmDistTag): string[] {
  const tag = oneOf("npm dist-tag", distTag, NPM_DIST_TAGS);
  return ["publish", `dist/npm/${dir}`, "--access", "public", "--tag", tag, "--provenance"];
}

/** Skips versions already on the registry so a re-run after a partial publish can finish. */
export function publishPackages(version: string, distTag: NpmDistTag, deps: PublishDeps): void {
  for (const dir of NPM_PACKAGE_DIRS) {
    const pkg = deps.packageName(`dist/npm/${dir}`);
    if (deps.isPublished(`${pkg}@${version}`)) {
      deps.notice(`${pkg}@${version} already published — skipping (idempotent re-run)`);
      continue;
    }
    deps.publish(publishArgs(dir, distTag));
  }
}

function main(): void {
  publishPackages(releaseVersion(requireEnv("VERSION")), npmDistTag(channelFromEnv()), {
    packageName,
    isPublished: (spec) => runQuiet("npm", ["view", "--", spec, "version"]) === 0,
    publish: (args) => runChecked("npm", args),
    notice,
  });
}

if (import.meta.main) {
  runMain(main);
}
