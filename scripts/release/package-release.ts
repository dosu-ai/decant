#!/usr/bin/env bun
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandFailure, capture, chomp, runMain } from "./actions.ts";
import { formatSha256Sums, sha256Hex } from "./checksums.ts";

export const RELEASE_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
export const TARBALL_MEMBERS = ["decant", "LICENSE", "NOTICE"] as const;

/** GNU tar flags that make the archive depend only on file contents and the commit time. */
export function deterministicTarArgs(sourceDir: string, sourceDateEpoch: string): string[] {
  return [
    "--sort=name",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    `--mtime=@${sourceDateEpoch}`,
    "-C",
    sourceDir,
    "-cf",
    "-",
    ...TARBALL_MEMBERS,
  ];
}

export function tarballName(target: string): string {
  return `decant-${target}.tar.gz`;
}

export function isReleaseTarball(name: string): boolean {
  return /^decant-.*\.tar\.gz$/.test(name);
}

async function writeTarball(sourceDir: string, epoch: string, destination: string): Promise<void> {
  const tar = Bun.spawn(["tar", ...deterministicTarArgs(sourceDir, epoch)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const gzip = Bun.spawn(["gzip", "-n"], {
    stdin: tar.stdout,
    stdout: Bun.file(destination),
    stderr: "inherit",
  });
  const [tarStatus, gzipStatus] = await Promise.all([tar.exited, gzip.exited]);
  if (tarStatus !== 0) {
    throw new CommandFailure(`tar exited with status ${tarStatus}`, tarStatus);
  }
  if (gzipStatus !== 0) {
    throw new CommandFailure(`gzip exited with status ${gzipStatus}`, gzipStatus);
  }
}

export async function packageRelease(options: {
  binDir: string;
  releaseDir: string;
  sourceDateEpoch: string;
  licenseDir?: string;
}): Promise<string> {
  const licenseDir = options.licenseDir ?? ".";
  mkdirSync(options.releaseDir, { recursive: true });
  for (const target of RELEASE_TARGETS) {
    const targetDir = join(options.binDir, target);
    copyFileSync(join(licenseDir, "LICENSE"), join(targetDir, "LICENSE"));
    copyFileSync(join(licenseDir, "NOTICE"), join(targetDir, "NOTICE"));
    await writeTarball(
      targetDir,
      options.sourceDateEpoch,
      join(options.releaseDir, tarballName(target)),
    );
  }
  const sums = formatSha256Sums(
    readdirSync(options.releaseDir)
      .filter(isReleaseTarball)
      .map((name) => ({ name, sha256: sha256Hex(readFileSync(join(options.releaseDir, name))) })),
  );
  writeFileSync(join(options.releaseDir, "SHA256SUMS"), sums);
  return sums;
}

async function main(): Promise<void> {
  const sourceDateEpoch = chomp(capture("git", ["show", "-s", "--format=%ct", "HEAD"]));
  const sums = await packageRelease({
    binDir: "dist/bin",
    releaseDir: "dist/release",
    sourceDateEpoch,
  });
  process.stdout.write(sums);
}

if (import.meta.main) {
  runMain(main);
}
