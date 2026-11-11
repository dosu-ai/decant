import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedFs, createProbeLedger, MAX_TEXT_BYTES } from "../src/bounded-fs.ts";
import { makeFifo, releaseFifo } from "./stalled-directory.ts";

const DEADLINE_MS = 300;
// Never waited out, so a slow machine cannot turn a readable path into a timeout.
const READABLE_DEADLINE_MS = 5000;
const tempRoots: string[] = [];
const fifos: string[] = [];

afterEach(() => {
  // Blocked helper threads end once their read returns.
  for (const fifo of fifos.splice(0)) {
    releaseFifo(fifo);
  }
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "decant-bounded-fs-")));
  tempRoots.push(dir);
  return dir;
}

function fifo(path: string): string {
  fifos.push(path);
  return makeFifo(path);
}

/** Its own ledger, so a stalled root here is invisible to other tests. */
function bounded(options: ConstructorParameters<typeof BoundedFs>[0] = {}): BoundedFs {
  return new BoundedFs({ deadlineMs: DEADLINE_MS, ledger: createProbeLedger(), ...options });
}

function elapsed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

async function eventually(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) {
      return true;
    }
    await Bun.sleep(10);
  }
  return false;
}

/** A gate the helper waits on for every path under `prefix`, standing in for
 * a folder whose calls never return. */
function stalled(prefix: string): { stall: { prefix: string; gate: SharedArrayBuffer } } {
  return { stall: { prefix, gate: new SharedArrayBuffer(4) } };
}

function open(gate: SharedArrayBuffer): void {
  const view = new Int32Array(gate);
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
}

describe("BoundedFs on readable paths", () => {
  test("answers as node:fs does", () => {
    const dir = tempDir();
    const fs = bounded({ deadlineMs: READABLE_DEADLINE_MS });
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    // A BOM, bytes that are not UTF-8, and more than the first reply buffer.
    const text = Buffer.concat([
      Buffer.from("﻿{}\n"),
      Buffer.from([0xff, 0xfe]),
      Buffer.alloc(200_000, "x"),
    ]);
    writeFileSync(join(dir, "real", "config.json"), text);

    expect(fs.realPath(join(dir, "link", "config.json"))).toBe(join(dir, "real", "config.json"));
    expect(fs.realPath(join(dir, "missing", "..", "gone"))).toBe(join(dir, "gone"));
    expect(fs.readText(join(dir, "link", "config.json"))).toBe(
      readFileSync(join(dir, "real", "config.json"), "utf8"),
    );
    expect(fs.readText(join(dir, "gone"))).toBeNull();
    expect(fs.readText(join(dir, "real"))).toBeNull();
    expect(fs.isDirectory(join(dir, "link"))).toBe(true);
    expect(fs.isDirectory(join(dir, "real", "config.json"))).toBe(false);
    expect(fs.isDirectory(join(dir, "gone"))).toBe(false);
    expect(fs.unanswered).toBe(0);
  });

  test("refuses text over the ceiling, so a late read cannot grow with the file", () => {
    const dir = tempDir();
    const fs = bounded({ deadlineMs: READABLE_DEADLINE_MS });
    writeFileSync(join(dir, "full.json"), Buffer.alloc(MAX_TEXT_BYTES, "x"));
    writeFileSync(join(dir, "over.json"), Buffer.alloc(MAX_TEXT_BYTES + 1, "x"));
    expect(fs.readText(join(dir, "full.json"))?.length).toBe(MAX_TEXT_BYTES);
    expect(fs.readText(join(dir, "over.json"))).toBeNull();
  });

  test("reads a small regular file and refuses anything else", () => {
    const dir = tempDir();
    const fs = bounded({ deadlineMs: READABLE_DEADLINE_MS });
    writeFileSync(join(dir, "small"), "gitdir: /repo/.git/worktrees/x\n");
    writeFileSync(join(dir, "large"), "x".repeat(65));
    fifo(join(dir, "pipe"));

    expect(fs.readSmallFile(join(dir, "small"), 64)).toBe("gitdir: /repo/.git/worktrees/x\n");
    expect(fs.readSmallFile(join(dir, "large"), 64)).toBeNull();
    expect(fs.readSmallFile(join(dir, "large"), 65)).toBe("x".repeat(65));
    expect(fs.readSmallFile(dir, 64)).toBeNull();
    expect(fs.readSmallFile(join(dir, "gone"), 64)).toBeNull();
    // Opened without blocking, so the FIFO is refused at once.
    expect(fs.readSmallFile(join(dir, "pipe"), 64)).toBeNull();
    expect(fs.unanswered).toBe(0);
  });

  test("refuses a path too long for the kernel", () => {
    const fs = bounded({ deadlineMs: READABLE_DEADLINE_MS });
    expect(fs.readText(`/${"a".repeat(5000)}`)).toBeNull();
    expect(fs.unanswered).toBe(0);
  });
});

describe("BoundedFs on a path that never answers", () => {
  test("gives up on a blocking read at the deadline and does not wait again", () => {
    const dir = tempDir();
    const fs = bounded();
    const pipe = fifo(join(dir, "opencode.json"));
    writeFileSync(join(dir, "opencode.jsonc"), "{}");

    let text: string | null = "unset";
    const first = elapsed(() => {
      text = fs.readText(pipe);
    });
    expect(text).toBeNull();
    expect(first).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
    expect(first).toBeLessThan(DEADLINE_MS * 4);
    expect(fs.unanswered).toBe(1);

    // The same path answers at once now, and its neighbours still read.
    expect(elapsed(() => fs.readText(pipe))).toBeLessThan(DEADLINE_MS / 2);
    expect(fs.realPath(pipe)).toBe(pipe);
    expect(fs.unanswered).toBe(3);
    expect(fs.readText(join(dir, "opencode.jsonc"))).toBe("{}");
    expect(fs.isDirectory(dir)).toBe(true);
  });

  test("reads the path again once the blocked call returns", async () => {
    const dir = tempDir();
    const fs = bounded();
    const pipe = fifo(join(dir, ".git"));
    expect(fs.readText(pipe)).toBeNull();
    expect(fs.isDirectory(pipe)).toBe(false);

    // Answered again means the call ran instead of being skipped.
    const answered = (): boolean => {
      const before = fs.unanswered;
      fs.isDirectory(pipe);
      return fs.unanswered === before;
    };
    expect(answered()).toBe(false);
    releaseFifo(pipe);
    expect(await eventually(answered)).toBe(true);
  });

  test("skips a whole stalled folder after finding its top", async () => {
    const dir = tempDir();
    const protectedDir = join(dir, "Documents");
    mkdirSync(join(protectedDir, "one", "deep"), { recursive: true });
    mkdirSync(join(protectedDir, "two"), { recursive: true });
    mkdirSync(join(dir, "code"), { recursive: true });
    writeFileSync(join(protectedDir, "two", "opencode.json"), "{}");
    writeFileSync(join(dir, "code", "opencode.json"), "{}");
    const options = stalled(protectedDir);
    const ledger = createProbeLedger();
    const fs = bounded({ ...options, ledger });

    // One wait for the path and one for the folder above it that also stalls.
    const first = elapsed(() => {
      expect(fs.realPath(join(protectedDir, "one", "deep"))).toBe(
        join(protectedDir, "one", "deep"),
      );
    });
    expect(first).toBeGreaterThanOrEqual(DEADLINE_MS * 2 - 40);
    expect(first).toBeLessThan(DEADLINE_MS * 6);

    // Siblings and the folder itself are skipped without a wait.
    const rest = elapsed(() => {
      expect(fs.readText(join(protectedDir, "two", "opencode.json"))).toBeNull();
      expect(fs.isDirectory(join(protectedDir, "one"))).toBe(false);
      expect(fs.isDirectory(protectedDir)).toBe(false);
    });
    expect(rest).toBeLessThan(DEADLINE_MS / 2);
    expect(fs.unanswered).toBe(4);

    // Everything outside it answers as before.
    expect(fs.readText(join(dir, "code", "opencode.json"))).toBe("{}");
    expect(fs.isDirectory(dir)).toBe(true);

    // Another thread's instance shares the ledger and does not wait at all.
    const next = bounded({ ...options, ledger });
    expect(
      elapsed(() => {
        expect(next.readText(join(protectedDir, "two", "opencode.json"))).toBeNull();
      }),
    ).toBeLessThan(DEADLINE_MS / 2);

    open(options.stall.gate);
    expect(
      await eventually(() => next.readText(join(protectedDir, "two", "opencode.json")) === "{}"),
    ).toBe(true);
    expect(fs.isDirectory(join(protectedDir, "one", "deep"))).toBe(true);
  });

  test("stops trying new paths once the ledger is full", () => {
    const dir = tempDir();
    const fs = bounded({ deadlineMs: 60 });
    writeFileSync(join(dir, "readable"), "ok");
    for (let index = 0; index < 8; index += 1) {
      expect(fs.readText(fifo(join(dir, `pipe-${index}`)))).toBeNull();
    }
    expect(fs.unanswered).toBe(8);
    // A ninth stalled path could not be remembered, so nothing is tried.
    expect(fs.readText(join(dir, "readable"))).toBeNull();
    expect(fs.unanswered).toBe(9);
  });
});
