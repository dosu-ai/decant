import { dirname, resolve, sep } from "node:path";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import { getDecantLogger } from "./logging.ts";

// File access for paths that came out of session logs. Such a path can sit
// where a call never returns (a macOS privacy prompt nobody answers, a stale
// network mount), so a helper thread makes the call and the caller waits for
// it only up to a deadline.

const logger = getDecantLogger("ingest");

export interface ProbeFs {
  /** The file's text, or null when it is missing, unreadable, or over
   * `MAX_TEXT_BYTES`. */
  readText(path: string): string | null;
  /** A regular file's text, or null when it is anything else, unreadable, or
   * over `maxBytes`. Decided on the open descriptor, and the read is bounded. */
  readSmallFile(path: string, maxBytes: number): string | null;
  /** The absolute path with symlinks resolved, or just made absolute when it
   * cannot be resolved. */
  realPath(path: string): string;
  isDirectory(path: string): boolean;
  /** Calls so far that got no answer because their location stalls. */
  readonly unanswered: number;
}

export interface BoundedFsOptions {
  /** Longest wait for one call, in milliseconds. */
  deadlineMs?: number;
  /** Stalled roots, shared by every thread that holds the same buffer. */
  ledger?: SharedArrayBuffer;
  /** Test seam: a path at or under `prefix` answers only once `gate` is set. */
  stall?: { prefix: string; gate: SharedArrayBuffer };
}

/** Local disks answer in microseconds; this leaves room for a slow mount. */
export const DEFAULT_PROBE_DEADLINE_MS = 2000;

const HELPER_START_MS = 5000;

/** Largest file `readText` returns. A read past the deadline keeps running on
 * the helper, so it must not grow with the file. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

// Ledger layout: a version counter, then a state and a byte length per slot,
// then each slot's UTF-8 path.
const SLOTS = 8;
const PATH_BYTES = 4096;
const HEADER_INTS = 1 + SLOTS * 2;
const FREE = 0;
const CLAIMED = 1;
const BLOCKED = 2;

const PENDING = 0;
const ANSWERED = 1;
const TIMED_OUT = Symbol("timed out");

type Op = "realPath" | "readText" | "readSmallFile" | "isDirectory" | "open";

// Plain JavaScript in a string, so a compiled binary runs exactly what the
// source run does and needs no extra worker entrypoint.
const HELPER_SOURCE = `
const fs = require("node:fs");
const READ = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
const EMPTY = Buffer.alloc(0);
const TEXT_MAX = ${MAX_TEXT_BYTES};
let state, reply, stall;

// A blocking open, so a pipe with a writer reads like a file. Over the
// ceiling the content is dropped and the path reads as unreadable.
function readText(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY);
  try {
    const chunks = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(65536);
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) return Buffer.concat(chunks, length);
      length += read;
      if (length > TEXT_MAX) return null;
      chunks.push(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function run(op, path, maxBytes) {
  if (op === "realPath") return Buffer.from(fs.realpathSync.native(path));
  if (op === "readText") return readText(path);
  if (op === "isDirectory") return fs.statSync(path).isDirectory() ? EMPTY : null;
  // Non-blocking, so a FIFO planted at the path cannot hold the open.
  const fd = fs.openSync(path, READ);
  try {
    if (op === "open") return EMPTY;
    if (!fs.fstatSync(fd).isFile()) return null;
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) return buffer.subarray(0, length);
      length += read;
      if (length > maxBytes) return null;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function answer(bytes) {
  if (bytes != null) {
    if (bytes.length > reply.byteLength) reply.grow(bytes.length);
    new Uint8Array(reply).set(bytes);
    Atomics.store(state, 1, bytes.length);
  }
  Atomics.store(state, 0, bytes == null ? 2 : 1);
  Atomics.notify(state, 0);
}

self.onmessage = ({ data }) => {
  if (data.state != null) {
    state = new Int32Array(data.state);
    reply = data.reply;
    stall = data.stall;
    answer(EMPTY);
    return;
  }
  if (data.op === "leave") {
    if (data.ledger != null) {
      // The stalled call came back, so the location answers again.
      const ledger = new Int32Array(data.ledger);
      Atomics.store(ledger, data.stateIndex, 0);
      Atomics.add(ledger, 0, 1);
    }
    self.onmessage = null;
    return;
  }
  let bytes = null;
  try {
    if (stall != null && (data.path === stall.prefix || data.path.startsWith(stall.prefix + "/"))) {
      Atomics.wait(new Int32Array(stall.gate), 0, 0);
    }
    bytes = run(data.op, data.path, data.maxBytes);
    answer(bytes);
  } catch {
    answer(null);
  }
};
`;

let helperUrl: string | null = null;

// Bun's worker has ref and unref; the DOM type in scope does not.
type HelperWorker = Worker & { ref(): void; unref(): void };

/** One helper thread and the shared memory it answers through. */
class ProbeHelper {
  readonly #worker: HelperWorker;
  readonly #state = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  // A file over the ceiling fails to grow the buffer and reads as unreadable.
  readonly #reply = new SharedArrayBuffer(64 * 1024, { maxByteLength: 64 * 1024 * 1024 });

  private constructor(stall: BoundedFsOptions["stall"]) {
    helperUrl ??= URL.createObjectURL(new Blob([HELPER_SOURCE], { type: "text/javascript" }));
    this.#worker = new Worker(helperUrl) as HelperWorker;
    // An idle helper must not keep the process or a sync worker alive.
    this.#worker.unref();
    this.#worker.postMessage({ state: this.#state.buffer, reply: this.#reply, stall });
  }

  static start(stall: BoundedFsOptions["stall"]): ProbeHelper | null {
    try {
      const helper = new ProbeHelper(stall);
      return helper.#wait(HELPER_START_MS) === ANSWERED ? helper : null;
    } catch {
      return null;
    }
  }

  request(op: Op, path: string, maxBytes: number, deadlineMs: number): Buffer | null | symbol {
    Atomics.store(this.#state, 0, PENDING);
    this.#worker.postMessage({ op, path, maxBytes });
    const status = this.#wait(deadlineMs);
    if (status === PENDING) {
      return TIMED_OUT;
    }
    return status === ANSWERED
      ? Buffer.from(new Uint8Array(this.#reply, 0, Atomics.load(this.#state, 1)))
      : null;
  }

  /** Ends the helper once its stalled call returns. With a ledger slot, it
   * frees that slot first. */
  leaveOnReturn(ledger?: SharedArrayBuffer, stateIndex?: number): void {
    if (ledger != null && !isMainThread) {
      // A sync worker that drains would end the helper before it reports.
      this.#worker.ref();
    }
    this.#worker.postMessage({ op: "leave", ledger, stateIndex });
  }

  #wait(ms: number): number {
    Atomics.wait(this.#state, 0, PENDING, ms);
    return Atomics.load(this.#state, 0);
  }
}

export function createProbeLedger(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_INTS * Int32Array.BYTES_PER_ELEMENT + SLOTS * PATH_BYTES);
}

const LEDGER_KEY = "decant.unreachable-roots";

// `decant serve` runs each sync on a new worker thread. Workers inherit this
// buffer, so a root that stalled once is not tried again by the next sync.
function processLedger(): SharedArrayBuffer {
  const inherited = getEnvironmentData(LEDGER_KEY);
  if (inherited instanceof SharedArrayBuffer) {
    return inherited;
  }
  const ledger = createProbeLedger();
  if (isMainThread) {
    setEnvironmentData(LEDGER_KEY, ledger);
  }
  return ledger;
}

const sharedLedger = processLedger();

function slotBytes(ledger: SharedArrayBuffer, slot: number, length: number): Uint8Array {
  return new Uint8Array(
    ledger,
    HEADER_INTS * Int32Array.BYTES_PER_ELEMENT + slot * PATH_BYTES,
    length,
  );
}

function blockedRoots(ledger: SharedArrayBuffer): string[] {
  const ints = new Int32Array(ledger, 0, HEADER_INTS);
  const roots: string[] = [];
  for (let slot = 0; slot < SLOTS; slot += 1) {
    if (Atomics.load(ints, 1 + slot * 2) === BLOCKED) {
      const length = Atomics.load(ints, 2 + slot * 2);
      roots.push(Buffer.from(slotBytes(ledger, slot, length)).toString("utf8"));
    }
  }
  return roots;
}

/** The index of the slot's state, or -1 when every slot is taken. */
function claimSlot(ledger: SharedArrayBuffer, root: string): number {
  const ints = new Int32Array(ledger, 0, HEADER_INTS);
  const bytes = Buffer.from(root, "utf8");
  for (let slot = 0; slot < SLOTS; slot += 1) {
    const stateIndex = 1 + slot * 2;
    if (Atomics.compareExchange(ints, stateIndex, FREE, CLAIMED) !== FREE) {
      continue;
    }
    slotBytes(ledger, slot, bytes.length).set(bytes);
    Atomics.store(ints, stateIndex + 1, bytes.length);
    Atomics.store(ints, stateIndex, BLOCKED);
    Atomics.add(ints, 0, 1);
    return stateIndex;
  }
  return -1;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Every ancestor of `path`, from the filesystem root down. */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let current = dirname(path); ; current = dirname(current)) {
    out.unshift(current);
    if (dirname(current) === current) {
      return out;
    }
  }
}

/** `ProbeFs` whose calls each wait at most the deadline. A call that times out
 * answers as an unreadable path does, and its location is skipped without
 * another wait until the stalled call returns. */
export class BoundedFs implements ProbeFs {
  readonly #deadlineMs: number;
  readonly #ledger: SharedArrayBuffer;
  readonly #version: Int32Array;
  readonly #stall: BoundedFsOptions["stall"];
  #idle: ProbeHelper | null = null;
  #helperFailed = false;
  #roots: readonly string[] = [];
  #seenVersion = -1;
  #unanswered = 0;

  constructor(options: BoundedFsOptions = {}) {
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;
    this.#ledger = options.ledger ?? sharedLedger;
    this.#version = new Int32Array(this.#ledger, 0, 1);
    this.#stall = options.stall;
  }

  get unanswered(): number {
    return this.#unanswered;
  }

  readText(path: string): string | null {
    return this.#call("readText", path)?.toString("utf8") ?? null;
  }

  readSmallFile(path: string, maxBytes: number): string | null {
    return this.#call("readSmallFile", path, maxBytes)?.toString("utf8") ?? null;
  }

  realPath(path: string): string {
    const absolute = resolve(path);
    return this.#call("realPath", absolute)?.toString("utf8") ?? absolute;
  }

  isDirectory(path: string): boolean {
    return this.#call("isDirectory", path) != null;
  }

  #call(op: Op, path: string, maxBytes = 0): Buffer | null {
    const target = resolve(path);
    // The kernel refuses a longer path, and a ledger slot could not hold it.
    if (target.length * 3 > PATH_BYTES && Buffer.byteLength(target) > PATH_BYTES) {
      return null;
    }
    const helper = this.#isBlocked(target) ? null : this.#helper();
    if (helper == null) {
      this.#unanswered += 1;
      return null;
    }
    const answer = helper.request(op, target, maxBytes, this.#deadlineMs);
    if (typeof answer !== "symbol") {
      return answer;
    }
    this.#idle = null;
    this.#block(target, helper);
    this.#unanswered += 1;
    return null;
  }

  #isBlocked(path: string): boolean {
    const version = Atomics.load(this.#version, 0);
    if (version !== this.#seenVersion) {
      this.#roots = blockedRoots(this.#ledger);
      this.#seenVersion = version;
    }
    if (this.#roots.length === 0) {
      return false;
    }
    // A full ledger cannot remember another root, so nothing new is tried.
    return this.#roots.length === SLOTS || this.#roots.some((root) => isUnder(path, root));
  }

  #helper(): ProbeHelper | null {
    if (this.#idle == null && !this.#helperFailed) {
      this.#idle = ProbeHelper.start(this.#stall);
      if (this.#idle == null) {
        this.#helperFailed = true;
        logger.warning("Project directories are not read: the helper thread did not start.", {
          "event.name": "decant.ingest.probe_helper_failed",
        });
      }
    }
    return this.#idle;
  }

  #block(path: string, stalled: ProbeHelper): void {
    // The shallowest ancestor that also stalls covers its siblings in one
    // entry, at the cost of one more stalled helper.
    let root = path;
    let owner = stalled;
    for (const ancestor of ancestors(path)) {
      const helper = this.#helper();
      if (helper == null) {
        break;
      }
      if (typeof helper.request("open", ancestor, 0, this.#deadlineMs) === "symbol") {
        this.#idle = null;
        stalled.leaveOnReturn();
        root = ancestor;
        owner = helper;
        break;
      }
    }
    const stateIndex = claimSlot(this.#ledger, root);
    if (stateIndex === -1) {
      owner.leaveOnReturn();
      return;
    }
    owner.leaveOnReturn(this.#ledger, stateIndex);
    logger.warning("A project directory did not answer in time and is skipped.", {
      "event.name": "decant.ingest.directory_unreachable",
      "file.path": root,
      "probe.timeout_ms": this.#deadlineMs,
    });
  }
}

/** The default for paths taken from session logs. One per thread; its helper
 * starts on first use. */
export const boundedFs: ProbeFs = new BoundedFs();
