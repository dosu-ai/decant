import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../src/db.ts";
import {
  discover,
  discoverSourcePaths,
  hermesDatabasePaths,
  type IngestConfig,
  sync,
} from "../src/ingest.ts";
import type { ParsedSession } from "../src/model.ts";
import { listSessions } from "../src/query.ts";
import { normalizeHermesToolName, parseHermesSession } from "../src/sources/hermes.ts";
import { HermesStore, HermesStoreError } from "../src/sources/hermes-store.ts";
import { totals } from "../src/stats.ts";
import { buildHermesDb, buildHermesFixtureDb } from "./hermes-fixture.ts";

const SAMPLE = "20261101_090000_a1b2c3";
const SUBAGENT = "20261101_090110_d4e5f6";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch(): string {
  // Discovery resolves symlinks, such as macOS's /var to /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "decant-hermes-test-")));
  roots.push(root);
  return root;
}

function fixtureDb(names: readonly string[] = ["sample.sql", "subagent.sql"]): string {
  const path = join(scratch(), "state.db");
  buildHermesFixtureDb(path, names);
  return path;
}

function dbWith(...scripts: string[]): string {
  const path = join(scratch(), "state.db");
  buildHermesDb(path, scripts);
  return path;
}

function parseFrom(dbPath: string, sessionId: string): ParsedSession {
  const store = HermesStore.open(dbPath);
  try {
    const loaded = store.loadSession(sessionId);
    if (loaded == null) {
      throw new Error(`missing fixture session ${sessionId}`);
    }
    return parseHermesSession(loaded.session, loaded.messages, loaded.modelUsage);
  } finally {
    store.close();
  }
}

/** One invented session row with the given extra columns. */
function sessionSql(id: string, columns: Record<string, string | number | null> = {}): string {
  const all: Record<string, string | number | null> = {
    id,
    source: "cli",
    started_at: 1791790000,
    cwd: "/decant-fixture/example",
    ...columns,
  };
  const names = Object.keys(all);
  const values = names.map((name) => {
    const value = all[name];
    return value == null ? "NULL" : typeof value === "number" ? String(value) : `'${value}'`;
  });
  return `INSERT INTO sessions (${names.join(", ")}) VALUES (${values.join(", ")});`;
}

function messageSql(
  sessionId: string,
  id: number,
  role: string,
  content: string | null,
  extra: Record<string, string | number | null> = {},
): string {
  const all: Record<string, string | number | null> = {
    id,
    session_id: sessionId,
    role,
    content,
    timestamp: 1791790000 + id,
    ...extra,
  };
  const names = Object.keys(all);
  const values = names.map((name) => {
    const value = all[name];
    if (value == null) return "NULL";
    if (typeof value === "number") return String(value);
    return `'${value.replaceAll("'", "''")}'`;
  });
  return `INSERT INTO messages (${names.join(", ")}) VALUES (${values.join(", ")});`;
}

describe("parseHermesSession", () => {
  const sample = parseFrom(fixtureDb(), SAMPLE);

  test("reads the display transcript, merging compaction copies and skipping rewound rows", () => {
    const { session, issues } = sample;
    expect(issues).toEqual([]);
    expect(session.tool).toBe("hermes");
    expect(session.sourceSessionId).toBe(SAMPLE);
    // Rows 1-4 were archived by compaction and stay; row 7 is the live copy
    // of row 5 and takes its place; row 14 was rewound.
    expect(session.messages.map((message) => message.sourceUuid)).toEqual([
      "uid-user-1",
      "uid-assistant-2",
      "uid-tool-3",
      "uid-assistant-4",
      "uid-user-5",
      "uid-summary-6",
      "uid-assistant-8",
      "uid-tool-9",
      "uid-tool-10",
      "uid-tool-11",
      "uid-assistant-12",
      "uid-tool-13",
      "uid-assistant-15",
    ]);
    expect(session.messages.map((message) => message.seq)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const copy = session.messages[4];
    expect(copy?.raw).toMatchObject({ id: 7, active: 1 });
    expect(session.rawMeta).toMatchObject({
      rewound_rows_skipped: 1,
      compacted_rows: 5,
      copied_rows_merged: 1,
    });
    expect(
      session.messages.some((message) => JSON.stringify(message.raw).includes("rewound")),
    ).toBe(false);
  });

  test("maps session metadata", () => {
    const { session } = sample;
    expect(session).toMatchObject({
      title: "Summarize the example notes",
      projectPath: "/decant-fixture/example",
      cwd: "/decant-fixture/example",
      gitBranch: "main",
      model: "anthropic/claude-sonnet-5-5",
      startedAt: "2026-10-12T06:20:00.000Z",
      endedAt: "2026-10-12T06:22:10.500Z",
      isArchived: false,
      isSubagent: false,
      rootSourceSessionId: null,
      reasoningSource: "reported",
    });
    expect(session.messages[0]?.timestamp).toBe("2026-10-12T06:20:00.000Z");
    expect(session.rawMeta).toMatchObject({
      session: { source: "cli", end_reason: "cli_close", model_config: { max_iterations: 90 } },
    });
    expect(JSON.stringify(session.rawMeta)).not.toContain("example assistant");
  });

  test("decodes structured content, reasoning, and tool calls", () => {
    const [user, read, readResult, , , summary, plan, ls, docs] = sample.session.messages;
    expect(user?.blocks.map((b) => [b.blockType, b.text])).toEqual([
      ["text", "Read notes.txt and summarize it."],
      ["image", null],
    ]);
    expect(user?.raw).toMatchObject({ content: [{ type: "text" }, { type: "image_url" }] });
    expect(read?.blocks.map((b) => [b.blockType, b.text ?? b.toolName])).toEqual([
      ["thinking", "Read the file before answering."],
      ["tool_use", "read_file"],
    ]);
    expect(read?.blocks[1]).toMatchObject({
      toolUseId: "call_read_1",
      toolInput: { path: "notes.txt" },
    });
    expect(readResult?.blocks[0]).toMatchObject({
      blockType: "tool_result",
      toolUseId: "call_read_1",
      toolName: "read_file",
      toolResult: "hello from the example notes",
    });
    // Stored as a user row, filed as the system row that marks the compaction.
    expect(summary?.role).toBe("system");
    expect(summary?.raw).toMatchObject({ role: "user", _compressed_summary: 1 });
    expect(plan?.stopReason).toBe("tool_calls");
    expect(plan?.model).toBeNull();
    expect(plan?.usage).toBeNull();
    expect(plan?.blocks.map((b) => [b.blockType, b.toolName, b.toolUseId])).toEqual([
      ["thinking", null, null],
      ["tool_use", "terminal", "call_ls_1"],
      ["tool_use", "mcp__docs__search_pages", "call_docs_1"],
      ["tool_use", "delegate_task", "call_delegate_1"],
    ]);
    expect(ls?.blocks[0]).toMatchObject({ toolUseId: "call_ls_1", toolName: "terminal" });
    expect(docs?.blocks[0]).toMatchObject({
      toolName: "mcp__docs__search_pages",
      toolResult: "Found 1 page: Getting started.",
    });
  });

  test("totals session usage and splits it by model", () => {
    const { session } = sample;
    expect(session.totals).toEqual({
      input: 1020,
      output: 252,
      cacheRead: 3000,
      cacheCreation: 400,
      cacheCreation1h: 0,
      reasoning: 60,
    });
    expect(session.rawMeta).toMatchObject({
      modelUsage: [
        {
          model: "anthropic/claude-sonnet-5-5",
          requests: 3,
          input: 900,
          output: 240,
          cacheRead: 3000,
          cacheCreation: 400,
        },
        {
          model: "gpt-5.4-mini",
          requests: 1,
          input: 120,
          output: 12,
          cacheRead: 0,
          cacheCreation: 0,
        },
      ],
    });
  });

  test("charges usage the per-model rows do not cover to the session model", () => {
    const db = dbWith(
      sessionSql("s-residual", {
        model: "gpt-5.4-mini",
        input_tokens: 150,
        output_tokens: 20,
        api_call_count: 3,
      }),
      `INSERT INTO session_model_usage (session_id, model, api_call_count, input_tokens, output_tokens)
       VALUES ('s-residual', 'gpt-5.4', 1, 100, 10);`,
    );
    const { session } = parseFrom(db, "s-residual");
    expect(session.totals).toMatchObject({ input: 150, output: 20 });
    expect(session.rawMeta).toMatchObject({
      modelUsage: [
        { model: "gpt-5.4-mini", requests: 2, input: 50, output: 10 },
        { model: "gpt-5.4", requests: 1, input: 100, output: 10 },
      ],
    });
  });

  test("takes the per-model rows as totals when they exceed the session row", () => {
    const db = dbWith(
      sessionSql("s-over", { model: "gpt-5.4", input_tokens: 10, output_tokens: 1 }),
      `INSERT INTO session_model_usage (session_id, model, api_call_count, input_tokens, output_tokens, reasoning_tokens)
       VALUES ('s-over', 'gpt-5.4', 2, 40, 9, 4);`,
    );
    const { session } = parseFrom(db, "s-over");
    expect(session.totals).toMatchObject({ input: 40, output: 9, reasoning: 4 });
  });

  test("a session with no usage reports none", () => {
    const db = dbWith(sessionSql("s-empty"), messageSql("s-empty", 1, "user", "hello"));
    const { session, issues } = parseFrom(db, "s-empty");
    expect(issues).toEqual([]);
    expect(session.reasoningSource).toBe("none");
    expect(session.rawMeta).not.toHaveProperty("modelUsage");
    expect(session.title).toBe("hello");
    expect(session.endedAt).toBe("2026-10-12T07:26:41.000Z");
  });

  test("malformed content and tool calls become diagnostics, and parsing continues", () => {
    const db = dbWith(
      sessionSql("s-bad"),
      `INSERT INTO messages (id, session_id, role, content, timestamp)
       VALUES (1, 's-bad', 'user', char(0) || 'json:[{"type":"text",', 1791790001);`,
      messageSql("s-bad", 2, "assistant", "calling", { tool_calls: "[{not json" }),
      messageSql("s-bad", 3, "assistant", "fine"),
    );
    const { session, issues } = parseFrom(db, "s-bad");
    expect(issues.map((issue) => [issue.code, issue.lineNo])).toEqual([
      ["unparsed_line", 1],
      ["unparsed_line", 2],
    ]);
    expect(issues[0]?.error).toBe("message content: record is not valid JSON");
    expect(issues[1]?.error).toBe("tool calls: record is not valid JSON");
    expect(session.messages.map((message) => message.blocks[0]?.text)).toEqual([
      '[{"type":"text",',
      "calling",
      "fine",
    ]);
  });

  test("an unknown role is kept as other and reported once per role", () => {
    const db = dbWith(
      sessionSql("s-role"),
      messageSql("s-role", 1, "developer", "one"),
      messageSql("s-role", 2, "developer", "two"),
      messageSql("s-role", 3, "user", "three"),
    );
    const { session, issues } = parseFrom(db, "s-role");
    expect(session.messages.map((message) => message.role)).toEqual(["other", "other", "user"]);
    expect(issues).toEqual([
      {
        code: "unknown_record_type",
        lineNo: 1,
        error: 'unknown record type "developer" on 2 line(s); kept as role "other"',
        rawLine: null,
      },
    ]);
  });

  test("reports a tool result with no matching call", () => {
    const db = dbWith(
      sessionSql("s-orphan"),
      messageSql("s-orphan", 1, "tool", "output", {
        tool_call_id: "call_missing",
        tool_name: "terminal",
      }),
    );
    const { issues } = parseFrom(db, "s-orphan");
    expect(issues.map((issue) => issue.code)).toEqual(["orphan_tool_result"]);
  });

  test("tells a subagent run from compression, reset, and branch continuations", () => {
    expect(parseFrom(fixtureDb(), SUBAGENT).session).toMatchObject({
      isSubagent: true,
      rootSourceSessionId: SAMPLE,
      agentId: SUBAGENT,
      rawMeta: { parentSessionId: SAMPLE },
    });
    const key = "agent:main:example:dm:1";
    const db = dbWith(
      sessionSql("p-compressed", { ended_at: 1791790100, end_reason: "compression" }),
      sessionSql("c-compressed", { parent_session_id: "p-compressed", started_at: 1791790101 }),
      sessionSql("p-reset", { session_key: key, ended_at: 1791790100, end_reason: "idle" }),
      sessionSql("c-reset", {
        parent_session_id: "p-reset",
        session_key: key,
        started_at: 1791790101,
      }),
      sessionSql("p-branched", { ended_at: 1791790100, end_reason: "branched" }),
      sessionSql("c-branched", { parent_session_id: "p-branched", started_at: 1791790101 }),
      sessionSql("p-plain"),
      sessionSql("c-marked", {
        parent_session_id: "p-plain",
        model_config: '{"_branched_from":"p-plain"}',
      }),
      sessionSql("c-reset-marked", {
        parent_session_id: "p-plain",
        model_config: '{"_reset_from":"p-plain"}',
      }),
      // Hermes drops the delegate marker from a reset row that picked one up.
      sessionSql("c-reset-and-delegate", {
        parent_session_id: "p-plain",
        model_config: '{"_reset_from":"p-plain","_delegate_from":"p-plain"}',
      }),
      // A compression continuation of a subagent copies its config, marker included.
      sessionSql("c-continued-subagent", {
        parent_session_id: "p-compressed",
        model_config: '{"_delegate_from":"p-plain"}',
      }),
    );
    for (const id of [
      "c-compressed",
      "c-reset",
      "c-branched",
      "c-marked",
      "c-reset-marked",
      "c-reset-and-delegate",
      "c-continued-subagent",
    ]) {
      const { session } = parseFrom(db, id);
      expect([id, session.isSubagent, session.rootSourceSessionId]).toEqual([id, false, null]);
      expect(session.rawMeta).not.toHaveProperty("parentSessionId");
    }
    expect(JSON.stringify(parseFrom(db, "c-reset").session.rawMeta)).not.toContain(key);
  });

  test("a delegated run stays a subagent whatever its parent later ended with", () => {
    const key = "agent:main:example:dm:1";
    const db = dbWith(
      sessionSql("p-idle", { session_key: key, ended_at: 1791790100, end_reason: "idle" }),
      sessionSql("c-unkeyed", { parent_session_id: "p-idle", started_at: 1791790050 }),
      // A keyed delegate that captured its parent's route keeps its marker.
      sessionSql("c-keyed-delegate", {
        parent_session_id: "p-idle",
        session_key: key,
        model_config: '{"_delegate_from":"p-idle"}',
        started_at: 1791790060,
      }),
      sessionSql("p-compressed", { ended_at: 1791790100, end_reason: "compression" }),
      sessionSql("c-delegate-before-compression", {
        parent_session_id: "p-compressed",
        model_config: '{"_delegate_from":"p-compressed"}',
        started_at: 1791790050,
      }),
      sessionSql("c-tool", { parent_session_id: "p-compressed", source: "tool" }),
    );
    for (const [id, parent] of [
      ["c-unkeyed", "p-idle"],
      ["c-keyed-delegate", "p-idle"],
      ["c-delegate-before-compression", "p-compressed"],
      ["c-tool", "p-compressed"],
    ] as const) {
      const { session } = parseFrom(db, id);
      expect([id, session.isSubagent, session.rootSourceSessionId]).toEqual([id, true, parent]);
      expect(session.rawMeta).toMatchObject({ parentSessionId: parent });
    }
  });
});

describe("normalizeHermesToolName", () => {
  test("rewrites Hermes's MCP prefix to Decant's form and leaves built-ins alone", () => {
    expect(normalizeHermesToolName("mcp_github_create_issue")).toBe("mcp__github__create_issue");
    expect(normalizeHermesToolName("mcp_docs_search")).toBe("mcp__docs__search");
    expect(normalizeHermesToolName("mcp_only")).toBe("mcp_only");
    expect(normalizeHermesToolName("read_file")).toBe("read_file");
  });
});

describe("HermesStore", () => {
  test("reads a database from before Hermes added later columns and per-model usage", () => {
    const path = join(scratch(), "state.db");
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT,
        started_at REAL NOT NULL, ended_at REAL, input_tokens INTEGER, output_tokens INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
        timestamp REAL NOT NULL);
      INSERT INTO sessions VALUES ('old', 'cli', 'gpt-5.4', 1791790000, 1791790060, 30, 5);
      INSERT INTO messages (session_id, role, content, timestamp) VALUES
        ('old', 'user', 'hello', 1791790001), ('old', 'assistant', 'hi', 1791790002);
    `);
    db.close();
    const store = HermesStore.open(path);
    try {
      expect(store.listSessions().map((ref) => ref.sessionId)).toEqual(["old"]);
      const loaded = store.loadSession("old");
      if (loaded == null) {
        throw new Error("the old session was not loaded");
      }
      expect(loaded.modelUsage).toEqual([]);
      expect(loaded.messages[0]).toMatchObject({ role: "user", active: null, compacted: null });
      const { session, issues } = parseHermesSession(
        loaded.session,
        loaded.messages,
        loaded.modelUsage,
      );
      expect(issues).toEqual([]);
      expect(session.messages).toHaveLength(2);
      expect(session.totals).toMatchObject({ input: 30, output: 5 });
      expect(store.loadSession("missing")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("refuses a database that is not a Hermes session store", () => {
    const path = join(scratch(), "state.db");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT);");
    db.close();
    expect(() => HermesStore.open(path)).toThrow(HermesStoreError);
  });

  test("the change key follows appends, rewinds, and session state, not heartbeats", () => {
    const path = fixtureDb(["sample.sql"]);
    const key = (): string => {
      const store = HermesStore.open(path);
      try {
        return store.listSessions()[0]?.fingerprint ?? "";
      } finally {
        store.close();
      }
    };
    const writer = new Database(path);
    try {
      const initial = key();
      writer.exec(`UPDATE sessions SET last_activity_at = last_activity_at + 60`);
      expect(key()).toBe(initial);
      writer.exec(`UPDATE messages SET active = 0 WHERE id = 15`);
      const rewound = key();
      expect(rewound).not.toBe(initial);
      writer.exec("UPDATE sessions SET title = 'Renamed'");
      const renamed = key();
      expect(renamed).not.toBe(rewound);
      writer.exec(
        `INSERT INTO messages (session_id, role, content, timestamp) VALUES ('${SAMPLE}', 'user', 'more', 1791786200)`,
      );
      expect(key()).not.toBe(renamed);
    } finally {
      writer.close();
    }
  });
});

describe("Hermes change key and in-place rewrites", () => {
  function keyOf(path: string): string {
    const store = HermesStore.open(path);
    try {
      return store.listSessions()[0]?.fingerprint ?? "";
    } finally {
      store.close();
    }
  }

  test("a transcript revision bump changes the key", () => {
    const path = fixtureDb(["sample.sql"]);
    const initial = keyOf(path);
    const writer = new Database(path);
    try {
      writer.exec(`UPDATE sessions SET transcript_revision = transcript_revision + 1`);
    } finally {
      writer.close();
    }
    expect(keyOf(path)).not.toBe(initial);
  });

  test("without a transcript revision, a rewrite that changes a message's length does", () => {
    const path = join(scratch(), "state.db");
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, started_at REAL NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);
      INSERT INTO sessions VALUES ('old', 'cli', 1791790000);
      INSERT INTO messages (session_id, role, content, timestamp) VALUES
        ('old', 'user', 'hello', 1791790001);
    `);
    const initial = keyOf(path);
    db.exec("UPDATE messages SET content = '[redacted]'");
    db.close();
    expect(keyOf(path)).not.toBe(initial);
  });
});

describe("Hermes discovery and ingest", () => {
  function hermesHome(): { root: string; home: string; config: IngestConfig } {
    const root = scratch();
    const home = join(root, "hermes");
    mkdirSync(join(home, "profiles", "work"), { recursive: true });
    mkdirSync(join(home, "profiles", ".deleted", "old"), { recursive: true });
    buildHermesFixtureDb(join(home, "state.db"), ["sample.sql", "subagent.sql"]);
    buildHermesDb(join(home, "profiles", "work", "state.db"), [
      sessionSql("work-1", {
        model: "gpt-5.4",
        input_tokens: 10,
        output_tokens: 2,
        api_call_count: 1,
      }),
      messageSql("work-1", 1, "user", "hello from the work profile"),
    ]);
    buildHermesDb(join(home, "profiles", ".deleted", "old", "state.db"), [sessionSql("deleted-1")]);
    const config: IngestConfig = {
      claudeDir: join(root, "claude"),
      codexDir: join(root, "codex"),
      hermesDir: home,
    };
    return { root, home, config };
  }

  test("finds the default and named profiles' databases, not deleted ones", () => {
    const { home, config } = hermesHome();
    expect(hermesDatabasePaths(home)).toEqual([
      join(home, "state.db"),
      join(home, "profiles", "work", "state.db"),
    ]);
    expect(hermesDatabasePaths(undefined)).toEqual([]);
    const files = discover(config).filter((file) => file.tool === "hermes");
    expect(files.map((file) => file.path)).toEqual([
      `${join(home, "profiles", "work", "state.db")}#work-1`,
      `${join(home, "state.db")}#${SAMPLE}`,
      `${join(home, "state.db")}#${SUBAGENT}`,
    ]);
  });

  test("--path accepts a state.db file or a directory holding one", () => {
    const { home } = hermesHome();
    const direct = discoverSourcePaths([join(home, "state.db")]);
    expect(direct.map((file) => [file.tool, file.hermes?.sessionId])).toEqual([
      ["hermes", SAMPLE],
      ["hermes", SUBAGENT],
    ]);
    expect(discoverSourcePaths([home]).map((file) => file.hermes?.sessionId)).toContain("work-1");
  });

  test("a state.db from another program is skipped with a warning", () => {
    const root = scratch();
    const other = new Database(join(root, "state.db"), { create: true });
    other.exec("CREATE TABLE kv (key TEXT, value TEXT);");
    other.close();
    const events: unknown[] = [];
    const files = discover(
      { claudeDir: join(root, "claude"), codexDir: join(root, "codex"), hermesDir: root },
      (_message, properties) => events.push(properties["event.name"]),
    );
    expect(files).toEqual([]);
    expect(events).toEqual(["decant.ingest.hermes_open_failed"]);
  });

  test("ingests sessions, links the subagent, prices by model, and skips unchanged sessions", () => {
    const { root, home, config } = hermesHome();
    const db = openDb(join(root, "archive.db"));
    try {
      expect(sync(db, config)).toMatchObject({ ingested: 3, failed: 0, issues: 0 });
      const rows = db
        .query(
          `SELECT s.source_session_id AS id, s.is_subagent, p.source_session_id AS parent,
                  s.total_input_tokens AS input, s.total_reasoning_tokens AS reasoning,
                  s.reasoning_source, s.estimated_cost_usd > 0 AS priced, s.compaction_count,
                  s.agent_spawn_count, s.turn_count
             FROM session s LEFT JOIN session p ON p.id = s.parent_session_id
            WHERE s.tool = 'hermes' ORDER BY s.source_session_id`,
        )
        .all();
      expect(rows).toEqual([
        {
          id: SAMPLE,
          is_subagent: 0,
          parent: null,
          input: 1020,
          reasoning: 60,
          reasoning_source: "reported",
          priced: 1,
          compaction_count: 1,
          agent_spawn_count: 1,
          turn_count: 2,
        },
        {
          id: SUBAGENT,
          is_subagent: 1,
          parent: SAMPLE,
          input: 400,
          reasoning: 0,
          reasoning_source: "reported",
          priced: 1,
          compaction_count: 0,
          agent_spawn_count: 0,
          turn_count: 1,
        },
        {
          id: "work-1",
          is_subagent: 0,
          parent: null,
          input: 10,
          reasoning: 0,
          reasoning_source: "reported",
          priced: 1,
          compaction_count: 0,
          agent_spawn_count: 0,
          turn_count: 1,
        },
      ]);
      expect(
        db
          .query(
            `SELECT u.model, u.requests, u.input_tokens FROM session_model_usage u
               JOIN session s ON s.id = u.session_id
              WHERE s.source_session_id = ?1 ORDER BY u.model`,
          )
          .all(SAMPLE),
      ).toEqual([
        { model: "anthropic/claude-sonnet-5-5", requests: 3, input_tokens: 900 },
        { model: "gpt-5.4-mini", requests: 1, input_tokens: 120 },
      ]);
      expect(
        db
          .query(
            `SELECT t.tool_kind, t.tool_name, t.mcp_server, t.has_result FROM tool_call t
               JOIN session s ON s.id = t.session_id
              WHERE s.source_session_id = ?1 ORDER BY t.id`,
          )
          .all(SAMPLE),
      ).toEqual([
        { tool_kind: "builtin", tool_name: "read_file", mcp_server: null, has_result: 1 },
        { tool_kind: "builtin", tool_name: "terminal", mcp_server: null, has_result: 1 },
        {
          tool_kind: "mcp",
          tool_name: "mcp__docs__search_pages",
          mcp_server: "docs",
          has_result: 1,
        },
        { tool_kind: "builtin", tool_name: "delegate_task", mcp_server: null, has_result: 1 },
        { tool_kind: "builtin", tool_name: "patch", mcp_server: null, has_result: 1 },
      ]);
      expect(
        db
          .query(
            `SELECT f.path, f.operation FROM file_ref f JOIN session s ON s.id = f.session_id
              WHERE s.source_session_id = ?1 ORDER BY f.id`,
          )
          .all(SAMPLE),
      ).toEqual([
        { path: "notes.txt", operation: "read" },
        { path: "/decant-fixture/example/notes.txt", operation: "edit" },
      ]);

      expect(sync(db, config)).toMatchObject({ ingested: 0, skipped: 3 });
      const writer = new Database(join(home, "state.db"));
      try {
        writer.exec(
          `INSERT INTO messages (session_id, role, content, timestamp)
           VALUES ('${SAMPLE}', 'user', 'One more question.', 1791786200)`,
        );
      } finally {
        writer.close();
      }
      expect(sync(db, config)).toMatchObject({ ingested: 1, skipped: 2 });
    } finally {
      closeDb(db);
    }
  });

  test("a message rewritten in place is re-ingested with its new text", () => {
    const { root, home, config } = hermesHome();
    const db = openDb(join(root, "archive.db"));
    try {
      sync(db, config);
      const writer = new Database(join(home, "state.db"));
      try {
        // Hermes's messages_transcript_revision_update trigger bumps the
        // revision on such a rewrite; the fixture schema has no triggers.
        writer.exec(`
          UPDATE messages SET content = 'Summary withheld.' WHERE id = 15;
          UPDATE sessions SET transcript_revision = transcript_revision + 1 WHERE id = '${SAMPLE}';
        `);
      } finally {
        writer.close();
      }
      expect(sync(db, config)).toMatchObject({ ingested: 1, skipped: 2 });
      expect(
        db
          .query(
            `SELECT b.text FROM block b JOIN message m ON m.id = b.message_id
               JOIN session s ON s.id = b.session_id
              WHERE s.source_session_id = ?1 AND m.source_uuid = 'uid-assistant-15'`,
          )
          .all(SAMPLE),
      ).toEqual([{ text: "Summary withheld." }]);
    } finally {
      closeDb(db);
    }
  });

  test("a session is read again from the older profile when its newer copy disappears", () => {
    const root = scratch();
    const home = join(root, "hermes");
    const main = join(home, "state.db");
    const work = join(home, "profiles", "work", "state.db");
    mkdirSync(join(home, "profiles", "work"), { recursive: true });
    buildHermesDb(main, [
      sessionSql("shared-1"),
      messageSql("shared-1", 1, "user", "hello from the default profile"),
    ]);
    buildHermesDb(work, []);
    const config: IngestConfig = {
      claudeDir: join(root, "claude"),
      codexDir: join(root, "codex"),
      hermesDir: home,
    };
    const writeWork = (sql: string): void => {
      const writer = new Database(work);
      try {
        writer.exec(sql);
      } finally {
        writer.close();
      }
    };
    const db = openDb(join(root, "archive.db"));
    const stored = (): unknown =>
      db
        .query(
          `SELECT s.source_path AS path, b.text FROM session s JOIN block b ON b.session_id = s.id
            WHERE s.source_session_id = 'shared-1' ORDER BY b.id`,
        )
        .all();
    try {
      expect(sync(db, config)).toMatchObject({ ingested: 1, failed: 0 });
      const fromMain = [{ path: `${main}#shared-1`, text: "hello from the default profile" }];
      expect(stored()).toEqual(fromMain);
      writeWork(
        `${sessionSql("shared-1")}
         ${messageSql("shared-1", 50, "user", "hello from the work profile")}`,
      );
      expect(sync(db, config)).toMatchObject({ ingested: 1, failed: 0 });
      expect(stored()).toEqual([{ path: `${work}#shared-1`, text: "hello from the work profile" }]);
      writeWork("DELETE FROM messages; DELETE FROM sessions;");
      expect(sync(db, config)).toMatchObject({ ingested: 1, failed: 0 });
      expect(stored()).toEqual(fromMain);
    } finally {
      closeDb(db);
    }
  });

  test("a session that recorded no usage reports it unavailable", () => {
    const root = scratch();
    const home = join(root, "hermes");
    mkdirSync(home, { recursive: true });
    buildHermesDb(join(home, "state.db"), [
      sessionSql("u-none"),
      messageSql("u-none", 1, "user", "hello"),
      sessionSql("u-totals", { model: "gpt-5.4", input_tokens: 10, output_tokens: 2 }),
      messageSql("u-totals", 2, "user", "hello"),
      sessionSql("u-calls", { model: "gpt-5.4", api_call_count: 1 }),
      messageSql("u-calls", 3, "user", "hello"),
    ]);
    const db = openDb(join(root, "archive.db"));
    try {
      sync(db, { claudeDir: join(root, "claude"), codexDir: join(root, "codex"), hermesDir: home });
      const available = Object.fromEntries(
        listSessions(db, { tool: "hermes" }).map((summary) => [
          summary.source_session_id,
          summary.usage_available,
        ]),
      );
      expect(available).toEqual({ "u-none": false, "u-totals": true, "u-calls": true });
      expect(totals(db, { tool: "hermes" })).toMatchObject({ sessions: 3, usage_sessions: 2 });
    } finally {
      closeDb(db);
    }
  });

  test("a session deleted from state.db keeps its archived copy", () => {
    const { root, home, config } = hermesHome();
    const db = openDb(join(root, "archive.db"));
    try {
      sync(db, config);
      const writer = new Database(join(home, "profiles", "work", "state.db"));
      try {
        writer.exec("DELETE FROM messages; DELETE FROM sessions;");
      } finally {
        writer.close();
      }
      expect(sync(db, config)).toMatchObject({ ingested: 0, failed: 0 });
      expect(
        db.query("SELECT COUNT(*) AS n FROM session WHERE source_session_id = 'work-1'").get(),
      ).toEqual({ n: 1 });
    } finally {
      closeDb(db);
    }
  });

  test("an unreadable profile database does not stop the others", () => {
    const { root, home, config } = hermesHome();
    writeFileSync(join(home, "profiles", "work", "state.db"), "not a database");
    const db = openDb(join(root, "archive.db"));
    try {
      expect(sync(db, config)).toMatchObject({ ingested: 2, failed: 0 });
    } finally {
      closeDb(db);
    }
  });
});
