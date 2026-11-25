import type { Database } from "bun:sqlite";
import type { DateFilter } from "./date-filter.ts";
import { exceptionAttributes, getDecantLogger } from "./logging.ts";
import { readEconomicsSeq } from "./sync-state.ts";
import {
  aggregateEconomicsVectors,
  computeSessionEconomicsVectorsByIds,
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
  #builtEconomicsSeq: number | null = null;
  #building: Promise<void> | null = null;
  #buildAbort: AbortController | null = null;
  #rebuildRequestedMidBuild = false;
  #disposed = false;
  readonly #options: EconomicsCacheOptions;

  constructor(options: EconomicsCacheOptions) {
    this.#options = options;
  }

  async get(filter?: DateFilter | null): Promise<TokenEconomics> {
    if (this.#vectors == null) {
      await (this.#building ?? this.#rebuild());
    } else if (this.#isStale()) {
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

  dataVersion(): number | null {
    return this.#dataVersion();
  }

  refreshSessions(
    sessionIds: readonly number[],
    expectedDataVersion?: number | null,
    ownEconomicsWrites?: number,
  ): void {
    if (this.#disposed) {
      return;
    }
    if (
      this.#vectors == null ||
      this.#building != null ||
      this.#options.computeVectors != null ||
      sessionIds.length === 0 ||
      sessionIds.length > 16 ||
      (expectedDataVersion !== undefined &&
        (expectedDataVersion == null || expectedDataVersion !== this.#builtDataVersion))
    ) {
      this.invalidate();
      return;
    }
    try {
      const dvBefore = this.#dataVersion();
      const seqBefore = readEconomicsSeq(this.#options.db);
      if (ownEconomicsWrites !== undefined) {
        if (
          this.#builtEconomicsSeq == null ||
          seqBefore == null ||
          ownEconomicsWrites < 0 ||
          seqBefore !== this.#builtEconomicsSeq + ownEconomicsWrites
        ) {
          this.invalidate();
          return;
        }
      } else if (dvBefore !== this.#builtDataVersion) {
        this.invalidate();
        return;
      }
      const uniqueIds = [...new Set(sessionIds)];
      const updated = computeSessionEconomicsVectorsByIds(this.#options.db, uniqueIds);
      const dvAfter = this.#dataVersion();
      const seqAfter = readEconomicsSeq(this.#options.db);
      if (seqAfter !== seqBefore || dvAfter !== dvBefore) {
        this.invalidate();
        return;
      }
      const updatedById = new Map(updated.map((vector) => [vector.id, vector]));
      const touched = new Set(uniqueIds);
      const next: SessionEconomicsVector[] = [];
      for (const vector of this.#vectors) {
        if (!touched.has(vector.id)) {
          next.push(vector);
          continue;
        }
        const replacement = updatedById.get(vector.id);
        if (replacement != null) {
          next.push(replacement);
          updatedById.delete(vector.id);
        }
      }
      for (const added of updatedById.values()) {
        next.push(added);
      }
      this.#vectors = next;
      this.#builtDataVersion = dvAfter;
      this.#builtEconomicsSeq = seqAfter;
    } catch {
      this.invalidate();
    }
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

  #isStale(): boolean {
    const dataVersion = this.#dataVersion();
    const economicsSeq = readEconomicsSeq(this.#options.db);
    if (economicsSeq == null || this.#builtEconomicsSeq == null) {
      return dataVersion !== this.#builtDataVersion;
    }
    if (economicsSeq !== this.#builtEconomicsSeq) {
      return true;
    }
    if (dataVersion != null && dataVersion !== this.#builtDataVersion) {
      this.#builtDataVersion = dataVersion;
    }
    return false;
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
      this.#rebuildRequestedMidBuild = true;
      return this.#building;
    }
    const compute = this.#options.computeVectors ?? computeVectorsInWorker;
    const version = this.#dataVersion();
    const economicsSeq = readEconomicsSeq(this.#options.db);
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
        this.#builtEconomicsSeq = economicsSeq;
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
        this.#startFollowUpRebuildIfRequested();
      });
    return this.#building;
  }

  #startFollowUpRebuildIfRequested(): void {
    if (this.#rebuildRequestedMidBuild && !this.#disposed) {
      this.#rebuildRequestedMidBuild = false;
      void this.#rebuild();
    }
  }
}

export function computeVectorsInWorker(
  dbPath: string,
  { signal }: ComputeVectorsOptions,
  spawn: () => Worker = () => new Worker(workerUrl("stats-worker.ts"), { type: "module" }),
): Promise<SessionEconomicsVector[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const worker = spawn();
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancelView = new Int32Array(cancelBuffer);
    let promiseSettled = false;
    const finish = (outcome: () => void): void => {
      signal.removeEventListener("abort", onAbort);
      if (promiseSettled) {
        return;
      }
      promiseSettled = true;
      outcome();
    };
    function onAbort(): void {
      Atomics.store(cancelView, 0, 1);
      finish(() => reject(new Error("aborted")));
      worker.terminate();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { ok: true; vectors: SessionEconomicsVector[] }
        | { ok: false; error: string };
      finish(() => (data.ok ? resolve(data.vectors) : reject(new Error(data.error))));
    });
    worker.addEventListener("error", (event) => {
      finish(() => reject(workerError(event, "token economics worker failed")));
    });
    worker.addEventListener("close", (event) => {
      const code = (event as Event & { code?: number }).code ?? "unknown";
      finish(() =>
        reject(new Error(`token economics worker exited with code ${code} before reporting`)),
      );
    });
    worker.postMessage({ dbPath, cancelBuffer });
  });
}
