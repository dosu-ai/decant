import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTranscript } from "@letta-ai/trajectory";
import {
  buildLegacyExport,
  compareLegacySessionTotals,
  compareModelTotals,
  compareRecordedCost,
  compareSessionTotals,
  compareStructure,
  costDecantModelGroups,
  type LegacySession,
  lettaStructure,
  type ModelTotals,
  mergeModelTotals,
  type OpenCodeAssistantRow,
  openCodeModelTotals,
  openCodeRuleDifferences,
  parseStatsJson,
  readLegacyCompaction,
  readLegacyModelTotals,
  readLegacySessions,
  readLegacySessionTotals,
  readOpenCodeAssistantRows,
  type SessionTotals,
  type TranscriptStructure,
  toolNamesMatch,
} from "../scripts/opencode-parity.ts";
import { closeDb, openDb } from "../src/db.ts";
import { sync } from "../src/ingest.ts";
import type {
  OpenCodeLegacyMessageRow,
  OpenCodeLegacyPartRow,
} from "../src/sources/opencode-legacy.ts";
import {
  buildOpenCodeDb,
  buildOpenCodeFixtureDb,
  buildOpenCodeV1Db,
  buildOpenCodeV1FixtureDb,
  opencodeFixtureSql,
} from "./opencode-fixture.ts";

const workDir = mkdtempSync(join(tmpdir(), "decant-opencode-parity-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
function freshPath(): string {
  counter += 1;
  const dir = join(workDir, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "opencode.db");
}

function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true, strict: true });
}

/** Runs `fn` on a read-only handle and closes it. */
function withDb<T>(path: string, fn: (db: Database) => T): T {
  const db = openReadOnly(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function legacyRows(
  db: Database,
  sessionId: string,
): { messages: OpenCodeLegacyMessageRow[]; parts: OpenCodeLegacyPartRow[] } {
  return {
    messages: db
      .query(
        `SELECT id, session_id, time_created, time_updated, data
           FROM message WHERE session_id = ?1 ORDER BY time_created, id`,
      )
      .all(sessionId) as OpenCodeLegacyMessageRow[],
    parts: db
      .query(
        `SELECT id, message_id, session_id, time_created, time_updated, data
           FROM part WHERE session_id = ?1 ORDER BY message_id, id`,
      )
      .all(sessionId) as OpenCodeLegacyPartRow[],
  };
}

function exportOf(db: Database, sessionId: string) {
  const session = readLegacySessions(db).find((row) => row.id === sessionId) as LegacySession;
  const { messages, parts } = legacyRows(db, sessionId);
  return buildLegacyExport(session, messages, parts);
}

/** Every focused 1.x session script (old-shape needs its own table shape). */
const V1_SESSIONS = [
  "v1-sample.sql",
  "v1/compaction.sql",
  "v1/subagent.sql",
  "v1/fork.sql",
  "v1/tokens.sql",
  "v1/malformed.sql",
];

const MIXED = [
  "v1-sample.sql",
  "v1/fork.sql",
  "v1/compaction.sql",
  "v1/tokens.sql",
  "v1/migrated.sql",
];

function model(overrides: Partial<ModelTotals>): ModelTotals {
  return {
    provider: "opencode-go",
    model: "glm-5.3-flash",
    steps: 2,
    input: 320,
    output: 42,
    reasoning: 10,
    cacheRead: 100,
    cacheWrite: 16,
    cost: 0.0000794,
    ...overrides,
  };
}

describe("opencode parity comparisons", () => {
  test("matches a model whose Decant output equals the reference output plus reasoning", () => {
    const decant = [model({ output: 52, reasoning: 10, cost: 0.0000794 })];
    const reference = [model({ output: 42, reasoning: 10 })];
    const lines = compareModelTotals(decant, reference, "opencode.db");
    expect(lines.map((line) => line.level)).toEqual(["ok"]);
    expect(lines[0]?.text).toContain("opencode-go/glm-5.3-flash");
  });

  test("flags every field that differs, and models missing on either side", () => {
    const decant = [model({ output: 52, cacheWrite: 0 })];
    const reference = [
      model({}),
      model({ provider: "openrouter", model: "meta/muse-wonder", steps: 1 }),
    ];
    const lines = compareModelTotals(decant, reference, "stats.json");
    expect(lines.map((line) => line.level)).toEqual(["mismatch", "mismatch"]);
    expect(lines[0]?.text).toContain("cacheWrite 0 vs 16");
    expect(lines[0]?.text).not.toContain("output");
    expect(lines[1]?.text).toContain("missing in Decant");
  });

  test("compares list-price cost with the recorded cost within half a percent", () => {
    const reference = [model({ cost: 0.0000794 }), model({ provider: "zai-coding-plan", cost: 0 })];
    const decant = [
      model({ output: 52, cost: 0.0000795 }),
      model({ provider: "zai-coding-plan", output: 52, cost: 0.0000794 }),
    ];
    const lines = compareRecordedCost(decant, reference);
    expect(lines).toEqual([
      { level: "ok", text: expect.stringContaining("opencode-go/glm-5.3-flash") },
      { level: "info", text: expect.stringContaining("zai-coding-plan/glm-5.3-flash") },
    ]);
    expect(compareRecordedCost([model({ output: 52, cost: 0.0001 })], [model({})])[0]?.level).toBe(
      "mismatch",
    );
  });

  test("takes reasoning charged twice before 1.3.16 off the recorded cost", () => {
    // 100 in + 50 out (holding 20 reasoning) at 0.15 / 0.5 per 1M is 40e-6;
    // OpenCode 1.3.10 recorded 50e-6, charging the 20 reasoning tokens again.
    const reference = [
      model({
        input: 100,
        output: 30,
        reasoning: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.00005,
        doubleCharged: 20,
      }),
    ];
    const decant = [
      model({
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.00004,
        costSource: "list",
      }),
    ];
    expect(compareRecordedCost(decant, reference)).toEqual([
      {
        level: "ok",
        text: "opencode-go/glm-5.3-flash: Decant 0.0000400 vs recorded 0.0000500, less 0.0000100 reasoning charged twice before 1.3.16 (0.00%)",
      },
    ]);
    expect(
      compareRecordedCost(decant, [{ ...(reference[0] as ModelTotals), doubleCharged: 0 }])[0]
        ?.level,
    ).toBe("mismatch");
  });

  test("compares a model Decant cannot price by its reported cost, for any provider", () => {
    const unpriced = { provider: "example", model: "example-unpriced" };
    const reference = [
      model({ ...unpriced, cost: 0.0012345 }),
      model({ provider: "zai-coding-plan", cost: 0 }),
      model({ provider: "example", model: "example-free", cost: 0 }),
    ];
    const decant = [
      model({ ...unpriced, cost: 0.0012345, costSource: "reported" }),
      // A free route stays at list price: informational, never a mismatch.
      model({ provider: "zai-coding-plan", cost: 0.0000794, costSource: "list" }),
      model({ provider: "example", model: "example-free", cost: 0, costSource: "reported" }),
    ];
    expect(compareRecordedCost(decant, reference)).toEqual([
      { level: "info", text: expect.stringContaining("example/example-free: no Decant rate") },
      {
        level: "ok",
        text: "example/example-unpriced: Decant reported 0.0012345 vs recorded 0.0012345 (no Decant rate)",
      },
      {
        level: "info",
        text: "zai-coding-plan/glm-5.3-flash: recorded 0, Decant 0.0000794 (not compared)",
      },
    ]);
    expect(
      compareRecordedCost(
        [model({ ...unpriced, cost: 0.008, costSource: "reported" })],
        [model({ ...unpriced, cost: 0.0012345 })],
      )[0]?.level,
    ).toBe("mismatch");
  });

  test("costs Decant groups at list price or at the archive's reported cost", () => {
    const group = {
      steps: 1,
      input: 320,
      output: 52,
      cacheRead: 100,
      cacheWrite: 16,
    };
    const rows = costDecantModelGroups(
      [
        { ...group, provider: "opencode-go", model: "glm-5.3-flash", recorded: 0.0000794 },
        { ...group, provider: "example", model: "example-unpriced", recorded: 0.006 },
        { ...group, provider: "other", model: "example-unpriced", recorded: 0.002 },
        { ...group, provider: "example", model: "example-zero", recorded: 0 },
      ],
      new Map([["example-unpriced", 0.01]]),
    );
    expect(rows.map((row) => [row.provider, row.costSource])).toEqual([
      ["opencode-go", "list"],
      ["example", "reported"],
      ["other", "reported"],
      ["example", "reported"],
    ]);
    expect(rows[0]?.cost).toBeGreaterThan(0);
    // One model's stored figure is shared by what each provider recorded.
    expect(rows[1]?.cost).toBeCloseTo(0.0075, 12);
    expect(rows[2]?.cost).toBeCloseTo(0.0025, 12);
    expect(rows[3]?.cost).toBe(0);
    expect(rows.every((row) => row.reasoning === 0)).toBe(true);
  });

  test("allows Decant session totals at or below the recorded ones, never above", () => {
    const base: SessionTotals = {
      sessionId: "ses_a",
      input: 320,
      output: 52,
      reasoning: 10,
      cacheRead: 100,
      cacheWrite: 16,
      cost: 0.0000794,
    };
    const reference: SessionTotals[] = [
      base,
      { ...base, sessionId: "ses_b", input: 400 },
      // Migrated from 1.x: session_v2 sums each message's last step only.
      { ...base, sessionId: "ses_c", input: 400, migrated: true },
    ];
    const decant: SessionTotals[] = [
      base,
      { ...base, sessionId: "ses_b", input: 410 },
      { ...base, sessionId: "ses_c", input: 410 },
    ];
    const lines = compareSessionTotals(decant, reference);
    expect(lines.map((line) => line.level)).toEqual(["ok", "mismatch", "info"]);
    expect(lines[1]?.text).toContain("input 410 > 400");
    expect(lines[2]?.text).toContain("migrated from 1.x");
    expect(compareSessionTotals([{ ...base, input: 300 }], [base])[0]?.level).toBe("ok");
  });

  test("reads the models list from opencode stats --json output", () => {
    const text = JSON.stringify({
      models: [
        {
          model: { providerID: "opencode-go", id: "glm-5.3-flash", variant: "max" },
          steps: 2,
          tokens: { input: 320, output: 42, reasoning: 10, cache: { read: 100, write: 16 } },
          cost: 0.0000794,
        },
        {
          model: { providerID: "opencode-go", id: "glm-5.3-flash" },
          steps: 1,
          tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0.000002,
        },
      ],
    });
    // Variants collapse into one provider/model line.
    const parsed = parseStatsJson(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      provider: "opencode-go",
      model: "glm-5.3-flash",
      steps: 3,
      input: 330,
      output: 43,
      reasoning: 10,
      cacheRead: 100,
      cacheWrite: 16,
    });
    expect(parsed[0]?.cost).toBeCloseTo(0.0000814, 12);
    expect(() => parseStatsJson("{}")).toThrow("models");
  });
});

describe("opencode parity: 1.x reference totals", () => {
  test("sums step-finish usage per model under Decant's 1.x rules", () => {
    const path = freshPath();
    buildOpenCodeFixtureDb(path, MIXED);
    const totals = withDb(path, readLegacyModelTotals);
    // sample (2 steps: 370 in, 47 out + 10 reasoning, 100 cache read, 16
    // cache write), the fork's own step (90/10), the compaction session's
    // ordinary step (100/40; its summary is counted separately), the 1.3.10
    // session (2 steps whose output already holds reasoning: 100 out, 40
    // reasoning), the 1.4.0 session (30 out + 20 reasoning), and ses_v1_only
    // (40/6). The unfinished sample message has no usage and is no step.
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({
      provider: "opencode-go",
      model: "glm-5.3-flash",
      steps: 8,
      input: 900,
      reasoning: 70,
      cacheRead: 100,
      cacheWrite: 16,
    });
    // OpenCode's convention: output excludes reasoning, so output + reasoning
    // is Decant's output (57 + 10 + 40 + 100 + 50 + 6).
    expect((totals[0]?.output ?? 0) + (totals[0]?.reasoning ?? 0)).toBe(263);
    expect(totals[0]?.cost).toBeCloseTo(0.0002919, 12);
  });

  test("reads a v1.2-shaped database without the aggregate columns", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1/old-shape.sql"], "1.2");
    withDb(path, (db) => {
      expect(readLegacyModelTotals(db)).toEqual([
        {
          provider: "opencode-go",
          model: "glm-5.3-flash",
          steps: 1,
          input: 100,
          output: 30,
          reasoning: 20,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0.00005,
          // 1.2.0 kept reasoning inside output and charged it twice.
          doubleCharged: 20,
        },
      ]);
      expect(readLegacySessions(db)[0]?.tokens_input).toBeNull();
      expect(readLegacySessionTotals(db)).toEqual([]);
    });
  });

  test("counts 1.x compaction summaries on their own", () => {
    const path = freshPath();
    buildOpenCodeFixtureDb(path, MIXED);
    expect(withDb(path, readLegacyCompaction)).toEqual({ rows: 1, input: 300, output: 40 });
  });

  test("reads a session from 1.x only when its 1.x copy is newer than session_v2", () => {
    const path = freshPath();
    buildOpenCodeDb(path, [
      opencodeFixtureSql("v1/migrated.sql"),
      // A 2.x step for the shared session, which must not be counted while
      // the newer 1.x copy is the one Decant reads.
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES ('msg_v1m_2', 'ses_shared', 'assistant', 1, 1791796001000, 1791796001000,
         '{"model":{"providerID":"opencode-go","id":"glm-5.3-flash"},"content":[],"cost":0.00001,"tokens":{"input":10,"output":2,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1791796001000}}');`,
    ]);
    const shared = (db: Database) =>
      readOpenCodeAssistantRows(db).filter((row) => row.sessionId === "ses_shared");
    withDb(path, (db) => {
      expect(readLegacySessions(db).map((row) => row.id)).toEqual(["ses_shared", "ses_v1_only"]);
      const rows = shared(db);
      expect(rows.map((row) => row.legacyPreferred)).toEqual([true]);
      expect(openCodeModelTotals(rows, "decant")).toEqual([]);
      expect(openCodeModelTotals(rows, "stats")[0]?.steps).toBe(1);
    });
    // On a tie the 2.x copy wins.
    const writable = new Database(path, { strict: true });
    writable.exec("UPDATE session SET time_updated = 1791796000000 WHERE id = 'ses_shared'");
    writable.close();
    withDb(path, (db) => {
      expect(readLegacySessions(db).map((row) => row.id)).toEqual(["ses_v1_only"]);
      expect(shared(db).map((row) => row.legacyPreferred)).toEqual([false]);
    });
  });

  test("reads nothing as 1.x from a pre-split 2.x preview database", () => {
    const path = freshPath();
    // session_message without session_v2: the `session` rows are 2.x-shaped.
    buildOpenCodeV1Db(path, [
      opencodeFixtureSql("v1-sample.sql"),
      "CREATE TABLE session_message (id text PRIMARY KEY);",
    ]);
    withDb(path, (db) => {
      expect(readLegacySessions(db)).toEqual([]);
      expect(readLegacyModelTotals(db)).toEqual([]);
    });
  });

  test("never modifies the OpenCode database", () => {
    const path = freshPath();
    buildOpenCodeFixtureDb(path, MIXED);
    // Read the bytes and mtime through one descriptor so both describe the
    // same file state.
    const snapshot = () => {
      const fd = openSync(path, "r");
      try {
        return { bytes: readFileSync(fd), mtimeMs: fstatSync(fd).mtimeMs };
      } finally {
        closeSync(fd);
      }
    };
    const before = snapshot();
    withDb(path, (db) => {
      readLegacyModelTotals(db);
      readLegacyCompaction(db);
      readLegacySessionTotals(db);
      readOpenCodeAssistantRows(db);
      exportOf(db, "ses_v1_sample");
    });
    const after = snapshot();
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe("opencode parity: 2.x counting rules", () => {
  const row = (overrides: Partial<OpenCodeAssistantRow>): OpenCodeAssistantRow => ({
    id: "msg_a",
    sessionId: "ses_a",
    provider: "opencode-go",
    model: "glm-5.3-flash",
    tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 0, write: 0 } },
    cost: 0.00004,
    version: "2.0.27",
    inherited: false,
    forkLinked: false,
    legacyPreferred: false,
    migrated: false,
    stepSum: null,
    ...overrides,
  });

  test("Decant skips every inherited row and keeps 1.x reasoning semantics", () => {
    const rows = [
      row({}),
      // Migrated before 1.3.16: output already includes reasoning.
      row({ version: "1.3.10" }),
      // A migrated fork's inherited row: no fork link, so only Decant skips it.
      row({ inherited: true }),
      // A 2.x fork's inherited row: both skip it.
      row({ inherited: true, forkLinked: true }),
    ];
    const decant = openCodeModelTotals(rows, "decant")[0];
    const stats = openCodeModelTotals(rows, "stats")[0];
    // 2.0.27: 50 + 20; 1.3.10: 50 (holding 20 reasoning).
    expect(decant).toMatchObject({ steps: 2, input: 200, reasoning: 40 });
    expect((decant?.output ?? 0) + (decant?.reasoning ?? 0)).toBe(120);
    // opencode stats adds reasoning to every row it counts.
    expect(stats).toMatchObject({ steps: 3, input: 300, output: 150, reasoning: 60 });
    expect(openCodeRuleDifferences(rows)).toEqual({
      inheritedWithoutForkLink: 1,
      legacyPreferred: 0,
      reasoningIncluded: 1,
      stepSums: 0,
    });
  });

  test("Decant reads a migrated row from its 1.x step-finish parts", () => {
    const path = freshPath();
    buildOpenCodeFixtureDb(path, ["v1/migrated.sql"]);
    const rows = withDb(path, readOpenCodeAssistantRows).filter(
      (r) => r.sessionId === "ses_migrated",
    );
    expect(rows.map((r) => [r.id, r.migrated, r.stepSum?.usage.input ?? null])).toEqual([
      ["msg_mg_2", true, 250],
      ["msg_mg_6", true, null],
    ]);
    // msg_mg_2: both steps (250 in), not the migrated last step (150 in).
    // msg_mg_6 was written by 2.x after the migration: its 4 reasoning
    // tokens are added to output although the session predates 1.3.16.
    expect(openCodeModelTotals(rows, "decant")).toEqual([
      model({
        steps: 2,
        input: 310,
        output: 58,
        reasoning: 4,
        cacheRead: 100,
        cacheWrite: 0,
        cost: 0.0000805,
      }),
    ]);
    expect(openCodeModelTotals(rows, "stats")[0]).toMatchObject({ input: 210, output: 38 });
    expect(openCodeRuleDifferences(rows)).toMatchObject({ stepSums: 1, reasoningIncluded: 0 });
  });

  test("merges 2.x and 1.x reference totals by provider and model", () => {
    const a: ModelTotals = {
      provider: "opencode-go",
      model: "glm-5.3-flash",
      steps: 1,
      input: 10,
      output: 2,
      reasoning: 1,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.5,
    };
    const merged = mergeModelTotals(
      [a],
      [
        { ...a, steps: 2 },
        { ...a, provider: "zai" },
      ],
    );
    expect(merged.map((m) => [m.provider, m.steps, m.input, m.cost])).toEqual([
      ["opencode-go", 3, 20, 1],
      ["zai", 1, 10, 0.5],
    ]);
  });
});

describe("opencode parity: 1.x session columns", () => {
  test("reports matches and differences as information only", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql", "v1/fork.sql"]);
    const reference = withDb(path, readLegacySessionTotals);
    const decant: SessionTotals[] = [
      {
        sessionId: "ses_v1_sample",
        input: 370,
        output: 57,
        reasoning: 10,
        cacheRead: 100,
        cacheWrite: 16,
        cost: 0.0000894,
      },
      // The fork's columns include its inherited usage; Decant's do not.
      {
        sessionId: "ses_v1_fork",
        input: 90,
        output: 10,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.0000185,
      },
    ];
    const lines = compareLegacySessionTotals(decant, reference);
    expect(lines.every((line) => line.level === "info")).toBe(true);
    expect(lines.map((line) => line.text)).toEqual([
      "ses_v1_fork: input 90 vs 210, cacheRead 0 vs 40, cacheWrite 0 vs 16 (Decant vs session columns)",
      "ses_v1_sample: input and cache match the session columns",
      "1 of 2 1.x session(s) match on input/cache (fork and backfilled aggregates differ by design)",
    ]);
  });
});

describe("opencode parity: Letta structural cross-check", () => {
  test("assembles the 1.x export layout from what Decant reads", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql", "v1/fork.sql", "v1/compaction.sql"]);
    withDb(path, (db) => {
      const sample = exportOf(db, "ses_v1_sample");
      expect(sample.info).toEqual({
        id: "ses_v1_sample",
        directory: "/decant-fixture/example",
        time: { created: 1791790000000 },
      });
      expect(sample.messages.map((message) => message.info.id)).toEqual([
        "msg_v1s_1",
        "msg_v1s_2",
        "msg_v1s_3",
        "msg_v1s_4",
      ]);
      // The synthetic text part is dropped; the user text and file stay.
      expect(sample.messages[0]?.parts.map((part) => part.id)).toEqual([
        "prt_v1s_01",
        "prt_v1s_03",
      ]);
      // Inherited fork history is not part of the fork.
      expect(exportOf(db, "ses_v1_fork").messages.map((message) => message.info.id)).toEqual([
        "msg_v1f_3",
        "msg_v1f_4",
      ]);
      // The compaction request and its summary become one system message in
      // Decant, so neither is exported.
      expect(exportOf(db, "ses_v1_compact").messages.map((message) => message.info.id)).toEqual([
        "msg_v1c_1",
        "msg_v1c_2",
        "msg_v1c_5",
      ]);
    });
  });

  test("reads tool calls and result flags from Letta's records", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql"]);
    const document = withDb(path, (db) => exportOf(db, "ses_v1_sample"));
    const result = normalizeTranscript({
      source: "opencode",
      transcript: JSON.stringify(document),
    });
    const letta = lettaStructure(result.records);
    expect(Object.fromEntries(letta.toolCalls)).toEqual({
      call_v1_read: { name: "read", outcome: "ok" },
      call_v1_mcp: { name: "dosu_search", outcome: "ok" },
      call_v1_bash: { name: "bash", outcome: "error" },
      call_v1_pending: { name: "read", outcome: "none" },
    });
    expect([letta.user, letta.assistantText, letta.reasoning]).toEqual([1, 1, 1]);
    // The retry part is the only one Letta reports dropping.
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "noise_record_dropped",
    ]);
  });

  const decantSample = (): TranscriptStructure => ({
    toolCalls: new Map([
      ["call_v1_read", { name: "read", outcome: "ok" as const }],
      ["call_v1_mcp", { name: "mcp__dosu__search", outcome: "ok" as const }],
      ["call_v1_bash", { name: "bash", outcome: "error" as const }],
      ["call_v1_pending", { name: "read", outcome: "none" as const }],
    ]),
    user: 1,
    assistantText: 1,
    reasoning: 1,
  });

  test("matches Decant's tool calls exactly, MCP names included", () => {
    const path = freshPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql"]);
    const document = withDb(path, (db) => exportOf(db, "ses_v1_sample"));
    const letta = lettaStructure(
      normalizeTranscript({ source: "opencode", transcript: JSON.stringify(document) }).records,
    );
    expect(compareStructure("ses_v1_sample", decantSample(), letta)).toEqual([
      { level: "ok", text: "ses_v1_sample: 4 tool call(s) match Letta (ids, names, results)" },
      {
        level: "info",
        text: "ses_v1_sample: records Decant/Letta user 1/1, assistant text 1/1, reasoning 1/1",
      },
    ]);
  });

  test("flags an extra id, a renamed tool, and a changed result flag", () => {
    const letta = decantSample();
    letta.toolCalls.set("call_v1_mcp", { name: "dosu_search", outcome: "ok" });
    const extra = decantSample();
    extra.toolCalls.set("call_v1_extra", { name: "read", outcome: "ok" });
    expect(compareStructure("ses_x", extra, letta).filter((l) => l.level === "mismatch")).toEqual([
      {
        level: "mismatch",
        text: "ses_x: tool-call ids differ (0 only in Letta, 1 only in Decant)",
      },
    ]);
    const changed = decantSample();
    changed.toolCalls.set("call_v1_bash", { name: "shell", outcome: "ok" });
    expect(
      compareStructure("ses_x", changed, letta)
        .filter((l) => l.level === "mismatch")
        .map((l) => l.text),
    ).toEqual([
      "ses_x: 1 tool name(s) differ from Letta",
      "ses_x: 1 tool result flag(s) differ from Letta",
    ]);
  });

  test("equates Decant's MCP names with OpenCode's server_tool names", () => {
    expect(toolNamesMatch("mcp__dosu__search", "dosu_search")).toBe(true);
    expect(toolNamesMatch("mcp__my__server__run", "my__server_run")).toBe(true);
    expect(toolNamesMatch("mcp__dosu__search", "dosu_find")).toBe(false);
    expect(toolNamesMatch("read", "read")).toBe(true);
    expect(toolNamesMatch("read", "write")).toBe(false);
  });

  // End to end: sync synthetic fixtures into a scratch archive with every
  // source and config path pointed at the case directory, then run the
  // script as a developer would.
  for (const [name, build] of [
    // 1.x sessions in a database only 1.x opened.
    ["a 1.x-only database", (path: string) => buildOpenCodeV1FixtureDb(path, V1_SESSIONS)],
    // The same beside 2.x sessions and a migrated session in one database.
    [
      "a 2.x database holding 1.x and migrated sessions",
      (path: string) =>
        buildOpenCodeFixtureDb(path, ["sample.sql", "mcp.sql", ...V1_SESSIONS, "v1/migrated.sql"]),
    ],
  ] as const) {
    test(`reports no mismatch for ${name} synced by Decant, with --letta`, () => {
      counter += 1;
      const dir = join(workDir, `e2e-${counter}`);
      const opencodeDir = join(dir, "opencode");
      mkdirSync(opencodeDir, { recursive: true });
      const opencodePath = join(opencodeDir, "opencode.db");
      build(opencodePath);
      // Names the dosu MCP server, so 1.x `dosu_search` calls become
      // mcp__dosu__search on both sides of the structural check.
      const configPath = join(dir, "opencode.json");
      writeFileSync(
        configPath,
        JSON.stringify({ mcp: { servers: { dosu: { type: "remote", url: "http://localhost" } } } }),
      );
      const archivePath = join(dir, "decant.db");
      const archive = openDb(archivePath);
      try {
        expect(
          sync(archive, {
            claudeDir: join(dir, "none"),
            codexDir: join(dir, "none"),
            geminiDir: join(dir, "none"),
            opencodeDir,
            opencodeConfigPath: configPath,
            opencodeModelsPath: join(dir, "models.json"),
          }),
        ).toMatchObject({ failed: 0 });
      } finally {
        closeDb(archive);
      }
      const run = Bun.spawnSync(
        [
          process.execPath,
          "run",
          join(import.meta.dir, "..", "scripts", "opencode-parity.ts"),
          opencodePath,
          archivePath,
          "--letta",
        ],
        { env: { ...process.env, NO_COLOR: "1" } },
      );
      const stdout = run.stdout.toString();
      expect(stdout.split("\n").filter((line) => line.startsWith("mismatch"))).toEqual([]);
      expect(stdout).toContain("== 0 mismatch line(s)");
      expect(stdout).toContain("== 1.x sessions: Decant vs Letta Trajectory");
      expect(run.exitCode).toBe(0);
    });
  }
});
