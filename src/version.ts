import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// This direct access is intentionally kept at module scope so `bun build
// --compile --env=DECANT_BUILD_VERSION*` can replace it in release binaries.
const INLINED_BUILD_VERSION = process.env.DECANT_BUILD_VERSION;

export interface VersionResolutionOptions {
  env?: Record<string, string | undefined>;
  checkoutDir?: string;
  describe?: (checkoutDir: string) => string | null;
}

function describeCheckout(checkoutDir: string): string | null {
  try {
    const result = spawnSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd: checkoutDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const version = result.status === 0 ? result.stdout.trim() : "";
    return version === "" ? null : version;
  } catch {
    return null;
  }
}

export function resolveDecantVersion(options: VersionResolutionOptions = {}): string {
  const builtVersion = (
    options.env == null ? INLINED_BUILD_VERSION : options.env.DECANT_BUILD_VERSION
  )?.trim();
  if (builtVersion != null && builtVersion !== "") {
    return builtVersion;
  }

  const checkoutDir = options.checkoutDir ?? resolve(import.meta.dir, "..");
  return (options.describe ?? describeCheckout)(checkoutDir) ?? "dev";
}

export const DECANT_VERSION = resolveDecantVersion();
