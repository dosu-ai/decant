import { workerError, workerUrl } from "../worker-runtime.ts";
import type { ReadOpArgs, ReadOpName, ReadOpOutput } from "./read-ops.ts";

/** Two workers let the Tools page's three heavy requests overlap without
 * holding a connection, a cache, and a thread per CPU on a laptop. */
export const DEFAULT_READ_POOL_SIZE = 2;

/** The Worker surface the pool uses, so tests can substitute a fake. */
export interface ReadWorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "close", listener: (event: Event) => void): void;
  terminate(): void;
}

export interface ReadPoolOptions {
  dbPath: string;
  size?: number;
  /** Test seam: build the worker for a slot. */
  spawn?: () => ReadWorkerLike;
  /** Longest wait for a worker to close its connection and exit before it is
   * terminated. */
  closeTimeoutMs?: number;
}

interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

type WorkerReply =
  | { type: "result"; id: number; ok: true; output: ReadOpOutput | null }
  | { type: "result"; id: number; ok: false; error: SerializedError };

interface Pending {
  resolve: (output: ReadOpOutput | null) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: ReadWorkerLike | null;
  pending: Map<number, Pending>;
  /** Settles when the slot's worker thread exits. */
  exited: PromiseWithResolvers<void> | null;
}

export class ReadPoolClosedError extends Error {
  constructor() {
    super("read pool is closed");
    this.name = "ReadPoolClosedError";
  }
}

/**
 * Runs read-only archive operations on worker threads, each with its own
 * SQLite connection. SQLite in WAL mode lets these readers proceed alongside
 * the server's connection and the sync worker's writes, so a slow aggregate
 * no longer delays a fast request queued behind it on one connection.
 *
 * Requests for the same operation and arguments prefer the same worker, which
 * keeps each worker's read cache (src/read-cache.ts) useful. A request spills
 * to another worker only when its preferred one is busy and another is idle.
 */
export class ReadPool {
  readonly #options: ReadPoolOptions;
  readonly #slots: Slot[];
  #nextId = 0;
  #closing = false;
  #closed: Promise<void> | null = null;

  constructor(options: ReadPoolOptions) {
    this.#options = options;
    const size = Math.max(1, Math.trunc(options.size ?? DEFAULT_READ_POOL_SIZE));
    this.#slots = Array.from({ length: size }, () => ({
      worker: null,
      pending: new Map(),
      exited: null,
    }));
  }

  run<N extends ReadOpName>(name: N, args: ReadOpArgs<N>): Promise<ReadOpOutput | null> {
    if (this.#closing) {
      return Promise.reject(new ReadPoolClosedError());
    }
    const slot = this.#pick(`${name}\u0000${JSON.stringify(args)}`);
    const worker = this.#ensureWorker(slot);
    const id = ++this.#nextId;
    const { promise, resolve, reject } = Promise.withResolvers<ReadOpOutput | null>();
    slot.pending.set(id, { resolve, reject });
    try {
      worker.postMessage({ type: "run", id, name, args });
    } catch (error) {
      slot.pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  /** Start every worker and open its connection now, so the first request
   * after startup does not also pay for a thread, its modules, and the schema. */
  prewarm(): void {
    if (this.#closing) {
      return;
    }
    for (const slot of this.#slots) {
      this.#ensureWorker(slot).postMessage({ type: "warm" });
    }
  }

  /** Have every live worker reread planner statistics another connection wrote. */
  reloadStatistics(): void {
    for (const slot of this.#slots) {
      slot.worker?.postMessage({ type: "reload-statistics" });
    }
  }

  /** Rejects work still in flight, then has each worker close its connection
   * and exit on its own, terminating any that has not exited within the
   * timeout. Every call returns the same promise. */
  close(): Promise<void> {
    this.#closed ??= this.#closeWorkers();
    return this.#closed;
  }

  async #closeWorkers(): Promise<void> {
    this.#closing = true;
    const timeoutMs = Math.max(0, this.#options.closeTimeoutMs ?? 5_000);
    await Promise.all(
      this.#slots.map(async (slot) => {
        this.#rejectPending(slot, new ReadPoolClosedError());
        const worker = slot.worker;
        if (worker == null) {
          return;
        }
        slot.exited = Promise.withResolvers<void>();
        let timer: Timer | null = null;
        try {
          worker.postMessage({ type: "close" });
          await Promise.race([
            slot.exited.promise,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, timeoutMs);
            }),
          ]);
        } catch {
          // A worker that cannot take the message is terminated below.
        } finally {
          if (timer != null) {
            clearTimeout(timer);
          }
          // A worker that exited has already been retired; this only stops
          // one that is still running past the timeout.
          if (slot.worker === worker) {
            slot.worker = null;
            worker.terminate();
          }
        }
      }),
    );
  }

  #pick(key: string): Slot {
    const preferred = this.#slots[Number(BigInt(Bun.hash(key)) % BigInt(this.#slots.length))];
    if (preferred == null) {
      throw new Error("read pool has no slots");
    }
    if (preferred.pending.size === 0) {
      return preferred;
    }
    let best = preferred;
    for (const slot of this.#slots) {
      if (slot.pending.size < best.pending.size) {
        best = slot;
      }
    }
    // Leaving the preferred worker costs a cache miss, so do it only for an
    // idle worker, not to shave one request off a queue.
    return best.pending.size === 0 ? best : preferred;
  }

  #ensureWorker(slot: Slot): ReadWorkerLike {
    if (slot.worker != null) {
      return slot.worker;
    }
    const worker =
      this.#options.spawn?.() ??
      (new Worker(workerUrl("read-worker.ts"), { type: "module" }) as ReadWorkerLike);
    slot.worker = worker;
    worker.addEventListener("message", (event) => {
      this.#onReply(slot, event.data as WorkerReply);
    });
    worker.addEventListener("error", (event) => {
      this.#retire(slot, worker, workerError(event, "read worker failed"));
    });
    worker.addEventListener("close", () => {
      slot.exited?.resolve();
      this.#retire(slot, worker, new Error("read worker exited"));
    });
    worker.postMessage({ type: "init", dbPath: this.#options.dbPath });
    return worker;
  }

  #onReply(slot: Slot, reply: WorkerReply): void {
    const pending = slot.pending.get(reply.id);
    if (pending == null) {
      return;
    }
    slot.pending.delete(reply.id);
    if (reply.ok) {
      pending.resolve(reply.output);
    } else {
      pending.reject(reviveError(reply.error));
    }
  }

  /** Drop a failed worker; the next request for this slot starts a fresh one. */
  #retire(slot: Slot, worker: ReadWorkerLike, error: Error): void {
    if (slot.worker !== worker) {
      return;
    }
    slot.worker = null;
    this.#rejectPending(slot, error);
    try {
      worker.terminate();
    } catch {
      // Already gone.
    }
  }

  #rejectPending(slot: Slot, error: Error): void {
    const pending = [...slot.pending.values()];
    slot.pending.clear();
    for (const entry of pending) {
      entry.reject(error);
    }
  }
}

/** Rebuild an Error the server's error mapping can classify: it reads `code`
 * to recognize a busy archive. */
function reviveError(serialized: SerializedError): Error {
  const error = new Error(serialized.message) as Error & { code?: string };
  error.name = serialized.name;
  if (serialized.code != null) {
    error.code = serialized.code;
  }
  if (serialized.stack != null) {
    error.stack = serialized.stack;
  }
  return error;
}
