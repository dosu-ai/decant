import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CorpusManifest,
  generateCorpus,
  generateLiveAppendChunk,
  type LiveAppenderState,
} from "../scripts/bench-corpus.ts";
import { trustedCorpusManifest } from "../scripts/bench-ingest.ts";
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
});
