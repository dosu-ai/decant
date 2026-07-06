import type { Config } from "./config.ts";
import type { sync } from "./ingest.ts";

export function runSyncWorker(config: Config): Promise<ReturnType<typeof sync>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sync-worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { ok: true; report: ReturnType<typeof sync> }
        | { ok: false; error: string };
      worker.terminate();
      if (data.ok) {
        resolve(data.report);
      } else {
        reject(new Error(data.error));
      }
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(event.error instanceof Error ? event.error : new Error(String(event.error)));
    });
    worker.postMessage(config);
  });
}
