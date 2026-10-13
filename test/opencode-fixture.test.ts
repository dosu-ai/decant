import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenCodeDb,
  buildOpenCodeFixtureDb,
  buildOpenCodeV1FixtureDb,
  opencodeFixtureSql,
} from "./opencode-fixture.ts";

// The 1.x fixtures are hand-written, so these checks pin the invariants real
// OpenCode 1.x rows hold (and the parser relies on) before any reader exists,
// plus one fixture convention: the session usage columns are kept the way
// releases from 1.14.49 on keep them.
const workDir = mkdtempSync(join(tmpdir(), "decant-opencode-fixture-test-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
function dbPath(): string {
  counter += 1;
  return join(workDir, `opencode-${counter}.db`);
}

function tables(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

function columns(path: string, table: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

function rows<T>(path: string, sql: string): T[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

const fixtureRoot = join(import.meta.dir, "..", "fixtures", "opencode");

function sqlFiles(dir = fixtureRoot, prefix = ""): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(join(dir, entry)).isDirectory()) {
      return sqlFiles(join(dir, entry), rel);
    }
    return entry.endsWith(".sql") ? [rel] : [];
  });
}

type Tokens = {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

const V1_SCRIPTS = [
  "v1-sample.sql",
  "v1/compaction.sql",
  "v1/subagent.sql",
  "v1/fork.sql",
  "v1/tokens.sql",
  "v1/malformed.sql",
];

describe("OpenCode fixture builders", () => {
  test("a 2.x database also carries the 1.x tables", () => {
    const path = dbPath();
    buildOpenCodeDb(path, []);
    expect(tables(path)).toEqual([
      "kv",
      "message",
      "part",
      "session",
      "session_message",
      "session_v2",
    ]);
  });

  test("a 1.x-only database has no 2.x tables", () => {
    const path = dbPath();
    buildOpenCodeV1FixtureDb(path, ["v1-sample.sql"]);
    expect(tables(path)).toEqual(["message", "part", "session"]);
    expect(rows<{ n: number }>(path, "SELECT COUNT(*) AS n FROM message")[0]?.n).toBe(4);
    expect(rows<{ n: number }>(path, "SELECT COUNT(*) AS n FROM part")[0]?.n).toBe(16);
  });

  test("the v1.2 shape lacks the columns later releases added", () => {
    const path = dbPath();
    buildOpenCodeV1FixtureDb(path, ["v1/old-shape.sql"], "1.2");
    const sessionColumns = columns(path, "session");
    for (const column of [
      "workspace_id",
      "path",
      "metadata",
      "cost",
      "tokens_input",
      "agent",
      "model",
    ]) {
      expect(sessionColumns).not.toContain(column);
    }
    expect(rows<{ id: string }>(path, "SELECT id FROM session")).toEqual([{ id: "ses_v1_12" }]);
  });

  test("each focused script builds and holds the sessions its tests name", () => {
    const path = dbPath();
    buildOpenCodeV1FixtureDb(path, V1_SCRIPTS);
    expect(
      rows<{ id: string }>(path, "SELECT id FROM session ORDER BY id").map((r) => r.id),
    ).toEqual([
      "ses_v1_bad",
      "ses_v1_child",
      "ses_v1_compact",
      "ses_v1_fork",
      "ses_v1_new",
      "ses_v1_old",
      "ses_v1_parent",
      "ses_v1_sample",
    ]);
    const migrated = dbPath();
    buildOpenCodeFixtureDb(migrated, ["v1/migrated.sql"]);
    expect(
      rows<{ id: string }>(migrated, "SELECT id FROM session ORDER BY id").map((r) => r.id),
    ).toEqual(["ses_migrated", "ses_shared", "ses_v1_only"]);
    expect(
      rows<{ id: string }>(migrated, "SELECT id FROM session_v2 ORDER BY id").map((r) => r.id),
    ).toEqual(["ses_migrated", "ses_shared"]);
  });
});

describe("OpenCode 1.x fixture invariants", () => {
  const path = dbPath();
  let messages: { id: string; session_id: string; time_created: number; data: string }[] = [];
  let parts: { message_id: string; session_id: string; data: string }[] = [];
  beforeAll(() => {
    buildOpenCodeV1FixtureDb(
      path,
      V1_SCRIPTS.filter((name) => name !== "v1/malformed.sql"),
    );
    messages = rows(path, "SELECT id, session_id, time_created, data FROM message ORDER BY id");
    parts = rows(path, "SELECT message_id, session_id, data FROM part ORDER BY message_id, id");
  });

  test("row time_created mirrors info.time.created and parts share their message's session", () => {
    const sessionOf = new Map(messages.map((m) => [m.id, m.session_id]));
    for (const message of messages) {
      expect(JSON.parse(message.data).time.created).toBe(message.time_created);
    }
    for (const part of parts) {
      expect(sessionOf.get(part.message_id)).toBe(part.session_id);
    }
  });

  test("info.cost sums the step costs and info.tokens is the last step", () => {
    for (const message of messages) {
      const info = JSON.parse(message.data);
      const steps = parts
        .filter((p) => p.message_id === message.id)
        .map((p) => JSON.parse(p.data))
        .filter((p) => p.type === "step-finish");
      if (info.role !== "assistant" || steps.length === 0) {
        continue;
      }
      const stepCost = steps.reduce((sum, step) => sum + step.cost, 0);
      expect(Math.abs(stepCost - info.cost)).toBeLessThan(1e-12);
      expect(info.tokens).toEqual(steps.at(-1).tokens);
    }
  });

  test("session aggregates equal the sum of step-finish parts, as 1.14.49+ keeps them", () => {
    // A fixture convention, not a 1.x rule: the columns arrived in 1.14.49
    // and were backfilled from each message's last-step info.tokens, so older
    // sessions' aggregates can be lower. The parser never reads them for usage.
    const sessions = rows<{
      id: string;
      cost: number;
      tokens_input: number;
      tokens_output: number;
      tokens_reasoning: number;
      tokens_cache_read: number;
      tokens_cache_write: number;
    }>(
      path,
      "SELECT id, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session",
    );
    for (const session of sessions) {
      const steps = parts
        .filter((p) => p.session_id === session.id)
        .map((p) => JSON.parse(p.data))
        .filter((p) => p.type === "step-finish") as { cost: number; tokens: Tokens }[];
      const sum = (pick: (t: Tokens) => number) =>
        steps.reduce((acc, s) => acc + pick(s.tokens), 0);
      expect({
        id: session.id,
        input: session.tokens_input,
        output: session.tokens_output,
        reasoning: session.tokens_reasoning,
        cacheRead: session.tokens_cache_read,
        cacheWrite: session.tokens_cache_write,
      }).toEqual({
        id: session.id,
        input: sum((t) => t.input),
        output: sum((t) => t.output),
        reasoning: sum((t) => t.reasoning),
        cacheRead: sum((t) => t.cache.read),
        cacheWrite: sum((t) => t.cache.write),
      });
      expect(Math.abs(session.cost - steps.reduce((acc, s) => acc + s.cost, 0))).toBeLessThan(
        1e-12,
      );
    }
  });
});

describe("OpenCode fixture content", () => {
  test("uses only invented paths that no user can create", () => {
    for (const name of sqlFiles()) {
      const text = opencodeFixtureSql(name);
      expect(text, name).not.toMatch(/\/tmp\/|\/Users\/|\/home\/|\/var\/folders\//);
    }
  });
});
