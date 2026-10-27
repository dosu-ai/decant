import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextWindowForSession } from "../src/context-window.ts";
import { closeDb, openDb } from "../src/db.ts";
import { exportTrajectory } from "../src/export.ts";
import { upsertSession } from "../src/ingest.ts";
import { canonicalJson } from "../src/json.ts";
import {
  compactMessageStorage,
  decodeMessageRaw,
  encodeMessageRaw,
} from "../src/message-storage.ts";
import { deriveModelUsage } from "../src/model-usage.ts";
import { getSession, listSessions } from "../src/query.ts";
import { setSessionUserState } from "../src/session-user-state.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { tokenEconomicsForSession } from "../src/token-economics.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-message-storage-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("message source storage", () => {
  test("round-trips the complete record and preserves every SQL metadata path", () => {
    const metadata = {
      isSidechain: true,
      subtype: "compact_boundary",
      type: "compaction",
      isCompactSummary: true,
      compactMetadata: { trigger: "auto", preTokens: 12345 },
      payload: { role: "developer" },
      message: {
        id: "response-1",
        usage: { speed: "fast", cache_creation: { ephemeral_1h_input_tokens: 42 } },
      },
      reasoning_tokens: 71,
      callID: "call-1",
      id: "part-1",
      name: "subagent",
      tool: "task",
      state: { metadata: { sessionID: "child-2", sessionId: "child-1" } },
      sessionId: "root",
      agentId: "agent",
      cost: 0.123,
      model: { providerID: "provider-1" },
      providerID: "provider-2",
    };
    const raw = canonicalJson({
      ...metadata,
      future_unknown_field: { complete: "héllo → 🙂\u0000\n".repeat(1000), keep: [1, null, false] },
    });
    const encoded = encodeMessageRaw(raw);
    expect(encoded.raw).toBeInstanceOf(Uint8Array);
    if (typeof encoded.raw === "string") throw new Error("expected compressed source record");
    expect(encoded.rawBytes).toBe(Buffer.byteLength(raw));
    expect(JSON.parse(encoded.rawMeta ?? "null")).toEqual(metadata);
    expect(decodeMessageRaw(encoded.raw)).toBe(raw);
    expect(encoded.raw.byteLength + Buffer.byteLength(encoded.rawMeta ?? "")).toBeLessThan(
      Buffer.byteLength(raw) / 4,
    );
  });

  test("leaves small, non-JSON, and non-beneficial records as text", () => {
    for (const raw of ["{}", "not JSON".repeat(1000), canonicalJson({ id: "x".repeat(5000) })]) {
      expect(encodeMessageRaw(raw)).toEqual({ raw, rawMeta: null, rawBytes: null });
      expect(decodeMessageRaw(raw)).toBe(raw);
    }
    expect(() => decodeMessageRaw(new Uint8Array([0, 1, 2, 3]))).toThrow();
  });

  test("resumes after a failed batch, preserves source text and search, and reclaims space", () => {
    const db = openDb(join(workDir, "resume.db"));
    const raw = canonicalJson({
      future_field: "lossless 🙂 source\n".repeat(500),
      payload: { role: "user" },
    });
    try {
      db.exec("INSERT INTO session(id, tool, source_session_id) VALUES (1, 'codex', 'retained')");
      const insert = db.prepare(
        "INSERT INTO message(id, session_id, seq, role, raw) VALUES (?1, 1, ?1, 'user', ?2)",
      );
      for (let id = 1; id <= 260; id += 1) insert.run(id, raw);
      insert.finalize();
      db.exec(`INSERT INTO block(id, message_id, session_id, ordinal, type, text)
        VALUES (1, 1, 1, 0, 'text', 'searchcanary retained content');
        CREATE TRIGGER fail_compaction BEFORE UPDATE OF raw ON message WHEN old.id = 129
        BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END;`);
      expect(setSessionUserState(db, 1, "archived")).toBe(true);
      const before = db.query("PRAGMA page_count").get() as { page_count: number };

      expect(() => compactMessageStorage(db)).toThrow("synthetic interruption");
      expect(
        db.query("SELECT COUNT(*) AS n FROM message WHERE typeof(raw) = 'blob'").get(),
      ).toEqual({ n: 128 });
      db.exec("DROP TRIGGER fail_compaction");
      const resumed = compactMessageStorage(db);
      expect(resumed.compressed).toBe(132);
      expect(resumed.saved_bytes).toBeGreaterThan(0);
      expect(compactMessageStorage(db)).toEqual({ scanned: 0, compressed: 0, saved_bytes: 0 });

      const rows = db.query("SELECT raw, raw_bytes FROM message ORDER BY id").all() as {
        raw: Uint8Array;
        raw_bytes: number;
      }[];
      expect(rows).toHaveLength(260);
      for (const row of rows) {
        expect(decodeMessageRaw(row.raw)).toBe(raw);
        expect(row.raw_bytes).toBe(Buffer.byteLength(raw));
      }
      expect(
        db.query("SELECT COUNT(*) AS n FROM block_fts WHERE block_fts MATCH 'searchcanary'").get(),
      ).toEqual({ n: 1 });
      expect(db.query("SELECT state FROM session_user_state").get()).toEqual({ state: "archived" });
      db.exec("VACUUM");
      const after = db.query("PRAGMA page_count").get() as { page_count: number };
      expect(after.page_count).toBeLessThan(before.page_count / 2);
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  test("compressed metadata preserves transcript, title, context, exports, and uncached accounting", () => {
    const db = openDb(join(workDir, "metadata-reads.db"));
    try {
      for (const [source, parse] of [
        ["claude", parseClaudeSession],
        ["codex", parseCodexSession],
      ] as const) {
        const parsed = parse(
          `storage-${source}`,
          readFileSync(join(import.meta.dir, "..", "fixtures", source, "sample.jsonl"), "utf8"),
          new Map(),
        );
        if (parsed.session == null) throw new Error("expected synthetic fixture session");
        for (const message of parsed.session.messages) {
          if (
            message.raw != null &&
            typeof message.raw === "object" &&
            !Array.isArray(message.raw)
          ) {
            message.raw.future_retained = "unknown source data 🙂".repeat(500);
          }
        }
        upsertSession(db, parsed, `/synthetic/${source}.jsonl`, 1, 2);
      }
      // Recreate existing uncompressed rows before taking the reference reads.
      for (const row of db.query("SELECT id, raw FROM message").all() as {
        id: number;
        raw: string | Uint8Array;
      }[]) {
        db.query(
          "UPDATE message SET raw = ?1, raw_meta = NULL, raw_bytes = NULL WHERE id = ?2",
        ).run(decodeMessageRaw(row.raw), row.id);
      }
      const ids = (db.query("SELECT id FROM session ORDER BY id").all() as { id: number }[]).map(
        (row) => row.id,
      );
      const readAll = () => {
        db.exec("DELETE FROM session_economics");
        return {
          sessions: listSessions(db),
          details: ids.map((id) => getSession(db, id)),
          context: ids.map((id) => contextWindowForSession(db, id)),
          trajectory: ids.map((id) => exportTrajectory(db, id)),
          usage: ids.map((id) => deriveModelUsage(db, id)),
          economics: ids.map((id) => tokenEconomicsForSession(db, id)),
        };
      };
      const plain = readAll();
      const result = compactMessageStorage(db);
      expect(result.compressed).toBeGreaterThan(4);
      expect(readAll()).toEqual(plain);
    } finally {
      closeDb(db);
    }
  });
});

describe("SQL readers of message source records", () => {
  test("read metadata through MESSAGE_METADATA_SQL instead of the raw column", async () => {
    // Compacted rows hold a zstd BLOB in raw, where json_extract raises
    // "malformed JSON" and json_valid returns 0. Only raw_meta is queryable.
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const pattern of ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"]) {
      for await (const file of new Bun.Glob(pattern).scan(root)) {
        const source = readFileSync(join(root, file), "utf8");
        for (const match of source.matchAll(/json_\w+\(\s*(?:\w+\.)?raw\s*[,)]/g)) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
