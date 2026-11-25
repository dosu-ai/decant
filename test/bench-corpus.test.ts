import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
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
  cachedCorpusManifest,
  corpusDirFor,
  corpusLockPath,
  corpusNamespace,
  portableCorpusManifest,
  prepareLockedCorpus,
  trustedCorpusManifest,
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
      const db = openDb(join(tmp, "archive.db"));
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
    liveSession: { filePath: `${dir}/claude/-home-dev-work-atlas/live.jsonl` },
    scalingFiles: [
      {
        label: "1mb",
        claudeDir: `${dir}/scaling/1mb/claude`,
        filePath: `${dir}/scaling/1mb/claude/-home-dev-work-atlas/s.jsonl`,
      },
    ],
  };

  test("accepts a cached manifest whose paths stay under its corpus directory", () => {
    expect(trustedCorpusManifest(manifest, dir)).not.toBeNull();
  });

  test.each([
    ["outDir", { ...manifest, outDir: "/etc" }],
    ["liveSession", { ...manifest, liveSession: { filePath: "/etc/passwd" } }],
    ["traversal", { ...manifest, liveSession: { filePath: `${dir}/claude/../../../x.jsonl` } }],
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
});
