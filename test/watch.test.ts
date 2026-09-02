import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { listSessions } from "../src/query.ts";
import {
  runSyncOnce,
  type SyncEvent,
  SyncStatusStore,
  startWatch,
  type WatchEvent,
  watchDirs,
} from "../src/watch.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-watch-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshConfig(): Config {
  caseCounter += 1;
  const root = join(workDir, `case-${caseCounter}`);
  const claudeDir = join(root, "claude", "projects");
  const codexDir = join(root, "codex");
  const cursorDir = join(root, "cursor", "chats");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  mkdirSync(cursorDir, { recursive: true });
  return {
    dbPath: join(root, "archive.db"),
    claudeDir,
    codexDir,
    cursorDir,
  };
}

function seedClaude(config: Config, name = "sample.jsonl"): void {
  const content = readFileSync(join(import.meta.dir, "..", "fixtures", "claude", name), "utf8");
  const path = join(config.claudeDir, "Users-dev-proj", name);
  mkdirSync(join(config.claudeDir, "Users-dev-proj"), { recursive: true });
  writeFileSync(path, content);
}

function onceSync(events: WatchEvent[]): Promise<SyncEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for sync event; saw ${events.length} events`));
    }, 2_000);
    const check = (): void => {
      const event = events.find((candidate): candidate is SyncEvent => candidate.type === "sync");
      if (event != null) {
        clearTimeout(timeout);
        resolve(event);
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });
}

describe("watch mode", () => {
  test("watchDirs returns existing source directories only", () => {
    const config = freshConfig();
    expect(watchDirs(config)).toEqual([
      config.claudeDir,
      join(config.codexDir, "sessions"),
      config.cursorDir,
    ]);
  });

  test("runSyncOnce updates status around a real ingest", () => {
    const config = freshConfig();
    seedClaude(config);
    const status = new SyncStatusStore();

    const report = runSyncOnce(config, status);
    expect(report).toMatchObject({ scanned: 1, ingested: 1, cancelled: false });
    expect(status.snapshot()).toMatchObject({
      in_progress: false,
      ingested_count: 1,
      last_error: null,
      runs: 1,
    });

    const db = openDb(config.dbPath);
    expect(listSessions(db)).toHaveLength(1);
    db.close();
  });

  test("runSyncOnce creates the archive directory owner-only", () => {
    const base = freshConfig();
    const config = { ...base, dbPath: join(dirname(base.dbPath), "archive", "decant.db") };

    runSyncOnce(config);

    expect(statSync(dirname(config.dbPath)).mode & 0o7777).toBe(0o700);
    expect(statSync(config.dbPath).mode & 0o7777).toBe(0o600);
  });

  test("runSyncOnce records open failures", () => {
    const config = freshConfig();
    const status = new SyncStatusStore();
    const open = (): Database => {
      throw new Error("cannot open");
    };

    expect(() => runSyncOnce(config, status, { aborted: false }, open)).toThrow("cannot open");
    expect(status.snapshot()).toMatchObject({
      in_progress: false,
      last_error: "cannot open",
      runs: 1,
    });
  });

  test("manual trigger ingests without overlapping the long-running watcher", async () => {
    const config = freshConfig();
    seedClaude(config);
    const events: WatchEvent[] = [];
    const handle = startWatch({
      config,
      enableWatch: false,
      intervalMs: 0,
      syncOnStart: false,
      onEvent: (event) => events.push(event),
    });

    handle.trigger("manual");
    const event = await onceSync(events);
    expect(event.reason).toBe("manual");
    expect(event.report.ingested).toBe(1);
    await handle.stop();
    expect(events.at(-1)?.type).toBe("stopped");
  });

  test("startWatch delegates syncs to an injected runner", async () => {
    const config = freshConfig();
    const events: WatchEvent[] = [];
    const runnerCalls: string[] = [];
    const handle = startWatch({
      config,
      enableWatch: false,
      intervalMs: 0,
      syncOnStart: false,
      onEvent: (event) => events.push(event),
      runner: (runnerConfig, status, _cancel, onProgress) => {
        runnerCalls.push(runnerConfig.dbPath);
        status.start();
        onProgress({ scanned: 1, ingested: 1, skipped: 0, failed: 0, total: 3 });
        const report = {
          scanned: 3,
          ingested: 2,
          skipped: 1,
          issues: 0,
          issuesByCode: {},
          failed: 0,
          cancelled: false,
        };
        status.finishOk(report);
        return Promise.resolve(report);
      },
    });

    handle.trigger("manual");
    const event = await onceSync(events);
    expect(runnerCalls).toEqual([config.dbPath]);
    expect(event.report.ingested).toBe(2);
    expect(event.status.last_report).toContain("ingested 2");
    expect(events).toContainEqual({
      type: "sync_progress",
      reason: "manual",
      progress: { scanned: 1, ingested: 1, skipped: 0, failed: 0, total: 3 },
      status: expect.objectContaining({ in_progress: true }),
    });
    await handle.stop();
  });

  test("a watcher that joins another owner does not emit duplicate terminal events", async () => {
    const config = freshConfig();
    const events: WatchEvent[] = [];
    const handle = startWatch({
      config,
      enableWatch: false,
      intervalMs: 0,
      syncOnStart: false,
      onEvent: (event) => events.push(event),
      runner: async (_runnerConfig, status) => {
        status.start();
        const report = {
          scanned: 1,
          ingested: 1,
          skipped: 0,
          issues: 0,
          issuesByCode: {},
          failed: 0,
          cancelled: false,
        };
        status.finishOk(report);
        return { report, emitTerminal: false };
      },
    });

    handle.trigger("watch");
    for (let attempt = 0; attempt < 100 && handle.status.snapshot().runs === 0; attempt += 1) {
      await Bun.sleep(2);
    }
    expect(handle.status.snapshot().runs).toBe(1);
    expect(events.some((event) => event.type === "sync")).toBe(false);
    await handle.stop();
  });

  test("a watcher that joins another owner does not emit duplicate terminal errors", async () => {
    const config = freshConfig();
    const events: WatchEvent[] = [];
    const handle = startWatch({
      config,
      enableWatch: false,
      intervalMs: 0,
      syncOnStart: false,
      onEvent: (event) => events.push(event),
      runner: async (_runnerConfig, status) => {
        status.start();
        const error = new Error("owned elsewhere");
        status.finishErr(error.message);
        return { error, emitTerminal: false };
      },
    });

    handle.trigger("watch");
    for (let attempt = 0; attempt < 100 && handle.status.snapshot().runs === 0; attempt += 1) {
      await Bun.sleep(2);
    }
    expect(handle.status.snapshot().runs).toBe(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    await handle.stop();
  });

  test("periodic sweep is enough to ingest when native watch is disabled", async () => {
    const config = freshConfig();
    seedClaude(config);
    const events: WatchEvent[] = [];
    const handle = startWatch({
      config,
      enableWatch: false,
      intervalMs: 20,
      syncOnStart: false,
      onEvent: (event) => events.push(event),
    });

    const event = await onceSync(events);
    expect(event.reason).toBe("sweep");
    expect(event.report.ingested).toBe(1);
    await handle.stop();
  });
});
