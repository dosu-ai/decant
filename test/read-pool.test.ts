import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { closeDb, openDb } from "../src/db.ts";
import { upsertSession } from "../src/ingest.ts";
import { ReadConnection } from "../src/read-connection.ts";
import { regenerate } from "../src/recommendations.ts";
import type { RequestContext } from "../src/server/context.ts";
import {
  executeReadOp,
  READ_OPS,
  type ReadOpArgs,
  type ReadOpName,
} from "../src/server/read-ops.ts";
import { ReadPool, ReadPoolClosedError, type ReadWorkerLike } from "../src/server/read-pool.ts";
import { handleRequest, serve } from "../src/server.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-read-pool-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let caseCounter = 0;
function freshConfig(): Config {
  const root = join(workDir, `case-${++caseCounter}`);
  for (const dir of ["claude", "codex/sessions", "codex/archived_sessions", "gemini", "opencode"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  return {
    dbPath: join(root, "archive.db"),
    claudeDir: join(root, "claude"),
    codexDir: join(root, "codex"),
    geminiDir: join(root, "gemini"),
    opencodeDir: join(root, "opencode"),
    cursorDir: join(root, "cursor"),
    copilotDir: join(root, "copilot"),
    vscodeCopilotDir: join(root, "vscode"),
  };
}

function fixture(tool: "claude" | "codex", name: string): string {
  return readFileSync(join(import.meta.dir, "..", "fixtures", tool, name), "utf8");
}

function seededConfig(): Config {
  const config = freshConfig();
  const db = openDb(config.dbPath);
  upsertSession(
    db,
    parseClaudeSession("sess-claude-enriched", fixture("claude", "enriched.jsonl")),
    "/x/claude-enriched.jsonl",
    1,
    2,
    "claude",
  );
  upsertSession(
    db,
    parseCodexSession("sess-codex-enriched", fixture("codex", "enriched.jsonl"), new Map()),
    "/x/codex-enriched.jsonl",
    1,
    2,
    "codex",
  );
  regenerate(db);
  closeDb(db);
  return config;
}

/** In-process stand-in for a read worker: records what it is sent and lets the
 * test decide when and how each request is answered. */
class FakeWorker implements ReadWorkerLike {
  readonly sent: ({ type: string; id?: number; name?: string } & Record<string, unknown>)[] = [];
  terminated = false;
  answerClose = true;
  readonly #events = new EventTarget();

  addEventListener(type: string, listener: (event: never) => void): void {
    this.#events.addEventListener(type, listener as EventListener);
  }

  dispatchEvent(event: Event): void {
    this.#events.dispatchEvent(event);
  }

  postMessage(message: unknown): void {
    const typed = message as FakeWorker["sent"][number];
    this.sent.push(typed);
    if (typed.type === "close" && this.answerClose) {
      // A real worker closes its connection and its thread exits.
      queueMicrotask(() => this.exit());
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  runs(): { id: number; name: string }[] {
    return this.sent.filter((message) => message.type === "run") as { id: number; name: string }[];
  }

  reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  answer(id: number, value: unknown): void {
    this.reply({
      type: "result",
      id,
      ok: true,
      output: { type: "json", body: JSON.stringify(value) },
    });
  }

  exit(): void {
    this.dispatchEvent(new Event("close"));
  }

  crash(message: string): void {
    const event = new Event("error") as Event & { error: Error; message: string };
    Object.assign(event, { error: new Error(message), message });
    this.dispatchEvent(event);
  }
}

function fakeSpawner(): { spawn: () => ReadWorkerLike; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  return {
    workers,
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  };
}

async function tick(): Promise<void> {
  await Bun.sleep(0);
}

function request(path: string): Request {
  return new Request(`http://127.0.0.1:3000${path}`);
}

/** Search reports how long it took, which differs between any two runs. */
function withoutTiming<T extends { body: string } | null>(output: T): T {
  return output == null
    ? output
    : { ...output, body: output.body.replace(/"elapsed_ms":[0-9.]+/, '"elapsed_ms":0') };
}

describe("read operations on a worker", () => {
  // One call per operation, with arguments that reach real rows in the fixture.
  const calls: { [N in ReadOpName]: ReadOpArgs<N> } = {
    sessions: { limit: 50 },
    sessionSearchIndex: {},
    projects: {},
    session: { id: 1, messageLimit: null, messageOffset: 0 },
    sessionTokenEconomics: { id: 1 },
    sessionContextWindow: { id: 1 },
    sessionOutline: { id: 1 },
    sessionIssues: { id: 1 },
    search: { query: "the", filter: { includeSubagents: true, limit: 10 } },
    statsSummary: {},
    statsByDimension: { dimension: "model", filter: {} },
    activity: {},
    modelSparklines: {},
    tokenEconomics: {},
    files: { group: "path", op: null, limit: 25, filter: {} },
    toolCalls: { limit: 50 },
    toolUsage: { errorsOnly: false, limit: 50, filter: {} },
    mcpUsage: { limit: 50, filter: {} },
    analyticsReport: { filter: {} },
    sessionReport: { id: 1 },
  };

  test("cover every registered operation", () => {
    expect(Object.keys(calls).sort()).toEqual(Object.keys(READ_OPS).sort());
  });

  test("return exactly what the same operation returns inline", async () => {
    const config = seededConfig();
    const db = openDb(config.dbPath);
    const pool = new ReadPool({ dbPath: config.dbPath, size: 2 });
    try {
      for (const name of Object.keys(calls) as ReadOpName[]) {
        const args = calls[name];
        const inline = withoutTiming(await executeReadOp(db, name, args as never));
        const pooled = withoutTiming(await pool.run(name, args as never));
        expect({ name, output: pooled }).toEqual({ name, output: inline });
        expect(pooled).not.toBeNull();
      }
      // A missing session is null, not an error, on both paths.
      expect(await pool.run("session", { id: 999, messageLimit: null, messageOffset: 0 })).toBe(
        null,
      );
      expect(await pool.run("sessionReport", { id: 999 })).toBe(null);
    } finally {
      await pool.close();
      closeDb(db);
    }
  });

  test("see writes the server connection commits after the worker opened", async () => {
    const config = seededConfig();
    const db = openDb(config.dbPath);
    const pool = new ReadPool({ dbPath: config.dbPath, size: 1 });
    try {
      const before = JSON.parse((await pool.run("statsSummary", {}))?.body ?? "null") as {
        sessions: number;
      };
      db.query("DELETE FROM session WHERE id = 1").run();
      const after = JSON.parse((await pool.run("statsSummary", {}))?.body ?? "null") as {
        sessions: number;
      };
      expect(after.sessions).toBe(before.sessions - 1);
    } finally {
      await pool.close();
      closeDb(db);
    }
  });

  test("reject unknown operation names", async () => {
    const config = seededConfig();
    const pool = new ReadPool({ dbPath: config.dbPath, size: 1 });
    try {
      await expect(pool.run("nope" as ReadOpName, {} as never)).rejects.toThrow(
        "unknown read operation: nope",
      );
    } finally {
      await pool.close();
    }
  });
});

describe("read pool scheduling", () => {
  test("a read waiting on a worker does not hold up other requests", async () => {
    const config = seededConfig();
    const db = openDb(config.dbPath);
    const { spawn, workers } = fakeSpawner();
    const readPool = new ReadPool({ dbPath: config.dbPath, size: 1, spawn });
    const context: RequestContext = { db, readPool };
    try {
      const slow = handleRequest(request("/api/tools/usage"), config, context);
      await tick();
      expect(workers[0]?.runs().map((run) => run.name)).toEqual(["toolUsage"]);

      // Fast routes keep answering on the server connection meanwhile.
      const health = await handleRequest(request("/api/health"), config, context);
      expect(health.status).toBe(200);
      const bounds = await handleRequest(request("/api/date-bounds"), config, context);
      expect(bounds.status).toBe(200);

      const run = workers[0]?.runs()[0];
      workers[0]?.answer(run?.id ?? 0, [{ tool_name: "Read" }]);
      const response = await slow;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.json()).toEqual([{ tool_name: "Read" }]);
    } finally {
      await readPool.close();
      closeDb(db);
    }
  });

  test("the same read prefers the same worker and spills only to an idle one", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = new ReadPool({ dbPath: "unused.db", size: 2, spawn });
    try {
      const first = pool.run("statsSummary", { from: "2026-01-01" });
      await tick();
      const owner = workers.find((worker) => worker.runs().length === 1);
      expect(owner).toBeDefined();
      owner?.answer(owner.runs()[0]?.id ?? 0, {});
      await first;

      // Idle again: the repeat goes back to the worker that holds its cache.
      const repeat = pool.run("statsSummary", { from: "2026-01-01" });
      await tick();
      expect(owner?.runs()).toHaveLength(2);

      // Busy now: a second copy goes to the idle worker rather than queueing.
      const spill = pool.run("statsSummary", { from: "2026-01-01" });
      await tick();
      expect(owner?.runs()).toHaveLength(2);
      expect(workers.reduce((sum, worker) => sum + worker.runs().length, 0)).toBe(3);

      for (const worker of workers) {
        for (const run of worker.runs()) {
          worker.answer(run.id, {});
        }
      }
      await Promise.all([repeat, spill]);
    } finally {
      await pool.close();
    }
  });

  test("a busy archive in the worker still maps to a retryable 503", async () => {
    const config = seededConfig();
    const db = openDb(config.dbPath);
    const { spawn, workers } = fakeSpawner();
    const readPool = new ReadPool({ dbPath: config.dbPath, size: 1, spawn });
    try {
      const pending = handleRequest(request("/api/stats/summary"), config, { db, readPool });
      await tick();
      workers[0]?.reply({
        type: "result",
        id: workers[0].runs()[0]?.id,
        ok: false,
        error: { name: "SQLiteError", message: "database is locked", code: "SQLITE_BUSY" },
      });
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "archive_locked", retryable: true });
    } finally {
      await readPool.close();
      closeDb(db);
    }
  });

  test("a crashed worker fails its reads and the next read starts a new one", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = new ReadPool({ dbPath: "unused.db", size: 1, spawn });
    try {
      const doomed = pool.run("projects", {});
      await tick();
      workers[0]?.crash("worker blew up");
      await expect(doomed).rejects.toThrow("worker blew up");
      expect(workers[0]?.terminated).toBe(true);

      const retry = pool.run("projects", {});
      await tick();
      expect(workers).toHaveLength(2);
      expect(workers[1]?.sent[0]).toEqual({ type: "init", dbPath: "unused.db" });
      workers[1]?.answer(workers[1].runs()[0]?.id ?? 0, []);
      expect(await retry).toEqual({ type: "json", body: "[]" });
    } finally {
      await pool.close();
    }
  });

  test("prewarm starts every worker and has it open its connection", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = new ReadPool({ dbPath: "warm.db", size: 2, spawn });
    pool.prewarm();
    expect(workers.map((worker) => worker.sent)).toEqual([
      [{ type: "init", dbPath: "warm.db" }, { type: "warm" }],
      [{ type: "init", dbPath: "warm.db" }, { type: "warm" }],
    ]);
    await pool.close();
    pool.prewarm();
    expect(workers).toHaveLength(2);
  });

  test("a prewarmed real worker answers its first read", async () => {
    const config = seededConfig();
    const pool = new ReadPool({ dbPath: config.dbPath, size: 1 });
    try {
      pool.prewarm();
      const output = await pool.run("statsSummary", {});
      expect(JSON.parse(output?.body ?? "null")).toMatchObject({ sessions: 2 });
    } finally {
      await pool.close();
    }
  });

  test("reloadStatistics reaches every live worker", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = new ReadPool({ dbPath: "unused.db", size: 2, spawn });
    try {
      pool.reloadStatistics();
      expect(workers).toHaveLength(0);
      const read = pool.run("projects", {});
      await tick();
      pool.reloadStatistics();
      expect(workers[0]?.sent.at(-1)).toEqual({ type: "reload-statistics" });
      workers[0]?.answer(workers[0].runs()[0]?.id ?? 0, []);
      await read;
    } finally {
      await pool.close();
    }
  });

  test("close fails reads in flight, closes each worker, and refuses new reads", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = new ReadPool({ dbPath: "unused.db", size: 1, spawn, closeTimeoutMs: 50 });
    const pending = pool.run("projects", {}).catch((error: unknown) => error);
    await tick();
    const worker = workers[0];
    if (worker == null) {
      throw new Error("no worker spawned");
    }
    worker.answerClose = false;

    const started = performance.now();
    await pool.close();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(await pending).toBeInstanceOf(ReadPoolClosedError);
    expect(worker.sent.at(-1)).toEqual({ type: "close" });
    // It never confirmed, so the timeout terminated it.
    expect(worker.terminated).toBe(true);
    await expect(pool.run("projects", {})).rejects.toBeInstanceOf(ReadPoolClosedError);
  });

  test("the real worker closes its connection and exits on its own", async () => {
    const config = seededConfig();
    let exited = false;
    const pool = new ReadPool({
      dbPath: config.dbPath,
      size: 1,
      closeTimeoutMs: 5_000,
      spawn: () => {
        const worker = new Worker(new URL("../src/read-worker.ts", import.meta.url), {
          type: "module",
        });
        worker.addEventListener("close", () => {
          exited = true;
        });
        return worker as ReadWorkerLike;
      },
    });
    await pool.run("projects", {});
    const started = performance.now();
    await pool.close();
    // The thread exited before close() returned, and well inside the timeout,
    // so it was not terminated mid-query.
    expect(exited).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("a second close waits for the first to finish", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = new ReadPool({ dbPath: "unused.db", size: 1, spawn, closeTimeoutMs: 200 });
    pool.prewarm();
    const worker = workers[0];
    if (worker == null) {
      throw new Error("no worker spawned");
    }
    worker.answerClose = false;
    const first = pool.close();
    const second = pool.close();
    expect(second).toBe(first);
    const started = performance.now();
    await second;
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    expect(worker.terminated).toBe(true);
  });

  test("a worker that exits unexpectedly fails its reads and is replaced", async () => {
    const { spawn, workers } = fakeSpawner();
    const pool = new ReadPool({ dbPath: "unused.db", size: 1, spawn });
    try {
      const doomed = pool.run("projects", {});
      await tick();
      workers[0]?.exit();
      await expect(doomed).rejects.toThrow("read worker exited");
      const retry = pool.run("projects", {});
      await tick();
      expect(workers).toHaveLength(2);
      workers[1]?.answer(workers[1].runs()[0]?.id ?? 0, []);
      expect(await retry).toEqual({ type: "json", body: "[]" });
    } finally {
      await pool.close();
    }
  });

  test("once the pool is closing, reads are served from the server connection", async () => {
    const config = seededConfig();
    const db = openDb(config.dbPath);
    const { spawn } = fakeSpawner();
    const readPool = new ReadPool({ dbPath: config.dbPath, size: 1, spawn });
    try {
      const inline = await handleRequest(request("/api/stats/summary"), config, { db });
      await readPool.close();
      const response = await handleRequest(request("/api/stats/summary"), config, {
        db,
        readPool,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(await inline.text());
    } finally {
      closeDb(db);
    }
  });
});

describe("serve() with the read pool", () => {
  test("stop() resolves promptly while a request awaits a pooled read", async () => {
    const config = seededConfig();
    const { spawn, workers } = fakeSpawner();
    const server = serve({ config, port: 0, readPool: { spawn, size: 1, closeTimeoutMs: 50 } });
    const pending = fetch(`http://127.0.0.1:${server.port}/api/tools/usage`).catch(
      (error: unknown) => error,
    );
    for (let attempt = 0; attempt < 100 && (workers[0]?.runs().length ?? 0) === 0; attempt++) {
      await Bun.sleep(5);
    }
    expect(workers[0]?.runs().map((run) => run.name)).toEqual(["toolUsage"]);

    const started = performance.now();
    await server.stop(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    await pending;
  });

  test("a sync that ingested sessions has the workers reload planner statistics", async () => {
    const config = seededConfig();
    const { spawn, workers } = fakeSpawner();
    const server = serve({
      config,
      port: 0,
      readPool: { spawn, size: 2 },
      syncRunner: async () => ({
        scanned: 1,
        ingested: 1,
        skipped: 0,
        issues: 0,
        issuesByCode: {},
        failed: 0,
        cancelled: false,
      }),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      expect(workers).toHaveLength(2);
      for (const worker of workers) {
        expect(worker.sent.map((message) => message.type)).toContain("reload-statistics");
      }
    } finally {
      await server.stop(true);
    }
  });

  test("serves analytics through real workers", async () => {
    const config = seededConfig();
    const server = serve({ config, port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const [summary, tools, missing] = await Promise.all([
        fetch(`${base}/api/stats/summary`),
        fetch(`${base}/api/tools/usage`),
        fetch(`${base}/api/sessions/999`),
      ]);
      expect(summary.status).toBe(200);
      expect(((await summary.json()) as { sessions: number }).sessions).toBeGreaterThan(0);
      expect(tools.status).toBe(200);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "session_not_found" });
    } finally {
      await server.stop(true);
    }
  });
});

describe("read connection statistics", () => {
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
    const path = join(workDir, `stats-${++caseCounter}.db`);
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

  test("a reload picks up statistics another connection wrote", async () => {
    const { path, writer } = statsArchive();
    const connection = new ReadConnection(path);
    try {
      expect(await connection.use(plannedIndex)).toContain("t_kind");
      writer.exec("ANALYZE");
      // A read-only connection keeps the plans it chose until it reopens.
      expect(await connection.use(plannedIndex)).toContain("t_kind");
      connection.reloadStatistics();
      expect(await connection.use(plannedIndex)).toContain("t_grp");
    } finally {
      connection.close();
      writer.close();
    }
  });

  test("a reload waits for a read still using the connection", async () => {
    const { path, writer } = statsArchive();
    const connection = new ReadConnection(path);
    try {
      const gate = Promise.withResolvers<void>();
      const slow = connection.use(async (db) => {
        // Plan once first: a connection loads statistics with the schema, on
        // its first statement.
        const before = plannedIndex(db);
        await gate.promise;
        return [before, plannedIndex(db)];
      });
      writer.exec("ANALYZE");
      connection.reloadStatistics();
      // The slow read still holds the old connection, so this one shares it.
      expect(await connection.use(plannedIndex)).toContain("t_kind");
      gate.resolve();
      expect(await slow).toEqual([
        expect.stringContaining("t_kind"),
        expect.stringContaining("t_kind"),
      ]);
      expect(await connection.use(plannedIndex)).toContain("t_grp");
    } finally {
      connection.close();
      writer.close();
    }
  });
});
