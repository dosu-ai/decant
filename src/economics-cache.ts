import type { Database } from "bun:sqlite";
import type { DateFilter } from "./date-filter.ts";
import {
  aggregateEconomicsVectors,
  economicsVectorMatchesFilter,
  type SessionEconomicsVector,
  type TokenEconomics,
} from "./token-economics.ts";

/**
 * Serves /api/analytics/token-economics from precomputed per-session vectors.
 *
 * Ingest persists versioned per-session vectors, so warming this cache reads
 * compact derived rows instead of walking every transcript block. The cache
 * then answers any date filter by summing vectors in memory.
 * `PRAGMA data_version` cheaply detects archive writes from other connections
 * (sync workers, CLI runs); a stale cache serves the previous model while a
 * refresh runs in the background, and onRebuilt lets the server nudge clients
 * to refetch.
 */
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
      // Stale-while-revalidate: answer from the previous model immediately and
      // refresh in the background; onRebuilt tells clients to refetch.
      void this.#rebuild();
    }
    const vectors = this.#vectors ?? [];
    return aggregateEconomicsVectors(
      vectors.filter((vector) => economicsVectorMatchesFilter(vector, filter)),
    );
  }

  /** Kick a background rebuild, e.g. right after a sync ingests new sessions. */
  invalidate(): void {
    void this.#rebuild();
  }

  prewarm(): void {
    void this.#rebuild();
  }

  /** Resolves once any in-flight rebuild (including chained follow-ups) has
   * finished (success or failure). */
  async settled(): Promise<void> {
    while (this.#building != null) {
      await this.#building;
    }
  }

  /** Aborts any in-flight rebuild (killing its worker immediately, rather than
   * leaving shutdown waiting out a multi-second archive scan) and stops
   * scheduling new ones. */
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
      // A build is already in flight and may not reflect writes that land
      // after it started (e.g. an ingest completing mid-prewarm-scan). Flag
      // it so the in-flight build schedules an immediate follow-up instead of
      // silently serving stale data until some unrelated future request
      // happens to notice via #dataVersion().
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
      .catch(() => {
        // Aborted (dispose) or a genuine compute failure: keep serving
        // whatever model (possibly none) is already cached.
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
    const worker = new Worker(new URL("./stats-worker.ts", import.meta.url), { type: "module" });
    const onAbort = (): void => {
      worker.terminate();
      reject(new Error("aborted"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (): void => {
      signal.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    worker.addEventListener("message", (event) => {
      const data = event.data as
        | { ok: true; vectors: SessionEconomicsVector[] }
        | { ok: false; error: string };
      settle();
      if (data.ok) {
        resolve(data.vectors);
      } else {
        reject(new Error(data.error));
      }
    });
    worker.addEventListener("error", (event) => {
      settle();
      reject(event.error instanceof Error ? event.error : new Error(String(event.error)));
    });
    worker.postMessage({ dbPath });
  });
}
