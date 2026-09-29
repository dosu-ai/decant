#!/usr/bin/env bun
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail, notice, requireEnv, runChecked, runMain, runQuiet } from "./actions.ts";

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
 * `gh release create` 422s on an existing tag, so a re-run only refreshes the
 * assets. `--latest` is explicit because gh otherwise decides by date and
 * version, and every release is meant to become latest.
 */
export function ghReleaseArgs(plan: ReleasePlan, releaseExists: boolean): string[] {
  if (releaseExists) {
    return ["release", "upload", plan.tag, ...releaseAssets(plan), "--clobber"];
  }
  return [
    "release",
    "create",
    plan.tag,
    ...releaseAssets(plan),
    "--verify-tag",
    "--generate-notes",
    "--latest",
  ];
}

function main(): void {
  const releaseDir = requireEnv("RELEASE_DIR");
  const tag = requireEnv("TAG");
  const bundle = attestationBundleName(tag);
  const bundlePath = join(releaseDir, bundle);
  if (!existsSync(bundlePath) || !statSync(bundlePath).isFile()) {
    fail(`attestation bundle ${bundle} missing from the release-tarballs artifact`);
  }
  const tarballs = readdirSync(releaseDir)
    .filter((name) => !name.startsWith(".") && name.endsWith(".tar.gz"))
    .sort();
  if (tarballs.length === 0) {
    fail(`no release tarballs found in ${releaseDir}`);
  }
  const plan: ReleasePlan = { tag, tarballs, bundle };

  const exists = runQuiet("gh", ["release", "view", tag], { cwd: releaseDir }) === 0;
  if (exists) {
    notice(`${tag} already has a release — refreshing assets only (gh release create would 422)`);
  }
  runChecked("gh", ghReleaseArgs(plan, exists), { cwd: releaseDir });
}

if (import.meta.main) {
  runMain(main);
}
