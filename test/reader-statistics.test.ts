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
      writer.exec("BEGIN IMMEDIATE; INSERT INTO t VALUES (1, -1);");
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
    statistics.onProgress(progress(500));
    expect(reloads).toEqual([26]);
  });

  test("waits for the ingested count to double before the next reload", () => {
    const { statistics, reloads, store } = tracker();
    const firstReload = 26;
    const secondReload = firstReload * 2;
    const thirdReload = secondReload * 2;
    expect([firstReload, secondReload, thirdReload]).toEqual([26, 52, 104]);
    store("at 26");
    statistics.onProgress(progress(firstReload));
    store("at 50");
    statistics.onProgress(progress(secondReload - 1));
    expect(reloads).toEqual([firstReload]);
    statistics.onProgress(progress(secondReload));
    expect(reloads).toEqual([firstReload, secondReload]);
    store("at 75");
    statistics.onProgress(progress(thirdReload - 1));
    expect(reloads).toEqual([firstReload, secondReload]);
    statistics.onProgress(progress(thirdReload));
    expect(reloads).toEqual([firstReload, secondReload, thirdReload]);
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

  const SESSIONS_PER_WORKER_ANALYZE = 25;
  const FIRST_RELOAD_AT = SESSIONS_PER_WORKER_ANALYZE + 1;
  function doublingReloadPoints(first: number, total: number): number[] {
    const points: number[] = [];
    for (let at = first; at < total; at *= 2) {
      points.push(at);
    }
    return points;
  }

  const BLOCK_JOIN_PLAN = `EXPLAIN QUERY PLAN
    SELECT COUNT(*) FROM session s WHERE NOT EXISTS (
      SELECT 1 FROM message m JOIN block b ON b.message_id = m.id
      WHERE m.session_id = s.id AND m.role = 'user' AND b.type = 'text')`;
  function blockJoinPlanWithoutPinningASnapshot(db: Database): string {
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
    const server = openDb(dbPath);
    optimizeLongLivedConnection(server);
    const reader = new ReadConnection(dbPath);
    const worker = openDb(dbPath);
    try {
      expect(blockJoinPlanWithoutPinningASnapshot(server)).toContain("idx_block_type");
      expect(await reader.use(blockJoinPlanWithoutPinningASnapshot)).toContain("idx_block_type");

      const reloads: { scanned: number; server: string }[] = [];
      let readerPlanAtFirstReload = "";
      let scanned = 0;
      const statistics = new ReaderStatistics({
        stored: () => storedPlannerStatistics(server),
        reload: () => {
          rereadPlannerStatistics(server);
          reader.reloadStatistics();
          reloads.push({ scanned, server: blockJoinPlanWithoutPinningASnapshot(server) });
          if (reloads.length === 1) {
            void reader.use((db) => {
              readerPlanAtFirstReload = blockJoinPlanWithoutPinningASnapshot(db);
            });
          }
        },
      });
      const report = sync(worker, config, undefined, (update) => {
        scanned = update.scanned;
        statistics.onProgress(update);
      });
      expect(report.ingested).toBe(total);

      expect(reloads[0]?.scanned).toBe(FIRST_RELOAD_AT);
      expect(readerPlanAtFirstReload).toContain("idx_block_message");
      expect(readerPlanAtFirstReload).not.toContain("idx_block_type");
      for (const reload of reloads) {
        expect(reload.scanned).toBeLessThan(total);
        expect(reload.server).toContain("idx_block_message");
        expect(reload.server).not.toContain("idx_block_type");
      }
      const possibleReloadPoints = doublingReloadPoints(FIRST_RELOAD_AT, total);
      expect(possibleReloadPoints).toEqual([26, 52, 104]);
      expect(reloads.length).toBeLessThanOrEqual(possibleReloadPoints.length);
    } finally {
      reader.close();
      closeDb(worker);
      closeDb(server);
    }
  });
});
