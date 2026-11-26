import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CorpusManifest,
  generateCorpus,
  generateLiveAppendChunk,
  type LiveAppenderState,
} from "../scripts/bench-corpus.ts";
import {
  acquireCorpusLock,
  allocatePrivateDir,
  cachedCorpusManifest,
  coalescingCheck,
  corpusDirFor,
  corpusLockPath,
  corpusNamespace,
  dockerUserArgs,
  ensurePrivateDir,
  isServeCommand,
  portableCorpusManifest,
  prepareLockedCorpus,
  readSessionRow,
  requireTracerRunning,
  type ServeStopOps,
  ServeSurvivedKillError,
  stopLaunchedServe,
  trustedCorpusManifest,
  withCorpusLock,
} from "../scripts/bench-ingest.ts";
import { closeDb, openDb } from "../src/db.ts";
import { type IngestConfig, type SyncReport, sync } from "../src/ingest.ts";

function configFor(manifest: CorpusManifest): IngestConfig {
  return {
    claudeDir: manifest.claudeDir,
    codexDir: manifest.codexDir,
    copilotDir: manifest.copilotDir,
  };
}

function expectCleanSync(report: SyncReport): void {
  expect(report.failed).toBe(0);
  expect(report.issuesByCode.unparsed_line ?? 0).toBe(0);
}

describe("bench corpus generator", () => {
  test("small corpus ingests cleanly and survives live appends", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "decant-bench-corpus-"));
    try {
      const manifest = await generateCorpus({
        outDir: join(tmp, "corpus"),
        profile: "small",
      });
      const dbPath = join(tmp, "archive.db");
      const db = openDb(dbPath);
      try {
        const config = configFor(manifest);
        expectCleanSync(sync(db, config));

        const counts = new Map(
          (
            db.query("SELECT tool, COUNT(*) AS n FROM session GROUP BY tool").all() as Array<{
              tool: string;
              n: number;
            }>
          ).map((row) => [row.tool, row.n]),
        );
        expect(counts.get("claude_code") ?? 0).toBeGreaterThan(0);
        expect(counts.get("codex") ?? 0).toBeGreaterThan(0);
        expect(counts.get("copilot") ?? 0).toBeGreaterThan(0);
        const cwds = (
          db.query("SELECT DISTINCT cwd FROM session WHERE cwd IS NOT NULL").all() as Array<{
            cwd: string;
          }>
        ).map((row) => row.cwd);
        expect(cwds.length).toBeGreaterThan(0);
        for (const cwd of cwds) {
          expect(cwd.startsWith("/synthetic-decant-bench/work/")).toBe(true);
        }

        const messageCount = (): number => {
          const row = db
            .query("SELECT message_count AS n FROM session WHERE source_session_id = ?1")
            .get(manifest.liveSession.sessionId) as { n: number } | null;
          return row?.n ?? 0;
        };

        const { filePath, initialBytes: _initialBytes, ...liveState } = manifest.liveSession;
        let state: LiveAppenderState = liveState;
        let previous = messageCount();
        expect(previous).toBeGreaterThan(0);

        for (const kind of ["tool_burst", "assistant_turn"] as const) {
          const marker = `bench-marker-${kind}`;
          const chunk = generateLiveAppendChunk(state, { kind, marker });
          expect(chunk.marker).toBe(marker);
          expect(chunk.lines.join("\n")).toContain(marker);
          appendFileSync(filePath, chunk.lines.map((line) => `${line}\n`).join(""));

          expectCleanSync(sync(db, config));
          const current = messageCount();
          expect(current).toBeGreaterThan(previous);
          const stored = db
            .query(
              `SELECT COUNT(*) AS n FROM block b JOIN session s ON s.id = b.session_id
                WHERE s.source_session_id = ?1 AND instr(b.text, ?2) > 0`,
            )
            .get(manifest.liveSession.sessionId, `${marker} `) as { n: number };
          expect(stored.n).toBeGreaterThan(0);
          previous = current;
          state = chunk.nextState;
        }

        const row = readSessionRow(dbPath, manifest.liveSession.sessionId);
        expect(row.id).toBeGreaterThan(0);
        expect(row.messageCount).toBe(previous);
        expect(() => readSessionRow(dbPath, "missing-session-id")).toThrow(/not in the archive/);
      } finally {
        closeDb(db);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("live append chunks", () => {
  const base: LiveAppenderState = {
    sessionId: "00000000-0000-4000-8000-00000000live",
    projectDir: "-synthetic-decant-bench-work-atlas",
    lastUuid: "00000000-0000-4000-8000-000000000000",
    lastTimestampMs: Date.UTC(2026, 10, 1),
    turnIndex: 3,
  };
  const ids = (lines: string[]): string[] =>
    lines.flatMap((line) => {
      const record = JSON.parse(line) as {
        uuid?: string;
        requestId?: string;
        message?: { id?: string; content?: unknown };
      };
      const content = Array.isArray(record.message?.content) ? record.message.content : [];
      const toolIds = content.flatMap((block: { id?: string; tool_use_id?: string }) =>
        [block.id, block.tool_use_id].filter((id): id is string => typeof id === "string"),
      );
      return [record.uuid, record.requestId, record.message?.id, ...toolIds].filter(
        (id): id is string => typeof id === "string",
      );
    });

  test("an explicit seed still gives each turn distinct ids and stays deterministic", () => {
    const first = generateLiveAppendChunk(base, { kind: "tool_burst", seed: 7 });
    const second = generateLiveAppendChunk(first.nextState, { kind: "tool_burst", seed: 7 });
    const firstIds = ids(first.lines);
    expect(firstIds.length).toBeGreaterThan(0);
    for (const id of ids(second.lines)) {
      expect(firstIds).not.toContain(id);
    }
    expect(generateLiveAppendChunk(base, { kind: "tool_burst", seed: 7 }).lines).toEqual(
      first.lines,
    );
    expect(generateLiveAppendChunk(base, { kind: "tool_burst", seed: 8 }).lines).not.toEqual(
      first.lines,
    );
  });
});

describe("bench corpus cache", () => {
  const dir = "/home/dev/.cache/decant-bench/corpus-pi-1";
  const manifest = {
    outDir: dir,
    claudeDir: `${dir}/claude`,
    codexDir: `${dir}/codex`,
    copilotDir: `${dir}/copilot`,
    liveSession: {
      filePath: `${dir}/claude/-home-dev-work-atlas/live.jsonl`,
      sessionId: "00000000-0000-4000-8000-00000000live",
      projectDir: "-home-dev-work-atlas",
      initialBytes: 1024,
      lastUuid: "00000000-0000-4000-8000-000000000001",
      lastTimestampMs: Date.UTC(2026, 10, 1),
      turnIndex: 1,
    },
    scalingFiles: [
      {
        label: "1mb",
        targetMb: 1,
        claudeDir: `${dir}/scaling/1mb/claude`,
        filePath: `${dir}/scaling/1mb/claude/-home-dev-work-atlas/s.jsonl`,
        sessionId: "00000000-0000-4000-8000-0000000001mb",
        lastUuid: "00000000-0000-4000-8000-000000000002",
        lastTimestampMs: Date.UTC(2026, 10, 1),
        bytes: 1_000_000,
      },
    ],
  };

  test("accepts a cached manifest whose paths stay under its corpus directory", () => {
    expect(trustedCorpusManifest(manifest, dir)).not.toBeNull();
  });

  test.each([
    ["outDir", { ...manifest, outDir: "/etc" }],
    [
      "liveSession",
      { ...manifest, liveSession: { ...manifest.liveSession, filePath: "/etc/passwd" } },
    ],
    [
      "traversal",
      {
        ...manifest,
        liveSession: {
          ...manifest.liveSession,
          filePath: `${dir}/claude/../../../x.jsonl`,
        },
      },
    ],
    [
      "missing live timestamp",
      {
        ...manifest,
        liveSession: { ...manifest.liveSession, lastTimestampMs: undefined },
      },
    ],
    [
      "empty live sessionId",
      {
        ...manifest,
        liveSession: { ...manifest.liveSession, sessionId: "" },
      },
    ],
    [
      "scaling file",
      {
        ...manifest,
        scalingFiles: [{ ...manifest.scalingFiles[0], filePath: "/var/tmp/s.jsonl" }],
      },
    ],
    [
      "scaling label",
      { ...manifest, scalingFiles: [{ ...manifest.scalingFiles[0], label: "../x" }] },
    ],
    [
      "missing scaling timestamp",
      {
        ...manifest,
        scalingFiles: [{ ...manifest.scalingFiles[0], lastTimestampMs: undefined }],
      },
    ],
    ["missing scaling", { ...manifest, scalingFiles: undefined }],
  ])("rejects a cached manifest with an untrusted %s", (_label, tampered) => {
    expect(trustedCorpusManifest(tampered, dir)).toBeNull();
  });

  test("a portable manifest resolves against whichever directory holds the corpus", () => {
    const portable = portableCorpusManifest(manifest as unknown as CorpusManifest, dir);
    expect(JSON.stringify(portable)).not.toContain(dir);
    const container = "/bench/corpus-pi-1";
    expect(cachedCorpusManifest(portable, container)?.liveSession.filePath).toBe(
      `${container}/claude/-home-dev-work-atlas/live.jsonl`,
    );
    expect(cachedCorpusManifest(portable, dir)?.liveSession.filePath).toBe(
      manifest.liveSession.filePath,
    );
  });

  test("an absolute manifest from another mount namespace is not reused", () => {
    expect(cachedCorpusManifest(manifest, dir)).not.toBeNull();
    expect(cachedCorpusManifest(manifest, "/bench/corpus-pi-1")).toBeNull();
  });

  test("seed caches are namespaced by the absolute corpus path", () => {
    expect(corpusNamespace(dir)).toMatch(/^[0-9a-f]{12}$/);
    expect(corpusNamespace(`${dir}/`)).toBe(corpusNamespace(dir));
    expect(corpusNamespace("/bench/corpus-pi-1")).not.toBe(corpusNamespace(dir));
  });
});

describe("bench corpus lock", () => {
  test("a second run cannot take the corpus while the first holds it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "decant-bench-lock-"));
    try {
      const lockPath = corpusLockPath(tmp, "pi", 7);
      expect(lockPath).toBe(join(tmp, ".bench-pi-7.lock"));
      const release = acquireCorpusLock(lockPath);
      expect(statSync(lockPath).mode & 0o777).toBe(0o600);
      expect(() => acquireCorpusLock(lockPath)).toThrow(/another bench run/);
      release();
      acquireCorpusLock(lockPath)();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a held lock stops --rebuild-seed before it deletes the corpus directory", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "decant-bench-lock-"));
    try {
      const corpusDir = corpusDirFor({ workDir, profile: "pi", seed: 7 });
      mkdirSync(corpusDir, { recursive: true });
      const marker = join(corpusDir, "in-use.txt");
      writeFileSync(marker, "concurrent run data\n");
      const lockPath = corpusLockPath(workDir, "pi", 7);
      const release = acquireCorpusLock(lockPath);
      try {
        await expect(
          prepareLockedCorpus({ workDir, profile: "pi", seed: 7, rebuildSeed: true }),
        ).rejects.toThrow(/another bench run/);
        expect(existsSync(corpusDir)).toBe(true);
        expect(readFileSync(marker, "utf8")).toBe("concurrent run data\n");
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        release();
      }
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test("removes a newly created lock if writing the pid fails, without removing an existing lock", () => {
    const tmp = mkdtempSync(join(tmpdir(), "decant-bench-lock-init-"));
    try {
      const lockPath = corpusLockPath(tmp, "pi", 11);
      expect(() =>
        acquireCorpusLock(lockPath, () => {
          throw new Error("disk full");
        }),
      ).toThrow(/disk full/);
      expect(existsSync(lockPath)).toBe(false);

      const release = acquireCorpusLock(lockPath);
      try {
        expect(() => acquireCorpusLock(lockPath)).toThrow(/another bench run/);
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        release();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("bench directory and docker helpers", () => {
  test("rejects an existing non-private work directory without changing its permissions", () => {
    const tmp = mkdtempSync(join(tmpdir(), "decant-bench-perms-"));
    try {
      const shared = join(tmp, "shared");
      mkdirSync(shared, { mode: 0o770 });
      chmodSync(shared, 0o770);
      expect(() => ensurePrivateDir(shared)).toThrow(/private \(0700\)/);
      expect(statSync(shared).mode & 0o777).toBe(0o770);

      const first = allocatePrivateDir(shared, "run");
      const second = allocatePrivateDir(shared, "run");
      expect(first).not.toBe(second);
      expect(statSync(shared).mode & 0o777).toBe(0o770);
      expect(statSync(first).mode & 0o777).toBe(0o700);
      expect(statSync(second).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("maps host uid/gid only for non-root rootful Linux Docker", () => {
    expect(dockerUserArgs("linux", 1000, 1000, "[name=seccomp]")).toEqual([
      "-u",
      "1000:1000",
      "-e",
      "HOME=/tmp",
    ]);
    expect(dockerUserArgs("linux", 1000, 1000, "[name=rootless]")).toEqual([]);
    expect(dockerUserArgs("linux", 0, 0, "[name=seccomp]")).toEqual([]);
    expect(dockerUserArgs("darwin", 501, 20, "[name=seccomp]")).toEqual([]);
  });
});

interface FakeTree {
  launcher: { pid: number; exited: Promise<number> };
  exitLauncher(code: number): void;
  alive: Set<number>;
  children: Map<number, number>;
  signals: Array<[number, string]>;
  ops: ServeStopOps;
}

function fakeTree(options: {
  launcherPid: number;
  servePid: number;
  onSignal: (tree: FakeTree, pid: number, signal: string) => void;
  childVisible?: boolean;
  orphanVisibleAfterExit?: boolean;
}): FakeTree {
  let exitLauncher!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exitLauncher = resolve;
  });
  const tree: FakeTree = {
    launcher: { pid: options.launcherPid, exited },
    exitLauncher: (code) => {
      tree.alive.delete(options.launcherPid);
      tree.children.delete(options.launcherPid);
      exitLauncher(code);
    },
    alive: new Set([options.launcherPid, options.servePid]),
    children: new Map(
      options.childVisible === false ? [] : [[options.launcherPid, options.servePid]],
    ),
    signals: [],
    ops: {
      findServePid: (pid) =>
        tree.children.get(pid) ??
        (options.orphanVisibleAfterExit === true &&
        !tree.alive.has(options.launcherPid) &&
        tree.alive.has(options.servePid)
          ? options.servePid
          : null),
      isAlive: (pid) => tree.alive.has(pid),
      signal: (pid, signal) => {
        tree.signals.push([pid, signal]);
        options.onSignal(tree, pid, signal);
      },
      sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    },
  };
  return tree;
}

describe("bench serve shutdown", () => {
  test("a graceful stop waits for both the tracer and the traced serve process", async () => {
    const tree = fakeTree({
      launcherPid: 10,
      servePid: 11,
      onSignal: (t, pid, signal) => {
        if (pid === 11 && signal === "SIGTERM") {
          t.alive.delete(11);
          t.exitLauncher(0);
        }
      },
    });
    const stopped = await stopLaunchedServe(tree.launcher, 11, 1_000, tree.ops);
    expect(stopped).toEqual({ exitCode: 0, servePid: 11, killed: false });
    expect(tree.signals).toEqual([[11, "SIGTERM"]]);
  });

  test("a tracer that exits while serve keeps running does not count as stopped", async () => {
    const tree = fakeTree({
      launcherPid: 20,
      servePid: 21,
      onSignal: (t, pid, signal) => {
        if (pid === 21 && signal === "SIGTERM") t.exitLauncher(0);
        if (pid === 21 && signal === "SIGKILL") t.alive.delete(21);
      },
    });
    const stopped = await stopLaunchedServe(tree.launcher, 21, 100, tree.ops);
    expect(stopped.killed).toBe(true);
    expect(tree.alive.size).toBe(0);
    expect(tree.signals).toEqual([
      [21, "SIGTERM"],
      [21, "SIGKILL"],
    ]);
  });

  test("an unknown serve pid is discovered at stop and both processes are killed on timeout", async () => {
    let killedServe = false;
    const tree = fakeTree({
      launcherPid: 30,
      servePid: 31,
      onSignal: (t, pid, signal) => {
        if (signal !== "SIGKILL") return;
        if (pid === 31) {
          killedServe = true;
          setTimeout(() => t.alive.delete(31), 5);
        }
        if (pid === 30) t.exitLauncher(137);
      },
    });
    const stopped = await stopLaunchedServe(tree.launcher, null, 100, tree.ops);
    expect(killedServe).toBe(true);
    expect(stopped).toEqual({ exitCode: null, servePid: 31, killed: true });
    expect(tree.alive.size).toBe(0);
    expect(tree.signals).toEqual([
      [31, "SIGTERM"],
      [31, "SIGKILL"],
      [30, "SIGKILL"],
    ]);
  });

  test("a serve child that appears only after the stop began is still killed", async () => {
    const tree = fakeTree({
      launcherPid: 40,
      servePid: 41,
      childVisible: false,
      onSignal: (t, pid, signal) => {
        if (pid === 40 && signal === "SIGTERM") t.children.set(40, 41);
        if (signal === "SIGKILL") {
          t.alive.delete(pid);
          if (pid === 40) t.exitLauncher(137);
        }
      },
    });
    const stopped = await stopLaunchedServe(tree.launcher, null, 100, tree.ops);
    expect(stopped.servePid).toBe(41);
    expect(tree.signals).toEqual([
      [40, "SIGTERM"],
      [41, "SIGTERM"],
      [41, "SIGKILL"],
      [40, "SIGKILL"],
    ]);
    expect(tree.alive.size).toBe(0);
  });

  test("a serve process orphaned by a tracer that exited is found, stopped, and awaited", async () => {
    const tree = fakeTree({
      launcherPid: 50,
      servePid: 51,
      childVisible: false,
      orphanVisibleAfterExit: true,
      onSignal: (t, pid, signal) => {
        if (pid === 50 && signal === "SIGTERM") t.exitLauncher(0);
        if (pid === 51 && signal === "SIGTERM") setTimeout(() => t.alive.delete(51), 5);
      },
    });
    const stopped = await stopLaunchedServe(tree.launcher, null, 1_000, tree.ops);
    expect(stopped).toEqual({ exitCode: 0, servePid: 51, killed: false });
    expect(tree.signals).toEqual([
      [50, "SIGTERM"],
      [51, "SIGTERM"],
    ]);
    expect(tree.alive.size).toBe(0);
  });

  test("processes that survive SIGKILL past the deadline are named in the error", async () => {
    const tree = fakeTree({ launcherPid: 60, servePid: 61, onSignal: () => {} });
    const stopping = stopLaunchedServe(tree.launcher, 61, 40, tree.ops, 40);
    await expect(stopping).rejects.toBeInstanceOf(ServeSurvivedKillError);
    await expect(stopping).rejects.toMatchObject({ pids: [60, 61] });
    expect(tree.signals).toEqual([
      [61, "SIGTERM"],
      [61, "SIGKILL"],
      [60, "SIGKILL"],
    ]);
  });

  test("the corpus lock is kept only while a killed serve process may still be alive", async () => {
    let releases = 0;
    const release = () => {
      releases += 1;
    };
    expect(await withCorpusLock(release, async () => "done")).toBe("done");
    expect(releases).toBe(1);
    await expect(
      withCorpusLock(release, async () => {
        throw new Error("replay failed");
      }),
    ).rejects.toThrow("replay failed");
    expect(releases).toBe(2);
    await expect(
      withCorpusLock(release, async () => {
        throw new ServeSurvivedKillError([70]);
      }),
    ).rejects.toBeInstanceOf(ServeSurvivedKillError);
    expect(releases).toBe(2);
  });

  test("orphan discovery matches only this run's serve command, not its tracer", () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const serve = [process.execPath, "run", cli, "serve", "--no-open", "--port", "4100"];
    expect(isServeCommand(serve, 4100)).toBe(true);
    expect(isServeCommand(serve, 4101)).toBe(false);
    expect(isServeCommand(["strace", "-f", "-o", "s.txt", ...serve], 4100)).toBe(false);
    expect(isServeCommand([process.execPath, "run", cli, "sync", "--port", "4100"], 4100)).toBe(
      false,
    );
  });

  test("an attach-mode tracer that already exited is rejected", () => {
    expect(() => requireTracerRunning({ exitCode: null }, "/logs")).not.toThrow();
    expect(() => requireTracerRunning({ exitCode: 1 }, "/logs")).toThrow(
      /strace -p exited with code 1/,
    );
  });
});

describe("bench freshness check coalescing", () => {
  test("a pass with nothing to do does not block later checks", async () => {
    let passes = 0;
    const check = coalescingCheck(async () => {
      passes += 1;
      return false;
    });
    await check();
    await check();
    expect(passes).toBe(2);
  });

  test("a check requested during a pass shares it and runs one more pass", async () => {
    let passes = 0;
    const gate = Promise.withResolvers<void>();
    const check = coalescingCheck(async () => {
      passes += 1;
      if (passes === 1) await gate.promise;
      return true;
    });
    const first = check();
    const second = check();
    expect(second).toBe(first);
    gate.resolve();
    await first;
    expect(passes).toBe(2);
    await check();
    expect(passes).toBe(3);
  });
});
