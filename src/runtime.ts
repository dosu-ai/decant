import { compareVersions, parseVersion } from "./update.ts";

// bun:sqlite in Bun 1.3.0 through 1.4.3 drops a leading U+FEFF from bound strings,
// so text that starts with a byte-order mark is stored without it.
export const MIN_BUN_VERSION = "1.4.4";

export function bunVersionSupported(version: string): boolean {
  const running = parseVersion(version);
  const minimum = parseVersion(MIN_BUN_VERSION);
  return running == null || minimum == null || compareVersions(running, minimum) >= 0;
}

export function runningBunVersion(): string {
  return typeof Bun === "undefined" ? "unknown" : Bun.version;
}
