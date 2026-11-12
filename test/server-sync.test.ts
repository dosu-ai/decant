import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { closeDb, openDb } from "../src/db.ts";
import type { EconomicsCache } from "../src/economics-cache.ts";
import type { SyncReport } from "../src/ingest.ts";
import { applyWatchEvent, noteArchiveOpened } from "../src/server/sync.ts";
import {
  createSyncCoordinator,
  handleRequest,
  type SyncWorkerRunner,
  workerSyncRunner,
} from "../src/server.ts";
import { SyncStatusStore } from "../src/watch.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-server-sync-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshConfig(): Config {
  caseCounter += 1;
  const root = join(workDir, `case-${caseCounter}`);
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  const geminiDir = join(root, "gemini");
  const opencodeDir = join(root, "opencode");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  mkdirSync(join(codexDir, "archived_sessions"), { recursive: true });
  mkdirSync(geminiDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });
  return {
    dbPath: join(root, "archive.db"),
    claudeDir,
    codexDir,
    geminiDir,
    opencodeDir,
    cursorDir: join(root, "cursor"),
    copilotDir: join(root, "copilot"),
    vscodeCopilotDir: join(root, "vscode"),
  };
}

describe("server sync coordination", () => {
  test("runs the completion hook once per successful physical sync", async () => {
    const config = freshConfig();
    const report = {
      scanned: 3,
      ingested: 3,
      skipped: 0,
      issues: 0,
      issuesByCode: {},
      failed: 0,
      cancelled: false,
    };
    let fail = false;
    const runner: SyncWorkerRunner = async () => {
      if (fail) {
        throw new Error("worker failed");
      }
      return report;
    };
    const completed: number[] = [];
    const coordinator = createSyncCoordinator(runner, {
      onCompleted: (finished) => {
        completed.push(finished.ingested);
        // A failing hook must not turn a committed sync into an error.
        throw new Error("statistics reload failed");
      },
    });

    const first = coordinator.run(config);
    const joined = coordinator.run(config);
    expect(joined).toBe(first);
    await expect(first).resolves.toEqual(report);
    expect(completed).toEqual([3]);

    fail = true;
    await expect(coordinator.run(config)).rejects.toThrow("worker failed");
    expect(completed).toEqual([3]);
    await coordinator.close();
  });

  test("coalesces overlapping runs and bounds progress updates", async () => {
    const config = freshConfig();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const runner: SyncWorkerRunner = async (_config, _cancel, onProgress) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      entered.resolve();
      await release.promise;
      for (let scanned = 0; scanned <= 100; scanned += 1) {
        onProgress?.({ scanned, ingested: 0, skipped: scanned, failed: 0, total: 100 });
      }
      active -= 1;
      return {
        scanned: 100,
        ingested: 0,
        skipped: 100,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: false,
      };
    };
    const coordinator = createSyncCoordinator(runner, {
      progressEveryFiles: 25,
      progressEveryMs: Number.POSITIVE_INFINITY,
      now: () => 0,
    });
    const firstProgress: number[] = [];
    const secondProgress: number[] = [];

    const first = coordinator.run(config, undefined, (progress) =>
      firstProgress.push(progress.scanned),
    );
    await entered.promise;
    const second = coordinator.run(config, undefined, (progress) =>
      secondProgress.push(progress.scanned),
    );
    expect(second).toBe(first);
    release.resolve();

    const [firstReport, secondReport] = await Promise.all([first, second]);
    expect(secondReport).toEqual(firstReport);
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);
    expect(firstProgress).toEqual([0, 25, 50, 75, 100]);
    expect(secondProgress).toEqual(firstProgress);
  });

  test("runs the progress hook with each update the listeners get", async () => {
    const config = freshConfig();
    const runner: SyncWorkerRunner = async (_config, _cancel, onProgress) => {
      for (let scanned = 0; scanned <= 100; scanned += 1) {
        onProgress?.({ scanned, ingested: scanned, skipped: 0, failed: 0, total: 100 });
      }
      return {
        scanned: 100,
        ingested: 100,
        skipped: 0,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: false,
      };
    };
    const order: string[] = [];
    const coordinator = createSyncCoordinator(runner, {
      progressEveryFiles: 25,
      progressEveryMs: Number.POSITIVE_INFINITY,
      now: () => 0,
      onProgress: (progress) => {
        order.push(`hook ${progress.ingested}`);
        // A failing hook must not fail the sync or starve its listeners.
        throw new Error("statistics reload failed");
      },
      onCompleted: () => order.push("completed"),
    });

    await coordinator.run(config, undefined, (progress) =>
      order.push(`listener ${progress.ingested}`),
    );
    expect(order).toEqual([
      ...[0, 25, 50, 75, 100].flatMap((count) => [`hook ${count}`, `listener ${count}`]),
      "completed",
    ]);
    await coordinator.close();
  });

  test("manual route joins the physical sync already owned by the watcher coordinator", async () => {
    const config = freshConfig();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const runner: SyncWorkerRunner = async (_config, _cancel, onProgress) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      entered.resolve();
      await release.promise;
      onProgress?.({ scanned: 0, ingested: 0, skipped: 0, failed: 0, total: 0 });
      active -= 1;
      return {
        scanned: 0,
        ingested: 0,
        skipped: 0,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: false,
      };
    };
    const coordinator = createSyncCoordinator(runner);
    const watcher = coordinator.run(config, { aborted: false }, () => {});
    await entered.promise;
    const joinedProgress: number[] = [];
    const joined = coordinator.runWithOwnership(config, undefined, (progress) =>
      joinedProgress.push(progress.scanned),
    );
    expect(joined.owned).toBe(false);
    expect(joined.promise).toBe(watcher);
    const manual = handleRequest(
      new Request("http://127.0.0.1:3000/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      config,
      { runSync: coordinator.run, syncCoordinator: coordinator },
    );
    release.resolve();

    const [response] = await Promise.all([manual, watcher]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scanned: 0, failed: 0 });
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);
    expect(joinedProgress).toEqual([]);
  });

  test("watcher joins a manual-owned physical sync without taking terminal ownership", async () => {
    const config = freshConfig();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const runner: SyncWorkerRunner = async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
      return {
        scanned: 1,
        ingested: 1,
        skipped: 0,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: false,
      };
    };
    const coordinator = createSyncCoordinator(runner);
    const manual = coordinator.runWithOwnership(config);
    expect(manual.owned).toBe(true);
    await entered.promise;

    const watcher = coordinator.runWithOwnership(config, { aborted: false }, () => {});
    expect(watcher.owned).toBe(false);
    expect(watcher.promise).toBe(manual.promise);
    release.resolve();

    expect(await watcher.promise).toMatchObject({ ingested: 1 });
    expect(calls).toBe(1);
  });

  test("watcher joining a failed manual-owned sync leaves terminal error ownership to manual", async () => {
    const config = freshConfig();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const runner: SyncWorkerRunner = async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
      throw new Error("fixture sync failed");
    };
    const coordinator = createSyncCoordinator(runner);
    const manual = coordinator.runWithOwnership(config);
    expect(manual.owned).toBe(true);
    await entered.promise;

    const status = new SyncStatusStore();
    const watcher = workerSyncRunner(
      config,
      status,
      { aborted: false },
      () => {},
      coordinator.runWithOwnership,
    );
    release.resolve();

    await expect(manual.promise).rejects.toThrow("fixture sync failed");
    const result = await watcher;
    expect(result).toMatchObject({ emitTerminal: false });
    expect("error" in result && result.error).toEqual(new Error("fixture sync failed"));
    expect(status.snapshot()).toMatchObject({
      in_progress: false,
      last_error: "fixture sync failed",
      runs: 1,
    });
    expect(calls).toBe(1);
  });

  test("coordinator close cancels and awaits a manual sync without a watcher cancel source", async () => {
    const config = freshConfig();
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const runner: SyncWorkerRunner = async (_config, cancel) => {
      calls += 1;
      entered.resolve();
      while (cancel?.aborted !== true) {
        await Bun.sleep(1);
      }
      cancelled.resolve();
      await release.promise;
      return {
        scanned: 0,
        ingested: 0,
        skipped: 0,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: true,
      };
    };
    const coordinator = createSyncCoordinator(runner);
    // An undefined external cancel source is the manual POST /api/sync case
    // when serve runs with --no-sync and therefore has no watcher.
    const manual = coordinator.run(config);
    await entered.promise;

    let closeResolved = false;
    const closing = coordinator.close().then(() => {
      closeResolved = true;
    });
    await cancelled.promise;
    await Bun.sleep(10);
    expect(closeResolved).toBe(false);

    release.resolve();
    await closing;
    expect(await manual).toMatchObject({ cancelled: true });
    expect(calls).toBe(1);
    await expect(coordinator.run(config)).rejects.toThrow("sync coordinator is closed");
  });

  test.each(["SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED_SHAREDCACHE"])(
    "maps extended SQLite contention code %s to a retryable service response",
    async (code) => {
      const response = await handleRequest(
        new Request("http://127.0.0.1:3000/api/analytics/token-economics"),
        freshConfig(),
        {
          economics: {
            get: () => Promise.reject(Object.assign(new Error("temporary contention"), { code })),
          } as never,
        },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "archive_locked",
        retryable: true,
      });
    },
  );
});

describe("sync status", () => {
  const report = {
    scanned: 4,
    ingested: 4,
    skipped: 0,
    issues: 0,
    issuesByCode: {},
    failed: 0,
    cancelled: false,
  };
  const economics = { invalidate() {} } as unknown as EconomicsCache;
  const idle = {
    last_sync_at: null,
    in_progress: false,
    last_report: null,
    last_error: null,
    ingested_count: null,
    runs: 0,
  };

  async function readStatus(config: Config): Promise<Record<string, unknown>> {
    const response = await handleRequest(
      new Request("http://127.0.0.1:3000/api/sync-status"),
      config,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  test("reports a manual sync's reason and latest progress while it runs", async () => {
    const config = freshConfig();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const progress = { scanned: 2, ingested: 2, skipped: 0, failed: 0, total: 4 };
    const runner: SyncWorkerRunner = async (_config, _cancel, onProgress) => {
      onProgress?.(progress);
      entered.resolve();
      await release.promise;
      return report;
    };
    const manual = handleRequest(
      new Request("http://127.0.0.1:3000/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      config,
      { runSync: runner },
    );
    await entered.promise;
    expect(await readStatus(config)).toMatchObject({
      in_progress: true,
      reason: "manual",
      progress,
    });

    release.resolve();
    expect((await manual).status).toBe(200);
    expect(await readStatus(config)).toMatchObject({
      in_progress: false,
      reason: null,
      progress: null,
      archive_synced: true,
    });
  });

  test("reports a watcher sync from its start, then its reason and progress", async () => {
    const config = freshConfig();
    const release = Promise.withResolvers<SyncReport>();
    const status = new SyncStatusStore();
    const run = workerSyncRunner(
      config,
      status,
      { aborted: false },
      () => {},
      () => ({ promise: release.promise, owned: true }),
    );
    // No progress event yet: the server knows a sync runs, not what started it.
    expect(await readStatus(config)).toMatchObject({
      in_progress: true,
      reason: null,
      progress: null,
    });

    const progress = { scanned: 1, ingested: 1, skipped: 0, failed: 0, total: 4 };
    applyWatchEvent(
      { type: "sync_progress", reason: "startup", progress, status: status.snapshot() },
      economics,
    );
    expect(await readStatus(config)).toMatchObject({
      in_progress: true,
      reason: "startup",
      progress,
    });

    release.resolve(report);
    await run;
    applyWatchEvent(
      { type: "sync", reason: "startup", report, status: status.snapshot() },
      economics,
    );
    expect(await readStatus(config)).toMatchObject({
      in_progress: false,
      reason: null,
      progress: null,
    });
  });

  test("a watcher run that joined another sync does not leave the status busy", async () => {
    const config = freshConfig();
    await workerSyncRunner(
      config,
      new SyncStatusStore(),
      { aborted: false },
      () => {},
      () => ({ promise: Promise.resolve(report), owned: false }),
    );
    expect(await readStatus(config)).toMatchObject({ in_progress: false });
  });

  test("a new archive counts as synced only after a sync completes", async () => {
    const config = freshConfig();
    const db = openDb(config.dbPath);
    try {
      noteArchiveOpened(db);
      expect(await readStatus(config)).toMatchObject({ archive_synced: false });

      // A failed sync and a cancelled one both leave the archive unfilled.
      applyWatchEvent(
        { type: "error", reason: "startup", error: "disk full", status: idle },
        economics,
      );
      applyWatchEvent(
        { type: "sync", reason: "sweep", report: { ...report, cancelled: true }, status: idle },
        economics,
      );
      expect(await readStatus(config)).toMatchObject({ archive_synced: false });

      applyWatchEvent({ type: "sync", reason: "sweep", report, status: idle }, economics);
      expect(await readStatus(config)).toMatchObject({ archive_synced: true });
    } finally {
      closeDb(db);
    }
  });

  test("an archive that already holds sessions opens as synced", async () => {
    const config = freshConfig();
    const db = openDb(config.dbPath);
    try {
      noteArchiveOpened(db);
      expect(await readStatus(config)).toMatchObject({ archive_synced: false });
      db.run("INSERT INTO ingest_source (path, tool) VALUES ('/synthetic/a.jsonl', 'claude_code')");
      noteArchiveOpened(db);
      expect(await readStatus(config)).toMatchObject({ archive_synced: true });
    } finally {
      closeDb(db);
    }
  });
});
