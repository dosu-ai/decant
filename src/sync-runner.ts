import type { Config } from "./config.ts";
import type { sync } from "./ingest.ts";

export function runSyncWorker(
  config: Config,
  cancel?: { aborted: boolean },
): Promise<ReturnType<typeof sync>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sync-worker.ts", import.meta.url), { type: "module" });
    let cancelPoll: Timer | null = null;
    const settle = (): void => {
      if (cancelPoll != null) {
        clearInterval(cancelPoll);
        cancelPoll = null;
      }
      worker.terminate();
    };
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { ok: true; report: ReturnType<typeof sync> }
        | { ok: false; error: string };
      settle();
      if (data.ok) {
        resolve(data.report);
      } else {
        reject(new Error(data.error));
      }
    });
    worker.addEventListener("error", (event) => {
      settle();
      reject(event.error instanceof Error ? event.error : new Error(String(event.error)));
    });
    if (cancel != null) {
      cancelPoll = setInterval(() => {
        if (cancel.aborted) {
          settle();
          resolve({ scanned: 0, ingested: 0, skipped: 0, issues: 0, failed: 0, cancelled: true });
        }
      }, 150);
    }
    worker.postMessage(config);
  });
}
