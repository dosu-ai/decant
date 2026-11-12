import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  openDb,
  optimizeLongLivedConnection,
  reloadPlannerStatistics,
} from "../src/db.ts";
import { type IngestConfig, type SyncProgress, sync } from "../src/ingest.ts";
import { ReadConnection } from "../src/read-connection.ts";
import {
  ReaderStatistics,
  rereadPlannerStatistics,
  storedPlannerStatistics,
} from "../src/server/reader-statistics.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-reader-statistics-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshCase(): string {
  const dir = join(workDir, `case-${++caseCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function progress(ingested: number): SyncProgress {
  return { scanned: ingested, ingested, skipped: 0, failed: 0, total: 1000 };
}

describe("planner statistics helpers", () => {
  // With no statistics SQLite guesses the low-cardinality `kind` index; once
  // ANALYZE records that `grp` is nearly unique, it should switch to it.
  function plannedIndex(db: Database): string {
    return (
      db.query("EXPLAIN QUERY PLAN SELECT * FROM t WHERE kind = 1 AND grp = 5").get() as {
        detail: string;
      }
    ).detail;
  }

  function statsArchive(): { path: string; writer: Database } {
    const path = join(freshCase(), "stats.db");
    const writer = new Database(path);
    writer.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE t(kind, grp); " +
        "CREATE INDEX t_grp ON t(grp); CREATE INDEX t_kind ON t(kind);",
    );
    const insert = writer.prepare("INSERT INTO t VALUES (?, ?)");
    writer.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        insert.run(i % 2, i);
      }
    })();
    return { path, writer };
  }

  test("stored statistics are empty until an ANALYZE and change with the data", () => {
    const { path, writer } = statsArchive();
    const reader = new Database(path, { readonly: true });
    try {
      expect(storedPlannerStatistics(reader)).toBe("");
      writer.exec("ANALYZE");
      const first = storedPlannerStatistics(reader);
      expect(first).toContain("t_grp");
      expect(storedPlannerStatistics(reader)).toBe(first);
      writer.exec("DELETE FROM t WHERE grp >= 100; ANALYZE");
      expect(storedPlannerStatistics(reader)).not.toBe(first);
    } finally {
      reader.close();
      writer.close();
    }
  });

  test("a reread loads statistics while another connection holds the write lock", () => {
    const { path, writer } = statsArchive();
    const server = new Database(path);
    const reader = new Database(path, { readonly: true });
    try {
      expect(plannedIndex(server)).toContain("t_kind");
      expect(plannedIndex(reader)).toContain("t_kind");
      writer.exec("ANALYZE");
      // A sync worker holds the write lock for most of a sync.
      writer.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (1, -1);");
      // ANALYZE sqlite_schema needs that lock, so it reloads nothing here.
      reloadPlannerStatistics(server);
      expect(plannedIndex(server)).toContain("t_kind");

      rereadPlannerStatistics(server);
      rereadPlannerStatistics(reader);
      expect(plannedIndex(server)).toContain("t_grp");
      expect(plannedIndex(reader)).toContain("t_grp");
      writer.exec("COMMIT");
    } finally {
      reader.close();
      server.close();
      writer.close();
    }
  });
});

describe("reader statistics", () => {
  function tracker(initial = ""): {
    statistics: ReaderStatistics;
    reloads: number[];
    store: (value: string) => void;
    reads: () => number;
  } {
    let stored = initial;
    let reads = 0;
    let ingested = 0;
    const reloads: number[] = [];
    const statistics = new ReaderStatistics({
      stored: () => {
        reads += 1;
        return stored;
      },
      reload: () => reloads.push(ingested),
    });
    const onProgress = statistics.onProgress.bind(statistics);
    statistics.onProgress = (update) => {
      ingested = update.ingested;
      onProgress(update);
    };
    return {
      statistics,
      reloads,
      store: (value) => {
        stored = value;
      },
      reads: () => reads,
    };
  }

  test("a reload that throws is tried again at the next update", () => {
    let stored = "";
    let fail = true;
    let reloads = 0;
    const statistics = new ReaderStatistics({
      stored: () => stored,
      reload: () => {
        if (fail) {
          throw new Error("worker unavailable");
        }
        reloads += 1;
      },
    });
    stored = "first refresh";
    expect(() => statistics.onProgress(progress(26))).toThrow("worker unavailable");
    // The sync can go on skipping files, so the count may not move.
    expect(() => statistics.onProgress(progress(26))).toThrow("worker unavailable");
    fail = false;
    statistics.onProgress(progress(26));
    expect(reloads).toBe(1);
  });

  test("reloads once the sync has stored statistics the readers lack", () => {
    const { statistics, reloads, store } = tracker();
    statistics.onProgress(progress(0));
    statistics.onProgress(progress(25));
    expect(reloads).toEqual([]);
    store("first refresh");
    statistics.onProgress(progress(26));
    expect(reloads).toEqual([26]);
    // Unchanged statistics never reload, however far the sync gets.
    statistics.onProgress(progress(500));
    expect(reloads).toEqual([26]);
  });

  test("waits for the ingested count to double before the next reload", () => {
    const { statistics, reloads, store } = tracker();
    store("at 26");
    statistics.onProgress(progress(26));
    store("at 50");
    statistics.onProgress(progress(51));
    expect(reloads).toEqual([26]);
    statistics.onProgress(progress(52));
    expect(reloads).toEqual([26, 52]);
    store("at 75");
    statistics.onProgress(progress(103));
    expect(reloads).toEqual([26, 52]);
    statistics.onProgress(progress(104));
    expect(reloads).toEqual([26, 52, 104]);
  });

  test("keeps a minimum gap after a reload early in a sync", () => {
    const { statistics, reloads, store } = tracker();
    store("at 1");
    statistics.onProgress(progress(1));
    store("at 2");
    statistics.onProgress(progress(25));
    expect(reloads).toEqual([1]);
    statistics.onProgress(progress(26));
    expect(reloads).toEqual([1, 26]);
  });

  test("reads the stored statistics only when the sync has ingested more", () => {
    const { statistics, reads } = tracker();
    const afterConstruction = reads();
    // A sweep that skips every unchanged file reports progress but writes nothing.
    for (let scanned = 0; scanned <= 400; scanned += 25) {
      statistics.onProgress({ scanned, ingested: 0, skipped: scanned, failed: 0, total: 400 });
    }
    expect(reads()).toBe(afterConstruction);
    statistics.onProgress(progress(3));
    statistics.onProgress(progress(3));
    expect(reads()).toBe(afterConstruction + 1);
  });

  test("starts over when the next sync begins", () => {
    const { statistics, reloads, store } = tracker();
    store("first sync");
    statistics.onProgress(progress(400));
    expect(reloads).toEqual([400]);
    // The first sync failed, so nothing marked the readers as loaded.
    statistics.onProgress(progress(0));
    store("second sync");
    statistics.onProgress(progress(5));
    expect(reloads).toEqual([400, 5]);
  });

  test("treats statistics the caller loaded itself as loaded", () => {
    const { statistics, reloads, store } = tracker();
    store("end of sync");
    statistics.markLoaded();
    statistics.onProgress(progress(30));
    expect(reloads).toEqual([]);
  });
});

describe("reader statistics during a first sync", () => {
  const sample = readFileSync(
    join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"),
    "utf8",
  );

  // An unpinned message-to-block join. Without statistics SQLite starts it
  // from every text block in the archive. Product queries may pin their own
  // plans, so the probe is written here and left free to follow statistics.
  const BLOCK_JOIN_PLAN = `EXPLAIN QUERY PLAN
    SELECT COUNT(*) FROM session s WHERE NOT EXISTS (
      SELECT 1 FROM message m JOIN block b ON b.message_id = m.id
      WHERE m.session_id = s.id AND m.role = 'user' AND b.type = 'text')`;
  function blockJoinPlan(db: Database): string {
    // Finalized rather than cached: bun:sqlite keeps this EXPLAIN active in its
    // statement cache, which pins the connection to the snapshot it first read.
    const statement = db.prepare(BLOCK_JOIN_PLAN);
    try {
      return (statement.all() as { detail: string }[]).map((row) => row.detail).join("\n");
    } finally {
      statement.finalize();
    }
  }

  test("the server and read connections plan with statistics before the sync ends", async () => {
    const dir = freshCase();
    const config: IngestConfig = { claudeDir: join(dir, "claude"), codexDir: join(dir, "codex") };
    const total = 120;
    const project = join(config.claudeDir, "-Users-dev-proj");
    mkdirSync(project, { recursive: true });
    for (let index = 0; index < total; index++) {
      const sessionId = `sess-first-sync-${index}`;
      writeFileSync(
        join(project, `${sessionId}.jsonl`),
        sample.replaceAll("sess-claude-1", sessionId),
      );
    }
    const dbPath = join(dir, "archive.db");
    // Open the long-lived connections the way serve does, before any sync.
    const server = openDb(dbPath);
    optimizeLongLivedConnection(server);
    const reader = new ReadConnection(dbPath);
    const worker = openDb(dbPath);
    try {
      expect(blockJoinPlan(server)).toContain("idx_block_type");
      expect(await reader.use(blockJoinPlan)).toContain("idx_block_type");

      const reloads: { scanned: number; server: string }[] = [];
      let readerPlanAtFirstReload = "";
      let scanned = 0;
      const statistics = new ReaderStatistics({
        stored: () => storedPlannerStatistics(server),
        reload: () => {
          rereadPlannerStatistics(server);
          reader.reloadStatistics();
          reloads.push({ scanned, server: blockJoinPlan(server) });
          if (reloads.length === 1) {
            // sync() is synchronous, so this read is the only one that can
            // reach the reader mid-sync: use() runs it before it first awaits.
            void reader.use((db) => {
              readerPlanAtFirstReload = blockJoinPlan(db);
            });
          }
        },
      });
      const report = sync(worker, config, undefined, (update) => {
        scanned = update.scanned;
        statistics.onProgress(update);
      });
      expect(report.ingested).toBe(total);

      // The worker first analyzes once 25 sessions are in.
      expect(reloads[0]?.scanned).toBe(26);
      expect(readerPlanAtFirstReload).toContain("idx_block_message");
      expect(readerPlanAtFirstReload).not.toContain("idx_block_type");
      for (const reload of reloads) {
        expect(reload.scanned).toBeLessThan(total);
        expect(reload.server).toContain("idx_block_message");
        expect(reload.server).not.toContain("idx_block_type");
      }
      // 26, 52 and 104 are the only counts a 120-session sync may reload at.
      expect(reloads.length).toBeLessThanOrEqual(3);
    } finally {
      reader.close();
      closeDb(worker);
      closeDb(server);
    }
  });
});
