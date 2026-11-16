import { workerError, workerUrl } from "../worker-runtime.ts";
import type { ReadOpArgs, ReadOpName, ReadOpOutput } from "./read-ops.ts";

export const DEFAULT_READ_POOL_SIZE = 2;

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
  spawn?: () => ReadWorkerLike;
  closeTimeoutMs?: number;
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
  preferred: number;
  resolve: (output: ReadOpOutput | null) => void;
  reject: (error: Error) => void;
  release: (() => void) | null;
}

interface Slot {
  worker: ReadWorkerLike | null;
  running: Job | null;
  exited: PromiseWithResolvers<void> | null;
}

export const DEFAULT_READ_QUEUE_LIMIT = 256;

export class ReadPoolClosedError extends Error {
  constructor() {
    super("read pool is closed");
    this.name = "ReadPoolClosedError";
  }
}

export class ReadPoolBusyError extends Error {
  constructor() {
    super("Decant is busy with other reads. Please try again.");
    this.name = "ReadPoolBusyError";
  }
}

export class ReadCancelledError extends Error {
  constructor() {
    super("read cancelled");
    this.name = "ReadCancelledError";
  }
}

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

  prewarm(): void {
    if (this.#closing) {
      return;
    }
    for (const slot of this.#slots) {
      this.#ensureWorker(slot).postMessage({ type: "warm" });
    }
  }

  reloadStatistics(): void {
    for (const slot of this.#slots) {
      slot.worker?.postMessage({ type: "reload-statistics" });
    }
  }

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
        } finally {
          if (timer != null) {
            clearTimeout(timer);
          }
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
        const worker = slot.worker;
        slot.running = null;
        slot.worker = null;
        if (worker != null) {
          terminateQuietly(worker);
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
    terminateQuietly(worker);
    this.#dispatch();
  }

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

function terminateQuietly(worker: ReadWorkerLike): void {
  try {
    worker.terminate();
  } catch {}
}

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
