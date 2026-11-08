import type { BackgroundStatus } from "./types.ts";

/**
 * What the Settings switch is doing beyond showing the service's state.
 * `handoff` is the gap between this server exiting and the background service
 * answering on the same port; `stopped` means the page's own server is gone.
 */
export type BackgroundPhase = "idle" | "saving" | "handoff" | "stopped";

export const HANDOFF_POLL_MS = 500;
export const HANDOFF_TIMEOUT_MS = 30_000;

export function backgroundNote(status: BackgroundStatus | null, phase: BackgroundPhase): string {
  if (phase === "handoff") {
    return "Moving Decant to the background. This page reloads when it is ready.";
  }
  if (phase === "stopped") {
    return "Decant stopped. Run decant in a terminal to start it again.";
  }
  if (phase === "saving") {
    return "Saving...";
  }
  if (status == null) {
    return "Loading...";
  }
  if (!status.supported) {
    return status.reason ?? "Running in the background is not available on this machine.";
  }
  if (!status.installed) {
    return "Off. Decant runs only while a terminal keeps it open.";
  }
  if (status.current) {
    return "On. This page is served by the background service, which starts when you log in.";
  }
  if (status.running) {
    return `On. Decant is running in the background at ${status.url ?? "its own port"}.`;
  }
  return "On, but the service is not running. Run decant service status for details.";
}

/**
 * Poll until the background service answers in place of the server that just
 * handed off. Requests fail while neither process holds the port, so every
 * error counts as not ready yet.
 */
export async function waitForBackgroundService(
  fetchStatus: () => Promise<BackgroundStatus>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? HANDOFF_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? HANDOFF_POLL_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    try {
      if ((await fetchStatus()).current) {
        return true;
      }
    } catch {
      // Neither server is listening yet.
    }
  }
  return false;
}
