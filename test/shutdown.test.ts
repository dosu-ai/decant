import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/config.ts";
import { closeDb, openDb } from "../src/db.ts";
import { computeVectorsInWorker } from "../src/economics-cache.ts";
import { type IngestConfig, type SyncReport, sync } from "../src/ingest.ts";
import { eventClientCount } from "../src/server/sse.ts";
import { runSyncWorker, SyncWorkerStopTimeoutError } from "../src/server/sync.ts";
import { serve, workerSyncRunner } from "../src/server.ts";
import { startWatch, type WatchEvent } from "../src/watch.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-shutdown-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const fixtureRoot = join(import.meta.dir, "..", "fixtures");

let caseCounter = 0;
function freshConfig(): Config {
  caseCounter += 1;
  const root = join(workDir, `case-${caseCounter}`);
  const config: Config = {
    dbPath: join(root, "archive.db"),
    claudeDir: join(root, "claude"),
    codexDir: join(root, "codex"),
    geminiDir: join(root, "gemini"),
    opencodeDir: join(root, "opencode"),
    cursorDir: join(root, "cursor"),
    copilotDir: join(root, "copilot"),
    vscodeCopilotDir: join(root, "vscode"),
  };
  mkdirSync(config.claudeDir, { recursive: true });
  return config;
}

const CANCELLED_REPORT: SyncReport = {
  scanned: 1,
  ingested: 0,
  skipped: 0,
  issues: 0,
  issuesByCode: {},
  failed: 0,
  cancelled: true,
};

/** Worker entrypoints that stand in for sync-worker.ts and stats-worker.ts
 * with the misbehavior a shutdown has to survive. */
const workerSources = {
  ignoresCancel: `
    self.addEventListener("message", function onMessage() {
      self.removeEventListener("message", onMessage);
      self.postMessage({ type: "progress", progress: { scanned: 0, ingested: 0, skipped: 0, failed: 0, total: 1 } });
      setInterval(() => {}, 1_000);
    });
  `,
  honorsCancel: `
    self.addEventListener("message", function onMessage(event) {
      self.removeEventListener("message", onMessage);
      const view = new Int32Array(event.data.cancelBuffer);
      const poll = setInterval(() => {
        if (Atomics.load(view, 0) !== 0) {
          clearInterval(poll);
          self.postMessage({ type: "complete", ok: true, report: ${JSON.stringify(CANCELLED_REPORT)} });
        }
      }, 5);
    });
  `,
  silent: `
    self.addEventListener("message", function onMessage() {
      self.removeEventListener("message", onMessage);
      setInterval(() => {}, 1_000);
    });
  `,
  exitsEarly: `
    self.addEventListener("message", () => process.exit(3));
  `,
};

function workerFile(name: keyof typeof workerSources): string {
  const path = join(workDir, "workers", `${name}.ts`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, workerSources[name]);
  return path;
}

function trackedSpawner(name: keyof typeof workerSources) {
  const path = workerFile(name);
  const exits: Promise<number>[] = [];
  return {
    exits,
    spawn: (): Worker => {
      const worker = new Worker(path, { type: "module" });
      exits.push(
        new Promise<number>((resolve) => {
          worker.addEventListener("close", (event) => resolve((event as CloseEvent).code));
        }),
      );
      return worker;
    },
  };
}

async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  let timer: Timer | null = null;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true as const,
    () => true as const,
  );
  const result = await Promise.race([settled, timeout]);
  if (timer != null) {
    clearTimeout(timer);
  }
  return result;
}

describe("cancelled ingest", () => {
  test("skips the derived-state refresh and leaves it to the next sync that ingests", () => {
    const config = freshConfig();
    const ingestConfig: IngestConfig = { claudeDir: config.claudeDir, codexDir: config.codexDir };
    const sample = readFileSync(join(fixtureRoot, "claude", "sample.jsonl"), "utf8");
    const enriched = readFileSync(join(fixtureRoot, "claude", "enriched.jsonl"), "utf8");
    writeFileSync(join(config.claudeDir, "a.jsonl"), sample);
    writeFileSync(join(config.claudeDir, "b.jsonl"), enriched);
    const db = openDb(config.dbPath);
    const recommendations = (): number =>
      (db.query("SELECT COUNT(*) AS n FROM recommendation").get() as { n: number }).n;

    let checks = 0;
    const cancel = {
      get aborted(): boolean {
        checks += 1;
        return checks > 1;
      },
    };
    expect(sync(db, ingestConfig, cancel)).toMatchObject({ ingested: 1, cancelled: true });
    expect(recommendations()).toBe(0);

    expect(sync(db, ingestConfig)).toMatchObject({ ingested: 1, skipped: 1, cancelled: false });
    expect(recommendations()).toBeGreaterThan(0);
    closeDb(db);
  });
});

describe("sync worker shutdown", () => {
  test("rejects when the worker exits without reporting", async () => {
    const config = freshConfig();
    const { spawn, exits } = trackedSpawner("exitsEarly");

    const run = runSyncWorker(config, { aborted: false }, undefined, { spawn });

    expect(await settlesWithin(run, 2_000)).toBe(true);
    await expect(run).rejects.toThrow("sync worker exited with code 3");
    expect(await exits[0]).toBe(3);
  });

  test("lets a worker that honors cancel finish within the grace without terminating it", async () => {
    const config = freshConfig();
    const { spawn, exits } = trackedSpawner("honorsCancel");
    const cancel = { aborted: false };

    const run = runSyncWorker(config, cancel, undefined, { spawn, cancelGraceMs: 5_000 });
    cancel.aborted = true;

    expect(await run).toEqual(CANCELLED_REPORT);
    expect(await exits[0]).toBe(0);
  });

  test("terminates a worker that ignores cancel once the grace runs out", async () => {
    const config = freshConfig();
    const { spawn, exits } = trackedSpawner("ignoresCancel");
    const cancel = { aborted: false };
    const progress: unknown[] = [];

    const run = runSyncWorker(config, cancel, (update) => progress.push(update), {
      spawn,
      cancelGraceMs: 100,
    });
    await Bun.sleep(50);
    expect(await settlesWithin(run, 300)).toBe(false);
    const cancelledAt = performance.now();
    cancel.aborted = true;

    await expect(run).rejects.toBeInstanceOf(SyncWorkerStopTimeoutError);
    expect(performance.now() - cancelledAt).toBeGreaterThanOrEqual(90);
    expect(performance.now() - cancelledAt).toBeLessThan(1_500);
    expect(await settlesWithin(exits[0] as Promise<number>, 2_000)).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
  });

  test("server stop() is bounded by the grace when the sync worker ignores cancel", async () => {
    const config = freshConfig();
    const { spawn, exits } = trackedSpawner("ignoresCancel");
    const server = serve({
      config,
      port: 0,
      economicsComputeVectors: async () => [],
      syncRunner: (workerConfig, cancel, onProgress) =>
        runSyncWorker(workerConfig, cancel, onProgress, { spawn, cancelGraceMs: 200 }),
    });
    const events = await fetch(`http://127.0.0.1:${server.port}/api/events`);
    const reader = events.body?.getReader();
    await reader?.read();
    const pendingRequest = fetch(`http://127.0.0.1:${server.port}/api/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch((error: unknown) => error);
    while (exits.length === 0) {
      await Bun.sleep(5);
    }
    expect(eventClientCount()).toBe(1);

    const stopping = server.stop(true);

    expect(await settlesWithin(stopping, 3_000)).toBe(true);
    await stopping;
    expect(await settlesWithin(exits[0] as Promise<number>, 2_000)).toBe(true);
    expect(eventClientCount()).toBe(0);
    await pendingRequest;
    await reader?.cancel().catch(() => {});
  });

  test("watch stop() is bounded by the grace and still reports that it stopped", async () => {
    const config = freshConfig();
    const { spawn, exits } = trackedSpawner("ignoresCancel");
    const events: WatchEvent[] = [];
    const handle = startWatch({
      config,
      intervalMs: 0,
      enableWatch: false,
      onEvent: (event) => events.push(event),
      runner: (workerConfig, status, cancel, onProgress) =>
        workerSyncRunner(workerConfig, status, cancel, onProgress, (c, flag, progress) => ({
          promise: runSyncWorker(c, flag, progress, { spawn, cancelGraceMs: 200 }),
          owned: true,
        })),
    });
    while (exits.length === 0) {
      await Bun.sleep(5);
    }

    const stopping = handle.stop();

    expect(await settlesWithin(stopping, 3_000)).toBe(true);
    expect(events.at(-1)?.type).toBe("stopped");
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(await settlesWithin(exits[0] as Promise<number>, 2_000)).toBe(true);
  });
});

describe("token economics worker shutdown", () => {
  test("abort terminates a stats worker that ignores cancel", async () => {
    const { spawn, exits } = trackedSpawner("silent");
    const abort = new AbortController();

    const run = computeVectorsInWorker("unused.db", { signal: abort.signal }, spawn);
    await Bun.sleep(50);
    abort.abort();

    expect(await settlesWithin(run, 1_000)).toBe(true);
    await expect(run).rejects.toThrow("aborted");
    expect(await settlesWithin(exits[0] as Promise<number>, 2_000)).toBe(true);
  });

  test("rejects when the stats worker exits without reporting", async () => {
    const { spawn } = trackedSpawner("exitsEarly");

    const run = computeVectorsInWorker(
      "unused.db",
      { signal: new AbortController().signal },
      spawn,
    );

    expect(await settlesWithin(run, 2_000)).toBe(true);
    await expect(run).rejects.toThrow("token economics worker exited with code 3");
  });
});
