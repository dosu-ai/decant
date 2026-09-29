#!/usr/bin/env bun
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail, notice, requireEnv, runChecked, runMain, runQuiet } from "./actions.ts";
import { channelFromEnv, type ReleaseChannel } from "./meta.ts";
import { releaseFileName, releaseTag, safePath } from "./validate.ts";

export interface ReleasePlan {
  tag: string;
  tarballs: readonly string[];
  bundle: string;
}

export function attestationBundleName(tag: string): string {
  return `decant-${tag.replace(/^v/, "")}.sigstore.json`;
}

export function releaseAssets(plan: ReleasePlan): string[] {
  return [...plan.tarballs.map((name) => `./${name}`), plan.bundle, "SHA256SUMS", "install.sh"];
}

/**
 * `latest` is explicit either way because gh otherwise decides by date and
 * version, and install.sh downloads from `releases/latest`.
 */
export function ghChannelFlags(channel: ReleaseChannel): string[] {
  const flags = channel.isPrerelease ? ["--prerelease"] : [];
  flags.push(channel.isLatest ? "--latest" : "--latest=false");
  return flags;
}

/** `gh release create` 422s on an existing tag, so a re-run only refreshes the assets. */
export function ghReleaseArgs(
  plan: ReleasePlan,
  releaseExists: boolean,
  channel: ReleaseChannel,
): string[] {
  if (releaseExists) {
    return ["release", "upload", "--clobber", "--", plan.tag, ...releaseAssets(plan)];
  }
  return [
    "release",
    "create",
    "--verify-tag",
    "--generate-notes",
    ...ghChannelFlags(channel),
    "--",
    plan.tag,
    ...releaseAssets(plan),
  ];
}

function main(): void {
  const releaseDir = safePath("RELEASE_DIR", requireEnv("RELEASE_DIR"));
  const tag = releaseTag("TAG", requireEnv("TAG"));
  const channel = channelFromEnv();
  const bundle = attestationBundleName(tag);
  const bundlePath = join(releaseDir, bundle);
  if (!existsSync(bundlePath) || !statSync(bundlePath).isFile()) {
    fail(`attestation bundle ${bundle} missing from the release-tarballs artifact`);
  }
  const tarballs = readdirSync(releaseDir)
    .filter((name) => !name.startsWith(".") && name.endsWith(".tar.gz"))
    .sort()
    .map(releaseFileName);
  if (tarballs.length === 0) {
    fail(`no release tarballs found in ${releaseDir}`);
  }
  const plan: ReleasePlan = { tag, tarballs, bundle };

  const exists = runQuiet("gh", ["release", "view", "--", tag], { cwd: releaseDir }) === 0;
  if (exists) {
    notice(`${tag} already has a release — refreshing assets only (gh release create would 422)`);
  }
  runChecked("gh", ghReleaseArgs(plan, exists, channel), { cwd: releaseDir });
}

if (import.meta.main) {
  runMain(main);
}
