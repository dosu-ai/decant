#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail, runMain } from "./actions.ts";

export const REQUIRED_PACKAGE_FILES = ["LICENSE", "NOTICE"] as const;

export function missingLicenseFile(
  packageDirs: readonly string[],
  isFile: (path: string) => boolean,
): string | null {
  for (const dir of packageDirs) {
    for (const file of REQUIRED_PACKAGE_FILES) {
      if (!isFile(`${dir}${file}`)) {
        return `${file} missing from staged package ${dir} (Apache-2.0 §4(d))`;
      }
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Lists staged package directories the way a shell directory glob does: sorted, slash-suffixed. */
export function stagedPackageDirs(root: string): string[] {
  return readdirSync(root)
    .filter((name) => !name.startsWith(".") && statSync(join(root, name)).isDirectory())
    .sort()
    .map((name) => `${root}/${name}/`);
}

function main(): void {
  const dirs = stagedPackageDirs("dist/npm");
  if (dirs.length === 0) {
    fail("no staged packages found under dist/npm");
  }
  const problem = missingLicenseFile(dirs, isFile);
  if (problem != null) {
    fail(problem);
  }
}

if (import.meta.main) {
  runMain(main);
}
