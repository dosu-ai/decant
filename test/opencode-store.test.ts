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
import { join } from "node:path";
import {
  OpenCodeMcpServerNames,
  OpenCodeStore,
  openCodeFingerprint,
  openCodeGlobalConfigPaths,
  parseJsonc,
  readOpenCodeMcpServers,
} from "../src/sources/opencode-store.ts";
import { buildOpenCodeDb, buildOpenCodeFixtureDb } from "./opencode-fixture.ts";

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
          fingerprint: "1791789660000:4:4:1791789607000",
          timeUpdated: 1791789660000,
        },
        {
          dbPath: path,
          sessionId: "ses_sample",
          fingerprint: "1791786060000:4:4:1791786008000",
          timeUpdated: 1791786060000,
        },
      ]);
      const loaded = store.loadSession("ses_sample");
      expect(loaded?.session).toMatchObject({
        id: "ses_sample",
        directory: "/tmp/example",
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
                   VALUES ('ses_live', 'prj', 'live', '/tmp/example', '2.0.27', 5, 9)`);
      writer.close();
      expect(store.listSessions()).toEqual([
        { dbPath: path, sessionId: "ses_live", fingerprint: "9:0:-1:-1", timeUpdated: 9 },
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
                   VALUES ('ses_wal', 'prj', 'wal', '/tmp/example', '2.0.27', 5, 9)`);
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
    buildOpenCodeFixtureDb(path, ["sample.sql", "mcp.sql"]);
    const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const beforeDigest = digest();
    const beforeMtime = statSync(path).mtimeMs;

    const store = OpenCodeStore.open(path);
    try {
      store.listSessions();
      store.loadSession("ses_sample");
      store.contextWindows();
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

  test("merges global and project configs per directory, read once each", () => {
    const root = join(workDir, "lookup");
    const globalDir = join(root, "config");
    const global = join(globalDir, "opencode.json");
    const project = join(root, "project");
    const other = join(root, "other");
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(project, ".opencode"), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(global, JSON.stringify(servers("dosu")));
    writeFileSync(
      join(root, "config", "opencode.jsonc"),
      `// global\n${JSON.stringify(servers("exa"))}`,
    );
    writeFileSync(join(project, "opencode.json"), JSON.stringify(servers("github")));
    writeFileSync(join(project, "opencode.jsonc"), JSON.stringify(servers("supabase")));
    writeFileSync(join(project, ".opencode", "opencode.json"), JSON.stringify(servers("context7")));
    writeFileSync(join(project, ".opencode", "opencode.jsonc"), "{ /* unfinished");

    const names = new OpenCodeMcpServerNames({ globalDir });
    expect(names.forDirectory(project)).toEqual(["context7", "dosu", "exa", "github", "supabase"]);
    expect(names.forDirectory(other)).toEqual(["dosu", "exa"]);
    expect(names.forDirectory(null)).toEqual(["dosu", "exa"]);
    expect(names.forDirectory("relative/dir")).toEqual(["dosu", "exa"]);
    expect(names.forDirectory(join(root, "missing"))).toEqual(["dosu", "exa"]);

    // Cached for the instance: a later edit applies to the next sync's lookup.
    writeFileSync(join(other, "opencode.json"), JSON.stringify(servers("probe-tools")));
    expect(names.forDirectory(other)).toEqual(["dosu", "exa"]);
    expect(new OpenCodeMcpServerNames({ globalDir }).forDirectory(other)).toEqual([
      "dosu",
      "exa",
      "probe-tools",
    ]);
    expect(new OpenCodeMcpServerNames().forDirectory(project)).toEqual([
      "context7",
      "github",
      "supabase",
    ]);
  });
});
