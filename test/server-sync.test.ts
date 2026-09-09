import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
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
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  mkdirSync(join(codexDir, "archived_sessions"), { recursive: true });
  mkdirSync(geminiDir, { recursive: true });
  return {
    dbPath: join(root, "archive.db"),
    claudeDir,
    codexDir,
    geminiDir,
  };
}

describe("server sync coordination", () => {
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

  test.each([
    "SQLITE_BUSY_SNAPSHOT",
    "SQLITE_LOCKED_SHAREDCACHE",
  ])("maps extended SQLite contention code %s to a retryable service response", async (code) => {
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
  });
});
