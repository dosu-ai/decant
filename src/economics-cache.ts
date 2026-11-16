import type { Database } from "bun:sqlite";
import type { DateFilter } from "./date-filter.ts";
import { exceptionAttributes, getDecantLogger } from "./logging.ts";
import {
  aggregateEconomicsVectors,
  economicsVectorMatchesFilter,
  type SessionEconomicsVector,
  type TokenEconomics,
} from "./token-economics.ts";
import { workerError, workerUrl } from "./worker-runtime.ts";

const logger = getDecantLogger("economics-cache");

export interface ComputeVectorsOptions {
  signal: AbortSignal;
}

export interface EconomicsCacheOptions {
  dbPath: string;
  db: Database;
  computeVectors?: (
    dbPath: string,
    options: ComputeVectorsOptions,
  ) => Promise<SessionEconomicsVector[]>;
  onRebuilt?: () => void;
  settleTimeoutMs?: number;
}

export class EconomicsCache {
  #vectors: SessionEconomicsVector[] | null = null;
  #builtDataVersion: number | null = null;
  #building: Promise<void> | null = null;
  #buildAbort: AbortController | null = null;
  #pendingRebuild = false;
  #disposed = false;
  readonly #options: EconomicsCacheOptions;

  constructor(options: EconomicsCacheOptions) {
    this.#options = options;
  }

  async get(filter?: DateFilter | null): Promise<TokenEconomics> {
    if (this.#vectors == null) {
      await (this.#building ?? this.#rebuild());
    } else if (this.#dataVersion() !== this.#builtDataVersion) {
      void this.#rebuild();
    }
    const vectors = this.#vectors ?? [];
    return aggregateEconomicsVectors(
      vectors.filter((vector) => economicsVectorMatchesFilter(vector, filter)),
    );
  }

  invalidate(): void {
    void this.#rebuild();
  }

  prewarm(): void {
    void this.#rebuild();
  }

  async settled(): Promise<void> {
    while (this.#building != null) {
      const building = this.#building;
      if (!this.#disposed) {
        await building;
        continue;
      }
      const timeoutMs = Math.max(0, this.#options.settleTimeoutMs ?? 5_000);
      let timer: Timer | null = null;
      await Promise.race([
        building,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (timer != null) {
        clearTimeout(timer);
      }
      if (this.#building === building) {
        return;
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#buildAbort?.abort();
  }

  #dataVersion(): number | null {
    try {
      // data_version only reflects other connections' commits after this
      // connection takes a fresh read snapshot, so touch a tiny table first.
      this.#options.db.query("SELECT 1 FROM schema_migrations LIMIT 1").get();
      const row = this.#options.db.query("PRAGMA data_version").get() as {
        data_version: number;
      } | null;
      return row?.data_version ?? null;
    } catch {
      return null;
    }
  }

  #rebuild(): Promise<void> {
    if (this.#disposed) {
      return Promise.resolve();
    }
    if (this.#building != null) {
      this.#pendingRebuild = true;
      return this.#building;
    }
    const compute = this.#options.computeVectors ?? computeVectorsInWorker;
    const version = this.#dataVersion();
    const abort = new AbortController();
    this.#buildAbort = abort;
    this.#building = compute(this.#options.dbPath, { signal: abort.signal })
      .then((vectors) => {
        if (this.#disposed) {
          return;
        }
        const replacedModel = this.#vectors != null;
        this.#vectors = vectors;
        this.#builtDataVersion = version;
        if (replacedModel) {
          this.#options.onRebuilt?.();
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted && !this.#disposed) {
          logger.warning("Token economics rebuild failed; keeping the previous model.", {
            "event.name": "decant.economics.rebuild_failed",
            ...exceptionAttributes(error),
          });
        }
      })
      .finally(() => {
        this.#building = null;
        this.#buildAbort = null;
        if (this.#pendingRebuild && !this.#disposed) {
          this.#pendingRebuild = false;
          void this.#rebuild();
        }
      });
    return this.#building;
  }
}

function computeVectorsInWorker(
  dbPath: string,
  { signal }: ComputeVectorsOptions,
): Promise<SessionEconomicsVector[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const worker = new Worker(workerUrl("stats-worker.ts"), { type: "module" });
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancelView = new Int32Array(cancelBuffer);
    let promiseSettled = false;
    const onAbort = (): void => {
      Atomics.store(cancelView, 0, 1);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { ok: true; vectors: SessionEconomicsVector[] }
        | { ok: false; error: string };
      settle();
      if (promiseSettled) {
        return;
      }
      promiseSettled = true;
      if (signal.aborted) {
        reject(new Error("aborted"));
      } else if (data.ok) {
        resolve(data.vectors);
      } else {
        reject(new Error(data.error));
      }
    });
    worker.addEventListener("error", (event) => {
      settle();
      if (promiseSettled) {
        return;
      }
      promiseSettled = true;
      reject(workerError(event, "token economics worker failed"));
    });
    worker.postMessage({ dbPath, cancelBuffer });
  });
}
