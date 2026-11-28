import { Database } from "bun:sqlite";
import { compareVersions, parseVersion } from "./update.ts";

// bun:sqlite in Bun 1.3.0 through 1.4.3 drops a leading U+FEFF from bound strings,
// so text that starts with a byte-order mark is stored without it. Some canaries
// report 1.4.4 and still have the bug, so the runtime check also probes SQLite.
export const MIN_BUN_VERSION = "1.4.4";

const BOM_PROBE = "﻿decant";

export function bunVersionSupported(version: string): boolean {
  const running = parseVersion(version);
  const minimum = parseVersion(MIN_BUN_VERSION);
  return running == null || minimum == null || compareVersions(running, minimum) >= 0;
}

export function runningBunVersion(): string {
  return typeof Bun === "undefined" ? "unknown" : Bun.version;
}

let keepsLeadingBom: boolean | undefined;

export function sqliteKeepsLeadingBom(): boolean {
  if (keepsLeadingBom === undefined) {
    try {
      const db = new Database(":memory:");
      try {
        const row = db.query("SELECT ?1 AS v").get(BOM_PROBE) as { v: string } | null;
        keepsLeadingBom = row?.v === BOM_PROBE;
      } finally {
        db.close();
      }
    } catch {
      keepsLeadingBom = true;
    }
  }
  return keepsLeadingBom;
}

export function bunRuntimeSupported(version: string = runningBunVersion()): boolean {
  return bunVersionSupported(version) && sqliteKeepsLeadingBom();
}
