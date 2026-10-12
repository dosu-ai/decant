import { Database } from "bun:sqlite";
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
  watchRoots,
} from "../src/watch.ts";
import { buildOpenCodeFixtureDb } from "./opencode-fixture.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-watch-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshConfig(): Config {
  caseCounter += 1;
  const root = join(workDir, `case-${caseCounter}`);
  const claudeDir = join(root, "claude", "projects");
  const codexDir = join(root, "codex");
  const geminiDir = join(root, "gemini");
  const opencodeDir = join(root, "opencode");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  mkdirSync(geminiDir, { recursive: true });
  mkdirSync(opencodeDir, { recursive: true });
  return {
    dbPath: join(root, "archive.db"),
    claudeDir,
    codexDir,
    geminiDir,
    opencodeDir,
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
      config.geminiDir,
      config.opencodeDir,
    ]);
  });

  test("OpenCode roots react only to a changed database or -wal", () => {
    const base = freshConfig();
    const explicit = join(dirname(base.dbPath), "elsewhere", "custom.db");
    mkdirSync(dirname(explicit), { recursive: true });
    const config: Config = { ...base, opencodeDb: explicit };
    const main = join(config.opencodeDir, "opencode.db");
    buildOpenCodeFixtureDb(main, ["sample.sql"]);
    buildOpenCodeFixtureDb(explicit, ["sample.sql"]);
    const roots = watchRoots(config);
    expect(roots.map((root) => [root.dir, root.recursive])).toEqual([
      [config.claudeDir, true],
      [join(config.codexDir, "sessions"), true],
      [config.geminiDir, true],
      [config.opencodeDir, false],
      [dirname(explicit), false],
    ]);
    const [claude, , , data, other] = roots;
    expect(claude?.accepts(null)).toBe(true);
    expect(claude?.accepts("Users-dev-proj/sample.jsonl")).toBe(true);

    // Nothing changed since the watcher started: reads touch only -shm.
    for (const name of [null, "opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
      expect(data?.accepts(name)).toBe(false);
    }
    const write = (path: string): void => {
      const writer = new Database(path, { strict: true });
      writer.exec("UPDATE session_v2 SET title = title || '.' WHERE id = 'ses_sample'");
      writer.close();
    };
    write(main);
    for (const name of ["log/opencode.log", "opencode.db-journal", "notes.db", "custom.db-shm"]) {
      expect(data?.accepts(name)).toBe(false);
    }
    // A sidecar event is a hint; the database's own change is reported once.
    expect(data?.accepts("opencode.db-shm")).toBe(true);
    expect(data?.accepts("opencode.db-wal")).toBe(false);
    expect(data?.accepts(null)).toBe(false);
    write(main);
    expect(data?.accepts(null)).toBe(true);

    expect(other?.accepts("custom.db-wal")).toBe(false);
    write(explicit);
    expect(other?.accepts("opencode.db")).toBe(false);
    expect(other?.accepts("custom.db-wal")).toBe(true);
    expect(other?.accepts("custom.db")).toBe(false);
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
  test("an OpenCode database read does not retrigger the watcher", async () => {
    const config = freshConfig();
    const main = join(config.opencodeDir, "opencode.db");
    buildOpenCodeFixtureDb(main, ["sample.sql"]);
    // OpenCode keeps its database in WAL mode. With no other connection open,
    // Decant's read-only connection is the first one and rebuilds the -shm
    // index, which the watcher sees as a change beside the database.
    const setup = new Database(main, { strict: true });
    setup.exec("PRAGMA journal_mode = WAL;");
    setup.close();
    // OpenCode leaves its sidecars behind; a read-only connection needs them.
    writeFileSync(`${main}-wal`, "");
    writeFileSync(`${main}-shm`, "");
    // OpenCode also writes logs and snapshots under its data directory.
    mkdirSync(join(config.opencodeDir, "log"), { recursive: true });

    const events: WatchEvent[] = [];
    const handle = startWatch({
      config,
      intervalMs: 0,
      debounceMs: 50,
      syncOnStart: false,
      onEvent: (event) => events.push(event),
    });
    const syncs = (): SyncEvent[] =>
      events.filter((event): event is SyncEvent => event.type === "sync");
    try {
      // Let the native watcher settle; FSEvents can still deliver the setup
      // writes above, so count only the syncs that follow.
      await Bun.sleep(300);
      const baseline = syncs().length;
      handle.trigger("manual");
      for (
        let attempt = 0;
        attempt < 200 && !syncs().some((event) => event.reason === "manual");
        attempt += 1
      ) {
        await Bun.sleep(10);
      }
      expect(syncs().find((event) => event.reason === "manual")?.report.scanned).toBe(1);
      writeFileSync(join(config.opencodeDir, "log", "opencode.log"), "synthetic log line\n");
      writeFileSync(join(config.opencodeDir, "opencode.db-journal"), "");
      await Bun.sleep(1_000);
      // The manual sync, plus at most one straggler.
      expect(syncs().length - baseline).toBeLessThanOrEqual(2);

      // A committed write lands in opencode.db-wal and still triggers a sync.
      const before = syncs().length;
      const writer = new Database(main, { strict: true });
      writer.exec(
        `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
         VALUES ('msg_sample_5', 'ses_sample', 'user', 5, 1791786070000, 1791786070000,
                 '{"text":"And again.","time":{"created":1791786070000}}')`,
      );
      for (let attempt = 0; attempt < 200 && syncs().length === before; attempt += 1) {
        await Bun.sleep(10);
      }
      writer.close();
      expect(syncs().length).toBeGreaterThan(before);
      expect(syncs().at(-1)?.reason).toBe("watch");
      expect(syncs().some((event) => event.report.ingested === 1 && event.reason === "watch")).toBe(
        true,
      );
    } finally {
      await handle.stop();
    }
  });
});
