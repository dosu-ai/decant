#!/usr/bin/env bun
import { notice, requireEnv, runChecked, runMain, runQuiet } from "./actions.ts";
import { packageName } from "./npm.ts";
import { releaseVersion } from "./validate.ts";

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

/**
 * Every release moves `latest`. The tag is explicit because npm refuses to
 * publish a suffixed version such as 1.2.0-beta.1 without one, and will not
 * implicitly move `latest` below a higher published version.
 */
export function publishArgs(dir: string): string[] {
  return ["publish", `dist/npm/${dir}`, "--access", "public", "--tag", "latest", "--provenance"];
}

/** Skips versions already on the registry so a re-run after a partial publish can finish. */
export function publishPackages(version: string, deps: PublishDeps): void {
  for (const dir of NPM_PACKAGE_DIRS) {
    const pkg = deps.packageName(`dist/npm/${dir}`);
    if (deps.isPublished(`${pkg}@${version}`)) {
      deps.notice(`${pkg}@${version} already published — skipping (idempotent re-run)`);
      continue;
    }
    deps.publish(publishArgs(dir));
  }
}

function main(): void {
  publishPackages(releaseVersion(requireEnv("VERSION")), {
    packageName,
    isPublished: (spec) => runQuiet("npm", ["view", "--", spec, "version"]) === 0,
    publish: (args) => runChecked("npm", args),
    notice,
  });
}

if (import.meta.main) {
  runMain(main);
}
