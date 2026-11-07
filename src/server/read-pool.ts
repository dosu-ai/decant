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
  /** Most reads that may wait for a worker; see DEFAULT_READ_QUEUE_LIMIT. */
  queueLimit?: number;
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

interface Job {
  id: number;
  name: ReadOpName;
  args: unknown;
  /** Index of the worker whose read cache most likely holds this result. */
  preferred: number;
  resolve: (output: ReadOpOutput | null) => void;
  reject: (error: Error) => void;
  /** Detaches the caller's abort listener; set while the job is unsettled. */
  release: (() => void) | null;
}

interface Slot {
  worker: ReadWorkerLike | null;
  /** The one read this worker is running. A worker gets its next read only
   * after this one answers, so waiting reads stay in the pool's queue, where
   * they can be cancelled and handed to whichever worker frees up first. */
  running: Job | null;
  /** Settles when the slot's worker thread exits. */
  exited: PromiseWithResolvers<void> | null;
}

/** Reads waiting for a free worker; at this many, new reads are refused. */
export const DEFAULT_READ_QUEUE_LIMIT = 256;

export class ReadPoolClosedError extends Error {
  constructor() {
    super("read pool is closed");
    this.name = "ReadPoolClosedError";
  }
}

/** Every worker is busy and the queue is full. Retryable. */
export class ReadPoolBusyError extends Error {
  constructor() {
    super("Decant is busy with other reads. Please try again.");
    this.name = "ReadPoolBusyError";
  }
}

/** The caller gave up on the read, for example because the client went away. */
export class ReadCancelledError extends Error {
  constructor() {
    super("read cancelled");
    this.name = "ReadCancelledError";
  }
}

/**
 * Runs read-only archive operations on worker threads, each with its own
 * SQLite connection. SQLite in WAL mode lets these readers proceed alongside
 * the server's connection and the sync worker's writes, so a slow aggregate
 * no longer delays a fast request queued behind it on one connection.
 *
 * Each worker runs one read at a time; the rest wait in a bounded FIFO queue.
 * A read goes to the worker its operation and arguments hash to when that
 * worker is free, which keeps each worker's read cache (src/read-cache.ts)
 * useful, and otherwise to any free worker. A read whose caller aborts while
 * it waits leaves the queue without running.
 */
export class ReadPool {
  readonly #options: ReadPoolOptions;
  readonly #slots: Slot[];
  readonly #queue: Job[] = [];
  readonly #queueLimit: number;
  #nextId = 0;
  #closing = false;
  #closed: Promise<void> | null = null;

  constructor(options: ReadPoolOptions) {
    this.#options = options;
    const size = Math.max(1, Math.trunc(options.size ?? DEFAULT_READ_POOL_SIZE));
    this.#slots = Array.from({ length: size }, () => ({
      worker: null,
      running: null,
      exited: null,
    }));
    this.#queueLimit = Math.max(0, Math.trunc(options.queueLimit ?? DEFAULT_READ_QUEUE_LIMIT));
  }

  run<N extends ReadOpName>(
    name: N,
    args: ReadOpArgs<N>,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReadOpOutput | null> {
    if (this.#closing) {
      return Promise.reject(new ReadPoolClosedError());
    }
    const { signal } = options;
    if (signal?.aborted === true) {
      return Promise.reject(new ReadCancelledError());
    }
    if (this.#queue.length >= this.#queueLimit && this.#freeSlot() == null) {
      return Promise.reject(new ReadPoolBusyError());
    }
    const { promise, resolve, reject } = Promise.withResolvers<ReadOpOutput | null>();
    const key = `${name}\u0000${JSON.stringify(args)}`;
    const job: Job = {
      id: ++this.#nextId,
      name,
      args,
      preferred: Number(BigInt(Bun.hash(key)) % BigInt(this.#slots.length)),
      resolve,
      reject,
      release: null,
    };
    if (signal != null) {
      const onAbort = (): void => {
        // A queued read never reaches a worker. A running one cannot be
        // interrupted mid-statement, so its answer is dropped when it lands.
        const queued = this.#queue.indexOf(job);
        if (queued !== -1) {
          this.#queue.splice(queued, 1);
        }
        this.#settle(job, new ReadCancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      job.release = () => signal.removeEventListener("abort", onAbort);
    } else {
      job.release = () => {};
    }
    this.#queue.push(job);
    this.#dispatch();
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

  /** Rejects queued and running reads, then has each worker close its
   * connection and exit on its own, terminating any that has not exited within
   * the timeout. Every call returns the same promise. */
  close(): Promise<void> {
    this.#closed ??= this.#closeWorkers();
    return this.#closed;
  }

  async #closeWorkers(): Promise<void> {
    this.#closing = true;
    for (const job of this.#queue.splice(0)) {
      this.#settle(job, new ReadPoolClosedError());
    }
    const timeoutMs = Math.max(0, this.#options.closeTimeoutMs ?? 5_000);
    await Promise.all(
      this.#slots.map(async (slot) => {
        if (slot.running != null) {
          this.#settle(slot.running, new ReadPoolClosedError());
          slot.running = null;
        }
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

  #freeSlot(preferred?: number): Slot | null {
    const slot = preferred == null ? undefined : this.#slots[preferred];
    if (slot != null && slot.running == null) {
      return slot;
    }
    return this.#slots.find((candidate) => candidate.running == null) ?? null;
  }

  /** Hand queued reads, oldest first, to free workers. */
  #dispatch(): void {
    while (!this.#closing && this.#queue.length > 0) {
      const job = this.#queue[0];
      const slot = job == null ? null : this.#freeSlot(job.preferred);
      if (job == null || slot == null) {
        return;
      }
      this.#queue.shift();
      slot.running = job;
      try {
        this.#ensureWorker(slot).postMessage({
          type: "run",
          id: job.id,
          name: job.name,
          args: job.args,
        });
      } catch (error) {
        // A worker that cannot take a message would fail every later read
        // too, so retire it now; the next read for this slot starts a fresh
        // one rather than waiting for an error or close event that may not come.
        const worker = slot.worker;
        slot.running = null;
        slot.worker = null;
        if (worker != null) {
          try {
            worker.terminate();
          } catch {
            // Already gone.
          }
        }
        this.#settle(job, error instanceof Error ? error : new Error(String(error)));
      }
    }
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
    const job = slot.running;
    if (job == null || job.id !== reply.id) {
      return;
    }
    slot.running = null;
    this.#settle(job, reply.ok ? reply.output : reviveError(reply.error));
    this.#dispatch();
  }

  /** Drop a failed worker. Its running read fails; queued reads move on to a
   * fresh worker. */
  #retire(slot: Slot, worker: ReadWorkerLike, error: Error): void {
    if (slot.worker !== worker) {
      return;
    }
    slot.worker = null;
    const job = slot.running;
    slot.running = null;
    if (job != null) {
      this.#settle(job, error);
    }
    try {
      worker.terminate();
    } catch {
      // Already gone.
    }
    this.#dispatch();
  }

  /** Resolve or reject a read once; later outcomes for it are ignored. */
  #settle(job: Job, outcome: ReadOpOutput | null | Error): void {
    if (job.release == null) {
      return;
    }
    job.release();
    job.release = null;
    if (outcome instanceof Error) {
      job.reject(outcome);
    } else {
      job.resolve(outcome);
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
