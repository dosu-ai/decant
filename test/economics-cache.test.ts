import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { EconomicsCache } from "../src/economics-cache.ts";
import { upsertSession } from "../src/ingest.ts";
import { handleRequest } from "../src/server.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { computeSessionEconomicsVectors, tokenEconomics } from "../src/token-economics.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-economics-cache-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let dbCounter = 0;
function seededDbPath(): string {
  dbCounter += 1;
  const path = join(workDir, `economics-${dbCounter}.db`);
  const db = openDb(path);
  upsertSession(
    db,
    parseClaudeSession("sess-enr-claude", fixture("claude", "enriched.jsonl")),
    "/x/claude.jsonl",
    1,
    2,
    "claude",
  );
  db.close();
  return path;
}

function fixture(tool: "claude" | "codex", name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", tool, name), "utf8");
}

function inProcessComputeVectors(path: string) {
  const worker = new Database(path, { readonly: true, strict: true });
  try {
    return computeSessionEconomicsVectors(worker);
  } finally {
    worker.close();
  }
}

/** A computeVectors fake that counts calls and computes in-process (no real
 * Worker), for tests that only care about cache orchestration. */
function countingComputeVectors(counter: { calls: number }) {
  return (path: string) => {
    counter.calls += 1;
    return Promise.resolve(inProcessComputeVectors(path));
  };
}

describe("economics cache", () => {
  test("serves tokenEconomics-identical answers from one computation", async () => {
    const dbPath = seededDbPath();
    const db = openDb(dbPath);
    const counter = { calls: 0 };
    const cache = new EconomicsCache({
      dbPath,
      db,
      computeVectors: countingComputeVectors(counter),
    });

    expect(await cache.get()).toEqual(tokenEconomics(db));
    expect(await cache.get({ from: "2026-05-04", to: "2026-05-04" })).toEqual(
      tokenEconomics(db, { from: "2026-05-04", to: "2026-05-04" }),
    );
    expect(await cache.get({ from: "2030-01-01", to: null })).toEqual(
      tokenEconomics(db, { from: "2030-01-01" }),
    );
    expect(counter.calls).toBe(1);
    cache.dispose();
    db.close();
  });

  test("detects external writes, serves stale, then rebuilds and notifies", async () => {
    const dbPath = seededDbPath();
    const db = openDb(dbPath);
    const counter = { calls: 0 };
    let rebuilt = 0;
    const cache = new EconomicsCache({
      dbPath,
      db,
      onRebuilt: () => {
        rebuilt += 1;
      },
      computeVectors: countingComputeVectors(counter),
    });

    const first = await cache.get();
    expect(counter.calls).toBe(1);
    expect(rebuilt).toBe(0);

    // Simulate a sync worker: another connection ingests a session.
    const writer = openDb(dbPath);
    upsertSession(
      writer,
      parseCodexSession("sess-enr-codex", fixture("codex", "enriched.jsonl"), new Map()),
      "/x/codex.jsonl",
      1,
      2,
      "codex",
    );
    writer.close();
    // The main connection has to touch the database once before data_version
    // reflects the external commit.
    db.query("SELECT COUNT(*) FROM session").get();

    const stale = await cache.get();
    expect(stale).toEqual(first);
    await cache.settled();
    expect(counter.calls).toBe(2);
    expect(rebuilt).toBe(1);
    expect(await cache.get()).toEqual(tokenEconomics(db));
    cache.dispose();
    db.close();
  });

  test("invalidate() kicks a rebuild without a request", async () => {
    const dbPath = seededDbPath();
    const db = openDb(dbPath);
    const counter = { calls: 0 };
    const cache = new EconomicsCache({
      dbPath,
      db,
      computeVectors: countingComputeVectors(counter),
    });
    cache.invalidate();
    await cache.settled();
    expect(counter.calls).toBe(1);
    expect(await cache.get()).toEqual(tokenEconomics(db));
    expect(counter.calls).toBe(1);
    cache.dispose();
    db.close();
  });

  test("invalidate() during an in-flight rebuild schedules an immediate follow-up", async () => {
    const dbPath = seededDbPath();
    const db = openDb(dbPath);
    const counter = { calls: 0 };
    let rebuilt = 0;
    // Captured before the ingest below, standing in for a worker whose read
    // already happened by the time invalidate() fires mid-build — the case
    // where naive coalescing would leave the cache pinned to a stale answer.
    const preIngestVectors = inProcessComputeVectors(dbPath);
    const gate = Promise.withResolvers<void>();
    const cache = new EconomicsCache({
      dbPath,
      db,
      onRebuilt: () => {
        rebuilt += 1;
      },
      computeVectors: async (path) => {
        counter.calls += 1;
        if (counter.calls === 1) {
          await gate.promise;
          return preIngestVectors;
        }
        return inProcessComputeVectors(path);
      },
    });

    cache.prewarm(); // build #1: blocked on gate, will resolve with stale data
    upsertSession(
      db,
      parseCodexSession("sess-enr-codex", fixture("codex", "enriched.jsonl"), new Map()),
      "/x/codex.jsonl",
      1,
      2,
      "codex",
    );
    // Must NOT be silently coalesced into build #1, which already committed
    // to answering with the pre-ingest snapshot.
    cache.invalidate();
    gate.resolve();
    await cache.settled();

    expect(counter.calls).toBe(2);
    expect(rebuilt).toBe(1);
    expect(await cache.get()).toEqual(tokenEconomics(db));
    cache.dispose();
    db.close();
  });

  test("dispose() aborts an in-flight rebuild and settled() awaits provider cleanup", async () => {
    const dbPath = seededDbPath();
    const db = openDb(dbPath);
    const sawAbort = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    const cache = new EconomicsCache({
      dbPath,
      db,
      computeVectors: (_path, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort.resolve();
            void releaseCleanup.promise.then(() => reject(new Error("aborted")));
          });
        }),
    });

    cache.prewarm();
    cache.dispose();
    await sawAbort.promise;
    let settled = false;
    const settling = cache.settled().then(() => {
      settled = true;
    });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    releaseCleanup.resolve();
    await settling;
    db.close();
  });

  test("dispose() bounds shutdown when a provider ignores cancellation", async () => {
    const dbPath = seededDbPath();
    const db = openDb(dbPath);
    const cache = new EconomicsCache({
      dbPath,
      db,
      settleTimeoutMs: 5,
      computeVectors: () => new Promise(() => {}),
    });

    cache.prewarm();
    cache.dispose();
    await Promise.race([
      cache.settled(),
      Bun.sleep(100).then(() => {
        throw new Error("settled timed out");
      }),
    ]);
    db.close();
  });

  test("stats worker computes the same vectors as an in-process run", async () => {
    const dbPath = seededDbPath();
    const cache = new EconomicsCache({ dbPath, db: openDb(dbPath) });
    const viaWorker = await cache.get();
    const direct = openDb(dbPath);
    expect(viaWorker).toEqual(tokenEconomics(direct));
    direct.close();
    cache.dispose();
  });

  test("stats worker acknowledges cooperative cancellation after closing SQLite", async () => {
    const dbPath = seededDbPath();
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    Atomics.store(new Int32Array(cancelBuffer), 0, 1);
    const worker = new Worker(new URL("../src/stats-worker.ts", import.meta.url), {
      type: "module",
    });
    const result = await Promise.race([
      new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        worker.addEventListener(
          "message",
          (event) => resolve(event.data as { ok: boolean; error?: string }),
          { once: true },
        );
        worker.addEventListener(
          "error",
          (event) =>
            reject(event.error instanceof Error ? event.error : new Error(String(event.error))),
          { once: true },
        );
        worker.postMessage({ dbPath, cancelBuffer });
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("stats worker did not acknowledge cancellation")), 2_000),
      ),
    ]);

    expect(result).toEqual({ ok: false, error: "aborted" });
  });

  test("dispose settles the default stats-worker path cooperatively", async () => {
    const dbPath = seededDbPath();
    const db = openDb(dbPath);
    const cache = new EconomicsCache({ dbPath, db });

    cache.prewarm();
    cache.dispose();
    await Promise.race([
      cache.settled(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("default stats worker did not settle")), 2_000),
      ),
    ]);
    db.close();
  });

  test("token-economics route answers from the cache when provided", async () => {
    const dbPath = seededDbPath();
    const db = openDb(dbPath);
    const config = {
      dbPath,
      claudeDir: join(workDir, "none"),
      codexDir: join(workDir, "none"),
      geminiDir: join(workDir, "none"),
    };
    const cache = new EconomicsCache({
      dbPath,
      db,
      computeVectors: countingComputeVectors({ calls: 0 }),
    });
    const response = await handleRequest(
      new Request("http://127.0.0.1:3000/api/analytics/token-economics"),
      config,
      { db, economics: cache },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(tokenEconomics(db))));
    cache.dispose();
    db.close();
  });
});
