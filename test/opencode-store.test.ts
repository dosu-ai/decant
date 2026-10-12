import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type OpenCodeConfigFs,
  OpenCodeMcpServerNames,
  OpenCodeStore,
  openCodeFingerprint,
  openCodeGlobalConfigPaths,
  openCodeLegacyFingerprint,
  parseJsonc,
  readOpenCodeMcpServers,
} from "../src/sources/opencode-store.ts";
import {
  buildOpenCodeDb,
  buildOpenCodeFixtureDb,
  buildOpenCodeV1Db,
  buildOpenCodeV1FixtureDb,
} from "./opencode-fixture.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-opencode-store-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
function freshPath(name = "opencode.db"): string {
  counter += 1;
  const dir = join(workDir, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

describe("OpenCodeStore", () => {
  test("lists sessions with a change key and loads one session's rows in seq order", () => {
    const path = freshPath();
    buildOpenCodeFixtureDb(path, ["sample.sql", "mcp.sql"]);
    const store = OpenCodeStore.open(path);
    try {
      expect(store.hasSessionTables()).toBe(true);
      expect(store.listSessions()).toEqual([
        {
          dbPath: path,
          sessionId: "ses_mcp",
          format: "v2",
          fingerprint: "1791789660000:4:4:1791789607000",
          timeUpdated: 1791789660000,
          directory: "/decant-fixture/example",
        },
        {
          dbPath: path,
          sessionId: "ses_sample",
          format: "v2",
          fingerprint: "1791786060000:4:4:1791786008000",
          timeUpdated: 1791786060000,
          directory: "/decant-fixture/example",
        },
      ]);
      const loaded = store.loadSession("ses_sample");
      expect(loaded?.session).toMatchObject({
        id: "ses_sample",
        directory: "/decant-fixture/example",
        title: "Summarize the example file",
        version: "2.0.27",
        cost: 0.0000794,
        tokens_input: 320,
        tokens_reasoning: 10,
        agent: "build",
        parent_id: null,
        fork_session_id: null,
        time_created: 1791786000000,
        time_updated: 1791786060000,
        time_archived: null,
      });
      expect(loaded?.messages.map((row) => [row.type, row.seq])).toEqual([
        ["user", 1],
        ["assistant", 2],
        ["assistant", 3],
        ["idle", 4],
      ]);
      expect(loaded?.messages[0]?.data).toContain('"text":"Read the example file');
      expect(store.loadSession("ses_missing")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("reads context limits from the cached models.dev catalog", () => {
    const path = freshPath();
    buildOpenCodeFixtureDb(path, []);
    const store = OpenCodeStore.open(path);
    try {
      const windows = store.contextWindows();
      expect(windows.get("opencode-go/glm-5.3-flash")).toBe(1_000_000);
      expect(windows.get("openrouter/meta/muse-wonder")).toBe(1_048_576);
      expect(windows.get("example/example-unpriced")).toBe(64_000);
      expect(windows.get("example/none")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("treats a database without 2.x tables as having no sessions", () => {
    const path = freshPath("opencode-legacy.db");
    const legacy = new Database(path, { create: true, strict: true });
    legacy.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    legacy.close();
    const store = OpenCodeStore.open(path);
    try {
      expect(store.hasSessionTables()).toBe(false);
      expect(store.listSessions()).toEqual([]);
      expect(store.contextWindows().size).toBe(0);
    } finally {
      store.close();
    }
  });

  test("opens read-only and sees rows committed by another connection", () => {
    const path = freshPath();
    buildOpenCodeDb(path, []);
    const store = OpenCodeStore.open(path);
    try {
      expect(store.listSessions()).toEqual([]);
      expect(() => store.loadSession("x")).not.toThrow();
      const writer = new Database(path, { strict: true });
      writer.exec(`INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
                   VALUES ('ses_live', 'prj', 'live', '/decant-fixture/example', '2.0.27', 5, 9)`);
      writer.close();
      expect(store.listSessions()).toEqual([
        {
          dbPath: path,
          sessionId: "ses_live",
          format: "v2",
          fingerprint: "9:0:-1:-1",
          timeUpdated: 9,
          directory: "/decant-fixture/example",
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("sees rows that exist only in the WAL of a database another process holds open", () => {
    const path = freshPath();
    buildOpenCodeFixtureDb(path, ["sample.sql"]);
    const writer = new Database(path, { strict: true });
    try {
      writer.exec("PRAGMA journal_mode = WAL;");
      // Auto-checkpoint is off so the insert stays in the -wal file, as it does
      // while OpenCode is running; an immutable open would never see it.
      writer.exec("PRAGMA wal_autocheckpoint = 0;");
      writer.exec(`INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
                   VALUES ('ses_wal', 'prj', 'wal', '/decant-fixture/example', '2.0.27', 5, 9)`);
      writer.exec(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
                   VALUES ('msg_wal_1', 'ses_wal', 'user', 1, 6, 7, '{"text":"hello"}')`);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

      const store = OpenCodeStore.open(path);
      try {
        expect(store.listSessions().map((ref) => [ref.sessionId, ref.fingerprint])).toEqual([
          ["ses_sample", "1791786060000:4:4:1791786008000"],
          ["ses_wal", "9:1:1:7"],
        ]);
        expect(store.loadSession("ses_wal")?.messages.map((row) => row.id)).toEqual(["msg_wal_1"]);
      } finally {
        store.close();
      }
    } finally {
      writer.close();
    }
  });

  test("never modifies the database file", () => {
    const path = freshPath();
    buildOpenCodeFixtureDb(path, ["sample.sql", "mcp.sql", "v1-sample.sql"]);
    const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const beforeDigest = digest();
    const beforeMtime = statSync(path).mtimeMs;

    const store = OpenCodeStore.open(path);
    try {
      store.listSessions();
      store.loadSession("ses_sample");
      store.contextWindows();
      expect(store.listLegacySessions().map((ref) => ref.sessionId)).toEqual(["ses_v1_sample"]);
      expect(store.loadLegacySession("ses_v1_sample")?.parts).toHaveLength(16);
    } finally {
      store.close();
    }

    expect(digest()).toBe(beforeDigest);
    expect(statSync(path).mtimeMs).toBe(beforeMtime);
    // A read-only connection leaves no journal or WAL sidecar behind.
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(`${path}-journal`)).toBe(false);
  });

  test("refuses to open a missing database", () => {
    expect(() => OpenCodeStore.open(join(workDir, "absent", "opencode.db"))).toThrow();
  });

  test("builds the fingerprint from the four change fields", () => {
    expect(openCodeFingerprint(10, 3, 7, 20)).toBe("10:3:7:20");
    expect(openCodeFingerprint(10, 0, null, null)).toBe("10:0:-1:-1");
  });
});

describe("OpenCodeStore 1.x tables", () => {
  const SAMPLE_FINGERPRINT = "v1:1791790060000:4:16:1791790010000:1791790010000";

  test("lists a 1.x-only database with v1 fingerprints", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql"]);
    const store = OpenCodeStore.open(path);
    try {
      expect(store.hasSessionTables()).toBe(false);
      expect(store.hasLegacyTables()).toBe(true);
      expect(store.listSessions()).toEqual([]);
      expect(store.loadSession("ses_v1_sample")).toBeNull();
      expect(store.listLegacySessions()).toEqual([
        {
          dbPath: path,
          sessionId: "ses_v1_sample",
          format: "v1",
          fingerprint: SAMPLE_FINGERPRINT,
          timeUpdated: 1791790060000,
          directory: "/decant-fixture/example",
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("lists both copies of a migrated session, each with its own time_updated", () => {
    // Which copy wins is ingest's decision (newest time_updated, across
    // formats and databases), so the store reports every 1.x session.
    const path = freshPath();
    buildOpenCodeFixtureDb(path, ["v1/migrated.sql"]);
    const store = OpenCodeStore.open(path);
    try {
      expect(store.listSessions()).toEqual([
        {
          dbPath: path,
          sessionId: "ses_shared",
          format: "v2",
          fingerprint: "1791796000000:1:0:1791796000000",
          timeUpdated: 1791796000000,
          directory: "/decant-fixture/example",
        },
      ]);
      expect(store.listLegacySessions()).toEqual([
        {
          dbPath: path,
          sessionId: "ses_shared",
          format: "v1",
          fingerprint: "v1:1791799999999:1:1:1791796000000:1791796000000",
          timeUpdated: 1791799999999,
          directory: "/decant-fixture/example",
        },
        {
          dbPath: path,
          sessionId: "ses_v1_only",
          format: "v1",
          fingerprint: "v1:1791796160000:2:4:1791796103000:1791796103000",
          timeUpdated: 1791796160000,
          directory: "/decant-fixture/example",
        },
      ]);
      expect(store.loadLegacySession("ses_shared")?.session.title).toBe("Legacy copy");
      expect(store.loadSession("ses_shared")?.session.title).toBe("Migrated copy");
    } finally {
      store.close();
    }
  });

  test("lists a session with no messages or parts", () => {
    const path = freshPath();
    buildOpenCodeV1Db(path, [
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES ('ses_v1_empty', 'prj', 'empty', '/decant-fixture/example', 'Empty', '1.18.35', 5, 9)`,
    ]);
    const store = OpenCodeStore.open(path);
    try {
      expect(store.listLegacySessions().map((ref) => ref.fingerprint)).toEqual(["v1:9:0:0:-1:-1"]);
      expect(store.loadLegacySession("ses_v1_empty")).toMatchObject({ messages: [], parts: [] });
    } finally {
      store.close();
    }
  });

  test("changes the fingerprint when a part or message changes", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql"]);
    const store = OpenCodeStore.open(path);
    const fingerprint = () => store.listLegacySessions()[0]?.fingerprint;
    try {
      expect(fingerprint()).toBe(SAMPLE_FINGERPRINT);
      const writer = new Database(path, { strict: true });
      try {
        // A streamed part update moves only the part's time_updated.
        writer.exec("UPDATE part SET time_updated = 1791790020000 WHERE id = 'prt_v1s_16'");
        const afterPartUpdate = fingerprint();
        expect(afterPartUpdate).toBe("v1:1791790060000:4:16:1791790010000:1791790020000");
        writer.exec(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                     VALUES ('prt_v1s_17', 'msg_v1s_4', 'ses_v1_sample', 1, 2, '{"type":"step-start"}')`);
        const afterInsert = fingerprint();
        expect(afterInsert).toBe("v1:1791790060000:4:17:1791790010000:1791790020000");
        writer.exec("DELETE FROM part WHERE message_id = 'msg_v1s_4'");
        writer.exec("DELETE FROM message WHERE id = 'msg_v1s_4'");
        expect(fingerprint()).toBe("v1:1791790060000:3:15:1791790009000:1791790009000");
      } finally {
        writer.close();
      }
    } finally {
      store.close();
    }
  });

  test("loads rows in OpenCode's order", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql"]);
    const store = OpenCodeStore.open(path);
    try {
      const loaded = store.loadLegacySession("ses_v1_sample");
      expect(loaded?.messages.map((row) => row.id)).toEqual([
        "msg_v1s_1",
        "msg_v1s_2",
        "msg_v1s_3",
        "msg_v1s_4",
      ]);
      expect(loaded?.parts).toHaveLength(16);
      expect(loaded?.parts.map((row) => row.id)).toEqual(
        Array.from({ length: 16 }, (_, i) => `prt_v1s_${String(i + 1).padStart(2, "0")}`),
      );
      expect(loaded?.parts.every((row) => row.session_id === "ses_v1_sample")).toBe(true);
      expect(loaded?.session).toEqual({
        id: "ses_v1_sample",
        project_id: "prj_v1",
        parent_id: null,
        slug: "v1-sample",
        directory: "/decant-fixture/example",
        title: "Read the example notes",
        version: "1.18.35",
        cost: 0.0000894,
        tokens_input: 370,
        tokens_output: 47,
        tokens_reasoning: 10,
        tokens_cache_read: 100,
        tokens_cache_write: 16,
        revert: null,
        agent: "build",
        model: '{"id":"glm-5.3-flash","providerID":"opencode-go","variant":"max"}',
        time_created: 1791790000000,
        time_updated: 1791790060000,
        time_archived: null,
      });
      expect(store.loadLegacySession("ses_missing")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("orders messages by time_created then id, and parts by message_id then id", () => {
    const path = freshPath();
    buildOpenCodeV1Db(path, [
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
       VALUES ('ses_o', 'prj', 'o', '/decant-fixture/example', 'Order', '1.18.35', 1, 9);
       INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
         ('msg_c', 'ses_o', 3, 3, '{}'),
         ('msg_b', 'ses_o', 2, 2, '{}'),
         ('msg_a2', 'ses_o', 2, 2, '{}'),
         ('msg_x', 'ses_other', 1, 1, '{}');
       INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
         ('prt_2', 'msg_c', 'ses_o', 1, 1, '{}'),
         ('prt_1', 'msg_c', 'ses_o', 9, 9, '{}'),
         ('prt_9', 'msg_a2', 'ses_o', 1, 1, '{}'),
         ('prt_0', 'msg_x', 'ses_other', 1, 1, '{}');`,
    ]);
    const store = OpenCodeStore.open(path);
    try {
      const loaded = store.loadLegacySession("ses_o");
      expect(loaded?.messages.map((row) => row.id)).toEqual(["msg_a2", "msg_b", "msg_c"]);
      expect(loaded?.parts.map((row) => row.id)).toEqual(["prt_9", "prt_1", "prt_2"]);
    } finally {
      store.close();
    }
  });

  test("reads a v1.2-shaped database", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1/old-shape.sql"], "1.2");
    const store = OpenCodeStore.open(path);
    try {
      expect(store.hasLegacyTables()).toBe(true);
      expect(store.listLegacySessions()).toEqual([
        {
          dbPath: path,
          sessionId: "ses_v1_12",
          format: "v1",
          fingerprint: "v1:1791798060000:2:2:1791798003000:1791798002500",
          timeUpdated: 1791798060000,
          directory: "/decant-fixture/example",
        },
      ]);
      const loaded = store.loadLegacySession("ses_v1_12");
      expect(loaded?.session).toMatchObject({
        id: "ses_v1_12",
        version: "1.2.0",
        title: "Old shape",
        cost: null,
        tokens_input: null,
        tokens_output: null,
        tokens_reasoning: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
        model: null,
        agent: null,
        time_archived: null,
      });
      expect(loaded?.messages.map((row) => row.id)).toEqual(["msg_v1t_1", "msg_v1t_2"]);
      expect(loaded?.parts.map((row) => row.id)).toEqual(["prt_v1t_01", "prt_v1t_02"]);
    } finally {
      store.close();
    }
  });

  test("returns malformed row data as stored, for the parser to diagnose", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1/malformed.sql"]);
    const store = OpenCodeStore.open(path);
    try {
      expect(store.listLegacySessions().map((ref) => ref.fingerprint)).toEqual([
        "v1:1791797060000:3:3:1791797003000:1791797004000",
      ]);
      const loaded = store.loadLegacySession("ses_v1_bad");
      expect(loaded?.messages.map((row) => row.data)[0]).toBe("not json");
      // The orphan part is still the session's part; ordering puts it by message id.
      expect(loaded?.parts.map((row) => row.id)).toEqual(["prt_v1b_1", "prt_v1b_2", "prt_v1b_3"]);
    } finally {
      store.close();
    }
  });

  test("has no legacy sessions without all three tables", () => {
    const path = freshPath("opencode-partial.db");
    const partial = new Database(path, { create: true, strict: true });
    partial.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    partial.exec("CREATE TABLE message (id TEXT PRIMARY KEY)");
    partial.close();
    const store = OpenCodeStore.open(path);
    try {
      expect(store.hasLegacyTables()).toBe(false);
      expect(store.listLegacySessions()).toEqual([]);
      expect(store.loadLegacySession("x")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("sees 1.x rows that exist only in the WAL of a database another process holds open", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql"]);
    const writer = new Database(path, { strict: true });
    try {
      writer.exec("PRAGMA journal_mode = WAL;");
      writer.exec("PRAGMA wal_autocheckpoint = 0;");
      writer.exec(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                   VALUES ('prt_v1s_17', 'msg_v1s_4', 'ses_v1_sample', 1791790011000,
                           1791790011000, '{"type":"step-start"}')`);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
      const store = OpenCodeStore.open(path);
      try {
        expect(store.listLegacySessions().map((ref) => ref.fingerprint)).toEqual([
          "v1:1791790060000:4:17:1791790010000:1791790011000",
        ]);
        expect(store.loadLegacySession("ses_v1_sample")?.parts.at(-1)?.id).toBe("prt_v1s_17");
      } finally {
        store.close();
      }
    } finally {
      writer.close();
    }
  });

  test("builds the v1 fingerprint from the six change fields", () => {
    expect(openCodeLegacyFingerprint(10, 3, 5, 20, 21)).toBe("v1:10:3:5:20:21");
    expect(openCodeLegacyFingerprint(10, 0, 0, null, null)).toBe("v1:10:0:0:-1:-1");
    // Never equal to a 2.x key for the same virtual path.
    expect(openCodeLegacyFingerprint(10, 0, 0, null, null)).not.toBe(
      openCodeFingerprint(10, 0, null, null),
    );
  });
});

describe("readOpenCodeMcpServers", () => {
  test("reads both the servers map and the legacy top-level layout", () => {
    const path = join(workDir, "opencode.json");
    writeFileSync(
      path,
      JSON.stringify({
        mcp: {
          timeout: 30,
          servers: { dosu: { type: "remote", url: "https://example.invalid/mcp" } },
          "legacy server": { type: "local", command: ["example"] },
        },
      }),
    );
    expect(readOpenCodeMcpServers(path)).toEqual(["dosu", "legacy server"]);
  });

  test("returns nothing for a missing, malformed, or server-less config", () => {
    expect(readOpenCodeMcpServers(join(workDir, "absent.json"))).toEqual([]);
    const broken = join(workDir, "broken.json");
    writeFileSync(broken, "{");
    expect(readOpenCodeMcpServers(broken)).toEqual([]);
    const empty = join(workDir, "empty.json");
    writeFileSync(empty, JSON.stringify({ model: "example/example-model" }));
    expect(readOpenCodeMcpServers(empty)).toEqual([]);
  });
});

describe("parseJsonc", () => {
  test("accepts comments and trailing commas outside strings", () => {
    const text = [
      "\uFEFF{",
      "  // line comment",
      '  "url": "https://example.invalid/a//b", /* block, with comma, */',
      '  "text": "keep /* this */ and \\"// this\\",",',
      '  "list": [1, 2, /* c */ ],',
      '  "nested": { "a": [], },',
      "}",
    ].join("\n");
    expect(parseJsonc(text)).toEqual({
      url: "https://example.invalid/a//b",
      text: 'keep /* this */ and "// this",',
      list: [1, 2],
      nested: { a: [] },
    });
  });

  test("rejects input that is not JSON once comments and trailing commas go", () => {
    expect(() => parseJsonc("{ /* open")).toThrow();
    expect(() => parseJsonc("{ a: 1 }")).toThrow();
    expect(() => parseJsonc("[1,,]")).toThrow();
  });
});

describe("OpenCode config lookup", () => {
  const servers = (...names: string[]) => ({
    mcp: { servers: Object.fromEntries(names.map((name) => [name, { type: "remote" }])) },
  });

  test("reads opencode.jsonc", () => {
    const dir = join(workDir, "jsonc");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "opencode.jsonc");
    writeFileSync(
      path,
      '{\n  // servers\n  "mcp": { "servers": { "exa": { "type": "remote", }, }, },\n}\n',
    );
    expect(readOpenCodeMcpServers(path)).toEqual(["exa"]);
  });

  test("reads the global directory's two files, or Decant's override, plus OPENCODE_CONFIG", () => {
    expect(openCodeGlobalConfigPaths({ globalDir: "/g" })).toEqual([
      "/g/opencode.json",
      "/g/opencode.jsonc",
    ]);
    // DECANT_OPENCODE_CONFIG replaces the global directory's files.
    expect(openCodeGlobalConfigPaths({ globalDir: "/g", globalFile: "/d/custom.json" })).toEqual([
      "/d/custom.json",
    ]);
    // OPENCODE_CONFIG is loaded in addition, as OpenCode does.
    expect(openCodeGlobalConfigPaths({ globalDir: "/g", extraFile: "/x/extra.json" })).toEqual([
      "/g/opencode.json",
      "/g/opencode.jsonc",
      "/x/extra.json",
    ]);
    expect(openCodeGlobalConfigPaths({})).toEqual([]);
  });

  /** An in-memory tree: `files` maps absolute paths to text, and `links`
   * maps a symlink's absolute path to its target. Every read is recorded. */
  function memoryFs(
    files: Record<string, unknown>,
    links: Record<string, string> = {},
  ): OpenCodeConfigFs & { reads: string[] } {
    const text = new Map(
      Object.entries(files).map(([path, value]) => [
        path,
        typeof value === "string" ? value : JSON.stringify(value),
      ]),
    );
    const realPath = (path: string): string => {
      let resolved = resolve(path);
      for (const [link, target] of Object.entries(links)) {
        if (resolved === link || resolved.startsWith(`${link}/`)) {
          resolved = target + resolved.slice(link.length);
        }
      }
      return resolved;
    };
    const reads: string[] = [];
    return {
      reads,
      realPath,
      readText(path) {
        reads.push(path);
        return text.get(realPath(path)) ?? null;
      },
    };
  }

  test("merges global and project configs per directory", () => {
    const fs = memoryFs({
      "/cfg/opencode.json": servers("dosu"),
      "/cfg/opencode.jsonc": `// global\n${JSON.stringify(servers("exa"))}`,
      "/work/project/opencode.json": servers("github"),
      "/work/project/opencode.jsonc": servers("supabase"),
      "/work/project/.opencode/opencode.json": servers("context7"),
      "/work/project/.opencode/opencode.jsonc": "{ /* unfinished",
    });
    const names = new OpenCodeMcpServerNames({ globalDir: "/cfg" }, fs);
    expect(names.forDirectory("/work/project")).toEqual([
      "context7",
      "dosu",
      "exa",
      "github",
      "supabase",
    ]);
    expect(names.forDirectory("/work/other")).toEqual(["dosu", "exa"]);
    expect(names.forDirectory(null)).toEqual(["dosu", "exa"]);
    expect(names.forDirectory("relative/dir")).toEqual(["dosu", "exa"]);
    expect(new OpenCodeMcpServerNames({}, fs).forDirectory("/work/project")).toEqual([
      "context7",
      "github",
      "supabase",
    ]);
  });

  test("walks from the session directory up to the filesystem root, each level read once", () => {
    const fs = memoryFs({
      "/cfg/opencode.json": servers("dosu"),
      "/opencode.json": servers("root-server"),
      "/work/opencode.jsonc": servers("exa"),
      "/work/repo/.opencode/opencode.json": servers("github"),
      "/work/repo/pkg/opencode.json": servers("context7"),
    });
    const names = new OpenCodeMcpServerNames({ globalDir: "/cfg" }, fs);
    expect(names.forDirectory("/work/repo/pkg")).toEqual([
      "context7",
      "dosu",
      "exa",
      "github",
      "root-server",
    ]);
    // A sibling shares every ancestor above it; those are not read again.
    expect(names.forDirectory("/work/repo/docs")).toEqual(["dosu", "exa", "github", "root-server"]);
    expect(names.forDirectory("/elsewhere")).toEqual(["dosu", "root-server"]);
    expect(fs.reads.filter((path) => path === "/work/opencode.jsonc")).toHaveLength(1);
    expect(fs.reads.filter((path) => path === "/opencode.json")).toHaveLength(1);
    expect(new Set(fs.reads).size).toBe(fs.reads.length);

    // Cached for the instance: a later edit is seen by the next sync's lookup.
    const edited = memoryFs({
      "/cfg/opencode.json": servers("dosu"),
      "/work/opencode.jsonc": servers("exa", "probe-tools"),
    });
    expect(
      new OpenCodeMcpServerNames({ globalDir: "/cfg" }, edited).forDirectory("/work/x"),
    ).toEqual(["dosu", "exa", "probe-tools"]);
  });

  test("does not read the global directory again when the walk passes through it", () => {
    const tree = {
      "/home/dev/.config/opencode/opencode.json": servers("dosu"),
      "/home/dev/.config/opencode/.opencode/opencode.json": servers("nested"),
      "/home/dev/.opencode/opencode.json": servers("exa"),
      "/home/dev/opencode.json": servers("home-server"),
    };
    const global = "/home/dev/.config/opencode/opencode.json";

    // A session below the global directory: its own files are global, not project.
    let fs = memoryFs(tree);
    let names = new OpenCodeMcpServerNames({ globalDir: "/home/dev/.config/opencode" }, fs);
    expect(names.forDirectory("/home/dev/.config/opencode/sub")).toEqual([
      "dosu",
      "exa",
      "home-server",
      "nested",
    ]);
    expect(fs.reads.filter((path) => path === global)).toHaveLength(1);

    // OPENCODE_CONFIG_DIR at a `.opencode` directory: the walk's `.opencode`
    // at that level is the global directory and is skipped.
    fs = memoryFs(tree);
    names = new OpenCodeMcpServerNames({ globalDir: "/home/dev/.opencode" }, fs);
    expect(names.forDirectory("/home/dev/project")).toEqual(["exa", "home-server"]);
    expect(fs.reads.filter((path) => path === "/home/dev/.opencode/opencode.json")).toHaveLength(1);

    // Reached through a symlink, the global directory is still recognized.
    fs = memoryFs(tree, { "/links/config": "/home/dev/.config/opencode" });
    names = new OpenCodeMcpServerNames({ globalDir: "/links/config" }, fs);
    expect(names.forDirectory("/home/dev/.config/opencode/sub")).toEqual([
      "dosu",
      "exa",
      "home-server",
      "nested",
    ]);
    expect(fs.reads.filter((path) => fs.realPath(path) === global)).toHaveLength(1);

    // A session run from the global directory itself reads no project configs.
    fs = memoryFs(tree);
    names = new OpenCodeMcpServerNames({ globalDir: "/home/dev/.config/opencode" }, fs);
    expect(names.forDirectory("/home/dev/.config/opencode")).toEqual(["dosu"]);
    expect(fs.reads).toEqual([global, "/home/dev/.config/opencode/opencode.jsonc"]);
  });
});
