import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { closeDb, openDb } from "../src/db.ts";
import type { SyncReport } from "../src/ingest.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-sqlite-workers-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function fixtureConfig(): Config {
  const root = join(workDir, `case-${++caseCounter}`);
  const config: Config = {
    dbPath: join(root, "archive.db"),
    claudeDir: join(root, "claude"),
    codexDir: join(root, "codex"),
    geminiDir: join(root, "gemini"),
    opencodeDir: join(root, "opencode"),
    cursorDir: join(root, "cursor"),
  };
  for (const path of [config.claudeDir, config.codexDir, config.geminiDir, config.opencodeDir]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(
    join(config.claudeDir, "session.jsonl"),
    readFileSync(join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl")),
  );
  return config;
}

interface WorkerRun {
  code: number;
  errors: string[];
  messages: unknown[];
}

/** A completion message alone misses exceptions thrown while shutting down. */
function runUntilClosed(
  file: "sync-worker.ts" | "stats-worker.ts",
  data: unknown,
): Promise<WorkerRun> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`../src/${file}`, import.meta.url), { type: "module" });
    const messages: unknown[] = [];
    const errors: string[] = [];
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${file} did not close after reporting completion`));
    }, 5_000);
    worker.addEventListener("message", (event) => messages.push(event.data));
    worker.addEventListener("error", (event) => {
      errors.push(event.message || String(event.error));
    });
    worker.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve({ code: (event as CloseEvent).code, errors, messages });
    });
    worker.postMessage(data);
  });
}

describe("SQLite worker shutdown", () => {
  test("sync releases SQLite and exits cleanly after success and a repeat sync", async () => {
    const config = fixtureConfig();
    const first = await runUntilClosed("sync-worker.ts", { config, cancelBuffer: null });
    expect(first.errors).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.messages.at(-1)).toMatchObject({
      type: "complete",
      ok: true,
      report: { ingested: 1 },
    });
    expect(
      first.messages.some((message) => (message as { type: string }).type === "progress"),
    ).toBe(true);

    const second = await runUntilClosed("sync-worker.ts", { config, cancelBuffer: null });
    expect(second.errors).toEqual([]);
    expect(second.code).toBe(0);
    expect(second.messages.at(-1)).toMatchObject({
      type: "complete",
      ok: true,
      report: { ingested: 0, skipped: 1 },
    });
    const db = openDb(config.dbPath);
    expect(db.query("SELECT COUNT(*) AS n FROM session").get()).toEqual({ n: 1 });
    db.exec("BEGIN IMMEDIATE; ROLLBACK;");
    closeDb(db);
  }, 10_000);

  test("sync exits cleanly after acknowledging cooperative cancellation", async () => {
    const config = fixtureConfig();
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    Atomics.store(new Int32Array(cancelBuffer), 0, 1);
    const run = await runUntilClosed("sync-worker.ts", { config, cancelBuffer });
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.messages.at(-1)).toMatchObject({
      type: "complete",
      ok: true,
      report: { cancelled: true, ingested: 0 },
    });
  }, 10_000);

  test("sync reports an archive-open failure and still exits cleanly", async () => {
    const config = fixtureConfig();
    config.dbPath = join(workDir, "missing-directory", "archive.db");
    const run = await runUntilClosed("sync-worker.ts", { config, cancelBuffer: null });
    expect(run.errors).toEqual([]);
    expect(run.code).toBe(0);
    expect(run.messages.at(-1)).toMatchObject({
      type: "complete",
      ok: false,
      error: expect.any(String),
    });
  }, 10_000);

  test("stats exits cleanly after success and cooperative cancellation", async () => {
    const config = fixtureConfig();
    const seeded = await runUntilClosed("sync-worker.ts", { config, cancelBuffer: null });
    expect((seeded.messages.at(-1) as { report: SyncReport }).report.ingested).toBe(1);
    const success = await runUntilClosed("stats-worker.ts", {
      dbPath: config.dbPath,
      cancelBuffer: null,
    });
    expect(success.errors).toEqual([]);
    expect(success.code).toBe(0);
    expect(success.messages).toEqual([{ ok: true, vectors: expect.any(Array) }]);

    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    Atomics.store(new Int32Array(cancelBuffer), 0, 1);
    const cancelled = await runUntilClosed("stats-worker.ts", {
      dbPath: config.dbPath,
      cancelBuffer,
    });
    expect(cancelled.errors).toEqual([]);
    expect(cancelled.code).toBe(0);
    expect(cancelled.messages).toEqual([{ ok: false, error: "aborted" }]);
  }, 10_000);
});
