import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeStore,
  openCodeFingerprint,
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
