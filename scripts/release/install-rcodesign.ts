#!/usr/bin/env bun
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addPath, log, requireEnv, runChecked, runMain } from "./actions.ts";
import { sha256Matches } from "./checksums.ts";

export const RCODESIGN_VERSION = "0.29.0";
export const RCODESIGN_SHA256 = "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002";

const ARCHIVE_ROOT = `apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl`;

export function rcodesignUrl(version = RCODESIGN_VERSION): string {
  return `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${version}/apple-codesign-${version}-x86_64-unknown-linux-musl.tar.gz`;
}

function main(): void {
  const runnerTemp = requireEnv("RUNNER_TEMP");
  const archive = join(runnerTemp, "rcodesign.tar.gz");

  runChecked("curl", ["-fsSL", "--retry", "3", "-o", archive, rcodesignUrl()]);
  if (!sha256Matches(readFileSync(archive), RCODESIGN_SHA256)) {
    throw new Error(`rcodesign.tar.gz: FAILED (expected sha256 ${RCODESIGN_SHA256})`);
  }
  log("rcodesign.tar.gz: OK");

  runChecked(
    "tar",
    ["-xzf", "rcodesign.tar.gz", "--strip-components=1", `${ARCHIVE_ROOT}/rcodesign`],
    { cwd: runnerTemp },
  );
  const binDir = join(runnerTemp, "bin");
  const installed = join(binDir, "rcodesign");
  mkdirSync(binDir, { recursive: true });
  copyFileSync(join(runnerTemp, "rcodesign"), installed);
  chmodSync(installed, 0o755);
  addPath(binDir);
}

if (import.meta.main) {
  runMain(main);
}
