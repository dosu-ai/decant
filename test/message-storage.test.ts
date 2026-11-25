import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextWindowForSession } from "../src/context-window.ts";
import { closeDb, openDb } from "../src/db.ts";
import { exportTrajectory, toMarkdown } from "../src/export.ts";
import { exportAtif } from "../src/export-atif.ts";
import { sync, upsertSession } from "../src/ingest.ts";
import { canonicalJson } from "../src/json.ts";
import {
  compactBlockToolResultStorage,
  compactMessageStorage,
  decodeBlockToolResult,
  decodeMessageRaw,
  encodeBlockToolResult,
  encodeMessageRaw,
} from "../src/message-storage.ts";
import { deriveModelUsage } from "../src/model-usage.ts";
import { getSession, listSessions } from "../src/query.ts";
import { setSessionUserState } from "../src/session-user-state.ts";
import { parseClaudeSession } from "../src/sources/claude.ts";
import { parseCodexSession } from "../src/sources/codex.ts";
import { tokenEconomicsForSession } from "../src/token-economics.ts";
import { isolatedConfig, runDifferentialScenario, SOURCE_ROOTS } from "./helpers/ingest-oracle.ts";

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
      data: { preCompactionTokens: 23456 },
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

describe("block tool_result storage", () => {
  test("round-trips large UTF-8 tool results and leaves null, small, or incompressible text uncompressed", () => {
    const large = "héllo → 🙂\u0000 line output\n".repeat(400);
    const encoded = encodeBlockToolResult(large);
    expect(encoded.toolResult).toBeInstanceOf(Uint8Array);
    if (!(encoded.toolResult instanceof Uint8Array)) {
      throw new Error("expected compressed tool_result");
    }
    expect(encoded.toolResultBytes).toBe(Buffer.byteLength(large));
    expect(decodeBlockToolResult(encoded.toolResult)).toBe(large);
    expect(encoded.toolResult.byteLength).toBeLessThan(Buffer.byteLength(large) / 4);

    expect(encodeBlockToolResult(null)).toEqual({ toolResult: null, toolResultBytes: null });
    expect(decodeBlockToolResult(null)).toBeNull();

    const small = "ok\n".repeat(100);
    expect(encodeBlockToolResult(small)).toEqual({ toolResult: small, toolResultBytes: null });
    expect(decodeBlockToolResult(small)).toBe(small);

    let incompressible = "";
    let state = 7;
    while (Buffer.byteLength(incompressible) < 1024) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const bucket = state >>> 24;
      if (bucket < 128) incompressible += String.fromCodePoint(bucket);
      else if (bucket < 180) incompressible += String.fromCodePoint(0x80 + (state % 0x780));
      else if (bucket < 230) incompressible += String.fromCodePoint(0x800 + (state % 0xc000));
      else incompressible += String.fromCodePoint(0x10000 + (state % 0x100000));
    }
    expect(encodeBlockToolResult(incompressible)).toEqual({
      toolResult: incompressible,
      toolResultBytes: null,
    });
    expect(decodeBlockToolResult(incompressible)).toBe(incompressible);

    expect(() => decodeBlockToolResult(new Uint8Array([0, 1, 2, 3]))).toThrow();
  });

  test("compacts existing tool_result rows resumable across interruptions while keeping FTS intact", () => {
    const db = openDb(join(workDir, "tool-result-resume.db"));
    const payload = "tool output 🙂 line\n".repeat(400);
    try {
      db.exec("INSERT INTO session(id, tool, source_session_id) VALUES (1, 'claude_code', 'tr')");
      db.exec("INSERT INTO message(id, session_id, seq, role, raw) VALUES (1, 1, 0, 'user', '{}')");
      const insert = db.prepare(
        `INSERT INTO block(id, message_id, session_id, ordinal, type, text, tool_result)
         VALUES (?1, 1, 1, ?1, 'tool_result', CASE WHEN ?1 = 1 THEN 'trcanarysearchable' ELSE NULL END, ?2)`,
      );
      for (let id = 1; id <= 260; id += 1) insert.run(id, payload);
      insert.finalize();
      db.exec(`CREATE TRIGGER fail_tr_compaction BEFORE UPDATE OF tool_result ON block WHEN old.id = 129
        BEGIN SELECT RAISE(ABORT, 'synthetic block interruption'); END;`);
      const before = db.query("PRAGMA page_count").get() as { page_count: number };

      expect(() => compactBlockToolResultStorage(db)).toThrow("synthetic block interruption");
      expect(
        db.query("SELECT COUNT(*) AS n FROM block WHERE typeof(tool_result) = 'blob'").get(),
      ).toEqual({ n: 128 });

      db.exec("DROP TRIGGER fail_tr_compaction");
      const resumed = compactBlockToolResultStorage(db);
      expect(resumed.compressed).toBe(132);
      expect(resumed.saved_bytes).toBeGreaterThan(0);
      expect(compactBlockToolResultStorage(db)).toEqual({
        scanned: 0,
        compressed: 0,
        saved_bytes: 0,
      });

      const rows = db
        .query("SELECT tool_result, tool_result_bytes FROM block ORDER BY id")
        .all() as {
        tool_result: Uint8Array;
        tool_result_bytes: number;
      }[];
      expect(rows).toHaveLength(260);
      for (const row of rows) {
        expect(decodeBlockToolResult(row.tool_result)).toBe(payload);
        expect(row.tool_result_bytes).toBe(Buffer.byteLength(payload));
      }
      expect(
        db
          .query("SELECT COUNT(*) AS n FROM block_fts WHERE block_fts MATCH 'trcanarysearchable'")
          .get(),
      ).toEqual({ n: 1 });
      expect(() =>
        db.run("INSERT INTO block_fts(block_fts, rank) VALUES ('integrity-check', 1)"),
      ).not.toThrow();

      db.exec("VACUUM");
      const after = db.query("PRAGMA page_count").get() as { page_count: number };
      expect(after.page_count).toBeLessThan(before.page_count / 2);
      expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      closeDb(db);
    }
  });

  test("compressed tool_result preserves transcript, exports, and uncached token economics", () => {
    const db = openDb(join(workDir, "tool-result-reads.db"));
    const largeOutput = "function greet(name: string) { return 'héllo ' + name + ' 🙂'; }\n".repeat(
      120,
    );
    try {
      const parsed = parseClaudeSession(
        "tr-parity",
        readFileSync(join(import.meta.dir, "..", "fixtures", "claude", "sample.jsonl"), "utf8"),
      );
      if (parsed.session == null) throw new Error("expected synthetic fixture session");
      for (const message of parsed.session.messages) {
        for (const block of message.blocks) {
          if (block.blockType === "tool_result") {
            block.toolResult = largeOutput;
          }
        }
      }
      const sessionId = upsertSession(db, parsed, "/synthetic/tr-parity.jsonl", 1, 2);
      if (sessionId == null) throw new Error("expected session id");

      const compressedCount = db
        .query(
          "SELECT COUNT(*) AS n FROM block WHERE session_id = ?1 AND typeof(tool_result) = 'blob'",
        )
        .get(sessionId) as { n: number };
      expect(compressedCount.n).toBeGreaterThan(0);

      // Clear tool_call.output_bytes so vectorsForScope exercises rb.tool_result_bytes directly.
      db.query("UPDATE tool_call SET output_bytes = NULL WHERE session_id = ?1").run(sessionId);

      const readAll = () => {
        db.exec("DELETE FROM session_economics");
        const detail = getSession(db, sessionId);
        return {
          detail,
          markdown: detail == null ? null : toMarkdown(detail),
          trajectory: exportTrajectory(db, sessionId),
          atif: exportAtif(db, sessionId),
          economics: tokenEconomicsForSession(db, sessionId),
        };
      };

      const compressedView = readAll();
      const resultBlock = compressedView.detail?.messages
        .flatMap((m) => m.blocks)
        .find((b) => b.block_type === "tool_result");
      expect(resultBlock?.tool_result).toBe(largeOutput);

      for (const row of db
        .query(
          "SELECT id, tool_result FROM block WHERE session_id = ?1 AND tool_result IS NOT NULL",
        )
        .all(sessionId) as { id: number; tool_result: string | Uint8Array }[]) {
        db.query("UPDATE block SET tool_result = ?1, tool_result_bytes = NULL WHERE id = ?2").run(
          decodeBlockToolResult(row.tool_result),
          row.id,
        );
      }

      const plainView = readAll();
      expect(compressedView).toEqual(plainView);

      const compacted = compactBlockToolResultStorage(db);
      expect(compacted.compressed).toBe(compressedCount.n);
      expect(readAll()).toEqual(plainView);
    } finally {
      closeDb(db);
    }
  });

  test("resolves Codex subagent parent links when spawn_agent tool_result is compressed", () => {
    const rootDir = mkdtempSync(join(workDir, "codex-spawner-"));
    const config = isolatedConfig(rootDir);
    const parentId = "11111111-1111-1111-1111-111111111111";
    const childId = "22222222-2222-2222-2222-222222222222";
    const largeSpawnOutput = JSON.stringify({
      agent_id: childId.toUpperCase(),
      status: "spawned",
      notes: "verbose startup context ".repeat(150),
    });
    const codexDir = join(rootDir, SOURCE_ROOTS.codex, "sessions", "2026", "05", "01");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, `rollout-2026-05-01T10-00-00-${parentId}.jsonl`),
      `${[
        JSON.stringify({
          timestamp: "2026-05-01T10:00:00.000Z",
          type: "session_meta",
          payload: { id: parentId, cwd: "/Users/dev/proj" },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Spawn a helper agent" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            arguments: JSON.stringify({ prompt: "inspect tests" }),
            call_id: "call_spawn_large_1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T10:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_spawn_large_1",
            output: largeSpawnOutput,
          },
        }),
      ].join("\n")}\n`,
    );
    writeFileSync(
      join(codexDir, `rollout-2026-05-01T10-00-04-${childId}.jsonl`),
      `${[
        JSON.stringify({
          timestamp: "2026-05-01T10:00:04.000Z",
          type: "session_meta",
          payload: {
            id: childId,
            cwd: "/Users/dev/proj",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: parentId,
                  depth: 1,
                },
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-01T10:00:05.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "inspect tests" }],
          },
        }),
      ].join("\n")}\n`,
    );

    const db = openDb(join(rootDir, "codex.db"));
    try {
      const report = sync(db, config);
      expect(report.failed).toBe(0);
      const spawnResult = db
        .query(
          "SELECT typeof(tool_result) AS kind FROM block WHERE tool_use_id = 'call_spawn_large_1' AND type = 'tool_result'",
        )
        .get() as { kind: string } | null;
      expect(spawnResult).toEqual({ kind: "blob" });

      const parent = db
        .query("SELECT id FROM session WHERE source_session_id = ?1")
        .get(parentId) as { id: number } | null;
      const child = db
        .query(
          "SELECT is_subagent, parent_session_id, spawn_tool_use_id FROM session WHERE source_session_id = ?1",
        )
        .get(childId) as {
        is_subagent: number;
        parent_session_id: number | null;
        spawn_tool_use_id: string | null;
      } | null;
      expect(parent).not.toBeNull();
      expect(child).toEqual({
        is_subagent: 1,
        parent_session_id: parent?.id ?? -1,
        spawn_tool_use_id: "call_spawn_large_1",
      });
    } finally {
      closeDb(db);
    }
  });

  test("incremental appends and in-place diff rewrites preserve compressed tool_result parity", () => {
    const bigResultA = "alpha result payload line 🙂\n".repeat(200);
    const bigResultB = "beta updated payload line →\n".repeat(220);
    const makeLines = (resultText: string, extra?: string) =>
      `${[
        JSON.stringify({
          type: "user",
          uuid: "u1",
          sessionId: "sess-tr-inc",
          timestamp: "2026-05-01T10:00:00.000Z",
          cwd: "/Users/dev/proj",
          message: { role: "user", content: "Read the files" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "sess-tr-inc",
          timestamp: "2026-05-01T10:00:01.000Z",
          cwd: "/Users/dev/proj",
          message: {
            id: "msg_tr_1",
            role: "assistant",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 100, output_tokens: 40 },
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "Read",
                input: { file_path: "/Users/dev/proj/a.ts" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          sessionId: "sess-tr-inc",
          timestamp: "2026-05-01T10:00:02.000Z",
          cwd: "/Users/dev/proj",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", is_error: false, content: resultText },
            ],
          },
        }),
        ...(extra == null ? [] : [extra]),
      ].join("\n")}\n`;

    const path = `${SOURCE_ROOTS.claude}/projects/-Users-dev-proj/sess-tr-inc.jsonl`;
    const appendTurn = `${[
      JSON.stringify({
        type: "assistant",
        uuid: "a2",
        parentUuid: "u2",
        sessionId: "sess-tr-inc",
        timestamp: "2026-05-01T10:00:03.000Z",
        cwd: "/Users/dev/proj",
        message: {
          id: "msg_tr_2",
          role: "assistant",
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 300, output_tokens: 50 },
          content: [
            {
              type: "tool_use",
              id: "tu_2",
              name: "Read",
              input: { file_path: "/Users/dev/proj/b.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "u3",
        parentUuid: "a2",
        sessionId: "sess-tr-inc",
        timestamp: "2026-05-01T10:00:04.000Z",
        cwd: "/Users/dev/proj",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_2", is_error: false, content: bigResultB },
          ],
        },
      }),
    ].join("\n")}\n`;

    const result = runDifferentialScenario({
      name: "compressed tool_result incremental and rewrite parity",
      queries: ["Read"],
      steps: [
        {
          label: "initial compressed tool_result",
          mutations: [{ op: "write", path, content: makeLines(bigResultA) }],
        },
        {
          label: "incremental append with second large tool_result",
          mutations: [{ op: "append", path, content: appendTurn }],
        },
        {
          label: "in-place rewrite modifying first compressed tool_result",
          mutations: [{ op: "rewrite", path, content: makeLines(bigResultB) + appendTurn }],
        },
      ],
    });
    const toolResultBlocks = result.snapshot.block.filter((row) => row.type === "tool_result");
    expect(toolResultBlocks).toHaveLength(2);
    for (const row of toolResultBlocks) {
      expect(row.decoded_tool_result).toBe(bigResultB);
      expect(row.tool_result_bytes).toBe(Buffer.byteLength(bigResultB));
    }
  });

  test("in-place diff keeps unchanged compressed rows and transitions cleanly between compressed BLOB and small TEXT", () => {
    const rootDir = mkdtempSync(join(workDir, "tool-result-diff-"));
    const config = isolatedConfig(rootDir);
    const projectDir = join(rootDir, SOURCE_ROOTS.claude, "projects", "-Users-dev-proj");
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, "tr-diff.jsonl");
    const largeA = "first large tool output\n".repeat(200);
    const largeB = "second large tool output\n".repeat(200);
    const small = "tiny";
    const makeJsonl = (promptText: string, resultText: string) =>
      `${[
        JSON.stringify({
          type: "user",
          uuid: "u1",
          sessionId: "tr-diff",
          timestamp: "2026-05-01T10:00:00.000Z",
          cwd: "/Users/dev/proj",
          message: { role: "user", content: promptText },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          sessionId: "tr-diff",
          timestamp: "2026-05-01T10:00:01.000Z",
          cwd: "/Users/dev/proj",
          message: {
            id: "m1",
            role: "assistant",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 100, output_tokens: 20 },
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "u2",
          parentUuid: "a1",
          sessionId: "tr-diff",
          timestamp: "2026-05-01T10:00:02.000Z",
          cwd: "/Users/dev/proj",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: resultText }],
          },
        }),
      ].join("\n")}\n`;

    const db = openDb(join(rootDir, "tool-result-diff.db"));
    try {
      const writeAndSync = (promptText: string, resultText: string, mtimeSec: number) => {
        writeFileSync(filePath, makeJsonl(promptText, resultText));
        utimesSync(filePath, mtimeSec, mtimeSec);
        expect(sync(db, config).failed).toBe(0);
      };

      writeAndSync("run 1", largeA, 1_780_000_000);
      const session = db
        .query("SELECT id FROM session WHERE source_session_id = 'tr-diff'")
        .get() as { id: number } | null;
      if (session == null) throw new Error("expected session id");
      const firstRow = db
        .query(
          "SELECT id, typeof(tool_result) AS kind, tool_result_bytes FROM block WHERE session_id = ?1 AND type = 'tool_result'",
        )
        .get(session.id) as { id: number; kind: string; tool_result_bytes: number | null };
      expect(firstRow.kind).toBe("blob");
      expect(firstRow.tool_result_bytes).toBe(Buffer.byteLength(largeA));

      // Rewriting an earlier message forces full fallback diff while keeping tool_result unchanged.
      writeAndSync("run 2", largeA, 1_780_000_010);
      const sameRow = db
        .query(
          "SELECT id, typeof(tool_result) AS kind, tool_result_bytes FROM block WHERE session_id = ?1 AND type = 'tool_result'",
        )
        .get(session.id) as { id: number; kind: string; tool_result_bytes: number | null };
      expect(sameRow).toEqual(firstRow);
      expect(getSession(db, session.id)?.messages.at(-1)?.blocks[0]?.tool_result).toBe(largeA);

      // Modifying the large tool_result updates the BLOB and byte count in place on the same row.
      writeAndSync("run 2", largeB, 1_780_000_020);
      const secondRow = db
        .query(
          "SELECT id, typeof(tool_result) AS kind, tool_result_bytes FROM block WHERE session_id = ?1 AND type = 'tool_result'",
        )
        .get(session.id) as { id: number; kind: string; tool_result_bytes: number | null };
      expect(secondRow).toEqual({
        id: firstRow.id,
        kind: "blob",
        tool_result_bytes: Buffer.byteLength(largeB),
      });
      expect(getSession(db, session.id)?.messages.at(-1)?.blocks[0]?.tool_result).toBe(largeB);

      // Shrinking below the compression threshold transitions back to TEXT with NULL byte count.
      writeAndSync("run 2", small, 1_780_000_030);
      const thirdRow = db
        .query(
          "SELECT id, typeof(tool_result) AS kind, tool_result_bytes FROM block WHERE session_id = ?1 AND type = 'tool_result'",
        )
        .get(session.id) as { id: number; kind: string; tool_result_bytes: number | null };
      expect(thirdRow).toEqual({ id: firstRow.id, kind: "text", tool_result_bytes: null });
      expect(getSession(db, session.id)?.messages.at(-1)?.blocks[0]?.tool_result).toBe(small);
    } finally {
      closeDb(db);
    }
  });
});

describe("SQL readers of message source records", () => {
  test("read metadata through MESSAGE_METADATA_SQL instead of the raw column", async () => {
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

  test("never apply SQL LIKE, GLOB, JSON, or unguarded length() directly to block.tool_result", async () => {
    const root = join(import.meta.dir, "..");
    const offenders: string[] = [];
    const forbidden = [
      /\b(?:\w+\.)?tool_result\s+(?:LIKE|GLOB)\b/gi,
      /\bjson_\w+\(\s*(?:\w+\.)?tool_result\s*[,)]/gi,
      /(?<!tool_result_bytes,\s*)\blength\(\s*(?:CAST\(\s*)?(?:\w+\.)?tool_result\b/gi,
    ];
    for (const pattern of ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"]) {
      for await (const file of new Bun.Glob(pattern).scan(root)) {
        const source = readFileSync(join(root, file), "utf8");
        for (const regex of forbidden) {
          for (const match of source.matchAll(regex)) {
            offenders.push(`${file}: ${match[0]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
