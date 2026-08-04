import { spawn } from "node:child_process";

/** Environment values that affect browser auto-open behavior. */
export interface OpenEnv {
  BROWSER?: string;
  DECANT_NO_OPEN?: string;
  CI?: string;
}

/** A pure decision describing whether and how Decant should open the UI. */
export interface OpenDecision {
  open: boolean;
  command?: string;
  reason: string;
}

export interface SpawnedLike {
  on?: (event: "error", listener: (error: Error) => void) => unknown;
  unref?: () => void;
}

export type SpawnLike = (
  bin: string,
  args: string[],
  options: { stdio: "ignore"; detached: true },
) => SpawnedLike;

export function displayUrl(host: string, port: number): string {
  const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
  const shown = wildcard ? "127.0.0.1" : host;
  const bracketed = shown.includes(":") && !shown.startsWith("[") ? `[${shown}]` : shown;
  return `http://${bracketed}:${port}`;
}

export function browserCommand(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") {
    return "open";
  }
  if (platform === "linux") {
    return "xdg-open";
  }
  // No Decant binaries ship for other platforms; never guess an opener.
  return null;
}

export function decideOpen(input: {
  enabled: boolean;
  env: OpenEnv;
  isTTY: boolean;
  platform: NodeJS.Platform;
}): OpenDecision {
  if (!input.enabled) {
    return { open: false, reason: "--no-open" };
  }
  // "Set to any value" disables, matching DECANT_NO_SYNC semantics.
  if (input.env.DECANT_NO_OPEN != null) {
    return { open: false, reason: "DECANT_NO_OPEN" };
  }
  const browser = input.env.BROWSER;
  if (browser === "none") {
    return { open: false, reason: "BROWSER=none" };
  }
  if (browser != null && browser !== "") {
    // Deliberate configuration wins over CI and TTY detection. This also gives
    // the serve E2E tests an opener seam while their stdio is piped.
    return { open: true, command: browser, reason: "BROWSER" };
  }
  if (input.env.CI != null) {
    return { open: false, reason: "CI" };
  }
  if (!input.isTTY) {
    return { open: false, reason: "not a TTY" };
  }
  const command = browserCommand(input.platform);
  if (command == null) {
    return { open: false, reason: `no opener for ${input.platform}` };
  }
  return { open: true, command, reason: "platform default" };
}

export function openBrowser(url: string, command: string, spawner: SpawnLike = spawn): void {
  try {
    const child = spawner(command, [url], { stdio: "ignore", detached: true });
    // Missing openers report ENOENT asynchronously; opening remains best-effort
    // because the CLI always prints the authoritative URL.
    child.on?.("error", () => {});
    child.unref?.();
  } catch {
    // A synchronous spawn failure is also covered by the printed URL fallback.
  }
}
